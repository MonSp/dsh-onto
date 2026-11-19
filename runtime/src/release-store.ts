/**
 * M4 受控导入 / 激活 / 回滚存储（spec S2.6.2–S2.6.3）。
 *
 * 布局（相对 `releasesRoot`，与 workspace 并列）：
 *   releases/
 *     active.json                 活动指针 + 插件/core/runtime 版本分记
 *     history.jsonl               激活/回滚追加日志（只增不删）
 *     manifests/<name>/<version>.json   发布描述（外层，非包内）
 *     inbox/                      部署配置受控上传落点（可选）
 *
 * 包内容写入 `PackageWorkspace` 版本目录（ISSUED 只读语义由 core 保证）。
 * 导入不自动激活；授权确认后才切活动版本。
 * @module @dsh-onto/runtime/release-store
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { PackageWorkspace } from '@dsh-onto/core'
import {
  assertAuthorizedActor,
  assertConnectorCapabilities,
  assertDependenciesIssued,
  assertDeploymentConfigSource,
  buildReleaseManifest,
  checkCompat,
  collectPackageFiles,
  computePackageDigest,
  parseReleaseManifest,
  ReleaseError,
  stageValidateFiles,
  verifyReleaseAgainstPackage,
  DEFAULT_STAGING_LIMITS,
  RELEASE_ACTIVE_FORMAT,
  RELEASE_BUNDLE_FORMAT,
  RELEASE_FORMAT,
  type CurrentRuntimeVersions,
  type ReleaseBundle,
  type ReleaseErrorCode,
  type ReleaseImportSource,
  type ReleaseManifest,
  type StagingLimits,
} from './release.js'

export interface ReleaseStoreOptions {
  /** 发布根目录（active.json / manifests / history）。 */
  root: string
  /** 包内容工作区（版本化只读存储落点）。 */
  workspace: PackageWorkspace
  /** 部署配置允许根（缺省仅 `<root>/inbox`）。 */
  allowedConfigRoots?: string[]
  limits?: Partial<StagingLimits>
  /** 激活时记录的插件/core/runtime 版本。 */
  versions?: Partial<CurrentRuntimeVersions>
  /** 激活时校验的连接器能力提供者（含已注册 id）。 */
  capabilities?: () => readonly string[]
}

export interface ActivePointer {
  format: typeof RELEASE_ACTIVE_FORMAT
  packages: Record<string, string>
  versions: {
    plugin?: string
    core: string
    runtime: string
  }
  updatedAt: string
  updatedBy: string
}

export interface ReleaseHistoryEntry {
  at: string
  action: 'import' | 'activate' | 'rollback'
  package: { name: string; version: string }
  from?: string | null
  to: string | null
  by: string
  packageDigest?: string
}

export interface ImportResult {
  ok: true
  idempotent: boolean
  package: { name: string; version: string }
  packageDigest: string
  dir: string
}

export interface ActivateResult {
  ok: true
  package: { name: string; version: string }
  previous: string | null
  versions: ActivePointer['versions']
}

export class ReleaseStore {
  readonly root: string
  private readonly ws: PackageWorkspace
  private readonly allowedConfigRoots: string[]
  private readonly limits: StagingLimits
  private readonly defaultVersions: CurrentRuntimeVersions
  private readonly capabilities: () => readonly string[]

  constructor(opts: ReleaseStoreOptions) {
    this.root = resolve(opts.root)
    this.ws = opts.workspace
    mkdirSync(this.root, { recursive: true })
    mkdirSync(this.inboxDir, { recursive: true })
    mkdirSync(this.manifestsDir, { recursive: true })
    this.allowedConfigRoots = opts.allowedConfigRoots ?? [this.inboxDir]
    this.limits = { ...DEFAULT_STAGING_LIMITS, ...(opts.limits ?? {}) }
    this.defaultVersions = {
      core: opts.versions?.core ?? '0.0.0',
      runtime: opts.versions?.runtime ?? '0.0.0',
      ...(opts.versions?.plugin !== undefined ? { plugin: opts.versions.plugin } : {}),
    }
    this.capabilities = opts.capabilities ?? (() => [])
  }

  get inboxDir(): string {
    return join(this.root, 'inbox')
  }

  get manifestsDir(): string {
    return join(this.root, 'manifests')
  }

  get activePath(): string {
    return join(this.root, 'active.json')
  }

  get historyPath(): string {
    return join(this.root, 'history.jsonl')
  }

  /* ── 活动指针 ─────────────────────────────────────────────────────────── */

  /** 读取活动指针；无文件返回 null（未进入发布管理语义）。 */
  readActive(): ActivePointer | null {
    if (!existsSync(this.activePath)) return null
    try {
      const doc = JSON.parse(readFileSync(this.activePath, 'utf8')) as ActivePointer
      if (doc === null || typeof doc !== 'object' || typeof doc.packages !== 'object' || doc.packages === null) {
        return null
      }
      return doc
    } catch {
      return null
    }
  }

  /** 单包活动版本；未管理返回 null。 */
  activeVersion(name: string): string | null {
    const a = this.readActive()
    if (a === null) return null
    return a.packages[name] ?? null
  }

  /** 活动映射副本；无指针返回 null。 */
  activeMap(): Map<string, string> | null {
    const a = this.readActive()
    if (a === null) return null
    return new Map(Object.entries(a.packages))
  }

  /**
   * 新运行选版断言：
   * - 无 active.json → 放行（开发工作区语义，兼容 M0–M3）；
   * - 指针含该包 → version 必须等于活动版，否则 RELEASE_VERSION_NOT_ACTIVE；
   * - 指针存在但不含该包 → 放行（该包未纳入发布管理，保持既有行为）。
   */
  assertActiveBinding(name: string, version: string): void {
    const a = this.readActive()
    if (a === null) return
    const active = a.packages[name]
    if (active === undefined) return
    if (active !== version) {
      throw new ReleaseError(
        'RELEASE_VERSION_NOT_ACTIVE',
        `包 ${name} 活动版本 ${active}，请求 ${version} 拒绝（新运行只绑活动版本）`,
      )
    }
  }

  /**
   * 过滤包版本列表：已纳入指针的包只保留活动版本；未纳入与无指针原样保留。
   * 用于 list_packages / 技能发现 / 专家索引。
   */
  filterActiveVersions<T extends { name: string; version: string }>(versions: readonly T[]): T[] {
    const a = this.readActive()
    if (a === null) return [...versions]
    return versions.filter((v) => {
      const active = a.packages[v.name]
      return active === undefined || active === v.version
    })
  }

  /* ── 发布描述读写 ─────────────────────────────────────────────────────── */

  manifestPath(name: string, version: string): string {
    return join(this.manifestsDir, name, `${version}.json`)
  }

  readManifest(name: string, version: string): ReleaseManifest | null {
    const p = this.manifestPath(name, version)
    if (!existsSync(p)) return null
    try {
      return parseReleaseManifest(JSON.parse(readFileSync(p, 'utf8')))
    } catch {
      return null
    }
  }

  listManifests(): ReleaseManifest[] {
    const out: ReleaseManifest[] = []
    if (!existsSync(this.manifestsDir)) return out
    for (const name of safeReaddir(this.manifestsDir)) {
      const nameDir = join(this.manifestsDir, name)
      if (!isDir(nameDir)) continue
      for (const file of safeReaddir(nameDir)) {
        if (!file.endsWith('.json')) continue
        const version = file.slice(0, -5)
        const m = this.readManifest(name, version)
        if (m !== null) out.push(m)
      }
    }
    return out.sort((a, b) =>
      a.package.name === b.package.name
        ? a.package.version < b.package.version ? -1 : 1
        : a.package.name < b.package.name ? -1 : 1,
    )
  }

  /* ── 受控导入 ─────────────────────────────────────────────────────────── */

  /**
   * 受控导入：来源白名单 → 围栏 → 锚点链 → 幂等/冲突 → 写入版本化存储。
   * **不**自动激活。
   */
  importRelease(source: ReleaseImportSource): ImportResult {
    const bundle = this.loadSourceBundle(source)
    const manifest = parseReleaseManifest(bundle.manifest)
    if (manifest.format !== RELEASE_FORMAT) {
      throw new ReleaseError('RELEASE_UNSUPPORTED_FORMAT', manifest.format)
    }

    // 围栏（先于任何落盘）
    stageValidateFiles(bundle.files, this.limits)

    // 格式：bundle 信封
    if (source.kind === 'controlled-upload' && source.bundle.format !== RELEASE_BUNDLE_FORMAT) {
      throw new ReleaseError('RELEASE_UNSUPPORTED_FORMAT', `bundle format: ${String(source.bundle.format)}`)
    }

    // packageDigest 与 files 重算一致（P1 篡改面之一）
    const actualDigest = computePackageDigest(bundle.files)
    if (actualDigest !== manifest.packageDigest) {
      throw new ReleaseError('RELEASE_ANCHOR_MISMATCH', 'packageDigest mismatch vs files')
    }

    // core/runtime 兼容
    const compat = checkCompat(manifest, this.defaultVersions)
    if (!compat.ok) {
      throw new ReleaseError(compat.code, compat.reason)
    }

    const { name, version } = manifest.package
    const dir = this.ws.versionDir(name, version)

    // 暂存写入：先写临时目录再校验入站锚点（P1 篡改先于幂等/冲突判定）
    const staging = join(this.root, '.staging', `${name}-${version}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    try {
      mkdirSync(staging, { recursive: true })
      for (const f of bundle.files) {
        const full = join(staging, f.path)
        // 二次围栏（join 后）
        if (!full.startsWith(staging)) {
          throw new ReleaseError('RELEASE_UNSAFE_PATH', `path escapes staging: ${f.path}`)
        }
        mkdirSync(dirname(full), { recursive: true })
        writeFileSync(full, f.content, 'utf8')
      }

      // 锚点链（对暂存内容；P1）——必须在冲突判定之前
      verifyReleaseAgainstPackage(manifest, staging, { files: bundle.files })

      // 依赖包（P3b）
      assertDependenciesIssued(manifest.dependencies, (n, v) => {
        const d = this.ws.versionDir(n, v)
        return existsSync(join(d, 'package.yaml')) ? d : null
      })

      // 幂等 / 冲突（P2）：入站已自洽，再比对既有存储
      const existingManifest = this.readManifest(name, version)
      const packageExists = existsSync(join(dir, 'package.yaml'))
      if (existingManifest !== null || packageExists) {
        const existingDigest =
          existingManifest?.packageDigest
          ?? (packageExists ? tryDigestOfDir(dir) : null)
        if (existingDigest !== null && existingDigest === manifest.packageDigest) {
          // 已存在同内容：补齐外层发布描述（幂等），不重写包文件
          const mp = this.manifestPath(name, version)
          if (!existsSync(mp)) {
            mkdirSync(dirname(mp), { recursive: true })
            writeFileSync(mp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
            this.appendHistory({
              at: new Date().toISOString(),
              action: 'import',
              package: { name, version },
              to: version,
              by: manifest.releasedBy,
              packageDigest: manifest.packageDigest,
            })
          }
          return {
            ok: true,
            idempotent: true,
            package: { name, version },
            packageDigest: manifest.packageDigest,
            dir,
          }
        }
        throw new ReleaseError(
          'RELEASE_CONFLICT',
          `${name}@${version} already exists with different content`,
        )
      }

      // 并入 workspace 版本目录
      mkdirSync(dir, { recursive: true })
      for (const f of bundle.files) {
        const full = join(dir, f.path)
        mkdirSync(dirname(full), { recursive: true })
        writeFileSync(full, f.content, 'utf8')
      }

      // 外层发布描述
      const mp = this.manifestPath(name, version)
      mkdirSync(dirname(mp), { recursive: true })
      writeFileSync(mp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

      this.appendHistory({
        at: new Date().toISOString(),
        action: 'import',
        package: { name, version },
        to: version,
        by: manifest.releasedBy,
        packageDigest: manifest.packageDigest,
      })

      return {
        ok: true,
        idempotent: false,
        package: { name, version },
        packageDigest: manifest.packageDigest,
        dir,
      }
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  }

  private loadSourceBundle(source: ReleaseImportSource): ReleaseBundle {
    if (source.kind === 'controlled-upload') {
      if (source.bundle === null || typeof source.bundle !== 'object') {
        throw new ReleaseError('RELEASE_SOURCE_REJECTED', 'controlled-upload requires bundle')
      }
      if (source.bundle.format !== RELEASE_BUNDLE_FORMAT) {
        throw new ReleaseError(
          'RELEASE_UNSUPPORTED_FORMAT',
          `bundle format: ${String(source.bundle.format)}`,
        )
      }
      return source.bundle
    }
    if (source.kind === 'deployment-config') {
      const full = assertDeploymentConfigSource(source, this.allowedConfigRoots)
      if (!existsSync(full) || !statSync(full).isFile()) {
        throw new ReleaseError('RELEASE_NOT_FOUND', 'deployment-config bundle not found')
      }
      // 禁止符号链接文件
      if (statSync(full).isSymbolicLink()) {
        throw new ReleaseError('RELEASE_SYMLINK', 'deployment-config bundle is symlink')
      }
      let doc: unknown
      try {
        doc = JSON.parse(readFileSync(full, 'utf8'))
      } catch {
        throw new ReleaseError('RELEASE_MALFORMED', 'deployment-config bundle is not valid JSON')
      }
      if (doc === null || typeof doc !== 'object' || (doc as { format?: unknown }).format !== RELEASE_BUNDLE_FORMAT) {
        throw new ReleaseError('RELEASE_UNSUPPORTED_FORMAT', 'deployment-config must be release bundle')
      }
      return doc as ReleaseBundle
    }
    throw new ReleaseError('RELEASE_SOURCE_REJECTED', 'unknown source kind')
  }

  /* ── 激活 / 回滚 ─────────────────────────────────────────────────────── */

  /**
   * 授权激活：重验锚点 + 依赖 + 连接器能力 → 写活动指针（分记插件/core/runtime 版本）。
   * 不改写在途提案与历史 RunRecord。
   */
  activate(name: string, version: string, opts: { authorizedBy: string }): ActivateResult {
    const by = assertAuthorizedActor(opts.authorizedBy)
    const manifest = this.readManifest(name, version)
    if (manifest === null) {
      throw new ReleaseError('RELEASE_NOT_FOUND', `no release manifest: ${name}@${version}`)
    }
    const dir = this.ws.versionDir(name, version)
    if (!existsSync(join(dir, 'package.yaml'))) {
      throw new ReleaseError('RELEASE_NOT_FOUND', `package missing: ${name}@${version}`)
    }

    // 激活时再跑一次锚点（防导入后篡改）
    verifyReleaseAgainstPackage(manifest, dir)
    assertDependenciesIssued(manifest.dependencies, (n, v) => {
      const d = this.ws.versionDir(n, v)
      return existsSync(join(d, 'package.yaml')) ? d : null
    })
    assertConnectorCapabilities(manifest.requiredConnectorCapabilities, this.capabilities())

    const active = this.readActive()
    const packages = { ...(active?.packages ?? {}) }
    const previous = packages[name] ?? null
    packages[name] = version

    const next: ActivePointer = {
      format: RELEASE_ACTIVE_FORMAT,
      packages,
      versions: {
        ...(active?.versions.plugin !== undefined || this.defaultVersions.plugin !== undefined
          ? { plugin: active?.versions.plugin ?? this.defaultVersions.plugin }
          : {}),
        core: this.defaultVersions.core,
        runtime: this.defaultVersions.runtime,
      },
      updatedAt: new Date().toISOString(),
      updatedBy: by,
    }
    this.writeActive(next)
    this.appendHistory({
      at: next.updatedAt,
      action: previous === null ? 'activate' : 'activate',
      package: { name, version },
      from: previous,
      to: version,
      by,
      packageDigest: manifest.packageDigest,
    })
    return { ok: true, package: { name, version }, previous, versions: next.versions }
  }

  /**
   * 回滚：恢复该包上一活动版本；只追加 history、不删除发布物。
   * 目标版本不存在于存储 → RELEASE_NOT_FOUND（不虚构）。
   * 只影响新运行选版。
   */
  rollback(name: string, opts: { authorizedBy: string }): ActivateResult {
    const by = assertAuthorizedActor(opts.authorizedBy)
    const active = this.readActive()
    if (active === null || active.packages[name] === undefined) {
      throw new ReleaseError('RELEASE_NOT_FOUND', `no active pointer for package: ${name}`)
    }
    const current = active.packages[name]
    const prev = this.findPreviousVersion(name, current)
    if (prev === null) {
      throw new ReleaseError('RELEASE_NOT_FOUND', `no previous active version to rollback for ${name}`)
    }
    // 目标必须仍在存储中
    if (this.readManifest(name, prev) === null || !existsSync(join(this.ws.versionDir(name, prev), 'package.yaml'))) {
      throw new ReleaseError('RELEASE_NOT_FOUND', `previous version missing in store: ${name}@${prev}`)
    }

    const packages = { ...active.packages }
    packages[name] = prev
    const next: ActivePointer = {
      ...active,
      packages,
      updatedAt: new Date().toISOString(),
      updatedBy: by,
    }
    this.writeActive(next)
    this.appendHistory({
      at: next.updatedAt,
      action: 'rollback',
      package: { name, version: prev },
      from: current,
      to: prev,
      by,
    })
    return {
      ok: true,
      package: { name, version: prev },
      previous: current,
      versions: next.versions,
    }
  }

  /** history 只读快照（P5：回滚后历史仍在）。 */
  readHistory(): ReleaseHistoryEntry[] {
    if (!existsSync(this.historyPath)) return []
    const text = readFileSync(this.historyPath, 'utf8')
    const out: ReleaseHistoryEntry[] = []
    for (const line of text.split('\n')) {
      const t = line.trim()
      if (t === '') continue
      try {
        out.push(JSON.parse(t) as ReleaseHistoryEntry)
      } catch {
        /* skip corrupt line */
      }
    }
    return out
  }

  private findPreviousVersion(name: string, before: string): string | null {
    const hist = this.readHistory().filter(
      (h) => h.package.name === name && (h.action === 'activate' || h.action === 'rollback') && h.to !== null,
    )
    // 从后往前找「当前 version 之前」的上一个 to
    const idx = hist.findIndex((h) => h.to === before)
    if (idx <= 0) {
      // 没有恰好等于 before 的记录时，取最近一条 to !== current 且 != before 的
      for (let i = hist.length - 1; i >= 0; i -= 1) {
        const t = hist[i].to
        if (t !== null && t !== before) return t
      }
      return null
    }
    for (let i = idx - 1; i >= 0; i -= 1) {
      const t = hist[i].to
      if (t !== null && t !== before) return t
    }
    return null
  }

  private writeActive(doc: ActivePointer): void {
    mkdirSync(dirname(this.activePath), { recursive: true })
    writeFileSync(this.activePath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
  }

  private appendHistory(entry: ReleaseHistoryEntry): void {
    mkdirSync(dirname(this.historyPath), { recursive: true })
    writeFileSync(this.historyPath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', flag: 'a' })
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function tryDigestOfDir(dir: string): string | null {
  try {
    return computePackageDigest(collectPackageFiles(dir))
  } catch {
    return null
  }
}

export type { ReleaseErrorCode, ReleaseManifest, ReleaseImportSource, CurrentRuntimeVersions }
