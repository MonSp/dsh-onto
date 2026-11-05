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
  buildRunRecord,
  compareRunRecords,
  derivePackage,
  exportRunArchive,
  isInsideDir,
  isSafeRelPath,
  loadPackage,
  loadRunRecord,
  listRunRecords,
  readPackageMeta,
  runScenario,
  savePackage,
  saveRunRecord,
  verifyDerived,
  writeQualityReport,
  type KnowledgeSourceRecord,
  type DraftCandidate,
  type DraftItem,
  type ModelGraph,
  type OntologyPackage,
  type PackageMeta,
  type QualityReport,
  type RunDiff,
  type RunRecord,
  type RuntimeDataset,
  type ScenarioRunResult,
  type SkeletonRecord,
  type SourceType,
} from '@dsh-onto/core'
import { invalidateSkillCatalog } from './agent-hooks.js'
import { buildGraphForTool } from './model-face.js'

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
      const dir = this.ws.createPackage(request)
      invalidateSkillCatalog()
      return { dir }
    })
  }

  @Remote('forkVersion')
  async remoteExportForkVersion(request: { name: string; fromVersion: string; toVersion: string }): Promise<{ dir: string }> {
    return guard(() => {
      if (!request?.name || !request?.fromVersion || !request?.toVersion) {
        throw ontoError('onto/bad-request', 'name/fromVersion/toVersion required')
      }
      const dir = this.ws.forkVersion(request.name, request.fromVersion, request.toVersion)
      invalidateSkillCatalog()
      return { dir }
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
      invalidateSkillCatalog()
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
      const dir = this.ws.importVersion(request.archive)
      invalidateSkillCatalog()
      return { dir }
    })
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * ontoModel —— O1/O2/O3 模型读写（建模面底层）
 * ═══════════════════════════════════════════════════════════════════════════ */

export class OntoModel extends TypertRemoteService {
  private readonly ws: PackageWorkspace
  private readonly knowledge: KnowledgeStore

  constructor(ctx: Context) {
    super(ctx, 'ontoModel')
    const dataDir = resolveDataDir(ctx)
    this.ws = new PackageWorkspace(join(dataDir, 'workspace'))
    this.knowledge = new KnowledgeStore(dataDir)
  }

  private dirOf(name: string, version: string): string {
    return this.ws.versionDir(name, version)
  }

  @Remote('load')
  async remoteExportLoad(request: { name: string; version: string }): Promise<{ pkg: OntologyPackage }> {
    return guard(() => ({ pkg: loadPackage(this.dirOf(request.name, request.version)) }))
  }

  /** 画布数据源（conversational-modeling P1）：节点/边/issues/骨架 + revision 刷新信号。 */
  @Remote('getGraph')
  async remoteExportGetGraph(request: { name: string; version: string }): Promise<{ graph: ModelGraph }> {
    return guard(() => ({
      graph: buildGraphForTool({
        ws: this.ws,
        knowledge: this.knowledge,
        name: request.name,
        version: request.version,
      }),
    }))
  }

  @Remote('save')
  async remoteExportSave(request: { name: string; version: string; pkg: OntologyPackage }): Promise<{ ok: true }> {
    return guard(() => {
      savePackage(this.dirOf(request.name, request.version), request.pkg)
      invalidateSkillCatalog()
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
      // 防路径逃逸：与 importVersion 同一口径（isSafeRelPath：绝对/ADS 冒号/多级下钻拒绝）
      // ——round-13 复审：原实现只拦 `..`/前导 `/`/反斜杠，冒号可落 NTFS ADS 隐藏流。
      const full = join(dir, request.relPath)
      if (!isSafeRelPath(request.relPath) || !isInsideDir(dir, full)) {
        throw ontoError('onto/bad-request', 'illegal relPath')
      }
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, request.text, 'utf8')
      invalidateSkillCatalog()
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

  /** 对话/画布直起草（conversational-modeling P3）：只入草案队列，永不直写包（I1）。 */
  @Remote('addDraft')
  async remoteExportAddDraft(request: {
    name: string
    version: string
    item: DraftItem
    turnId?: string
  }): Promise<{ candidate: DraftCandidate }> {
    return guard(() => {
      if (!request?.name || !request?.version || !request?.item) {
        throw ontoError('onto/bad-request', 'name/version/item required')
      }
      const dir = this.ws.versionDir(request.name, request.version)
      const meta = readPackageMeta(dir)
      if (meta.status === 'ISSUED') {
        throw ontoError('onto/readonly', `${meta.name}@${meta.version} is ISSUED (fork before drafting)`)
      }
      return {
        candidate: this.store.addDraft({
          packageId: meta.name,
          item: request.item,
          provenance: { turnId: request.turnId },
        }),
      }
    })
  }

  /** 对话开局骨架（P3/I6）：domainCode + 全量 ID 清单 + 确认态；骨架门在物化前置。 */
  @Remote('saveSkeleton')
  async remoteExportSaveSkeleton(request: {
    name: string
    version: string
    domainCode: string
    confirmed: boolean
    ids: string[]
  }): Promise<{ skeleton: SkeletonRecord }> {
    return guard(() => {
      if (!request?.name || !request?.version || !Array.isArray(request?.ids)) {
        throw ontoError('onto/bad-request', 'name/version/ids required')
      }
      const dir = this.ws.versionDir(request.name, request.version)
      const meta = readPackageMeta(dir)
      if (meta.status === 'ISSUED') {
        throw ontoError('onto/readonly', `${meta.name}@${meta.version} is ISSUED (read-only)`)
      }
      return {
        skeleton: this.store.skeletons.save({
          packageId: meta.name,
          domainCode: request.domainCode,
          confirmed: request.confirmed,
          ids: request.ids,
        }),
      }
    })
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
    return guard(() => {
      const out = this.store.materialize(this.ws.versionDir(request.name, request.version), request.ids ?? [])
      invalidateSkillCatalog()
      return out
    })
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
      const result = runScenario(dir, request.scenarioId, request.dataset)
      // 运行留痕（run-insight S2.1）：人审面完整结果 + 双源红线落盘（wire 不脱敏，落盘面供跨进程遮蔽）。
      const meta = readPackageMeta(dir)
      const scenario = loadPackage(dir).scenarios.find((s) => s.id === request.scenarioId)
      const redlines = [
        ...new Set(
          [
            ...result.audit.forbiddenPhraseHits.map((h) => h.phrase),
            ...(scenario?.outputContract.forbiddenPhrases ?? []),
          ].filter((p) => typeof p === 'string' && p !== ''),
        ),
      ]
      saveRunRecord(
        this.ws.root,
        buildRunRecord({
          package: { name: meta.name, version: meta.version },
          dataset: request.dataset,
          result,
          redlines,
        }),
      )
      return { result }
    })
  }

  /** 运行历史（run-insight S2.5）：时间倒序摘要。wire 人审面。 */
  @Remote('listRuns')
  async remoteExportListRuns(): Promise<{
    runs: Array<{
      runId: string
      scenarioId: string
      package: { name: string; version: string }
      datasetDigest: string
      datasetSummary: RunRecord['datasetSummary']
      auditPassed: boolean
      startedAt: string
      savedAt: string
    }>
  }> {
    return guard(() => ({
      runs: listRunRecords(this.ws.root).map((r) => ({
        runId: r.runId,
        scenarioId: r.scenarioId,
        package: r.package,
        datasetDigest: r.datasetDigest.slice(0, 12),
        datasetSummary: r.datasetSummary,
        auditPassed: r.result.audit.passed === true,
        startedAt: r.startedAt,
        savedAt: r.savedAt,
      })),
    }))
  }

  /** 单轮运行全量（人审面：完整短语与证据链，供复核定位）。 */
  @Remote('showRun')
  async remoteExportShowRun(request: { runId: string }): Promise<{ record: RunRecord }> {
    return guard(() => ({ record: loadRunRecord(this.ws.root, request.runId) }))
  }

  /** 两轮对比（人审面完整；工具面同语义经 compare_runs 投影）。 */
  @Remote('compareRuns')
  async remoteExportCompareRuns(request: {
    runIdA: string
    runIdB: string
  }): Promise<{ diff: RunDiff }> {
    return guard(() => {
      const a = loadRunRecord(this.ws.root, request.runIdA)
      const b = loadRunRecord(this.ws.root, request.runIdB)
      return { diff: compareRunRecords(a, b) }
    })
  }

  /** 审计归档导出（固定目录；返回 workspace 相对 locator）。 */
  @Remote('exportAudit')
  async remoteExportExportAudit(request: { runId: string }): Promise<{
    locator: string
    archivedAt: string
  }> {
    return guard(() => {
      const { locator, archive } = exportRunArchive(this.ws.root, request.runId)
      return { locator, archivedAt: archive.archivedAt }
    })
  }
}
