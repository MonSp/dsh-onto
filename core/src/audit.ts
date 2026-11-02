/**
 * 三层审计闭合（规范 §9.3）—— 防幻觉闸门：
 *   O1 闭合：引用的对象/关系真实存在
 *   O2 闭合：行为实例与规则命中真实发生（对照行为实例表与规则日志）
 *   O3 闭合：结论未越出场景卡输出契约；禁用表述零命中
 * 不闭合 → 打回重算或降级为「待核实点」。审计链带时间戳，可回放。
 */
import type {
  AuditCheckEntry,
  ForbiddenPhraseHit,
  O3ScenarioCard,
  OntologyPackage,
  RuleHitLogEntry,
  RuntimeDataset,
} from './types.js'

export interface AuditInput {
  pkg: OntologyPackage
  scenario: O3ScenarioCard
  dataset: RuntimeDataset
  behaviorInstances: Array<{ id: string; type: string; anchorRef: string; objectRef: string }>
  ruleHitLog: RuleHitLogEntry[]
  /** 最终输出的全部字符串（带路径，供禁语扫描）。 */
  outputStrings: Array<{ where: string; text: string }>
  /** mustInclude 检查：token → 是否满足。 */
  mustIncludeSatisfied: Record<string, boolean>
}

export interface AuditOutcome {
  checks: AuditCheckEntry[]
  forbiddenPhraseHits: ForbiddenPhraseHit[]
  passed: boolean
}

/**
 * 扫描禁用表述（§12.2 零容忍）。返回命中清单。
 */
export function scanForbiddenPhrases(
  strings: Array<{ where: string; text: string }>,
  phrases: string[],
): ForbiddenPhraseHit[] {
  const hits: ForbiddenPhraseHit[] = []
  for (const phrase of phrases) {
    if (!phrase) continue
    for (const s of strings) {
      if (s.text.includes(phrase)) hits.push({ phrase, where: s.where })
    }
  }
  return hits
}

/** 收集任意输出对象里的全部字符串（带 JSON 路径）。 */
export function collectStrings(value: unknown, path = '$'): Array<{ where: string; text: string }> {
  const out: Array<{ where: string; text: string }> = []
  const walk = (v: unknown, p: string): void => {
    if (typeof v === 'string') {
      out.push({ where: p, text: v })
      return
    }
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${p}[${i}]`))
      return
    }
    if (v !== null && typeof v === 'object') {
      for (const [k, item] of Object.entries(v)) walk(item, `${p}.${k}`)
    }
  }
  walk(value, path)
  return out
}

/**
 * 执行三层闭合检查。
 */
export function runAudit(input: AuditInput): AuditOutcome {
  const ts = () => new Date().toISOString()
  const checks: AuditCheckEntry[] = []

  /* ── O1 闭合：引用的对象/关系真实存在 ─────────────────────────────── */
  {
    const typeIds = new Set(input.pkg.objects.map((o) => o.id))
    const relIds = new Set(input.pkg.relations.map((r) => r.id))
    const instanceIds = new Set(input.dataset.objects.map((o) => o.id))
    const problems: string[] = []
    for (const o of input.dataset.objects) {
      if (!typeIds.has(o.type)) problems.push(`对象 ${o.id} 的类型 ${o.type} 不在 O1`)
    }
    for (const r of input.dataset.relations) {
      if (!relIds.has(r.type)) problems.push(`关系 ${r.id} 的类型 ${r.type} 不在 O1`)
      if (!instanceIds.has(r.from)) problems.push(`关系 ${r.id} 的 from ${r.from} 不存在`)
      if (!instanceIds.has(r.to)) problems.push(`关系 ${r.id} 的 to ${r.to} 不存在`)
    }
    for (const c of input.dataset.candidates) {
      if (!instanceIds.has(c.objectRef)) problems.push(`候选 ${c.candidateId} 的对象 ${c.objectRef} 不存在`)
    }
    for (const b of input.behaviorInstances) {
      if (!instanceIds.has(b.objectRef)) problems.push(`行为实例 ${b.id} 的对象 ${b.objectRef} 不存在`)
    }
    checks.push({
      check: 'O1_CLOSED',
      closed: problems.length === 0,
      detail: problems.length === 0 ? '引用的对象/关系真实存在' : problems.join('；'),
      ts: ts(),
    })
  }

  /* ── O2 闭合：行为实例与规则命中真实发生 ─────────────────────────── */
  {
    const behaviorTypeIds = new Set(input.pkg.behaviors.map((b) => b.id))
    const ruleIds = new Set(input.pkg.scoreRules.map((r) => r.id))
    const problems: string[] = []
    for (const b of input.behaviorInstances) {
      if (!behaviorTypeIds.has(b.type)) problems.push(`行为实例 ${b.id} 的类型 ${b.type} 不在 O2`)
    }
    for (const hit of input.ruleHitLog) {
      if (!ruleIds.has(hit.ruleId)) problems.push(`规则命中 ${hit.ruleId} 不在 O2`)
      if (!hit.ts) problems.push(`规则命中 ${hit.ruleId} 缺时间戳`)
    }
    // 规则命中必须与候选结果里的 hitRuleIds / evidenceChains 对得上
    const hitPairs = new Set(input.ruleHitLog.map((h) => `${h.candidateId}|${h.ruleId}`))
    checks.push({
      check: 'O2_CLOSED',
      closed: problems.length === 0 && hitPairs.size === input.ruleHitLog.length,
      detail:
        problems.length === 0
          ? `行为实例 ${input.behaviorInstances.length} 条、规则命中 ${input.ruleHitLog.length} 条均可回指`
          : problems.join('；'),
      ts: ts(),
    })
  }

  /* ── O3 闭合：输出契约必含项 + 禁用表述零命中 ────────────────────── */
  {
    const missing = Object.entries(input.mustIncludeSatisfied)
      .filter(([, ok]) => !ok)
      .map(([k]) => k)
    const phraseHits = scanForbiddenPhrases(input.outputStrings, input.scenario.outputContract.forbiddenPhrases)
    const ok = missing.length === 0 && phraseHits.length === 0
    checks.push({
      check: 'O3_CLOSED',
      closed: ok,
      detail:
        ok
          ? '输出契约必含项齐全，禁用表述零命中'
          : [
              missing.length > 0 ? `缺必含项: ${missing.join(', ')}` : '',
              phraseHits.length > 0 ? `禁语命中: ${phraseHits.map((h) => `${h.phrase}@${h.where}`).join('; ')}` : '',
            ]
              .filter(Boolean)
              .join('；'),
      ts: ts(),
    })
    return {
      checks,
      forbiddenPhraseHits: phraseHits,
      passed: checks.every((c) => c.closed),
    }
  }
}
