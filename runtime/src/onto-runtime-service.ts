/**
 * ontoRuntime wire service + profile data-dir resolution (M2: shared by backend and AML hosts).
 * No auto-assembly — hosts register this plugin explicitly inside a RuntimeContext.
 * @module @dsh-onto/runtime/onto-runtime-service
 */
import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteErrorDetailsMap } from '@deepseek-ai/dsh-typert-protocol'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PackageWorkspace,
  buildRunRecord,
  compareRunRecords,
  exportRunArchive,
  isSafeRunId,
  listExperienceNotes,
  loadExperienceNote,
  loadPackage,
  loadRunRecord,
  listRunRecords,
  readPackageMeta,
  reviewExperienceNote,
  runScenario,
  saveRunRecord,
  type DataBasisInput,
  type RunDiff,
  type RunRecord,
  type RuntimeDataset,
  type ScenarioRunResult,
} from '@dsh-onto/core'
import { runtimeContextForHost } from './context.js'
import { AgentToolError } from './agent-policy.js'
import { dataSources } from './data-sources.js'
import { actionStoreFor, type ActionProposal, type ReviewDecision, type StoredActionRecord } from './action-store.js'
import { ReleaseStore } from './release-store.js'
import { ReleaseError } from './release.js'

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

declare module '@deepseek-ai/cordis' {
  interface Context {
    ontoRuntime: OntoRuntime
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

/** Keep Remote prototype markers intact while binding invocation ownership. */
export class RuntimeRemoteService extends TypertRemoteService {
  constructor(ctx: Context, serviceKey: string) {
    super(ctx, serviceKey)
    const runtime = runtimeContextForHost(ctx.root)
    const prototype = Object.getPrototypeOf(this)
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (!name.startsWith('remoteExport')) continue
      const method = Reflect.get(prototype, name)
      if (typeof method === 'function') {
        Object.defineProperty(this, name, { value: runtime.bind(method), configurable: true, writable: true })
      }
    }
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * ontoRuntime —— 场景执行
 * ═══════════════════════════════════════════════════════════════════════════ */

export class OntoRuntime extends RuntimeRemoteService {
  private readonly ws: PackageWorkspace
  private readonly releases: ReleaseStore

  constructor(ctx: Context) {
    super(ctx, 'ontoRuntime')
    const dataDir = resolveDataDir(ctx)
    this.ws = new PackageWorkspace(join(dataDir, 'workspace'))
    this.releases = new ReleaseStore({
      root: join(dataDir, 'releases'),
      workspace: this.ws,
      versions: { core: '0.0.0', runtime: '0.0.0' },
    })
  }

  @Remote('listScenarios')
  async remoteExportListScenarios(request: { name: string; version: string }): Promise<{
    scenarios: Array<{ id: string; name: string; goal: string; boundary: string }>
  }> {
    return guard(() => {
      this.assertActive(request.name, request.version)
      const pkg = loadPackage(this.ws.versionDir(request.name, request.version))
      return {
        scenarios: pkg.scenarios.map((s) => ({ id: s.id, name: s.name, goal: s.goal, boundary: s.boundary })),
      }
    })
  }

  /** M4 活动版本绑定：指针存在时新运行只认活动版（ReleaseError → Remote）。 */
  private assertActive(name: string, version: string): void {
    try {
      this.releases.assertActiveBinding(name, version)
    } catch (e) {
      if (e instanceof ReleaseError) {
        throw ontoError(
          e.code === 'RELEASE_VERSION_NOT_ACTIVE' || e.code === 'RELEASE_NOT_ACTIVE'
            ? 'onto/conflict'
            : 'onto/bad-request',
          e.message,
        )
      }
      throw e
    }
  }

  @Remote('runScenario')
  async remoteExportRunScenario(request: {
    name: string
    version: string
    scenarioId: string
    dataset?: RuntimeDataset
    /** M1-B 正式取数通道：服务端登记数据源 id（与 dataset 互斥）。 */
    sourceId?: string
    query?: { objectTypes?: string[]; timeWindow?: { from: string; to: string }; instanceIds?: string[] }
    /** 计算策略（缺省 explore）：formal=正式可信分析（缺依据 → dataStatus=insufficient）。 */
    analysisMode?: 'formal' | 'explore'
  }): Promise<{ result: ScenarioRunResult }> {
    return guard(async () => {
      this.assertActive(request.name, request.version)
      const dir = this.ws.versionDir(request.name, request.version)
      const hasSource = typeof request.sourceId === 'string' && request.sourceId !== ''
      if (hasSource === (request.dataset !== undefined && request.dataset !== null)) {
        throw new AgentToolError('INVALID_ARGS', 'sourceId（正式取数）与 dataset（探索通道）必须且只能提供一个')
      }
      const analysisMode = request.analysisMode === 'formal' ? 'formal' : 'explore'
      let dataset: RuntimeDataset
      let dataBasis: DataBasisInput | undefined
      if (hasSource) {
        // 正式通道：provenance/dataBasis 只由服务端连接器产出
        const fetched = await dataSources.fetch({
          sourceId: request.sourceId as string,
          query: request.query ?? {},
          tenant: 'default',
          root: this.ws.root,
        })
        dataset = fetched.dataset
        dataBasis = fetched.dataBasis
      } else {
        // 数据入口固定来源身份（R5）：wire 入参是外部请求，不得自称 connector 获得可信状态。
        dataset = { ...(request.dataset as RuntimeDataset), provenance: 'inline' }
      }
      const result = runScenario(dir, request.scenarioId, dataset, {
        analysisMode,
        ...(dataBasis !== undefined ? { dataBasis } : {}),
      })
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
          dataset: result.effectiveDataset ?? dataset,
          inputDataset: dataset,
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

  /** 审计归档导出（固定目录；返回 workspace 相对 locator）。D 包：附治理链条文件。 */
  @Remote('exportAudit')
  async remoteExportExportAudit(request: { runId: string }): Promise<{
    locator: string
    archivedAt: string
    chainLocator?: string
  }> {
    return guard(() => {
      // 本层独立复核 runId（不依赖 exportRunArchive 内部校验的调用顺序）：治理链文件名直拼入参
      const safeRunId = requireSafeRunId(request.runId)
      const { locator, archive } = exportRunArchive(this.ws.root, safeRunId)
      // 治理链串联（F1 步骤 7）：snapshot → run → decision → proposal → approval → externalRef
      const chain = this.reviewChainOf(safeRunId)
      const chainLocator = `runs/exports/${safeRunId}-chain.json`
      const chainPath = join(this.ws.root, 'runs', 'exports', `${safeRunId}-chain.json`)
      writeFileSync(chainPath, `${JSON.stringify({ runId: safeRunId, ...chain }, null, 2)}\n`, 'utf8')
      return { locator, archivedAt: archive.archivedAt, chainLocator }
    })
  }

  /** 治理链（D 包人审面）：复核决定 → 动作提案 → 动作台账（含批准与外部回执）。 */
  @Remote('reviewChain')
  async remoteExportReviewChain(request: { runId: string }): Promise<{
    decisions: ReviewDecision[]
    proposals: ActionProposal[]
    actions: StoredActionRecord[]
  }> {
    return guard(() => this.reviewChainOf(request.runId))
  }

  private reviewChainOf(runId: string): {
    decisions: ReviewDecision[]
    proposals: ActionProposal[]
    actions: StoredActionRecord[]
  } {
    const store = actionStoreFor(this.ws.root)
    const decisions = store.listDecisions(runId)
    const decisionIds = new Set(decisions.map((d) => d.decisionId))
    const proposals = store.listProposals().filter((p) => decisionIds.has(p.decisionId))
    const proposalIds = new Set(proposals.map((p) => p.proposalId))
    const actions = store.listActions().filter(
      (a) => (a.decisionId !== undefined && decisionIds.has(a.decisionId))
        || (a.proposalId !== undefined && proposalIds.has(a.proposalId)),
    )
    return { decisions, proposals, actions }
  }

  /* ── 经验闭环（experience-loop P2）：人审面 wire ── */

  /** 经验记录列表（时间倒序摘要；人审面）。 */
  @Remote('listExperiences')
  async remoteExportListExperiences(): Promise<{
    experiences: Array<{
      runId: string
      scenarioId: string
      packageScope: string
      outcome: string
      counterexample: boolean
      reusedFrom: string | null
      misTransferJudged: boolean
      reviewFocus: string[]
      savedAt: string
    }>
  }> {
    return guard(() => ({
      experiences: listExperienceNotes(this.ws.root).map((n) => ({
        runId: n.runId,
        scenarioId: n.signature.scenarioId,
        packageScope: n.signature.packageScope,
        outcome: n.outcome,
        counterexample: n.counterexample,
        reusedFrom: n.reusedFrom?.runId ?? null,
        misTransferJudged: n.misTransfer?.judged ?? false,
        reviewFocus: n.reviewFocus ?? [],
        savedAt: n.savedAt,
      })),
    }))
  }

  /** 单条经验全量（含签名与差异表；人审面）。 */
  @Remote('showExperience')
  async remoteExportShowExperience(request: { runId: string }): Promise<{
    note: Awaited<ReturnType<typeof loadExperienceNote>>
  }> {
    return guard(() => ({ note: loadExperienceNote(this.ws.root, request.runId) }))
  }

  /** 人审回填（S5.4）：改判 outcome、误迁移只由人判（by 必填）、reviewFocus 沉淀。 */
  @Remote('reviewExperience')
  async remoteExportReviewExperience(request: {
    runId: string
    outcome?: 'success' | 'partial' | 'failure' | 'pending-human'
    outcomeReason?: string
    misTransfer?: { judged: boolean; by: string; note?: string }
    reviewFocus?: string[]
  }): Promise<{ note: Awaited<ReturnType<typeof loadExperienceNote>> }> {
    return guard(() => ({
      note: reviewExperienceNote(this.ws.root, request.runId, {
        outcome: request.outcome,
        outcomeReason: request.outcomeReason,
        misTransfer: request.misTransfer,
        reviewFocus: request.reviewFocus,
      }),
    }))
  }
}
