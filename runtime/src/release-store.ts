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
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  renameSync,
  writeFileSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { runtimeState } from './context.js'
import { dirname, join, resolve, sep } from 'node:path'
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
  requireActive?: boolean
}

const releaseModeKey = Symbol('releaseMode')
const releaseMode = () => runtimeState(releaseModeKey, () => ({ strict: false }))
export function enableStrictReleaseMode(): void { releaseMode().strict = true }
export function isStrictReleaseMode(): boolean { return releaseMode().strict }

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
  /** 批准卡凭证摘要（T2.1 留痕）：本条发布动作放行时的批次指纹，导出/回查可对账。 */
  approvalDigest?: string
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

const LOCK_STALE_MS = 30_000
const LOCK_WAIT_MS = 10_000

function sleepMs(ms: number): void {
  // 同步等待（本模块写路径是同步 API）：Atomics.wait 主线程可用（Node）
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * 跨进程互斥（lockfile，`openSync(..., 'wx')` 原子创建，同 source-config 持锁模式）：
 * 把「读活动指针 → 判定 → 写指针 → 落 history」放进同一临界区——
 * 并发 readActive→writeActive 的 TOCTOU 窗口会造成后写覆盖先写 / 指针与 history 错位。
 * 持锁进程死亡 → 按 mtime 超时打破陈锁（打破后重新竞争，不直接进临界区）。
 */
function withReleaseLock<T>(lockFile: string, fn: () => T): T {
  mkdirSync(dirname(lockFile), { recursive: true })
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    let fd: number
    try {
      fd = openSync(lockFile, 'wx')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      try {
        if (Date.now() - statSync(lockFile).mtimeMs > LOCK_STALE_MS) rmSync(lockFile, { force: true })
      } catch {
        /* 锁已被并发方移除：下轮重新竞争 */
      }
      if (Date.now() > deadline) {
        throw new ReleaseError('RELEASE_CONFLICT', '发布指针写入锁超时（并发争用）：请重试')
      }
      sleepMs(5)
      continue
    }
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), 'utf8')
      return fn()
    } finally {
      closeSync(fd)
      rmSync(lockFile, { force: true })
    }
  }
}

export class ReleaseStore {
  readonly root: string
  private readonly ws: PackageWorkspace
  private readonly allowedConfigRoots: string[]
  private readonly limits: StagingLimits
  private readonly defaultVersions: CurrentRuntimeVersions
  private readonly capabilities: () => readonly string[]
  private readonly requireActive: boolean

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
    this.requireActive = opts.requireActive ?? isStrictReleaseMode()
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
      if (doc === null || doc.format !== RELEASE_ACTIVE_FORMAT || !doc.packages
        || typeof doc.packages !== 'object' || Array.isArray(doc.packages)
        || Object.values(doc.packages).some(v => typeof v !== 'string' || v.length === 0)
        || !doc.versions || typeof doc.versions.core !== 'string' || typeof doc.versions.runtime !== 'string') {
        throw new ReleaseError('RELEASE_MALFORMED', 'invalid active release pointer')
      }
      return doc
    } catch {
      if (this.requireActive) throw new ReleaseError('RELEASE_MALFORMED', 'unreadable active release pointer')
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
   * - 无 active.json：未受管包（该名下无任何发布 manifest）放行（开发工作区语义，兼容 M0–M3）；
   *   已受管（该名下任一版本有 manifest）未激活 → RELEASE_NOT_ACTIVE（发布业务 v1：包级受管，未激活一律拒）；
   * - 指针含该包 → version 必须等于活动版，否则 RELEASE_VERSION_NOT_ACTIVE；
   * - 指针存在但不含该包 → 未受管放行；已受管同上拒（未激活）。
   * - requireActive（strict）：一切未激活皆拒 + 激活后复核 manifest 锚点（反篡改）。
   * - manifest 损坏（存在但不可解析）→ RELEASE_MALFORMED（fail-closed，不得退回「未受管」语义）。
   */
  assertActiveBinding(name: string, version: string): void {
    const a = this.readActive()
    const active = a && Object.hasOwn(a.packages, name) ? a.packages[name] : undefined
    if (active === undefined) {
      // 发布业务 v1（平台免重启声明式发布）：已受管（该名下任一版本有发布 manifest）的包未激活一律拒——
      // 未激活 fail-closed（包级受管，同名其它版本不得退回开发语义）；未受管包保持开发工作区语义（M0–M3）。
      if (this.requireActive || this.hasAnyManifest(name)) {
        throw new ReleaseError('RELEASE_NOT_ACTIVE', `no active release for ${name}@${version}（已导入未激活，需授权人激活）`)
      }
      return
    }
    if (active !== version) {
      throw new ReleaseError(
        'RELEASE_VERSION_NOT_ACTIVE',
        `包 ${name} 活动版本 ${active}，请求 ${version} 拒绝（新运行只绑活动版本）`,
      )
    }
    if (this.requireActive) {
      const manifest = this.readManifest(name, version)
      if (manifest === null) throw new ReleaseError('RELEASE_NOT_FOUND', `no release manifest: ${name}@${version}`)
      verifyReleaseAgainstPackage(manifest, this.ws.versionDir(name, version))
    }
  }

  /**
   * 过滤包版本列表：已纳入指针的包只保留活动版本；未纳入与无指针原样保留。
   * 用于 list_packages / 技能发现 / 专家索引。
   */
  filterActiveVersions<T extends { name: string; version: string }>(versions: readonly T[]): T[] {
    const a = this.readActive()
    if (a === null) return this.requireActive ? [] : [...versions]
    return versions.filter((v) => {
      const active = Object.hasOwn(a.packages, v.name) ? a.packages[v.name] : undefined
      return active === v.version || (active === undefined && !this.requireActive)
    })
  }

  /* ── 发布描述读写 ─────────────────────────────────────────────────────── */

  manifestPath(name: string, version: string): string {
    return join(this.manifestsDir, name, `${version}.json`)
  }

  /**
   * 读发布描述：文件缺失返回 null；**存在但损坏/结构非法抛 RELEASE_MALFORMED**——
   * 受管闸不得把损坏 manifest 退回「未受管放行」（fail-open 面，须 fail-loud）。
   */
  readManifest(name: string, version: string): ReleaseManifest | null {
    const p = this.manifestPath(name, version)
    if (!existsSync(p)) return null
    try {
      return parseReleaseManifest(JSON.parse(readFileSync(p, 'utf8')))
    } catch (e) {
      if (e instanceof ReleaseError) throw e
      throw new ReleaseError('RELEASE_MALFORMED', `unreadable release manifest: ${name}@${version}（人工核对，不自动重建）`)
    }
  }

  /** 该包名下是否已有任一发布 manifest（包级受管判定）。损坏 manifest 同样 fail-loud。 */
  hasAnyManifest(name: string): boolean {
    const dir = join(this.manifestsDir, name)
    if (!isDir(dir)) return false
    return safeReaddir(dir).some((f) => f.endsWith('.json'))
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
        // 列举面按条跳过损坏项（软面容错）；硬面（受管闸/激活）经 readManifest fail-loud。
        try {
          const m = this.readManifest(name, version)
          if (m !== null) out.push(m)
        } catch {
          /* skip corrupt manifest */
        }
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
   * **不**自动激活。opts.approvalDigest 为批准卡凭证摘要（T2.1 留痕入 history）。
   */
  importRelease(source: ReleaseImportSource, opts?: { approvalDigest?: string }): ImportResult {
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
        // 二次围栏（join 后；dir+sep 前缀防 sibling 目录名前缀误判，如 /pkg-1.0.0 与 /pkg-1.0.0-evil）
        if (!full.startsWith(staging + sep)) {
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
          // 已存在同内容：幂等，不改写包内容。但包实物缺失（manifest 在、workspace 空）时
          // 从暂存区按同摘要自愈补写——否则出现「导入报幂等成功、激活报包缺失」的自洽性断裂。
          if (!packageExists) {
            mkdirSync(dir, { recursive: true })
            for (const f of bundle.files) {
              const full = join(dir, f.path)
              if (!full.startsWith(dir + sep)) {
                throw new ReleaseError('RELEASE_UNSAFE_PATH', `path escapes package dir: ${f.path}`)
              }
              mkdirSync(dirname(full), { recursive: true })
              writeFileSync(full, f.content, 'utf8')
            }
          }
          // 补齐外层发布描述（幂等），不重写包文件
          const mp = this.manifestPath(name, version)
          if (!existsSync(mp)) {
            this.writeManifestFile(mp, manifest)
            this.appendHistory({
              at: new Date().toISOString(),
              action: 'import',
              package: { name, version },
              to: version,
              by: manifest.releasedBy,
              packageDigest: manifest.packageDigest,
              ...(opts?.approvalDigest !== undefined ? { approvalDigest: opts.approvalDigest } : {}),
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
        // 二次围栏（join 后；与 staging/自愈同口径，dir+sep 防 sibling 前缀误判）
        if (!full.startsWith(dir + sep)) {
          throw new ReleaseError('RELEASE_UNSAFE_PATH', `path escapes package dir: ${f.path}`)
        }
        mkdirSync(dirname(full), { recursive: true })
        writeFileSync(full, f.content, 'utf8')
      }

      // 外层发布描述
      const mp = this.manifestPath(name, version)
      this.writeManifestFile(mp, manifest)

      this.appendHistory({
        at: new Date().toISOString(),
        action: 'import',
        package: { name, version },
        to: version,
        by: manifest.releasedBy,
        packageDigest: manifest.packageDigest,
        ...(opts?.approvalDigest !== undefined ? { approvalDigest: opts.approvalDigest } : {}),
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
   * 全程持锁（读指针→写指针→history 同临界区，消 TOCTOU）；appendHistory 失败
   * 补偿回写原指针再抛错——不留「指针已动、无 history」半态。
   */
  activate(name: string, version: string, opts: { authorizedBy: string; approvalDigest?: string }): ActivateResult {
    const by = assertAuthorizedActor(opts.authorizedBy)
    return withReleaseLock(`${this.activePath}.lock`, () => {
      const manifest = this.validateActivation(name, version)
      const active = this.readActive()
      const packages = { ...(active?.packages ?? {}), [name]: version }
      const previous = active && Object.hasOwn(active.packages, name) ? active.packages[name] : null

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
      try {
        this.appendHistory({
          at: next.updatedAt,
          action: 'activate',
          package: { name, version },
          from: previous,
          to: version,
          by,
          packageDigest: manifest.packageDigest,
          ...(opts.approvalDigest !== undefined ? { approvalDigest: opts.approvalDigest } : {}),
        })
      } catch (e) {
        // 补偿（先读后写）：history 落盘失败 → 回写原指针（无原指针则撤下 active.json）
        if (active === null) rmSync(this.activePath, { force: true })
        else this.writeActive(active)
        throw e
      }
      return { ok: true, package: { name, version }, previous, versions: next.versions }
    })
  }

  private validateActivation(name: string, version: string): ReleaseManifest {
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
    const compat = checkCompat(manifest, this.defaultVersions)
    if (!compat.ok) throw new ReleaseError(compat.code, compat.reason)
    assertDependenciesIssued(manifest.dependencies, (n, v) => {
      const d = this.ws.versionDir(n, v)
      return existsSync(join(d, 'package.yaml')) ? d : null
    })
    assertConnectorCapabilities(manifest.requiredConnectorCapabilities, this.capabilities())
    return manifest
  }

  /**
   * 回滚：恢复该包上一活动版本；只追加 history、不删除发布物。
   * 目标版本不存在于存储 → RELEASE_NOT_FOUND（不虚构）。
   * 只影响新运行选版。
   * 全程持锁 + appendHistory 失败补偿回写原指针（同 activate 口径，不留半态）。
   */
  rollback(name: string, opts: { authorizedBy: string; approvalDigest?: string }): ActivateResult {
    const by = assertAuthorizedActor(opts.authorizedBy)
    return withReleaseLock(`${this.activePath}.lock`, () => {
      const active = this.readActive()
      if (active === null || !Object.hasOwn(active.packages, name)) {
        throw new ReleaseError('RELEASE_NOT_FOUND', `no active pointer for package: ${name}`)
      }
      const current = active.packages[name]
      const prev = this.findPreviousVersion(name, current)
      if (prev === null) {
        throw new ReleaseError('RELEASE_NOT_FOUND', `no previous active version to rollback for ${name}`)
      }
      const manifest = this.validateActivation(name, prev)

      const packages = { ...active.packages }
      packages[name] = prev
      const next: ActivePointer = {
        ...active,
        packages,
        updatedAt: new Date().toISOString(),
        updatedBy: by,
      }
      this.writeActive(next)
      try {
        this.appendHistory({
          at: next.updatedAt,
          action: 'rollback',
          package: { name, version: prev },
          from: current,
          to: prev,
          by,
          packageDigest: manifest.packageDigest,
          ...(opts.approvalDigest !== undefined ? { approvalDigest: opts.approvalDigest } : {}),
        })
      } catch (e) {
        // 补偿（先读后写）：history 落盘失败 → 回写原指针，不留「指针已动、无 history」半态
        this.writeActive(active)
        throw e
      }
      return {
        ok: true,
        package: { name, version: prev },
        previous: current,
        versions: next.versions,
      }
    })
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
    // 从后往前找「当前 version 最近一次成为 to」的前驱——末次匹配：同一版本多次激活/回滚时
    // 取最近一次的前驱（findIndex 首次匹配会在双回滚场景跳版激活）。
    let idx = -1
    for (let i = hist.length - 1; i >= 0; i -= 1) {
      if (hist[i].to === before) {
        idx = i
        break
      }
    }
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
    const temp = `${this.activePath}.${randomUUID()}.tmp`
    try {
      writeFileSync(temp, `${JSON.stringify(doc, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
      renameSync(temp, this.activePath)
    } finally {
      rmSync(temp, { force: true })
    }
  }

  /** 发布描述原子写（tmp+rename）：防半截文件——损坏 manifest 曾把受管闸退回 fail-open。 */
  private writeManifestFile(path: string, manifest: ReleaseManifest): void {
    mkdirSync(dirname(path), { recursive: true })
    const temp = `${path}.${randomUUID()}.tmp`
    try {
      writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
      renameSync(temp, path)
    } finally {
      rmSync(temp, { force: true })
    }
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
