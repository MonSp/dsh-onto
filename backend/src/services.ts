/**
 * Host half of the dsh-onto unified backend bundle.
 *
 * Owns every dsh-onto wire namespace in one bundle:
 * - `ontoWorkspace` — 包管理（创建/fork/签发状态机/导入导出）
 * - `ontoModel`     — O1/O2/O3 模型读写 + YAML 源文件通道
 * - `ontoValidate`  — 校验器（quality-report）
 * - `ontoDerive`    — 派生链 + 加载门禁（DERIVED_DRIFT）
 * - `ontoKnowledge` — 知识库（原料/解析/人审队列/物化）
 * - `ontoRuntime`   — 场景执行（排除→打分→叙述→三层审计→人审字段）
 *
 * Persistence: 业务本体包是文件系统一等交付物，工作区在
 * `<profileDir>/onto/workspace/packages/<name>/<version>/`；
 * 知识库队列在 `<profileDir>/onto/knowledge/`。
 *
 * `@deepseek-ai/cordis` 与 `@deepseek-ai/dsh-typert-protocol` 用 `link:`
 * 指向 harness 物理路径（与宿主共享 cordis 模块实例）。
 * @module @dsh-onto/backend
 */
import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteErrorDetailsMap } from '@deepseek-ai/dsh-typert-protocol'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  KnowledgeStore,
  PackageWorkspace,
  SOURCE_TYPES,
  buildQualityReport,
  derivePackage,
  loadPackage,
  readPackageMeta,
  runScenario,
  savePackage,
  verifyDerived,
  writeQualityReport,
  type KnowledgeSourceRecord,
  type OntologyPackage,
  type PackageMeta,
  type QualityReport,
  type RuntimeDataset,
  type ScenarioRunResult,
  type SourceType,
} from '@dsh-onto/core'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'onto/not-found': Record<string, never>
    'onto/bad-request': Record<string, never>
    'onto/conflict': Record<string, never>
    'onto/readonly': Record<string, never>
    'onto/drift': Record<string, never>
  }
}

/** Structural slice of the host profile context (avoids a dsh-profile dep). */
interface ProfileContextLike {
  readonly dir?: unknown
}

/**
 * Resolve the profile data directory (`<profileDir>/dsh-onto`).
 * Best-effort via the root provide store; fails loud when unavailable.
 */
export function resolveDataDir(ctx: Context): string {
  let profile: ProfileContextLike | undefined
  try {
    profile = ctx.root.get('profileContext') as ProfileContextLike | undefined
  } catch {
    profile = undefined
  }
  const base = profile?.dir
  if (!base || typeof base !== 'string') {
    throw new Error('profileContext.dir unavailable; cannot locate dsh-onto data directory')
  }
  return join(base, 'dsh-onto')
}

function ontoError(code: keyof RemoteErrorDetailsMap, message: string): RemoteError {
  return new RemoteError(code, message, {})
}

function toRemoteError(e: unknown): RemoteError {
  if (e instanceof RemoteError) return e
  const message = e instanceof Error ? e.message : String(e)
  const code =
    typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : ''
  if (code === 'PACKAGE_READONLY' || code === 'PACKAGE_ISSUE_REQUIRES_HUMAN') {
    return ontoError('onto/readonly', message)
  }
  if (code === 'PACKAGE_EXISTS') return ontoError('onto/conflict', message)
  if (code === 'DERIVED_DRIFT') return ontoError('onto/drift', message)
  if (/not found|NOT_FOUND/.test(code + message)) return ontoError('onto/not-found', message)
  return ontoError('onto/bad-request', message)
}

function guard<T>(fn: () => T): T {
  try {
    return fn()
  } catch (e) {
    throw toRemoteError(e)
  }
}

async function guardAsync<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    throw toRemoteError(e)
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * ontoWorkspace —— 包管理与签发状态机
 * ═══════════════════════════════════════════════════════════════════════════ */

declare module '@deepseek-ai/cordis' {
  interface Context {
    ontoWorkspace: OntoWorkspace
    ontoModel: OntoModel
    ontoValidate: OntoValidate
    ontoDerive: OntoDerive
    ontoKnowledge: OntoKnowledge
    ontoRuntime: OntoRuntime
  }
}

export class OntoWorkspace extends TypertRemoteService {
  readonly ws: PackageWorkspace

  constructor(ctx: Context) {
    super(ctx, 'ontoWorkspace')
    this.ws = new PackageWorkspace(join(resolveDataDir(ctx), 'workspace'))
  }

  @Remote('listVersions')
  async remoteExportListVersions(): Promise<Array<{ name: string; version: string; status: string; domain: string; dir: string }>> {
    return guard(() => this.ws.listVersions())
  }

  @Remote('createPackage')
  async remoteExportCreatePackage(request: { name: string; version: string; domain: string }): Promise<{ dir: string }> {
    return guard(() => {
      if (!request?.name || !request?.version || !request?.domain) {
        throw ontoError('onto/bad-request', 'name/version/domain required')
      }
      return { dir: this.ws.createPackage(request) }
    })
  }

  @Remote('forkVersion')
  async remoteExportForkVersion(request: { name: string; fromVersion: string; toVersion: string }): Promise<{ dir: string }> {
    return guard(() => {
      if (!request?.name || !request?.fromVersion || !request?.toVersion) {
        throw ontoError('onto/bad-request', 'name/fromVersion/toVersion required')
      }
      return { dir: this.ws.forkVersion(request.name, request.fromVersion, request.toVersion) }
    })
  }

  @Remote('transition')
  async remoteExportTransition(request: {
    name: string
    version: string
    to: 'DRAFT' | 'IN_REVIEW' | 'ISSUED'
    issuedBy?: string
    note?: string
  }): Promise<{ status: string }> {
    return guard(() => {
      if (!request?.name || !request?.version || !request?.to) {
        throw ontoError('onto/bad-request', 'name/version/to required')
      }
      this.ws.transition(request.name, request.version, request.to, request.issuedBy, request.note)
      return { status: request.to }
    })
  }

  @Remote('exportVersion')
  async remoteExportExportVersion(request: { name: string; version: string }): Promise<{ archive: unknown }> {
    return guard(() => ({ archive: this.ws.exportVersion(request.name, request.version) }))
  }

  @Remote('importVersion')
  async remoteExportImportVersion(request: {
    archive: { meta: PackageMeta; files: Record<string, string> }
  }): Promise<{ dir: string }> {
    return guard(() => {
      if (!request?.archive?.meta?.name) throw ontoError('onto/bad-request', 'archive required')
      return { dir: this.ws.importVersion(request.archive) }
    })
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * ontoModel —— O1/O2/O3 模型读写（建模面底层）
 * ═══════════════════════════════════════════════════════════════════════════ */

export class OntoModel extends TypertRemoteService {
  private readonly ws: PackageWorkspace

  constructor(ctx: Context) {
    super(ctx, 'ontoModel')
    this.ws = new PackageWorkspace(join(resolveDataDir(ctx), 'workspace'))
  }

  private dirOf(name: string, version: string): string {
    return this.ws.versionDir(name, version)
  }

  @Remote('load')
  async remoteExportLoad(request: { name: string; version: string }): Promise<{ pkg: OntologyPackage }> {
    return guard(() => ({ pkg: loadPackage(this.dirOf(request.name, request.version)) }))
  }

  @Remote('save')
  async remoteExportSave(request: { name: string; version: string; pkg: OntologyPackage }): Promise<{ ok: true }> {
    return guard(() => {
      savePackage(this.dirOf(request.name, request.version), request.pkg)
      return { ok: true as const }
    })
  }

  @Remote('readSources')
  async remoteExportReadSources(request: { name: string; version: string }): Promise<{ files: Record<string, string> }> {
    return guard(() => ({ files: this.ws.exportVersion(request.name, request.version).files }))
  }

  @Remote('writeSource')
  async remoteExportWriteSource(request: {
    name: string
    version: string
    relPath: string
    text: string
  }): Promise<{ ok: true }> {
    return guard(() => {
      // YAML 导入通道：写源文件前过 ISSUED 只读守卫
      const dir = this.dirOf(request.name, request.version)
      const meta = readPackageMeta(dir)
      if (meta.status === 'ISSUED') {
        throw ontoError('onto/readonly', `${meta.name}@${meta.version} is ISSUED (read-only)`)
      }
      // 防路径逃逸
      if (request.relPath.includes('..') || request.relPath.startsWith('/') || request.relPath.includes('\\')) {
        throw ontoError('onto/bad-request', 'illegal relPath')
      }
      const full = join(dir, request.relPath)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, request.text, 'utf8')
      return { ok: true as const }
    })
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * ontoValidate / ontoDerive
 * ═══════════════════════════════════════════════════════════════════════════ */

export class OntoValidate extends TypertRemoteService {
  private readonly ws: PackageWorkspace

  constructor(ctx: Context) {
    super(ctx, 'ontoValidate')
    this.ws = new PackageWorkspace(join(resolveDataDir(ctx), 'workspace'))
  }

  @Remote('validate')
  async remoteExportValidate(request: { name: string; version: string }): Promise<{ report: QualityReport }> {
    return guard(() => {
      const dir = this.ws.versionDir(request.name, request.version)
      return { report: writeQualityReport(dir) }
    })
  }

  @Remote('summary')
  async remoteExportSummary(request: { name: string; version: string }): Promise<{ report: QualityReport }> {
    return guard(() => {
      const dir = this.ws.versionDir(request.name, request.version)
      return { report: buildQualityReport(dir) }
    })
  }
}

export class OntoDerive extends TypertRemoteService {
  private readonly ws: PackageWorkspace

  constructor(ctx: Context) {
    super(ctx, 'ontoDerive')
    this.ws = new PackageWorkspace(join(resolveDataDir(ctx), 'workspace'))
  }

  @Remote('derive')
  async remoteExportDerive(request: { name: string; version: string }): Promise<{ ok: true; sources: number; derived: number; sourceDigest: string }> {
    return guard(() => {
      const dir = this.ws.versionDir(request.name, request.version)
      const manifest = derivePackage(dir)
      return {
        ok: true as const,
        sources: manifest.sources.length,
        derived: manifest.derived.length,
        sourceDigest: manifest.sourceDigest,
      }
    })
  }

  @Remote('gate')
  async remoteExportGate(request: { name: string; version: string }): Promise<
    { ok: true; manifest: unknown } | { ok: false; code: string; reason: string }
  > {
    return guard(() => {
      const dir = this.ws.versionDir(request.name, request.version)
      return verifyDerived(dir) as { ok: true; manifest: unknown } | { ok: false; code: string; reason: string }
    })
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * ontoKnowledge —— 知识库：原料 / 解析 / 人审 / 物化
 * ═══════════════════════════════════════════════════════════════════════════ */

export class OntoKnowledge extends TypertRemoteService {
  private readonly store: KnowledgeStore
  private readonly ws: PackageWorkspace

  constructor(ctx: Context) {
    super(ctx, 'ontoKnowledge')
    const dataDir = resolveDataDir(ctx)
    this.store = new KnowledgeStore(dataDir)
    this.ws = new PackageWorkspace(join(dataDir, 'workspace'))
  }

  @Remote('uploadSource')
  async remoteExportUploadSource(request: {
    packageId: string
    sourceType: SourceType
    name: string
    content: string
  }): Promise<{ source: KnowledgeSourceRecord }> {
    return guard(() => ({ source: this.store.uploadSource(request) }))
  }

  @Remote('uploadSources')
  async remoteExportUploadSources(request: {
    packageId: string
    items: Array<{ sourceType: SourceType; name: string; content: string }>
  }): Promise<{ sources: KnowledgeSourceRecord[]; skipped: number; invalid: number }> {
    return guard(() => {
      if (!request?.packageId || !Array.isArray(request?.items) || request.items.length === 0) {
        throw ontoError('onto/bad-request', 'packageId and non-empty items required')
      }
      const sources: KnowledgeSourceRecord[] = []
      let skipped = 0 // sha256 幂等跳过
      let invalid = 0 // 形状非法（缺 name/content 或未知 sourceType）
      let attempted = 0
      for (const item of request.items) {
        if (!item?.name || !item?.content || !SOURCE_TYPES.includes(item.sourceType)) {
          invalid++
          continue
        }
        attempted++
        const before = this.store.listSources(request.packageId).length
        const rec = this.store.uploadSource({
          packageId: request.packageId,
          sourceType: item.sourceType,
          name: item.name,
          content: item.content,
        })
        // sha256 幂等：未新增则只计 skipped，不进 sources（避免接受/跳过双计）
        if (this.store.listSources(request.packageId).length === before) {
          skipped++
          continue
        }
        sources.push(rec)
      }
      if (attempted === 0) throw ontoError('onto/bad-request', 'no valid items')
      return { sources, skipped, invalid }
    })
  }

  @Remote('parseSource')
  async remoteExportParseSource(request: { sourceId: string; useApi?: boolean }): Promise<{
    added: unknown[]
    engine: 'deepseek' | 'heuristic'
    report: {
      received: number
      accepted: number
      idempotentSkipped: number
      invalidDropped: number
      engine: 'deepseek' | 'heuristic'
    }
  }> {
    return guardAsync(async () => {
      const { HeuristicLlm, DeepSeekLlm } = await import('@dsh-onto/core')
      const llm = request.useApi ? new DeepSeekLlm() : new HeuristicLlm()
      const { added, engine, report } = await this.store.parseSource(request.sourceId, llm)
      return { added, engine, report }
    })
  }

  @Remote('listSources')
  async remoteExportListSources(request: { packageId?: string }): Promise<{ sources: KnowledgeSourceRecord[] }> {
    return guard(() => ({ sources: this.store.listSources(request?.packageId) }))
  }

  @Remote('listCandidates')
  async remoteExportListCandidates(request?: { packageId?: string; status?: string }): Promise<{ items: unknown[] }> {
    return guard(() => ({
      items: this.store.listCandidates({
        packageId: request?.packageId,
        status: request?.status as never,
      }),
    }))
  }

  @Remote('updateCandidate')
  async remoteExportUpdateCandidate(request: {
    id: string
    patch: { name?: string; payload?: Record<string, unknown>; rationale?: string; confidence?: number }
  }): Promise<{ candidate: unknown }> {
    return guard(() => {
      if (!request?.id || !request?.patch) throw ontoError('onto/bad-request', 'id and patch required')
      return { candidate: this.store.updateCandidate(request.id, request.patch) }
    })
  }

  @Remote('reviewCandidate')
  async remoteExportReviewCandidate(request: {
    id: string
    action: 'approve' | 'reject' | 'merge'
    mergeIntoName?: string
  }): Promise<{ candidate: unknown }> {
    return guard(() => ({
      candidate: this.store.reviewCandidate(request.id, request.action, { mergeIntoName: request.mergeIntoName }),
    }))
  }

  @Remote('previewMaterialize')
  async remoteExportPreviewMaterialize(request: { name: string; version: string; ids: string[] }): Promise<{
    previews: Array<{
      id: string
      ok: boolean
      error?: string
      targetKind: string
      name: string
      element?: unknown
      summary: string
    }>
  }> {
    return guard(() => {
      if (!request?.name || !request?.version || !Array.isArray(request?.ids)) {
        throw ontoError('onto/bad-request', 'name/version/ids required')
      }
      return { previews: this.store.previewMaterialize(this.ws.versionDir(request.name, request.version), request.ids) }
    })
  }

  @Remote('materialize')
  async remoteExportMaterialize(request: { name: string; version: string; ids: string[] }): Promise<{
    applied: string[]
    skipped: Array<{ id: string; reason: string }>
  }> {
    return guard(() =>
      this.store.materialize(this.ws.versionDir(request.name, request.version), request.ids ?? []),
    )
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * ontoRuntime —— 场景执行
 * ═══════════════════════════════════════════════════════════════════════════ */

export class OntoRuntime extends TypertRemoteService {
  private readonly ws: PackageWorkspace

  constructor(ctx: Context) {
    super(ctx, 'ontoRuntime')
    this.ws = new PackageWorkspace(join(resolveDataDir(ctx), 'workspace'))
  }

  @Remote('listScenarios')
  async remoteExportListScenarios(request: { name: string; version: string }): Promise<{
    scenarios: Array<{ id: string; name: string; goal: string; boundary: string }>
  }> {
    return guard(() => {
      const pkg = loadPackage(this.ws.versionDir(request.name, request.version))
      return {
        scenarios: pkg.scenarios.map((s) => ({ id: s.id, name: s.name, goal: s.goal, boundary: s.boundary })),
      }
    })
  }

  @Remote('runScenario')
  async remoteExportRunScenario(request: {
    name: string
    version: string
    scenarioId: string
    dataset: RuntimeDataset
  }): Promise<{ result: ScenarioRunResult }> {
    return guard(() => {
      const dir = this.ws.versionDir(request.name, request.version)
      return { result: runScenario(dir, request.scenarioId, request.dataset) }
    })
  }
}
