/**
 * M4 发布描述（Release Manifest）与受控导入校验纯函数（spec S2.6）。
 *
 * - 发布描述是**独立外层**文档，不写入 ISSUED 包源文件；
 * - 导入者不能代替签发人；锚点失败只拒绝，不自动重派生修漂移；
 * - 本模块零 harness / backend 依赖，可单测。
 * @module @dsh-onto/runtime/release
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  DERIVED_FILES,
  isSafeRelPath,
  loadPackage,
  readManifest,
  readPackageMeta,
  sha256Text,
  validatePackageDir,
  verifyDerived,
  type DerivedManifest,
} from '@dsh-onto/core'

/* ═══════════════════════════════════════════════════════════════════════════
 * 类型与常量
 * ═══════════════════════════════════════════════════════════════════════════ */

export const RELEASE_FORMAT = 'dsh-onto-release/1' as const
export const RELEASE_BUNDLE_FORMAT = 'dsh-onto-release-bundle/1' as const
export const RELEASE_ACTIVE_FORMAT = 'dsh-onto-release-active/1' as const
export const RELEASE_MANIFEST_KIND = 'OntologyReleaseManifest' as const

/** 拒绝码（P1–P5 与导入围栏；与 AgentToolError.code 兼容的字符串字面量）。 */
export type ReleaseErrorCode =
  | 'RELEASE_MALFORMED'
  | 'RELEASE_UNSUPPORTED_FORMAT'
  | 'RELEASE_INCOMPATIBLE'
  | 'RELEASE_UNSAFE_PATH'
  | 'RELEASE_TOO_LARGE'
  | 'RELEASE_TOO_MANY_ENTRIES'
  | 'RELEASE_DUPLICATE_ENTRY'
  | 'RELEASE_SYMLINK'
  | 'RELEASE_NOT_ISSUED'
  | 'RELEASE_ANCHOR_MISMATCH'
  | 'RELEASE_MISSING_DEP'
  | 'RELEASE_CAPABILITY_MISMATCH'
  | 'RELEASE_CONFLICT'
  | 'RELEASE_NOT_FOUND'
  | 'RELEASE_UNAUTHORIZED'
  | 'RELEASE_SOURCE_REJECTED'
  | 'RELEASE_VERSION_NOT_ACTIVE'
  | 'RELEASE_NOT_ACTIVE'
  | 'DERIVED_DRIFT'

export class ReleaseError extends Error {
  readonly code: ReleaseErrorCode
  constructor(code: ReleaseErrorCode, message: string) {
    super(message)
    this.name = 'ReleaseError'
    this.code = code
  }
}

export interface ReleaseVersionRange {
  /** 下界（含），semver 式 `x.y.z`。 */
  min: string
  /** 上界（含），缺省无上界。 */
  max?: string
}

export interface ReleaseIssueRef {
  issuedAt: string
  issuedBy: string
  /** 与包内 issueRecord 末条 manifestDigest 一致（库外锚点）。 */
  manifestDigest: string
}

export interface ReleaseManifest {
  kind: typeof RELEASE_MANIFEST_KIND
  format: typeof RELEASE_FORMAT
  package: { name: string; version: string }
  domain: string
  coreCompat: ReleaseVersionRange
  runtimeCompat: ReleaseVersionRange
  /** 全包（源+派生）按 path 排序的 `path:sha256` 聚合摘要——幂等/冲突判据。 */
  packageDigest: string
  /** 与 derived/manifest.yaml 的 sourceDigest 一致。 */
  sourceDigest: string
  /** sha256(derived/manifest.yaml 文本)。 */
  manifestDigest: string
  issue: ReleaseIssueRef
  scenarios: string[]
  actions: string[]
  requiredConnectorCapabilities: string[]
  /** 依赖包（须已存在且 ISSUED）；不含自身。 */
  dependencies: Array<{ name: string; version: string }>
  releasedAt: string
  /** 发布方（部署身份）；**不得**被解释为签发人。 */
  releasedBy: string
}

export interface ReleaseBundleFile {
  path: string
  content: string
}

export interface ReleaseBundle {
  format: typeof RELEASE_BUNDLE_FORMAT
  manifest: ReleaseManifest
  files: ReleaseBundleFile[]
}

export interface StagingLimits {
  maxEntries: number
  maxFileBytes: number
  maxTotalBytes: number
}

export const DEFAULT_STAGING_LIMITS: StagingLimits = {
  maxEntries: 500,
  maxFileBytes: 5 * 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
}

/** 受控来源：仅部署配置根目录下的相对路径，或进程内受控上传 bundle。 */
export type ReleaseImportSource =
  | { kind: 'controlled-upload'; bundle: ReleaseBundle }
  | { kind: 'deployment-config'; root: string; relPath: string }

export interface CurrentRuntimeVersions {
  core: string
  runtime: string
  plugin?: string
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 摘要与兼容（纯函数）
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * 全包内容摘要：按 path 字典序拼 `path\ncontent\n` 后 sha256。
 * 与文件顺序无关；同内容同摘要。
 */
export function computePackageDigest(files: ReadonlyArray<{ path: string; content: string }>): string {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const body = sorted.map((f) => `${f.path}\n${f.content}\n`).join('')
  return sha256Text(body)
}

/** semver 式数字段比较；非数字段回退字典序（与 agent-skills compareVersions 同族）。 */
function compareSemver(a: string, b: string): number {
  const pa = a.split('.')
  const pb = b.split('.')
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] ?? '0'
    const y = pb[i] ?? '0'
    if (x === y) continue
    const nx = /^\d+$/.test(x) ? Number.parseInt(x, 10) : Number.NaN
    const ny = /^\d+$/.test(y) ? Number.parseInt(y, 10) : Number.NaN
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) return nx - ny
    if (!Number.isNaN(nx)) return -1
    if (!Number.isNaN(ny)) return 1
    return x < y ? -1 : 1
  }
  return 0
}

export function inRange(version: string, range: ReleaseVersionRange): boolean {
  if (compareSemver(version, range.min) < 0) return false
  if (range.max !== undefined && compareSemver(version, range.max) > 0) return false
  return true
}

export function checkCompat(
  manifest: ReleaseManifest,
  current: CurrentRuntimeVersions,
): { ok: true } | { ok: false; code: 'RELEASE_INCOMPATIBLE'; reason: string } {
  if (!inRange(current.core, manifest.coreCompat)) {
    return {
      ok: false,
      code: 'RELEASE_INCOMPATIBLE',
      reason: `core ${current.core} not in [${manifest.coreCompat.min}, ${manifest.coreCompat.max ?? '*'}]`,
    }
  }
  if (!inRange(current.runtime, manifest.runtimeCompat)) {
    return {
      ok: false,
      code: 'RELEASE_INCOMPATIBLE',
      reason: `runtime ${current.runtime} not in [${manifest.runtimeCompat.min}, ${manifest.runtimeCompat.max ?? '*'}]`,
    }
  }
  return { ok: true }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 结构校验
 * ═══════════════════════════════════════════════════════════════════════════ */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function requireString(v: unknown, field: string): string {
  if (typeof v !== 'string' || v === '') {
    throw new ReleaseError('RELEASE_MALFORMED', `manifest.${field} must be non-empty string`)
  }
  return v
}

function parseRange(v: unknown, field: string): ReleaseVersionRange {
  if (!isRecord(v)) throw new ReleaseError('RELEASE_MALFORMED', `manifest.${field} must be object`)
  const min = requireString(v.min, `${field}.min`)
  if (v.max !== undefined && v.max !== null) {
    if (typeof v.max !== 'string' || v.max === '') {
      throw new ReleaseError('RELEASE_MALFORMED', `manifest.${field}.max must be non-empty string`)
    }
    return { min, max: v.max }
  }
  return { min }
}

function parseStringArray(v: unknown, field: string): string[] {
  if (!Array.isArray(v)) throw new ReleaseError('RELEASE_MALFORMED', `manifest.${field} must be array`)
  return v.map((x, i) => {
    if (typeof x !== 'string' || x === '') {
      throw new ReleaseError('RELEASE_MALFORMED', `manifest.${field}[${i}] must be non-empty string`)
    }
    return x
  })
}

function parseDependencies(v: unknown): Array<{ name: string; version: string }> {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) throw new ReleaseError('RELEASE_MALFORMED', 'manifest.dependencies must be array')
  return v.map((d, i) => {
    if (!isRecord(d)) throw new ReleaseError('RELEASE_MALFORMED', `manifest.dependencies[${i}] must be object`)
    return {
      name: requireString(d.name, `dependencies[${i}].name`),
      version: requireString(d.version, `dependencies[${i}].version`),
    }
  })
}

/** 解析并做结构级校验；格式不符 → RELEASE_MALFORMED / RELEASE_UNSUPPORTED_FORMAT。 */
export function parseReleaseManifest(doc: unknown): ReleaseManifest {
  if (!isRecord(doc)) throw new ReleaseError('RELEASE_MALFORMED', 'manifest must be object')
  if (doc.kind !== RELEASE_MANIFEST_KIND) {
    throw new ReleaseError('RELEASE_MALFORMED', `unknown kind: ${String(doc.kind)}`)
  }
  if (doc.format !== RELEASE_FORMAT) {
    throw new ReleaseError('RELEASE_UNSUPPORTED_FORMAT', `unsupported format: ${String(doc.format)}`)
  }
  if (!isRecord(doc.package)) throw new ReleaseError('RELEASE_MALFORMED', 'manifest.package must be object')
  const name = requireString(doc.package.name, 'package.name')
  const version = requireString(doc.package.version, 'package.version')
  if (!isRecord(doc.issue)) throw new ReleaseError('RELEASE_MALFORMED', 'manifest.issue must be object')
  const issue: ReleaseIssueRef = {
    issuedAt: requireString(doc.issue.issuedAt, 'issue.issuedAt'),
    issuedBy: requireString(doc.issue.issuedBy, 'issue.issuedBy'),
    manifestDigest: requireString(doc.issue.manifestDigest, 'issue.manifestDigest'),
  }
  if (!isRecord(doc.releasedAt) && typeof doc.releasedAt !== 'string') {
    throw new ReleaseError('RELEASE_MALFORMED', 'manifest.releasedAt must be string')
  }
  return {
    kind: RELEASE_MANIFEST_KIND,
    format: RELEASE_FORMAT,
    package: { name, version },
    domain: requireString(doc.domain, 'domain'),
    coreCompat: parseRange(doc.coreCompat, 'coreCompat'),
    runtimeCompat: parseRange(doc.runtimeCompat, 'runtimeCompat'),
    packageDigest: requireString(doc.packageDigest, 'packageDigest'),
    sourceDigest: requireString(doc.sourceDigest, 'sourceDigest'),
    manifestDigest: requireString(doc.manifestDigest, 'manifestDigest'),
    issue,
    scenarios: parseStringArray(doc.scenarios, 'scenarios'),
    actions: parseStringArray(doc.actions ?? [], 'actions'),
    requiredConnectorCapabilities: parseStringArray(doc.requiredConnectorCapabilities ?? [], 'requiredConnectorCapabilities'),
    dependencies: parseDependencies(doc.dependencies),
    releasedAt: requireString(doc.releasedAt, 'releasedAt'),
    releasedBy: requireString(doc.releasedBy, 'releasedBy'),
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 暂存围栏（先校验后落盘）
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * 校验受控载荷文件列表：路径围栏、重复条目、规模上限、符号链接标记。
 * 任一失败整体拒绝（调用方不得半写）。
 */
export function stageValidateFiles(
  files: ReadonlyArray<{ path: string; content: string }>,
  limits: StagingLimits = DEFAULT_STAGING_LIMITS,
): void {
  if (!Array.isArray(files)) {
    throw new ReleaseError('RELEASE_MALFORMED', 'files must be array of {path,content}')
  }
  if (files.length > limits.maxEntries) {
    throw new ReleaseError('RELEASE_TOO_MANY_ENTRIES', `entries ${files.length} > ${limits.maxEntries}`)
  }
  const seen = new Set<string>()
  let total = 0
  for (const f of files) {
    if (typeof f !== 'object' || f === null) {
      throw new ReleaseError('RELEASE_MALFORMED', 'file entry must be object')
    }
    const path = (f as { path?: unknown }).path
    const content = (f as { content?: unknown }).content
    if (typeof path !== 'string' || typeof content !== 'string') {
      throw new ReleaseError('RELEASE_MALFORMED', 'file.path and file.content must be strings')
    }
    // 符号链接/链接型标记：载荷为纯文本，path 前缀或 link 字段均拒
    if (path.startsWith('symlink:') || (f as { link?: unknown }).link !== undefined) {
      throw new ReleaseError('RELEASE_SYMLINK', `symlink entries rejected: ${path}`)
    }
    if (!isSafeRelPath(path)) {
      throw new ReleaseError('RELEASE_UNSAFE_PATH', `invalid archive path: ${path}`)
    }
    if (seen.has(path)) {
      throw new ReleaseError('RELEASE_DUPLICATE_ENTRY', `duplicate entry: ${path}`)
    }
    seen.add(path)
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > limits.maxFileBytes) {
      throw new ReleaseError('RELEASE_TOO_LARGE', `file ${path} size ${bytes} > ${limits.maxFileBytes}`)
    }
    total += bytes
    if (total > limits.maxTotalBytes) {
      throw new ReleaseError('RELEASE_TOO_LARGE', `total size ${total} > ${limits.maxTotalBytes}`)
    }
  }
}

/**
 * 部署配置来源：root 必须是允许根之一（词法前缀），relPath 安全且落在 root 内。
 * 拒绝绝对路径透传与 `..` 穿越（RELEASE_SOURCE_REJECTED / RELEASE_UNSAFE_PATH）。
 */
export function assertDeploymentConfigSource(
  source: { root: string; relPath: string },
  allowedRoots: readonly string[],
): string {
  if (allowedRoots.length === 0) {
    throw new ReleaseError('RELEASE_SOURCE_REJECTED', 'no deployment-config roots allowed')
  }
  if (typeof source.relPath !== 'string' || source.relPath === '') {
    throw new ReleaseError('RELEASE_SOURCE_REJECTED', 'relPath required')
  }
  if (!isSafeRelPath(source.relPath)) {
    throw new ReleaseError('RELEASE_UNSAFE_PATH', `invalid relPath: ${source.relPath}`)
  }
  const rootAllowed = allowedRoots.find((r) => {
    const norm = r.replace(/[\\/]+$/, '')
    const rootNorm = source.root.replace(/[\\/]+$/, '')
    return rootNorm === norm || rootNorm.startsWith(norm + '/')
  })
  if (rootAllowed === undefined) {
    throw new ReleaseError('RELEASE_SOURCE_REJECTED', 'root not in allowed deployment-config roots')
  }
  return join(source.root, source.relPath)
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 从磁盘包构建 / 校验发布锚点
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 递归收集版本目录下全部文本文件（相对 path）。不跟随符号链接。 */
export function collectPackageFiles(versionDir: string, base = versionDir): Array<{ path: string; content: string }> {
  const out: Array<{ path: string; content: string }> = []
  const walk = (dir: string): void => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      const full = join(dir, name)
      let st: ReturnType<typeof statSync>
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) {
        throw new ReleaseError('RELEASE_SYMLINK', `symlink in package tree: ${name}`)
      }
      if (st.isDirectory()) {
        walk(full)
        continue
      }
      if (!st.isFile()) continue
      const rel = full.slice(base.length + 1).replace(/\\/g, '/')
      out.push({ path: rel, content: readFileSync(full, 'utf8') })
    }
  }
  walk(versionDir)
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return out
}

/**
 * 从已签发+已派生的版本目录构建发布 Manifest。
 * **不**写回包内；仅返回外层描述。签发记录必须已含当前版本条目。
 */
export function buildReleaseManifest(versionDir: string, opts: {
  coreCompat: ReleaseVersionRange
  runtimeCompat: ReleaseVersionRange
  releasedBy: string
  releasedAt?: string
  dependencies?: Array<{ name: string; version: string }>
  requiredConnectorCapabilities?: string[]
  current?: CurrentRuntimeVersions
}): ReleaseManifest {
  const meta = readPackageMeta(versionDir)
  if (meta.status !== 'ISSUED') {
    throw new ReleaseError('RELEASE_NOT_ISSUED', `${meta.name}@${meta.version} is ${meta.status}, not ISSUED`)
  }
  const manifestPath = join(versionDir, DERIVED_FILES.manifest)
  if (!existsSync(manifestPath)) {
    throw new ReleaseError('DERIVED_DRIFT', 'missing derived/manifest.yaml (never derived)')
  }
  const manifestText = readFileSync(manifestPath, 'utf8')
  const derived = readManifest(versionDir)
  if (derived === null) {
    throw new ReleaseError('DERIVED_DRIFT', 'derived manifest unreadable')
  }
  const last = meta.issueRecord[meta.issueRecord.length - 1]
  if (!last || last.version !== meta.version || !last.manifestDigest) {
    throw new ReleaseError('RELEASE_NOT_ISSUED', 'issueRecord missing manifestDigest anchor for current version')
  }
  const files = collectPackageFiles(versionDir)
  const pkg = loadPackage(versionDir)
  const gate = verifyDerived(versionDir)
  if (!gate.ok) {
    throw new ReleaseError('DERIVED_DRIFT', gate.reason)
  }
  const actions: string[] = []
  for (const b of pkg.behaviors) {
    const c = (b as { actionContract?: { id?: string } }).actionContract
    if (c && typeof c.id === 'string') actions.push(c.id)
  }
  return {
    kind: RELEASE_MANIFEST_KIND,
    format: RELEASE_FORMAT,
    package: { name: meta.name, version: meta.version },
    domain: meta.domain,
    coreCompat: opts.coreCompat,
    runtimeCompat: opts.runtimeCompat,
    packageDigest: computePackageDigest(files),
    sourceDigest: derived.sourceDigest,
    manifestDigest: sha256Text(manifestText),
    issue: {
      issuedAt: last.issuedAt,
      issuedBy: last.issuedBy,
      manifestDigest: last.manifestDigest,
    },
    scenarios: pkg.scenarios.map((s) => s.id),
    actions: [...new Set(actions)].sort(),
    requiredConnectorCapabilities: [...(opts.requiredConnectorCapabilities ?? [])].sort(),
    dependencies: [...(opts.dependencies ?? [])].sort((a, b) =>
      a.name === b.name ? compareSemver(a.version, b.version) : a.name < b.name ? -1 : 1,
    ),
    releasedAt: opts.releasedAt ?? new Date().toISOString(),
    releasedBy: opts.releasedBy,
  }
}

/** 由版本目录 + Manifest 组装受控上传 bundle。 */
export function buildReleaseBundle(versionDir: string, manifest: ReleaseManifest): ReleaseBundle {
  const files = collectPackageFiles(versionDir)
  return { format: RELEASE_BUNDLE_FORMAT, manifest, files }
}

/**
 * 校验 Manifest 与磁盘包内容的锚点链（P1 篡改面）：
 * packageDigest → ISSUED/issue → sourceDigest/manifestDigest → verifyDerived → 引用闭合。
 * 失败抛 ReleaseError；**不**调用 derivePackage 修复。
 */
export function verifyReleaseAgainstPackage(
  manifest: ReleaseManifest,
  versionDir: string,
  opts: { files?: ReadonlyArray<{ path: string; content: string }> } = {},
): void {
  if (!existsSync(join(versionDir, 'package.yaml'))) {
    throw new ReleaseError('RELEASE_NOT_FOUND', 'package.yaml missing')
  }
  const files = opts.files ?? collectPackageFiles(versionDir)
  const actualDigest = computePackageDigest(files)
  if (actualDigest !== manifest.packageDigest) {
    throw new ReleaseError('RELEASE_ANCHOR_MISMATCH', 'packageDigest mismatch')
  }

  const meta = readPackageMeta(versionDir)
  if (meta.name !== manifest.package.name || meta.version !== manifest.package.version) {
    throw new ReleaseError('RELEASE_ANCHOR_MISMATCH', 'package identity mismatch')
  }
  if (meta.status !== 'ISSUED') {
    throw new ReleaseError('RELEASE_NOT_ISSUED', `${meta.name}@${meta.version} status=${meta.status}`)
  }
  const last = meta.issueRecord[meta.issueRecord.length - 1]
  if (
    !last
    || last.version !== meta.version
    || last.issuedAt !== manifest.issue.issuedAt
    || last.issuedBy !== manifest.issue.issuedBy
    || last.manifestDigest !== manifest.issue.manifestDigest
  ) {
    throw new ReleaseError('RELEASE_NOT_ISSUED', 'issue record does not match manifest.issue')
  }

  const derived = readManifest(versionDir)
  if (derived === null) {
    throw new ReleaseError('DERIVED_DRIFT', 'missing manifest (never derived)')
  }
  if (derived.sourceDigest !== manifest.sourceDigest) {
    throw new ReleaseError('RELEASE_ANCHOR_MISMATCH', 'sourceDigest mismatch')
  }
  const manifestText = readFileSync(join(versionDir, DERIVED_FILES.manifest), 'utf8')
  const manifestSha = sha256Text(manifestText)
  if (manifestSha !== manifest.manifestDigest) {
    throw new ReleaseError('RELEASE_ANCHOR_MISMATCH', 'manifestDigest mismatch')
  }
  if (manifest.issue.manifestDigest !== manifest.manifestDigest) {
    throw new ReleaseError('RELEASE_ANCHOR_MISMATCH', 'issue.manifestDigest != manifest.manifestDigest')
  }

  const gate = verifyDerived(versionDir)
  if (!gate.ok) {
    throw new ReleaseError('DERIVED_DRIFT', gate.reason)
  }

  const { errors } = validatePackageDir(versionDir)
  if (errors.length > 0) {
    throw new ReleaseError('RELEASE_MALFORMED', `validation errors: ${errors.map((e) => e.code).join(',')}`)
  }

  // Manifest 自报清单与包内容一致
  const scenarioIds = new Set(loadPackage(versionDir).scenarios.map((s) => s.id))
  for (const id of manifest.scenarios) {
    if (!scenarioIds.has(id)) {
      throw new ReleaseError('RELEASE_ANCHOR_MISMATCH', `scenario not in package: ${id}`)
    }
  }
}

/** 依赖包：须存在且 ISSUED（在给定解析器下）。 */
export function assertDependenciesIssued(
  deps: ReadonlyArray<{ name: string; version: string }>,
  resolve: (name: string, version: string) => string | null,
): void {
  for (const dep of deps) {
    const dir = resolve(dep.name, dep.version)
    if (dir === null || !existsSync(join(dir, 'package.yaml'))) {
      throw new ReleaseError('RELEASE_MISSING_DEP', `dependency missing: ${dep.name}@${dep.version}`)
    }
    try {
      const meta = readPackageMeta(dir)
      if (meta.status !== 'ISSUED') {
        throw new ReleaseError('RELEASE_MISSING_DEP', `dependency not ISSUED: ${dep.name}@${dep.version}`)
      }
    } catch (e) {
      if (e instanceof ReleaseError) throw e
      throw new ReleaseError('RELEASE_MISSING_DEP', `dependency unreadable: ${dep.name}@${dep.version}`)
    }
  }
}

/** 连接器能力：required ⊆ available（dryrun 恒可用）。 */
export function assertConnectorCapabilities(
  required: readonly string[],
  available: readonly string[],
): void {
  const set = new Set(['dryrun', ...available])
  for (const cap of required) {
    if (!set.has(cap)) {
      throw new ReleaseError('RELEASE_CAPABILITY_MISMATCH', `missing connector capability: ${cap}`)
    }
  }
}

/** 激活/回滚操作者：非空且不得是 agent/llm（与签发同族拒绝口径）。 */
export function assertAuthorizedActor(authorizedBy: unknown): string {
  if (typeof authorizedBy !== 'string' || authorizedBy.trim() === '') {
    throw new ReleaseError('RELEASE_UNAUTHORIZED', 'authorizedBy required (human/deployment operator)')
  }
  const t = authorizedBy.trim()
  if (/^(agent|llm|ai|bot|system)$/i.test(t)) {
    throw new ReleaseError('RELEASE_UNAUTHORIZED', 'agent/LLM may not authorize release activation')
  }
  return t
}

export type { DerivedManifest }
