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
import {
  OntoRuntime,
  RuntimeRemoteService,
  resolveDataDir,
} from '@dsh-onto/runtime'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  KnowledgeStore,
  PackageWorkspace,
  SOURCE_TYPES,
  assertIssueReady,
  buildQualityReport,
  buildRunRecord,
  compareRunRecords,
  derivePackage,
  exportRunArchive,
  isInsideDir,
  isSafeRelPath,
  isSafeRunId,
  listExperienceNotes,
  loadExperienceNote,
  loadPackage,
  loadRunRecord,
  listRunRecords,
  readPackageMeta,
  reviewExperienceNote,
  runScenario,
  savePackage,
  saveRunRecord,
  verifyDerived,
  writeQualityReport,
  type KnowledgeSourceRecord,
  type DataBasisInput,
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
import { AgentToolError } from './agent-policy.js'
import { dataSources } from './data-sources.js'
import { actionStoreFor, type ActionProposal, type ReviewDecision, type StoredActionRecord } from './action-store.js'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'onto/not-found': Record<string, never>
    'onto/bad-request': Record<string, never>
    'onto/conflict': Record<string, never>
    'onto/readonly': Record<string, never>
    'onto/drift': Record<string, never>
    'onto/issue-gate': Record<string, never>
  }
}

// resolveDataDir / OntoRuntime live in @dsh-onto/runtime (M2); re-export for backend hosts.
export { resolveDataDir, OntoRuntime, RuntimeRemoteService }

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
  if (code.startsWith('ISSUE_GATE')) return ontoError('onto/issue-gate', message)
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

/**
 * runId 路径段复核（与 core runstore 同口径；本层独立过一遍，不依赖调用顺序——
 * 治理链文件名直拼 runId 前必须先验，防路径段注入写出工作区外）。
 */
function requireSafeRunId(runId: unknown): string {
  if (!isSafeRunId(runId)) {
    throw new AgentToolError('INVALID_ARGS', `runId 非法（须为单段安全路径）: ${String(runId)}`)
  }
  return runId
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

export class OntoWorkspace extends RuntimeRemoteService {
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
      const dir = this.ws.versionDir(request.name, request.version)
      // 签发门禁：校验 0 错 + 场景/规则非空 + 派生 + 加载门禁（空壳包/坏包不得签发）。
      const gate = request.to === 'ISSUED' ? assertIssueReady(dir) : null
      this.ws.transition(request.name, request.version, request.to, request.issuedBy, request.note)
      invalidateSkillCatalog()
      // 状态迁移会改写 package.yaml（issueRecord/状态位）→ 同事务重派生，
      // 否则签发/送审即 DERIVED_DRIFT，包立刻不可加载（实测 P0）。
      try {
        derivePackage(dir)
      } catch (e) {
        throw ontoError(
          'onto/drift',
          `状态已迁移到 ${request.to}，但重派生失败（请在校验派生页手动 derive）：${e instanceof Error ? e.message : String(e)}`,
        )
      }
      return { status: request.to, ...(gate ? { gate } : {}) }
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

export class OntoModel extends RuntimeRemoteService {
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
      const dir = this.dirOf(request.name, request.version)
      savePackage(dir, request.pkg)
      invalidateSkillCatalog()
      // P1-C：与 materialize D6 同口径——源已改即重派生，避免 UI 保存后立刻 DERIVED_DRIFT。
      try {
        derivePackage(dir)
      } catch (e) {
        throw ontoError('onto/drift', `源已保存但重派生失败，请在校验派生页手动 derive：${e instanceof Error ? e.message : String(e)}`)
      }
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
      // P1-C：YAML 导入后同事务重派生（与 materialize D6 / save 同口径）。
      try {
        derivePackage(dir)
      } catch (e) {
        throw ontoError('onto/drift', `源已写入但重派生失败，请在校验派生页手动 derive：${e instanceof Error ? e.message : String(e)}`)
      }
      return { ok: true as const }
    })
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * ontoValidate / ontoDerive
 * ═══════════════════════════════════════════════════════════════════════════ */

export class OntoValidate extends RuntimeRemoteService {
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

export class OntoDerive extends RuntimeRemoteService {
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

export class OntoKnowledge extends RuntimeRemoteService {
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
    return guard(() => {
      // P3b（实测）：红线候选的唯一载体是场景 forbiddenPhrases——「标记并入」目标必须
      // 命中该包任一版本的场景（ID 或名），否则记账成 merged 只会骗人（无载体、物化必失败）。
      if (request.action === 'merge') {
        const cand = this.store.getCandidate(request.id)
        if (cand.targetKind === 'RedLine') {
          const target = (request.mergeIntoName ?? '').trim()
          const scenarioIds: string[] = []
          let hit = false
          for (const v of this.ws.listVersions()) {
            if (v.name !== cand.packageId) continue
            try {
              for (const s of loadPackage(v.dir).scenarios) {
                scenarioIds.push(s.id)
                if (s.id === target || s.name === target) hit = true
              }
            } catch {
              /* 单版本读取失败不阻断其余版本的匹配 */
            }
          }
          if (!hit) {
            throw ontoError(
              'onto/bad-request',
              `红线候选只能并入场景（forbiddenPhrases 载体）：「${target}」不是该包任何版本的场景。可用场景：${[...new Set(scenarioIds)].join(', ') || '（该包尚无场景，红线暂无载体）'}`,
            )
          }
        }
      }
      return {
        candidate: this.store.reviewCandidate(request.id, request.action, {
          mergeIntoName: request.mergeIntoName,
          reviewedBy: 'workbench',
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

