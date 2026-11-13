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
import { verifyDerived } from './loadgate.js'
import {
  applyExclusions,
  fillTemplate,
  riskLevelOf,
  type RuleEngineConfig,
  type RuleEvalResult,
  scoreCandidates,
} from './rules.js'
import { loadPackage } from './store.js'
import type {
  CandidateResult,
  O3ScenarioCard,
  OntologyPackage,
  RuntimeBehaviorInstance,
  RuntimeDataset,
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
 * 流程：门禁 → 建图 → 行为 → 排除 → 打分 → 叙述 → 审计 → 人工复核字段。
 */
export function runScenario(
  versionDir: string,
  scenarioId: string,
  dataset: RuntimeDataset,
  now: () => Date = () => new Date(),
): ScenarioRunResult {
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

  const startedAt = now().toISOString()
  const runId = `run-${randomUUID().slice(0, 8)}`
  const config = ruleEngineConfigOf(pkg, scenario)

  /* pipeline 状态 */
  let ingestProblems: string[] = []
  const behaviorInstances: RuntimeBehaviorInstance[] = []
  let excluded: RuleEvalResult['excluded'] = []
  const exclusionFeatureGaps: RuleEvalResult['exclusionFeatureGaps'] = []
  let scored: RuleEvalResult | null = null
  let survivors = dataset.candidates.map((c) => ({ ...c, weightFactor: 1 }))
  let scoringDone = false

  /* ── 最小步派发（§9.1 编排载体 = 场景解释器，不另起重型工作流引擎） ── */
  for (const step of scenario.pipeline) {
    switch (step.stepType) {
      case 'DATA_INGEST': {
        ingestProblems = ingestDataset(pkg, dataset)
        break
      }
      case 'BEHAVIOR_CALL': {
        behaviorInstances.push(...materializeBehaviors(pkg, dataset, scenario))
        break
      }
      case 'RULE_EVALUATE': {
        if (step.order === 'before-scoring') {
          // 排除段
          const excludedOut: RuleEvalResult['excluded'] = []
          const gaps: RuleEvalResult['exclusionFeatureGaps'] = []
          survivors = applyExclusions(config.exclusion, dataset.candidates, excludedOut, gaps)
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
        // 人工门禁字段在装配时统一附加
        break
      }
      default:
        throw new ScenarioRunError('UNKNOWN_STEP_TYPE', `未知 stepType: ${String(step.stepType)}`)
    }
  }

  if (!scoringDone || scored === null) {
    throw new ScenarioRunError(
      'PIPELINE_INCOMPLETE',
      `场景 ${scenarioId} 的 pipeline 缺少打分段 RULE_EVALUATE`,
    )
  }

  /* ── 装配候选结果（含 SKILL_RUN 叙述：只用模板，禁认定） ───────────── */
  const skillRefs = scenario.pipeline
    .filter((s) => s.stepType === 'SKILL_RUN')
    .flatMap((s) => s.skillRefs ?? [])
  const skills = pkg.skillTemplates.filter((s) => skillRefs.includes(s.id))

  const candidates: CandidateResult[] = scored.candidates.map((c) => {
    const candInput = dataset.candidates.find((x) => x.candidateId === c.candidateId)
    const obj = dataset.objects.find((o) => o.id === c.objectRef)
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

  // P0-3：排除条件特征未投影进 features → 显式待核实（不再静默不匹配）
  for (const gap of scored.exclusionFeatureGaps ?? []) {
    const c = candidates.find((x) => x.candidateId === gap.candidateId)
    if (!c) continue
    c.pendingChecks.push({
      ruleId: gap.ruleId,
      missing: gap.missing,
      note: `排除规则 ${gap.ruleId} 条件特征 [${gap.missing.join(', ')}] 不在候选 features——接入层须从对象 attrs 投影（P0-3），否则该规则对该候选不生效`,
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

  const result: ScenarioRunResult = {
    scenarioId,
    runId,
    startedAt,
    candidates,
    excluded,
    humanReviewRequired: true,
    reviewGate: {
      threshold: scenario.reviewGate.threshold,
      required: scenario.reviewGate.required,
      requireReviewFor,
    },
    ruleHitLog: scored.ruleHitLog,
    audit: { checks: [], forbiddenPhraseHits: [], passed: true },
  }

  const mustIncludeSatisfied = checkMustInclude(scenario, result)

  /* ── AUDIT_CHECK：三层闭合闸门（§9.3） ────────────────────────────── */
  const outputStrings = collectStrings(
    { candidates: result.candidates, excluded: result.excluded, reviewGate: result.reviewGate, ingestProblems },
  )
  const audit = runAudit({
    pkg,
    scenario,
    dataset,
    behaviorInstances,
    ruleHitLog: result.ruleHitLog,
    outputStrings,
    mustIncludeSatisfied,
  })
  result.audit = { checks: audit.checks, forbiddenPhraseHits: audit.forbiddenPhraseHits, passed: audit.passed }

  /* 不闭合 → 降级为「待核实点」（§9.3） */
  if (!audit.passed) {
    for (const c of result.candidates) {
      for (const check of audit.checks) {
        if (!check.closed) {
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
  const binNo = typeof attrs['binNo'] === 'string' ? attrs['binNo'] : (features['binNo'] ?? c.objectRef)
  const threshold = opts?.threshold ?? 0.75
  const fillVars: Record<string, number | string> = {
    ...features,
    candidateId: c.candidateId,
    objectRef: c.objectRef,
    // 模板侧两位小数；result.riskScore 仍保持引擎全精度供闸门比较
    riskScore: Number(c.riskScore.toFixed(2)),
    riskLevel: riskLevelOf(c.riskScore, threshold),
    binNo: String(binNo),
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
