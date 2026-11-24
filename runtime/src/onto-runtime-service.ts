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
  buildRunReport,
  compareRunRecords,
  exportRunArchive,
  isSafeRunId,
  listExperienceNotes,
  listReportPages,
  loadExperienceNote,
  loadPackage,
  loadReportPage,
  loadRunRecord,
  listRunRecords,
  readPackageMeta,
  reviewExperienceNote,
  runScenario,
  saveRunRecord,
  type DataBasisInput,
  type ReportPage,
  type RunDiff,
  type RunRecord,
  type RunReport,
  type RuntimeDataset,
  type ScenarioRunResult,
} from '@dsh-onto/core'
import { runtimeContextForHost } from './context.js'
import { AgentToolError } from './agent-policy.js'
import { dataSources } from './data-sources.js'
import { actionStoreFor, type ActionProposal, type ReviewDecision, type StoredActionRecord } from './action-store.js'
import { isStrictReleaseMode, ReleaseStore } from './release-store.js'
import { ReleaseError } from './release.js'
import {
  assertBusinessDataset, assertBusinessReportPage, assertBusinessRun, requireBusinessIdentity, runAccessBinding, scopeDataQuery,
} from './business-policy.js'
import { persistReviewDecision, requireReviewerHostId, validateReviewDecision } from './review-decision.js'
import { loadSourceConfigs } from './source-config.js'

/** wire 错误 details：origCode 保留业务机器码（REVIEW_* / INVALID_ARGS…），便于 UI 展示。 */
type OntoErrorDetails = { origCode?: string }

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'onto/not-found': OntoErrorDetails
    'onto/bad-request': OntoErrorDetails
    'onto/conflict': OntoErrorDetails
    'onto/readonly': OntoErrorDetails
    'onto/drift': OntoErrorDetails
    'onto/issue-gate': OntoErrorDetails
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

function ontoError(code: keyof RemoteErrorDetailsMap, message: string, origCode?: string): RemoteError {
  return new RemoteError(code, message, origCode !== undefined ? { origCode } : {})
}

function toRemoteError(e: unknown): RemoteError {
  if (e instanceof RemoteError) return e
  const message = e instanceof Error ? e.message : String(e)
  const code =
    typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : ''
  if (code === 'PACKAGE_READONLY' || code === 'PACKAGE_ISSUE_REQUIRES_HUMAN') {
    return ontoError('onto/readonly', message, code || undefined)
  }
  if (code === 'PACKAGE_EXISTS') return ontoError('onto/conflict', message, code || undefined)
  if (code.startsWith('ISSUE_GATE')) return ontoError('onto/issue-gate', message, code || undefined)
  if (code === 'DERIVED_DRIFT') return ontoError('onto/drift', message, code || undefined)
  if (/not found|NOT_FOUND/.test(code + message)) return ontoError('onto/not-found', message, code || undefined)
  return ontoError('onto/bad-request', message, code || undefined)
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
  private readonly strict: boolean
  /** 数据根（source-configs.json 等部署配置面落点；ws.root = <dataDir>/workspace）。 */
  private readonly dataDir: string

  constructor(ctx: Context) {
    super(ctx, 'ontoRuntime')
    const dataDir = resolveDataDir(ctx)
    this.dataDir = dataDir
    this.strict = runtimeContextForHost(ctx.root).run(isStrictReleaseMode)
    this.ws = new PackageWorkspace(join(dataDir, 'workspace'))
    this.releases = new ReleaseStore({
      root: join(dataDir, 'releases'),
      workspace: this.ws,
      versions: { core: '0.0.0', runtime: '0.0.0' },
      requireActive: this.strict,
    })
  }

  /**
   * 受控数据源登记面（issue #30 WP-B 页面选源跑批）：按包过滤返回 source-configs 摘要。
   * 只读、最小披露——不返回 apiBaseUrl / apiTokenEnv（部署配置细节不过页面）。
   * 配置损坏 fail-loud（不静默空表）；active 绑定口径与 listScenarios 同。
   */
  @Remote('listSourceConfigs')
  async remoteExportListSourceConfigs(request: { name: string; version: string }): Promise<{
    sources: Array<{
      sourceId: string
      package: { name: string; version: string }
      sourceKind: 'simulated' | 'formal'
      registeredAt: string
    }>
  }> {
    return guard(() => {
      this.assertActive(request.name, request.version)
      const sources = loadSourceConfigs(this.dataDir)
        .filter((c) => c.package.name === request.name && c.package.version === request.version)
        .map((c) => ({
          sourceId: c.sourceId,
          package: c.package,
          sourceKind: c.sourceKind,
          registeredAt: c.registeredAt,
        }))
      return { sources }
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
          e.code,
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
      const identity = this.strict ? requireBusinessIdentity('read') : undefined
      const pkg = loadPackage(dir)
      let dataset: RuntimeDataset
      let dataBasis: DataBasisInput | undefined
      if (hasSource) {
        // 正式通道：provenance/dataBasis 只由服务端连接器产出
        const fetched = await dataSources.fetch({
          sourceId: request.sourceId as string,
          query: identity ? scopeDataQuery(identity, request.query ?? {}) : request.query ?? {},
          tenant: identity?.tenant ?? 'default',
          dataScope: identity?.dataScope,
          authorizeDataset: identity ? data => assertBusinessDataset(identity, pkg, data) : undefined,
          root: this.ws.root,
        })
        dataset = fetched.dataset
        dataBasis = fetched.dataBasis
      } else {
        // 数据入口固定来源身份（R5）：wire 入参是外部请求，不得自称 connector 获得可信状态。
        dataset = { ...(request.dataset as RuntimeDataset), provenance: 'inline' }
        if (identity) assertBusinessDataset(identity, pkg, dataset)
      }
      const result = runScenario(dir, request.scenarioId, dataset, {
        analysisMode,
        ...(dataBasis !== undefined ? { dataBasis } : {}),
      })
      // 运行留痕（run-insight S2.1）：人审面完整结果 + 双源红线落盘（wire 不脱敏，落盘面供跨进程遮蔽）。
      const meta = readPackageMeta(dir)
      const scenario = pkg.scenarios.find((s) => s.id === request.scenarioId)
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
          accessBinding: identity && runAccessBinding(identity),
        }),
      )
      return { result }
    })
  }

  private visibleRuns(): RunRecord[] {
    const binding = this.strict ? runAccessBinding(requireBusinessIdentity('history')) : undefined
    return listRunRecords(this.ws.root).filter(run => !this.strict || run.accessBinding === binding)
  }

  private readRun(runId: string, operation: 'history' | 'export' = 'history'): RunRecord {
    const identity = this.strict ? requireBusinessIdentity(operation) : undefined
    const run = loadRunRecord(this.ws.root, runId)
    return identity ? assertBusinessRun(identity, run) : run
  }

  /**
   * 运行历史（run-insight S2.5）——纯 RunRecord 摘要，**不依赖 action-store**。
   * workbench 运行列表等只读消费方与复核待办解耦：台账损坏不得打挂历史页。
   * 复核状态走 {@link remoteExportListReviewQueue}。
   */
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
      runs: this.visibleRuns().map((r) => ({
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

  /**
   * 复核待办联合（aml-review-workbench S2.1）：RunRecord × ReviewDecision。
   * pending = 无决定；有决定取最新。action-store 缺失/损坏 **fail-loud**——
   * 不静默把全部 run 标成 pending（待办口径不可假阴性）。仅复核面消费本端点。
   */
  @Remote('listReviewQueue')
  async remoteExportListReviewQueue(): Promise<{
    runs: Array<{
      runId: string
      scenarioId: string
      package: { name: string; version: string }
      datasetDigest: string
      datasetSummary: RunRecord['datasetSummary']
      auditPassed: boolean
      startedAt: string
      savedAt: string
      reviewStatus: 'pending' | 'approved' | 'rejected'
      latestDecision?: {
        decisionId: string
        decision: 'approved' | 'rejected'
        createdAt: string
        reason?: string
        candidateIds: string[]
      }
    }>
  }> {
    return guard(() => {
      const store = actionStoreFor(this.ws.root)
      // 一次拉全表再分组，避免 per-run N+1
      const byRun = new Map<string, ReviewDecision[]>()
      for (const d of store.listDecisions()) {
        const list = byRun.get(d.runId)
        if (list === undefined) byRun.set(d.runId, [d])
        else list.push(d)
      }
      const rows = this.visibleRuns().map((r) => {
        const decisions = byRun.get(r.runId) ?? []
        const latest = decisions.length === 0
          ? undefined
          : [...decisions].sort((a, b) =>
              a.createdAt < b.createdAt ? 1
              : a.createdAt > b.createdAt ? -1
              : a.decisionId < b.decisionId ? 1
              : a.decisionId > b.decisionId ? -1
              : 0)[0]
        return {
          runId: r.runId,
          scenarioId: r.scenarioId,
          package: r.package,
          datasetDigest: r.datasetDigest.slice(0, 12),
          datasetSummary: r.datasetSummary,
          auditPassed: r.result.audit.passed === true,
          startedAt: r.startedAt,
          savedAt: r.savedAt,
          reviewStatus: (latest?.decision ?? 'pending') as 'pending' | 'approved' | 'rejected',
          ...(latest
            ? {
                latestDecision: {
                  decisionId: latest.decisionId,
                  decision: latest.decision,
                  createdAt: latest.createdAt,
                  ...(latest.reason !== undefined ? { reason: latest.reason } : {}),
                  candidateIds: latest.candidateIds,
                },
              }
            : {}),
        }
      })
      // pending 在前，其后 savedAt 时间倒序（S2.1）。
      rows.sort((a, b) => {
        const ap = a.reviewStatus === 'pending' ? 0 : 1
        const bp = b.reviewStatus === 'pending' ? 0 : 1
        if (ap !== bp) return ap - bp
        if (a.savedAt !== b.savedAt) return a.savedAt < b.savedAt ? 1 : -1
        return a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0
      })
      return { runs: rows }
    })
  }

  /** 单轮运行全量（人审面：完整短语与证据链，供复核定位）。 */
  @Remote('showRun')
  async remoteExportShowRun(request: { runId: string }): Promise<{ record: RunRecord }> {
    return guard(() => ({ record: this.readRun(request.runId) }))
  }

  /**
   * 运行报表投影（chat-run-report S2.4）：固定结果页与对话报表共用的唯一投影源，
   * 数值一致由构造保证。人审面（完整证据/叙述），鉴权同 showRun。
   */
  @Remote('getRunReport')
  async remoteExportGetRunReport(request: { runId: string }): Promise<{ report: RunReport }> {
    return guard(() => ({ report: buildRunReport(this.readRun(request.runId)) }))
  }

  /** 报表页列表（chat-run-report S2.7；人审面完整 surface，供插件「报表页」渲染）。 */
  @Remote('listReportPages')
  async remoteExportListReportPages(): Promise<{ pages: ReportPage[] }> {
    return guard(() => {
      const binding = this.strict ? runAccessBinding(requireBusinessIdentity('history')) : undefined
      return {
        pages: listReportPages(this.ws.root).filter((p) => !this.strict || p.accessBinding === binding),
      }
    })
  }

  /** 单个报表页（越权 strict 拒绝，RunRecord 同口径）。 */
  @Remote('getReportPage')
  async remoteExportGetReportPage(request: { pageId: string }): Promise<{ page: ReportPage }> {
    return guard(() => {
      const page = loadReportPage(this.ws.root, request.pageId)
      if (this.strict) assertBusinessReportPage(requireBusinessIdentity('history'), page)
      return { page }
    })
  }

  /** 两轮对比（人审面完整；工具面同语义经 compare_runs 投影）。 */
  @Remote('compareRuns')
  async remoteExportCompareRuns(request: {
    runIdA: string
    runIdB: string
  }): Promise<{ diff: RunDiff }> {
    return guard(() => {
      const a = this.readRun(request.runIdA)
      const b = this.readRun(request.runIdB)
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
      if (this.strict) this.readRun(safeRunId, 'export')
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
    return guard(() => {
      if (this.strict) this.readRun(request.runId)
      return this.reviewChainOf(request.runId)
    })
  }

  /**
   * 业务复核决定 UI 直写（aml-review-workbench S2.3）：与 record_review_decision 工具
   * 同一套公共校验；候选须在结果集内（比工具面更严）。
   *
   * 身份顺序（防探测）：先 requireReviewerHostId fail-closed，再做 run/摘要校验——
   * 无身份调用方不得靠 REVIEW_RUN_NOT_FOUND 等错误码探知台账存在性。
   * 不走批准卡——UI 本人点击即人审事件；执行批准/提案/对账仍只在工具面批准卡。
   */
  @Remote('recordReviewDecision')
  async remoteExportRecordReviewDecision(request: {
    runId: string
    candidateIds: string[]
    snapshotDigest: string
    ruleFingerprint: string
    decision: 'approved' | 'rejected'
    reason?: string
  }): Promise<{
    decisionId: string
    runId: string
    decision: 'approved' | 'rejected'
    candidateIds: string[]
    reviewer: string
    createdAt: string
    humanReviewRequired: true
  }> {
    return guard(() => {
      const reviewer = requireReviewerHostId()
      const validated = validateReviewDecision(
        this.ws.root,
        {
          runId: request.runId,
          candidateIds: request.candidateIds,
          snapshotDigest: request.snapshotDigest,
          ruleFingerprint: request.ruleFingerprint,
          decision: request.decision,
          ...(request.reason !== undefined ? { reason: request.reason } : {}),
        },
        { requireCandidateSubset: true },
      )
      if (this.strict) assertBusinessRun(requireBusinessIdentity('history'), validated.runRec)
      const dec = persistReviewDecision(this.ws.root, validated, reviewer)
      return {
        decisionId: dec.decisionId,
        runId: dec.runId,
        decision: dec.decision,
        candidateIds: dec.candidateIds,
        reviewer: dec.reviewer,
        createdAt: dec.createdAt,
        humanReviewRequired: true as const,
      }
    })
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
    return guard(() => {
      const ids = this.strict ? new Set(this.visibleRuns().map(run => run.runId)) : undefined
      return { experiences: listExperienceNotes(this.ws.root)
        .filter(note => !ids || ids.has(note.runId)).map((n) => ({
        runId: n.runId,
        scenarioId: n.signature.scenarioId,
        packageScope: n.signature.packageScope,
        outcome: n.outcome,
        counterexample: n.counterexample,
        reusedFrom: n.reusedFrom?.runId ?? null,
        misTransferJudged: n.misTransfer?.judged ?? false,
        reviewFocus: n.reviewFocus ?? [],
        savedAt: n.savedAt,
      })) }
    })
  }

  /** 单条经验全量（含签名与差异表；人审面）。 */
  @Remote('showExperience')
  async remoteExportShowExperience(request: { runId: string }): Promise<{
    note: Awaited<ReturnType<typeof loadExperienceNote>>
  }> {
    return guard(() => {
      if (this.strict) this.readRun(request.runId)
      return { note: loadExperienceNote(this.ws.root, request.runId) }
    })
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
    return guard(() => {
      if (this.strict) this.readRun(request.runId)
      return { note: reviewExperienceNote(this.ws.root, request.runId, {
        outcome: request.outcome,
        outcomeReason: request.outcomeReason,
        misTransfer: request.misTransfer,
        reviewFocus: request.reviewFocus,
      }) }
    })
  }
}
