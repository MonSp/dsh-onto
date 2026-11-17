/**
 * 场景执行器（规范 §9.1/§9.4）：按场景卡 pipeline 做最小步派发。
 *
 * 槽位语义：
 *   DATA_INGEST   数据归一、建图
 *   BEHAVIOR_CALL 行为实例生成与关系聚合
 *   RULE_EVALUATE 规则引擎（order=before-scoring 为排除段，否则打分段）
 *   SKILL_RUN     方法论/叙述（引用 O2 模板，禁认定）
 *   AUDIT_CHECK   三层闭合闸门
 *   HUMAN_REVIEW  人工复核标记
 *
 * 运行时加载前必须过派生门禁（缺 manifest / 指纹不符 → DERIVED_DRIFT 拒绝加载）。
 * 输出永远不含「认定」；humanReviewRequired 恒为 true。
 */
import { randomUUID } from 'node:crypto'
import { collectStrings, runAudit } from './audit.js'
import { readManifest } from './derive.js'
import { deriveFeatures, inferFeatureSources, projectFeatures } from './features.js'
import { verifyDerived } from './loadgate.js'
import {
  applyExclusions,
  fillTemplate,
  referencedFeatures,
  riskLevelOf,
  type RuleEngineConfig,
  type RuleEvalResult,
  scoreCandidates,
} from './rules.js'
import { loadPackage } from './store.js'
import { expandEntity, MAX_EXPAND_HOPS } from './subgraph.js'
import type {
  CandidateResult,
  ContractStatus,
  DataBasisInput,
  DataStatus,
  FeatureSourceRecord,
  O3ScenarioCard,
  OntologyPackage,
  RuntimeBehaviorInstance,
  RuntimeDataset,
  ScenarioPrepSummary,
  ScenarioRunResult,
} from './types.js'

export class ScenarioRunError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'ScenarioRunError'
    this.code = code
  }
}

/** runScenario 第 4 参：seedIds 圈定 + 可注入 now（兼容旧 now 函数直传）。 */
export interface ScenarioRunOptions {
  /** 种子实体 ID（≤32）；场景未声明 prep.expand 时传入 → INVALID_ARGS。 */
  seedIds?: string[]
  /** 可测注入位（与 ruleHitLog 同源）；缺省 = new Date()。 */
  now?: () => Date
  /**
   * R5 特征执行模式：
   * - `explore`（缺省，探索分析）：保留条件性计算（不改打分公式），但无依据特征逐候选降级、
   *   不得显示复算通过；
   * - `formal`（正式可信分析）：无依据特征不参与计算（跳过，由规则引擎按缺失特征待核实）。
   */
  analysisMode?: 'formal' | 'explore'
  /**
   * 取数上下文（M1-B）：服务端连接器取数时随数据集传入（含快照核验结论）；
   * 缺省 = 来源未声明。调用方自称 provenance=connector 而无 basis → 不按可信来源算
   * （伪造来源拒绝，不得 verified）。
   */
  dataBasis?: DataBasisInput
}

/**
 * 从派生配置提取规则引擎配置。
 * v1.1 引用位参与运行收窄：场景带 `exclusionRefs` / `scoreRefs` 时只执行圈内规则
 * （缺省 = 全部）——此前排除与打分均全量执行，与「显式数组 = 限定范围」口径冲突
 * （D7 排除段 / D13 打分段；打分收窄另使范围外规则不再因缺特征刷待核实）。
 */
export function ruleEngineConfigOf(pkg: OntologyPackage, scenario?: O3ScenarioCard): RuleEngineConfig {
  const exRefs = scenario?.exclusionRefs
  const exclusions = exRefs ? pkg.exclusionRules.filter((r) => exRefs.includes(r.id)) : pkg.exclusionRules
  const scRefs = scenario?.scoreRefs
  const scorings = scRefs ? pkg.scoreRules.filter((r) => scRefs.includes(r.id)) : pkg.scoreRules
  return {
    exclusion: exclusions.map((r) => ({
      id: r.id,
      name: r.name,
      action: r.action,
      factor: r.factor ?? null,
      condition: r.condition,
    })),
    scoring: scorings.map((r) => ({
      id: r.id,
      name: r.name,
      weight: r.weight,
      expression: r.expression,
      threshold: r.threshold ?? null,
      evidenceTemplate: r.evidenceTemplate ?? null,
    })),
  }
}

/**
 * 执行一个场景。`versionDir` 是包版本目录。
 * 流程：门禁 → 建图 → [prep: expand→project→derive] → 行为 → 排除 → 打分 → 叙述 → 审计 → 人审。
 *
 * 第 4 参兼容两种形态：`ScenarioRunOptions` 或旧签名的 `now` 函数。
 * 无 prep / 未传 seedIds → 与现状逐字节一致（回归断言）。
 */
export function runScenario(
  versionDir: string,
  scenarioId: string,
  dataset: RuntimeDataset,
  optsOrNow?: ScenarioRunOptions | (() => Date),
): ScenarioRunResult {
  const opts: ScenarioRunOptions =
    typeof optsOrNow === 'function' ? { now: optsOrNow } : (optsOrNow ?? {})
  const now = opts.now ?? (() => new Date())
  const seedIds = opts.seedIds

  /* 0. 运行时加载门禁（§8.1） */
  const gate = verifyDerived(versionDir)
  if (!gate.ok) {
    throw new ScenarioRunError('DERIVED_DRIFT', `拒绝加载: ${gate.reason}`)
  }
  const manifest = readManifest(versionDir)
  if (manifest === null) {
    throw new ScenarioRunError('DERIVED_DRIFT', 'missing manifest')
  }

  const pkg = loadPackage(versionDir)
  const scenario: O3ScenarioCard | undefined = pkg.scenarios.find((s) => s.id === scenarioId)
  if (!scenario) {
    throw new ScenarioRunError('SCENARIO_NOT_FOUND', `场景不存在: ${scenarioId}`)
  }

  /* 入参面（S2.1 语义矩阵）：seedIds 无处落地 → 拒；全部缺失种子 → 受控失败 */
  if (seedIds !== undefined) {
    if (!Array.isArray(seedIds) || seedIds.length === 0 || seedIds.length > 32) {
      throw new ScenarioRunError('INVALID_ARGS', 'seedIds 须为非空数组且 ≤32')
    }
    if (seedIds.some((s) => typeof s !== 'string' || s === '')) {
      throw new ScenarioRunError('INVALID_ARGS', 'seedIds 须为非空字符串条目')
    }
    if (!scenario.prep?.expand) {
      throw new ScenarioRunError('INVALID_ARGS', `场景 ${scenarioId} 未声明 prep.expand，无法应用 seedIds`)
    }
  }

  const startedAt = now().toISOString()
  // since 派生基准与 startedAt 同源单次捕获（评审缺陷4）：回放可还原计算条件。
  const sinceBasis = startedAt
  const runId = `run-${randomUUID().slice(0, 8)}`
  const config = ruleEngineConfigOf(pkg, scenario)

  /* ── prep（S2.3）：expand → project → derive；必须先于排除/评分 ── */
  let effective: RuntimeDataset = dataset
  let prepSummary: ScenarioPrepSummary | undefined
  let prepApplied = false
  let featureSources: FeatureSourceRecord[] = []
  let featureGovApplied = false
  const prepSourceRecords: FeatureSourceRecord[] = []

  /** R5 特征来源治理：记录逐键来源状态；正式模式剔除无依据特征（prep 开/关同口径）。 */
  const applyFeatureGovernance = (): void => {
    if (featureGovApplied) return
    featureGovApplied = true
    // 推断为底、prep 投影/派生记录为权威（覆盖同键）
    const byKey = new Map<string, FeatureSourceRecord>()
    for (const r of inferFeatureSources(pkg, effective, effective.candidates)) {
      byKey.set(`${r.candidateId}|${r.key}`, r)
    }
    for (const r of prepSourceRecords) byKey.set(`${r.candidateId}|${r.key}`, r)
    featureSources = [...byKey.values()]
    if (opts.analysisMode === 'formal') {
      // 正式可信分析：无依据特征不参与计算（跳过）
      const unverified = new Set(
        featureSources.filter((r) => r.source === 'unverified-caller').map((r) => `${r.candidateId}|${r.key}`),
      )
      let stripped = false
      const nextCandidates = effective.candidates.map((c) => {
        const feats = Object.fromEntries(
          Object.entries(c.features).filter(([k]) => !unverified.has(`${c.candidateId}|${k}`)),
        )
        if (Object.keys(feats).length === Object.keys(c.features).length) return c
        stripped = true
        return { ...c, features: feats }
      })
      if (stripped) effective = { ...effective, candidates: nextCandidates }
    }
  }

  const applyPrep = (): void => {
    if (prepApplied) return
    prepApplied = true
    const prep = scenario.prep
    const wantExpand = seedIds !== undefined && prep?.expand !== undefined
    const wantFeatures = prep?.features === true
    if (wantExpand || wantFeatures) {
      let next = effective
      const summary: ScenarioPrepSummary = {}

      if (wantExpand && seedIds !== undefined && prep?.expand) {
        const expandOpts = {
          ...(prep.expand.hops !== undefined ? { hops: prep.expand.hops } : {}),
          ...(prep.expand.direction !== undefined ? { direction: prep.expand.direction } : {}),
          ...(prep.expand.relationTypes !== undefined ? { relationTypes: prep.expand.relationTypes } : {}),
        }
        const expanded = expandEntity(next, seedIds, expandOpts)
        if (expanded.seedIds.length === 0) {
          throw new ScenarioRunError('INVALID_ARGS', '全部种子缺失，无法扩图')
        }
        next = expanded.dataset
        summary.expanded = {
          seeds: expanded.seedIds,
          hops: Math.min(
            Math.max(0, Math.floor(prep.expand.hops ?? 1)),
            MAX_EXPAND_HOPS,
          ),
          objects: expanded.stats.objects,
          truncated: expanded.truncated,
        }
      }

      if (wantFeatures) {
        const proj = projectFeatures(pkg, next, next.candidates)
        let candidates = proj.candidates
        summary.projectedWrites = proj.projected.reduce((n, p) => n + p.keys.length, 0)
        const overrides = [...proj.overrides]
        prepSourceRecords.push(...proj.sources)
        const recipes = pkg.featureRecipes
        if (recipes !== undefined && recipes.length > 0 && Array.isArray(recipes)) {
          // A-10/缺陷4：包级配方禁 now；执行层注入本轮 sinceBasis（与 startedAt 同源，可回放）。
          const ready = recipes.map((r) =>
            r.kind === 'since' && (r.now === undefined || r.now === null)
              ? { ...r, now: sinceBasis }
              : r,
          )
          const der = deriveFeatures(candidates, next, ready, proj.sources)
          candidates = der.candidates
          summary.derived = der.derived
          summary.sinceBasis = sinceBasis
          overrides.push(...der.overrides)
          prepSourceRecords.push(...der.sources)
        }
        if (overrides.length > 0) summary.featureOverrides = overrides
        next = { ...next, candidates }
      }

      effective = next
      prepSummary = summary
    }
    // R5：来源记录 + 模式治理恒走（prep 开/关同一降级口径）
    applyFeatureGovernance()
  }

  /* pipeline 状态（使用 effective 数据集） */
  let ingestProblems: string[] = []
  const behaviorInstances: RuntimeBehaviorInstance[] = []
  let excluded: RuleEvalResult['excluded'] = []
  const exclusionFeatureGaps: RuleEvalResult['exclusionFeatureGaps'] = []
  let scored: RuleEvalResult | null = null
  let survivors = effective.candidates.map((c) => ({ ...c, weightFactor: 1 }))
  let scoringDone = false
  const resetSurvivors = (): void => {
    survivors = effective.candidates.map((c) => ({ ...c, weightFactor: 1 }))
  }

  /* ── 最小步派发（§9.1）：prep 保证先于任何排除/评分（评审缺陷2） ── */
  // 人审屏障（T2.2）：HUMAN_REVIEW 是硬停点——自动执行越过人审点的步骤不跑，
  // 落 reviewBarrier 留痕待人工放行后再恢复（恢复通道另行交付；现包 HUMAN_REVIEW 均为末步，零回归）。
  let reviewBarrier: { stepId: string; skipped: string[] } | undefined
  for (const [stepIdx, step] of scenario.pipeline.entries()) {
    if (reviewBarrier !== undefined) {
      // AUDIT_CHECK 是输出装配时恒执行的核验（非动作），不计 skipped——
      // 「其后步骤不自动执行」只记真正未执行的步骤
      if (step.stepType !== 'AUDIT_CHECK') reviewBarrier.skipped.push(step.stepId)
      continue
    }
    // 打分/排除段入口：prep 未应用则先做（无 DATA_INGEST / 顺序异常均兜住）
    if (step.stepType === 'RULE_EVALUATE' && !prepApplied) {
      applyPrep()
      resetSurvivors()
    }
    switch (step.stepType) {
      case 'DATA_INGEST': {
        ingestProblems = ingestDataset(pkg, effective)
        // S2.3：正常路径在 DATA_INGEST 完成后立即 prep（非 pipeline 新槽位）。
        applyPrep()
        resetSurvivors()
        break
      }
      case 'BEHAVIOR_CALL': {
        behaviorInstances.push(...materializeBehaviors(pkg, effective, scenario))
        break
      }
      case 'RULE_EVALUATE': {
        if (step.order === 'before-scoring') {
          // 排除段
          const excludedOut: RuleEvalResult['excluded'] = []
          const gaps: RuleEvalResult['exclusionFeatureGaps'] = []
          survivors = applyExclusions(config.exclusion, effective.candidates, excludedOut, gaps)
          excluded = excludedOut
          exclusionFeatureGaps.push(...gaps)
        } else {
          // 打分段
          const out = scoreCandidates(config.scoring, survivors, now)
          scored = {
            candidates: out.candidates,
            excluded,
            ruleHitLog: out.ruleHitLog,
            exclusionFeatureGaps,
          }
          scoringDone = true
        }
        break
      }
      case 'SKILL_RUN': {
        // 叙述步骤在打分后统一装配（依赖 evidenceChains）
        break
      }
      case 'AUDIT_CHECK': {
        // 审计在输出装配后统一执行（依赖完整输出）
        break
      }
      case 'HUMAN_REVIEW': {
        // 人工门禁字段在装配时统一附加；屏障语义（T2.2）：此后步骤不自动执行（skipped 由循环续记）。
        if (stepIdx + 1 < scenario.pipeline.length) {
          reviewBarrier = { stepId: step.stepId, skipped: [] }
        }
        break
      }
      default:
        throw new ScenarioRunError('UNKNOWN_STEP_TYPE', `未知 stepType: ${String(step.stepType)}`)
    }
  }

  // 防御：畸形 pipeline（有 prep 但既无 DATA_INGEST 也无 RULE_EVALUATE）不得静默丢 prep。
  // 正常有打分段时 prep 已在 RULE_EVALUATE 入口强制应用；此处不覆盖「已打分后才补」路径。
  if (!prepApplied && (scenario.prep?.expand !== undefined || scenario.prep?.features === true)) {
    applyPrep()
    resetSurvivors()
  }

  if (!scoringDone || scored === null) {
    // 人审屏障拦住打分段（T2.2）：这不是缺步，是「停在人审点等放行」——显式区分。
    if (reviewBarrier !== undefined) {
      throw new ScenarioRunError(
        'HUMAN_REVIEW_PENDING',
        `场景 ${scenarioId} 停在人审屏障 ${reviewBarrier.stepId}：其后 ${reviewBarrier.skipped.length} 个步骤（含打分）未自动执行——待人工放行后再恢复`,
      )
    }
    throw new ScenarioRunError(
      'PIPELINE_INCOMPLETE',
      `场景 ${scenarioId} 的 pipeline 缺少打分段 RULE_EVALUATE`,
    )
  }

  /* ── 装配候选结果（含 SKILL_RUN 叙述：只用模板，禁认定） ───────────── */
  const skippedSteps = new Set(reviewBarrier?.skipped ?? [])
  const skillRefs = scenario.pipeline
    .filter((s) => s.stepType === 'SKILL_RUN' && !skippedSteps.has(s.stepId))
    .flatMap((s) => s.skillRefs ?? [])
  const skills = pkg.skillTemplates.filter((s) => skillRefs.includes(s.id))

  const candidates: CandidateResult[] = scored.candidates.map((c) => {
    const candInput = effective.candidates.find((x) => x.candidateId === c.candidateId)
    const obj = effective.objects.find((o) => o.id === c.objectRef)
    const objectAttrs: Record<string, unknown> = obj?.attrs ?? {}
    const narrative = buildNarrative(
      skills,
      { ...c },
      candInput?.features ?? {},
      { threshold: scenario.reviewGate.threshold, objectAttrs },
    )
    return {
      candidateId: c.candidateId,
      objectRef: c.objectRef,
      riskScore: c.riskScore,
      riskLevel: riskLevelOf(c.riskScore, scenario.reviewGate.threshold),
      hitRuleIds: c.hitRuleIds,
      evidenceChains: c.evidenceChains,
      narrative,
      pendingChecks: c.pendingChecks,
      pendingVerification: c.pendingVerification,
    }
  })

  // 排除条件特征未投影进 features → 显式待核实（不再静默不匹配）；
  // 存活候选挂 pendingChecks，被 drop 候选的缺口保留在 result.exclusionFeatureGaps（不静默丢弃）
  const allGaps = scored.exclusionFeatureGaps ?? []
  for (const gap of allGaps) {
    const c = candidates.find((x) => x.candidateId === gap.candidateId)
    if (!c) continue
    c.pendingChecks.push({
      ruleId: gap.ruleId,
      missing: gap.missing,
      note: `排除规则 ${gap.ruleId} 条件特征 [${gap.missing.join(', ')}] 不在候选 features——接入层须从对象 attrs 投影，否则该规则对该候选不生效`,
    })
    c.pendingVerification = true
  }

  // 事实覆盖留痕（可信取数 T1.1）：调用方预置特征被对象事实/配方覆盖 → 显式降级提示
  for (const ov of prepSummary?.featureOverrides ?? []) {
    const c = candidates.find((x) => x.candidateId === ov.candidateId)
    if (!c) continue
    c.pendingChecks.push({
      note: `特征 ${ov.key} 的调用方预置值与对象事实冲突，已按事实覆盖（预置值不参与打分）`,
    })
    c.pendingVerification = true
  }

  // 内联数据降级提示（可信取数 T1.2）：未经可信取数核验 → 候选显式待核实（不改分）。
  if (dataset.provenance === 'inline') {
    for (const c of candidates) {
      c.pendingChecks.push({
        note: '数据为调用方内联提交，未经可信取数核验——分数仅在该数据集内自洽',
      })
      c.pendingVerification = true
    }
  }

  // R5：无依据特征逐候选降级——声明契约在而事实缺的预置值不得伪装为可复算事实；
  // 正式模式下被剔除的值同样上墙（来源未声明的旧输入面只留痕，不逐候选降级）。
  for (const rec of featureSources) {
    if (rec.source !== 'unverified-caller') continue
    if (!rec.declared && opts.analysisMode !== 'formal') continue
    const c = candidates.find((x) => x.candidateId === rec.candidateId)
    if (!c) continue
    c.pendingChecks.push({
      note:
        `特征 ${rec.key} 无事实依据（${rec.detail}）——不得视为可复算事实`
        + (opts.analysisMode === 'formal' ? '（正式可信分析：已剔除，不参与评分）' : ''),
    })
    c.pendingVerification = true
  }

  /* ── 输出契约 mustInclude 检查 + 人工复核字段 ─────────────────────── */
  const requireReviewFor = candidates
    .filter((c) => c.riskScore >= scenario.reviewGate.threshold)
    .map((c) => c.candidateId)
  // P-1：includeExcluded=true 时排除件也进人工复核队列（缺省 = 现状，只收有分候选）
  if (scenario.reviewGate.includeExcluded === true) {
    const seen = new Set(requireReviewFor)
    for (const ex of excluded) {
      if (!seen.has(ex.candidateId)) {
        seen.add(ex.candidateId)
        requireReviewFor.push(ex.candidateId)
      }
    }
  }

  // 数据信任提示（可信取数 T1.2）：provenance 未声明 = 来源未声明，不触发信任检查。
  const provenance = dataset.provenance
  const dataTrust =
    provenance === undefined
      ? undefined
      : {
          provenance,
          verified: provenance === 'connector',
          note:
            provenance === 'connector'
              ? '可信取数接口'
              : provenance === 'file'
                ? '工作区数据文件（未经源系统对账）'
                : '内联数据未经可信取数核验——结论仅在该数据集内自洽',
        }

  const result: ScenarioRunResult = {
    scenarioId,
    runId,
    startedAt,
    candidates,
    excluded,
    exclusionFeatureGaps: allGaps,
    humanReviewRequired: true,
    reviewGate: {
      threshold: scenario.reviewGate.threshold,
      required: scenario.reviewGate.required,
      requireReviewFor,
    },
    ruleHitLog: scored.ruleHitLog,
    audit: { checks: [], forbiddenPhraseHits: [], passed: true },
    ...(prepSummary !== undefined ? { prep: prepSummary } : {}),
    ...(reviewBarrier !== undefined ? { reviewBarrier } : {}),
    ...(dataTrust !== undefined ? { dataTrust } : {}),
  }
  if (prepSummary !== undefined || effective !== dataset) {
    // 非枚举：不进 JSON/模型面/RunRecord.result，仅 buildRunRecord 读 effective 双 digest。
    Object.defineProperty(result, 'effectiveDataset', {
      value: effective,
      enumerable: false,
      writable: false,
      configurable: true,
    })
  }

  const mustIncludeSatisfied = checkMustInclude(scenario, result)

  /* ── M1-B dataStatus（先于禁语扫描：待补数备注须进扫描面） ───────── */
  // R5：核验对象 = 本轮实际参与评分/排除的特征（scenario 收窄后的规则引用面）
  const usedFeatureKeys = new Set<string>()
  for (const r of [...config.scoring, ...config.exclusion]) {
    const expr = 'expression' in r ? r.expression : r.condition
    try {
      for (const f of referencedFeatures(expr)) {
        if (f !== 'tag') usedFeatureKeys.add(f)
      }
    } catch {
      /* 语法错误由 validate 拦；运行侧跳过扫描 */
    }
  }
  // 可信来源 = 服务端取数上下文（dataBasis 仅由服务端连接器产线构造）；
  // inline/file 显式标签的通道不得被 basis 升级；自称 provenance=connector 无 basis → 不算可信（伪造来源拒绝）。
  // 对账锚点齐全（snapshotId/sourceId 非空）才算可信来源——dataBasis: {} 不得升级信任（评审 P3）；
  // complete/fresh 显式核验（=== true），缺省 = 未核验（fail-closed，不得缺省为真）。
  const basis = opts.dataBasis
  const sourceVerified =
    basis !== undefined
    && typeof basis.snapshotId === 'string' && basis.snapshotId !== ''
    && typeof basis.sourceId === 'string' && basis.sourceId !== ''
    && provenance !== 'inline' && provenance !== 'file'
  const complete = basis?.complete === true
  const fresh = basis?.fresh === true
  // 必需特征依据全过：本轮实际参与评分/排除的特征逐候选均有可复算来源——
  // 整体缺失（无键、无来源记录）同样是缺依据，不得按 verified/低风险处置（评审 P2）
  const unverifiedUsed = featureSources.filter(
    (rec) => rec.source === 'unverified-caller' && usedFeatureKeys.has(rec.key),
  )
  const featureGapKeys = new Set<string>(unverifiedUsed.map((r) => r.key))
  const provByKey = new Map(featureSources.map((r) => [`${r.candidateId}|${r.key}`, r]))
  for (const c of effective.candidates) {
    for (const key of usedFeatureKeys) {
      if (!provByKey.has(`${c.candidateId}|${key}`)) featureGapKeys.add(key)
    }
  }
  const featuresOk = featureGapKeys.size === 0
  const formal = opts.analysisMode === 'formal'
  let dataStatus: DataStatus
  if (formal) {
    // 正式模式：缺源/超时效/取数不完整/必需特征缺依据 → 不可完成/待补数（不得按低风险处置）
    dataStatus = sourceVerified && complete && fresh && featuresOk ? 'verified' : 'insufficient'
  } else if (!sourceVerified) {
    dataStatus = 'unverified'
  } else if (complete && fresh && featuresOk) {
    dataStatus = 'verified'
  } else {
    dataStatus = 'conditional'
  }
  result.dataStatus = dataStatus
  // formal 依据不足：结果态为待补数——逐候选显式上墙，分数不得被解读为低风险结论
  if (dataStatus === 'insufficient') {
    const gaps: string[] = []
    if (!sourceVerified) gaps.push('缺可信来源')
    if (!complete) gaps.push('取数不完整')
    if (!fresh) gaps.push('数据超时效')
    if (!featuresOk) gaps.push(`必需特征缺依据（${[...featureGapKeys].join('、')}）`)
    for (const c of result.candidates) {
      c.pendingChecks.push({
        note: `正式分析依据不足（${gaps.join('；')}）——结果不可处置，待补数后重跑`,
      })
      c.pendingVerification = true
    }
  }

  /* ── AUDIT_CHECK：三层闭合闸门（§9.3） ────────────────────────────── */
  // 扫描面含 prep（featureOverrides 带调用方字符串）；待补数备注已先上墙再扫描
  const outputStrings = collectStrings(
    {
      candidates: result.candidates,
      excluded: result.excluded,
      reviewGate: result.reviewGate,
      ingestProblems,
      prep: result.prep,
    },
  )
  const audit = runAudit({
    pkg,
    scenario,
    dataset: effective,
    behaviorInstances,
    ruleHitLog: result.ruleHitLog,
    outputStrings,
    mustIncludeSatisfied,
    featureProvenance: featureSources,
    usedFeatures: [...usedFeatureKeys],
  })
  result.audit = { checks: audit.checks, forbiddenPhraseHits: audit.forbiddenPhraseHits, passed: audit.passed }

  /* ── M1-B 三状态：contractStatus（不与 audit.passed 混用） ── */
  const contractStatus: ContractStatus = audit.passed ? 'conformant' : 'non-conformant'
  result.contractStatus = contractStatus

  /* 不闭合 → 降级为「待核实点」（§9.3；非阻断提示项不降级） */
  if (!audit.passed) {
    for (const c of result.candidates) {
      for (const check of audit.checks) {
        if (!check.closed && check.blocking !== false) {
          c.pendingChecks.push({ note: `审计未闭合 ${check.check}: ${check.detail}` })
          c.pendingVerification = true
        }
      }
    }
    if (ingestProblems.length > 0) {
      for (const c of result.candidates) {
        c.pendingChecks.push({ note: `数据归一问题: ${ingestProblems.join('；')}` })
        c.pendingVerification = true
      }
    }
  }

  return result
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 步骤实现
 * ═══════════════════════════════════════════════════════════════════════════ */

/** DATA_INGEST：数据归一、建图（对照 O1 校验实例合法性）。 */
function ingestDataset(pkg: OntologyPackage, dataset: RuntimeDataset): string[] {
  const problems: string[] = []
  const typeIds = new Set(pkg.objects.map((o) => o.id))
  const relIds = new Set(pkg.relations.map((r) => r.id))
  const instanceIds = new Set<string>()
  for (const o of dataset.objects) {
    if (instanceIds.has(o.id)) problems.push(`对象实例 ID 重复: ${o.id}`)
    instanceIds.add(o.id)
    if (!typeIds.has(o.type)) problems.push(`对象 ${o.id} 的类型 ${o.type} 未定义`)
  }
  for (const r of dataset.relations) {
    if (!relIds.has(r.type)) problems.push(`关系 ${r.id} 的类型 ${r.type} 未定义`)
    if (!instanceIds.has(r.from)) problems.push(`关系 ${r.id} 的 from ${r.from} 不在图中`)
    if (!instanceIds.has(r.to)) problems.push(`关系 ${r.id} 的 to ${r.to} 不在图中`)
  }
  return problems
}

/** BEHAVIOR_CALL：行为实例生成与关系聚合（运行时行为记录）；behaviorRefs 显式圈定时只跑圈内（缺省 = 全部）。 */
function materializeBehaviors(
  pkg: OntologyPackage,
  dataset: RuntimeDataset,
  scenario: O3ScenarioCard,
): RuntimeBehaviorInstance[] {
  const refs = scenario.behaviorRefs
  const inScope = refs ? pkg.behaviors.filter((b) => refs.includes(b.id)) : pkg.behaviors
  const behaviorTypeIds = new Set(inScope.map((b) => b.id))
  const out: RuntimeBehaviorInstance[] = []
  for (const b of dataset.behaviors ?? []) {
    if (!behaviorTypeIds.has(b.type)) continue
    out.push({ ...b })
  }
  return out
}

/** SKILL_RUN：方法论叙述——只用模板回填，不引入任何认定性表述。 */
function buildNarrative(
  skills: OntologyPackage['skillTemplates'],
  c: {
    candidateId: string
    objectRef: string
    hitRuleIds: string[]
    riskScore: number
    evidenceChains: Array<{ ruleId: string; evidence: string }>
  },
  features: Record<string, number | string>,
  opts?: { threshold?: number; objectAttrs?: Record<string, unknown> },
): string[] {
  const lines: string[] = []
  const attrs = opts?.objectAttrs ?? {}
  const threshold = opts?.threshold ?? 0.75
  const fillVars: Record<string, number | string> = {
    // 对象 attrs 标量值作模板变量（通用机制；业务字段名如 binNo 不进 core）
    ...Object.fromEntries(
      Object.entries(attrs).filter(
        (e): e is [string, number | string] =>
          typeof e[1] === 'string' || (typeof e[1] === 'number' && Number.isFinite(e[1])),
      ),
    ),
    ...features,
    candidateId: c.candidateId,
    objectRef: c.objectRef,
    // 模板侧两位小数；result.riskScore 仍保持引擎全精度供闸门比较
    riskScore: Number(c.riskScore.toFixed(2)),
    riskLevel: riskLevelOf(c.riskScore, threshold),
    hitCount: c.hitRuleIds.length,
    ruleIds: c.hitRuleIds.join(',') || '无',
  }
  for (const skill of skills) {
    if (skill.outputTemplate) {
      lines.push(fillTemplate(skill.outputTemplate, fillVars))
    }
    for (const step of skill.steps ?? []) {
      lines.push(fillTemplate(step, fillVars))
    }
  }
  for (const e of c.evidenceChains) {
    if (!lines.some((l) => l.includes(e.evidence))) lines.push(e.evidence)
  }
  return lines
}

/** 输出契约必含项检查（§9.4）。 */
function checkMustInclude(scenario: O3ScenarioCard, result: ScenarioRunResult): Record<string, boolean> {
  const sat: Record<string, boolean> = {}
  for (const token of scenario.outputContract.mustInclude) {
    switch (token) {
      case 'candidateList':
        sat[token] = Array.isArray(result.candidates)
        break
      case 'riskScore':
        sat[token] = result.candidates.every((c) => typeof c.riskScore === 'number')
        break
      case 'evidenceChains':
        sat[token] = result.candidates.every((c) => Array.isArray(c.evidenceChains))
        break
      case 'pendingChecks':
        sat[token] = result.candidates.every((c) => Array.isArray(c.pendingChecks))
        break
      case 'hitRuleIds':
        sat[token] = result.candidates.every((c) => Array.isArray(c.hitRuleIds))
        break
      default: {
        // 通用：token 必须出现在输出序列化后的键或值里
        const json = JSON.stringify(result)
        sat[token] = json.includes(token)
        break
      }
    }
  }
  return sat
}
