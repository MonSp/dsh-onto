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
  expandEntity,
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
  verifyDerived,
  type DataBasisInput,
  type ExpandResult,
  type OntologyPackage,
  type ReportPage,
  type RunDiff,
  type RunRecord,
  type RunReport,
  type RuntimeDataset,
  type ScenarioRunResult,
} from '@dsh-onto/core'
import { runtimeContextForHost } from './context.js'
import { AgentToolError, isRecord } from './agent-policy.js'
import { actionDigest } from './agent-approval.js'
import {
  approvalContextDigest,
  connectorNature,
  currentConnectorIdentity,
  digestAction,
  executeBehaviorAction,
  reconcileActionRecord,
  validateActionIntent,
  type ActionIntent,
} from './action-executor.js'
import { checkGrant, readToolContracts } from './agent-grants.js'
import { consumeUiApprovalChallenge, issueUiApprovalChallenge } from './ui-approval.js'
import { dataSources } from './data-sources.js'
import { actionStoreFor, type ActionProposal, type ReviewDecision, type StoredActionRecord } from './action-store.js'
import { isStrictReleaseMode, ReleaseStore } from './release-store.js'
import { ReleaseError } from './release.js'
import {
  actChecks,
  assertBusinessDataset, assertBusinessReportPage, assertBusinessRun, parseTargetRef,
  requireBusinessIdentity, requireBizAuth, runAccessBinding, runPlaneInstances, scopeDataQuery,
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

  /* ── 动作面（issue #30 WP-C）：页面提案 / 两段式批准卡 / 执行 / 对账 ─────
   * 与 agent 工具面同源（同一 action store / runstore / 执行器），wire 面批准卡
   * 以 {@link consumeUiApprovalChallenge} 充当 requestGrant：单次、TTL、摘要绑定、
   * 批准人宿主身份留痕（fail-closed）。身份先行（防探测）：requireBusinessIdentity('act')
   * 先于包内容/台账查询类错误。 */

  /** 动作面包加载（工具面 loadToolPackage 同闸：派生门禁 DERIVED_DRIFT）。 */
  private loadActionPackage(name: string, version: string): OntologyPackage {
    let dir: string
    let pkg: OntologyPackage
    try {
      dir = this.ws.versionDir(name, version)
      pkg = loadPackage(dir)
    } catch {
      throw new AgentToolError('NOT_FOUND', `包不存在或无法加载: ${name}@${version}`)
    }
    let gate: ReturnType<typeof verifyDerived>
    try {
      gate = verifyDerived(dir)
    } catch {
      throw new AgentToolError('DERIVED_DRIFT', '拒绝加载: 派生门禁不可读')
    }
    if (!gate.ok) {
      throw new AgentToolError('DERIVED_DRIFT', `拒绝加载: ${gate.reason}`)
    }
    return pkg
  }

  /** 动作面公共前置：身份 → 包（过门禁）→ 意图校验（O2 闭合/锚点/载荷契约）→ 六元组 act。 */
  private actionFace(request: {
    name: string
    version: string
    behaviorId: string
    objectRef: string
    payload: unknown
  }): { pkg: OntologyPackage; intent: ActionIntent; behavior: { id: string; anchor?: string; name?: string; relations?: string[]; states?: string[] } } {
    // 身份先行（fail-closed，无身份不得靠 INVALID_ARGS/NOT_FOUND 探测包内容）
    requireBusinessIdentity('act')
    if (!isRecord(request.payload)) {
      throw new AgentToolError('INVALID_ARGS', 'payload 必须是 JSON 对象')
    }
    const pkg = this.loadActionPackage(request.name, request.version)
    const intent: ActionIntent = {
      behaviorId: request.behaviorId,
      objectRef: request.objectRef,
      payload: request.payload as Record<string, unknown>,
    }
    validateActionIntent(pkg.behaviors, intent, {
      isGranted: (ref) =>
        checkGrant(readToolContracts(this.ws.versionDir(request.name, request.version)), ref) === undefined,
    })
    const behavior = pkg.behaviors.find((b) => b.id === request.behaviorId)
    if (behavior === undefined) {
      throw new AgentToolError('INVALID_ARGS', `行为 ${request.behaviorId} 未在包内声明（O2 闭合）`)
    }
    // M1-C 六元组：动作面（act）——权限判定在批准卡之前（批准卡不授予权限）
    requireBizAuth(
      'act',
      parseTargetRef(request.objectRef),
      actChecks(new Set(pkg.objects.map((o) => o.id)), runPlaneInstances(this.ws.root)),
    )
    return {
      pkg,
      intent,
      behavior: {
        id: behavior.id,
        ...(behavior.anchor !== undefined ? { anchor: behavior.anchor } : {}),
        ...(behavior.name !== undefined ? { name: behavior.name } : {}),
        ...(behavior.relations !== undefined ? { relations: behavior.relations } : {}),
        ...(behavior.states !== undefined ? { states: behavior.states } : {}),
      },
    }
  }

  /**
   * 动作提案（WP-C）：对已获准复核决定内的候选立受治理提案——服务端 operationId、单次消费。
   * 提案 ≠ 执行批准：执行仍过批准卡（executeAction 提 proposalId + approval.challengeId）。
   */
  @Remote('createActionProposal')
  async remoteExportCreateActionProposal(request: {
    decisionId: string
    runId: string
    candidateId: string
    name: string
    version: string
    behaviorId: string
    objectRef: string
    payload: unknown
  }): Promise<{
    proposalId: string
    decisionId: string
    operationId: string
    runId: string
    candidateId: string
    behaviorId: string
    objectRef: string
    humanReviewRequired: true
  }> {
    return guard(() => {
      const identity = requireBusinessIdentity('act')
      if (this.strict) assertBusinessRun(identity, loadRunRecord(this.ws.root, request.runId))
      const { intent } = this.actionFace(request)
      const connIdentity = currentConnectorIdentity()
      const proposal = actionStoreFor(this.ws.root).createProposal({
        decisionId: request.decisionId,
        runId: request.runId,
        candidateId: request.candidateId,
        behaviorId: request.behaviorId,
        objectRef: request.objectRef,
        payload: intent.payload,
        intentDigest: digestAction(intent),
        connectorId: connIdentity.id,
        connectorEnv: connIdentity.env,
        connectorKind: connIdentity.kind ?? 'dryrun',
      })
      return {
        proposalId: proposal.proposalId,
        decisionId: proposal.decisionId,
        operationId: proposal.operationId,
        runId: proposal.runId,
        candidateId: proposal.candidateId,
        behaviorId: proposal.behaviorId,
        objectRef: proposal.objectRef,
        humanReviewRequired: true as const,
      }
    })
  }

  /**
   * 页面批准卡第一步（WP-C 两段式）：服务端签发带 contextDigest 的批准挑战，
   * 页面据此弹批准卡。挑战绑定 intent/载荷/对象/连接器目标；TTL 内单次消费。
   */
  @Remote('prepareAction')
  async remoteExportPrepareAction(request: {
    name: string
    version: string
    behaviorId: string
    objectRef: string
    payload: unknown
    proposalId?: string
  }): Promise<{
    challengeId: string
    contextDigest: string
    expiresAt: string
    approvalCard: {
      behaviorId: string
      objectRef: string
      payload: Record<string, unknown>
      package: { name: string; version: string }
      connector: { id: string; env: string; kind?: string }
      operationId?: string
    }
    humanReviewRequired: true
  }> {
    return guard(async () => {
      const { intent, behavior, pkg } = this.actionFace(request)
      const identity = currentConnectorIdentity()
      const contextDigest = approvalContextDigest(
        intent,
        identity,
        { name: pkg.meta.name, version: pkg.meta.version },
        behavior,
      )
      let operationId: string | undefined
      if (request.proposalId !== undefined) {
        const proposal = actionStoreFor(this.ws.root).getProposal(request.proposalId)
        if (proposal === null) {
          throw new AgentToolError('PROPOSAL_NOT_FOUND', `动作提案 ${request.proposalId} 不存在——执行须引用服务端保存的提案`)
        }
        if (proposal.status !== 'pending') {
          throw new AgentToolError('PROPOSAL_NOT_PENDING', `动作提案 ${request.proposalId} 状态 ${proposal.status}——须为 pending 才能批准`)
        }
        operationId = proposal.operationId
      }
      const challenge = issueUiApprovalChallenge(contextDigest)
      return {
        challengeId: challenge.challengeId,
        contextDigest,
        expiresAt: challenge.expiresAt,
        approvalCard: {
          behaviorId: intent.behaviorId,
          objectRef: intent.objectRef,
          payload: intent.payload,
          package: { name: pkg.meta.name, version: pkg.meta.version },
          connector: {
            id: identity.id,
            env: identity.env,
            ...(identity.kind !== undefined ? { kind: identity.kind } : {}),
          },
          ...(operationId !== undefined ? { operationId } : {}),
        },
        humanReviewRequired: true as const,
      }
    })
  }

  /**
   * 动作执行（WP-C）：页面批准卡消费挑战充当 requestGrant，其余与工具面同源——
   * 意图校验 → 六元组 act → 原子占位 → 批准（挑战单次/摘要绑定）→ 连接器执行 → 补偿/对账。
   * 演练/模拟性质显式上墙（simulated=true 不得当作真实业务成功）。
   */
  @Remote('executeAction')
  async remoteExportExecuteAction(request: {
    name: string
    version: string
    behaviorId: string
    objectRef: string
    payload: unknown
    proposalId?: string
    approval: { challengeId: string; contextDigest: string }
  }): Promise<{
    actionId: string
    status: string
    replayed: boolean
    behaviorId: string
    objectRef: string
    externalRef?: string
    note?: string
    connectorKind: string
    simulated: boolean
    approvedBy?: string
    humanReviewRequired: true
  }> {
    return guard(async () => {
      const { intent, behavior, pkg } = this.actionFace(request)
      const res = await executeBehaviorAction({
        root: this.ws.root,
        intent,
        pkg: { name: pkg.meta.name, version: pkg.meta.version },
        behavior,
        ...(request.proposalId !== undefined ? { proposalId: request.proposalId } : {}),
        // 页面批准卡 = requestGrant 替代源：消费单次挑战（身份/TTL/摘要绑定 fail-closed）
        requestGrant: async (contextDigest) => {
          const grant = consumeUiApprovalChallenge(
            { challengeId: request.approval.challengeId, contextDigest: request.approval.contextDigest },
            contextDigest,
          )
          return {
            approvalDigest: grant.approvalDigest,
            approvedAt: grant.approvedAt,
            approvedBy: grant.approvedBy,
          }
        },
      })
      const record = res.record
      const nature = connectorNature(record.connector)
      return {
        actionId: record.actionId,
        status: record.status,
        replayed: res.replayed,
        behaviorId: record.behaviorId,
        objectRef: record.objectRef,
        ...(record.externalRef !== undefined ? { externalRef: record.externalRef } : {}),
        ...(res.note !== undefined ? { note: res.note } : {}),
        connectorKind: nature.kind,
        simulated: nature.simulated,
        ...(record.approvedBy !== undefined ? { approvedBy: record.approvedBy } : {}),
        humanReviewRequired: true as const,
      }
    })
  }

  /**
   * 人工对账（WP-C）：unknown / dispatched 在途记录按外部回执处置——成功恢复 / 未执行按失败留痕 /
   * 无确定回执保持 unknown。不自动重跑、不产生二次外部效应；UI 点击即人审事件（同 recordReviewDecision
   * 口径，身份先行 + 六元组 act；无外部效应故不再叠批准卡）。
   */
  @Remote('reconcileAction')
  async remoteExportReconcileAction(request: { actionId: string }): Promise<{
    actionId: string
    status: string
    externalRef?: string
    note?: string
    humanReviewRequired: true
  }> {
    return guard(async () => {
      requireReviewerHostId()
      const store = actionStoreFor(this.ws.root)
      const record = store.listActions().find((a) => a.actionId === request.actionId)
      if (record === undefined) {
        throw new AgentToolError('INVALID_ARGS', `动作台账 ${request.actionId} 不存在`)
      }
      requireBizAuth(
        'act',
        parseTargetRef(record.objectRef),
        actChecks(null, runPlaneInstances(this.ws.root), record.objectRef),
      )
      const res = await reconcileActionRecord(this.ws.root, record.businessKey)
      return {
        actionId: res.record.actionId,
        status: res.record.status,
        ...(res.record.externalRef !== undefined ? { externalRef: res.record.externalRef } : {}),
        ...(res.note !== undefined ? { note: res.note } : {}),
        humanReviewRequired: true as const,
      }
    })
  }

  /* ── 对象视图面（issue #30 WP-D）：实体浏览 / 邻域跳转 ─────────────────────
   * 实例数据走双通道（dataset 内联 XOR sourceId 受控取数，与 runScenario 同互斥口径）；
   * RunRecord 只留摘要不留全量 dataset——浏览面以通道数据为准。 */

  /** 浏览数据集解析（双通道互斥；sourceId 通道走服务端连接器 + 范围收窄）。 */
  private async resolveBrowseDataset(request: {
    name: string
    version: string
    dataset?: RuntimeDataset
    sourceId?: string
    query?: { objectTypes?: string[]; timeWindow?: { from: string; to: string }; instanceIds?: string[] }
  }): Promise<RuntimeDataset> {
    const hasSource = typeof request.sourceId === 'string' && request.sourceId !== ''
    if (hasSource === (request.dataset !== undefined && request.dataset !== null)) {
      throw new AgentToolError('INVALID_ARGS', 'sourceId（正式取数）与 dataset（探索通道）必须且只能提供一个')
    }
    if (hasSource) {
      const identity = this.strict ? requireBusinessIdentity('read') : undefined
      const pkg = loadPackage(this.ws.versionDir(request.name, request.version))
      const fetched = await dataSources.fetch({
        sourceId: request.sourceId as string,
        query: identity ? scopeDataQuery(identity, request.query ?? {}) : request.query ?? {},
        tenant: identity?.tenant ?? 'default',
        dataScope: identity?.dataScope,
        authorizeDataset: identity ? (d) => assertBusinessDataset(identity, pkg, d) : undefined,
        root: this.ws.root,
      })
      return fetched.dataset
    }
    const dataset = request.dataset as RuntimeDataset
    if (!isRecord(dataset) || !Array.isArray(dataset.objects) || !Array.isArray(dataset.relations)) {
      throw new AgentToolError('INVALID_ARGS', 'dataset 必须是 JSON 对象（objects/relations 数组）')
    }
    return dataset
  }

  /**
   * 实体浏览（WP-D）：按类型过滤 + 分页返回实例对象与类型计数（探索/正式双通道）。
   */
  @Remote('browseObjects')
  async remoteExportBrowseObjects(request: {
    name: string
    version: string
    dataset?: RuntimeDataset
    sourceId?: string
    query?: { objectTypes?: string[]; timeWindow?: { from: string; to: string }; instanceIds?: string[] }
    typeFilter?: string
    offset?: number
    limit?: number
  }): Promise<{
    objects: Array<{ id: string; type: string; attrs?: Record<string, unknown> }>
    types: Array<{ type: string; count: number }>
    total: number
  }> {
    return guard(async () => {
      this.assertActive(request.name, request.version)
      const dataset = await this.resolveBrowseDataset(request)
      const counts = new Map<string, number>()
      for (const o of dataset.objects) {
        counts.set(o.type, (counts.get(o.type) ?? 0) + 1)
      }
      const filtered = request.typeFilter !== undefined && request.typeFilter !== ''
        ? dataset.objects.filter((o) => o.type === request.typeFilter)
        : dataset.objects
      const offset = Math.max(0, Math.floor(request.offset ?? 0))
      const limit = Math.min(200, Math.max(1, Math.floor(request.limit ?? 50)))
      return {
        objects: filtered.slice(offset, offset + limit).map((o) => ({
          id: o.id,
          type: o.type,
          ...(o.attrs !== undefined ? { attrs: o.attrs } : {}),
        })),
        types: [...counts.entries()].map(([type, count]) => ({ type, count })),
        total: filtered.length,
      }
    })
  }

  /**
   * 邻域跳转（WP-D）：种子 BFS 扩出邻域子 dataset（hops≤3）——missingSeedIds / truncated
   * 显式呈现（不静默吞）。逐种子过 expand 面授权（包对象表 + 数据面实例）。
   */
  @Remote('expandEntity')
  async remoteExportExpandEntity(request: {
    name: string
    version: string
    dataset?: RuntimeDataset
    sourceId?: string
    query?: { objectTypes?: string[]; timeWindow?: { from: string; to: string }; instanceIds?: string[] }
    seedIds: string[]
    hops?: number
    direction?: 'out' | 'in' | 'both'
    relationTypes?: string[]
  }): Promise<ExpandResult> {
    return guard(async () => {
      this.assertActive(request.name, request.version)
      const dataset = await this.resolveBrowseDataset(request)
      const pkg = loadPackage(this.ws.versionDir(request.name, request.version))
      const types = new Set(pkg.objects.map((o) => o.id))
      const byId = new Map(dataset.objects.map((o) => [o.id, o]))
      const plane = new Set(dataset.objects.map((o) => `${o.type}:${o.id}`))
      // M1-C：扩图（expand）——种子逐实例授权（explore 读面口径，与工具面同）
      for (const seed of request.seedIds ?? []) {
        const o = byId.get(String(seed))
        requireBizAuth(
          'expand',
          { type: o?.type ?? '', instance: String(seed) },
          { typeExists: (t) => types.has(t), instanceExists: (t, i) => plane.has(`${t}:${i}`) },
          { analysisMode: 'explore' },
        )
      }
      return expandEntity(dataset, request.seedIds ?? [], {
        ...(request.hops !== undefined ? { hops: request.hops } : {}),
        ...(request.direction !== undefined ? { direction: request.direction } : {}),
        ...(request.relationTypes !== undefined ? { relationTypes: request.relationTypes } : {}),
      })
    })
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
