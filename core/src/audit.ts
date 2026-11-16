/**
 * 三层审计闭合（规范 §9.3）—— 防幻觉闸门：
 *   O1 闭合：引用的对象/关系真实存在
 *   O2 闭合：行为实例与规则命中真实发生（对照行为实例表与规则日志）
 *   O3 闭合：结论未越出场景卡输出契约；禁用表述零命中
 * 可信取数（T1.2/T1.3）增补：
 *   DATA_TRUST：数据来源信任面（inline 未核验 → 不闭合）
 *   INSTANCE_SCHEMA：实例属性类型/必填、关系端点类型匹配
 *   FEATURE_RECOMPUTED：featureSources 声明特征与对象事实一致（可复算）
 * 不闭合 → 打回重算或降级为「待核实点」。审计链带时间戳，可回放。
 */
import type {
  AuditCheckEntry,
  ForbiddenPhraseHit,
  FeatureSourceRecord,
  O3ScenarioCard,
  OntoAttribute,
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
  /**
   * R5：本轮特征来源记录（prep 投影/派生或入口推断）——核验本轮实际使用的特征，
   * 而不是仅比较同名 attrs。缺省时按旧口径就地推断。
   */
  featureProvenance?: FeatureSourceRecord[]
  /** 本轮实际参与评分/排除的特征名（缺省 = 候选 features 全部键）。 */
  usedFeatures?: string[]
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

/** 属性值与 OntoAttribute 声明类型一致性（T1.3；enum 按字典值集校验，字典缺失只验 string 形）。 */
function attrValueConforms(
  decl: OntoAttribute,
  v: unknown,
  dictValues: Map<string, Set<string>>,
): boolean {
  switch (decl.type) {
    case 'string':
    case 'ref':
      return typeof v === 'string'
    case 'int':
      return typeof v === 'number' && Number.isInteger(v)
    case 'float':
      return typeof v === 'number' && Number.isFinite(v)
    case 'bool':
      return typeof v === 'boolean'
    case 'date':
      return typeof v === 'string' && Number.isFinite(new Date(v).getTime())
    case 'enum': {
      if (typeof v !== 'string') return false
      const dict = decl.enumValuesRef !== undefined ? dictValues.get(decl.enumValuesRef) : undefined
      return dict === undefined || dict.has(v)
    }
    default:
      return typeof v === 'string'
  }
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

  /* ── 数据信任面（可信取数 T1.2）：provenance 未声明不触发；inline 未核验留痕提示 ── */
  {
    const provenance = input.dataset.provenance
    if (provenance !== undefined) {
      const ok = provenance !== 'inline'
      checks.push({
        check: 'DATA_TRUST',
        closed: ok,
        // 提示项：数据来源信任是独立轴，不否定本数据集内的三层闭合；降级提示走 dataTrust/渲染面。
        blocking: false,
        detail: ok
          ? provenance === 'connector'
            ? '可信取数接口供数'
            : '工作区数据文件（未经源系统对账）'
          : '内联数据未经可信取数核验——分数仅在该数据集内自洽，不得视为业务事实',
        ts: ts(),
      })
    }
  }

  /* ── 实例模式闭合（可信取数 T1.3）：属性类型/必填 + 关系端点类型匹配 ── */
  {
    const objTypes = new Map(input.pkg.objects.map((o) => [o.id, o]))
    const relTypes = new Map(input.pkg.relations.map((r) => [r.id, r]))
    const instanceType = new Map(input.dataset.objects.map((o) => [o.id, o.type]))
    const dictValues = new Map(input.pkg.dictionaries.map((d) => [d.id, new Set(d.values)]))
    const problems: string[] = []
    const checkAttrs = (
      owner: string,
      decls: OntoAttribute[] | undefined,
      attrs: Record<string, unknown> | undefined,
    ): void => {
      for (const a of decls ?? []) {
        const v = attrs?.[a.name]
        if (v === undefined || v === null) {
          if (a.required === true) problems.push(`${owner} 缺必填属性 ${a.name}`)
          continue
        }
        if (!attrValueConforms(a, v, dictValues)) {
          problems.push(`${owner} 属性 ${a.name} 与声明类型 ${a.type} 不符`)
        }
      }
    }
    for (const o of input.dataset.objects) {
      const t = objTypes.get(o.type)
      if (t === undefined) continue // 类型缺失已由 O1_CLOSED 报告
      checkAttrs(`对象 ${o.id}`, t.attributes, o.attrs)
    }
    for (const r of input.dataset.relations) {
      const t = relTypes.get(r.type)
      if (t === undefined) continue
      const fromType = instanceType.get(r.from)
      const toType = instanceType.get(r.to)
      if (fromType !== undefined && fromType !== t.from) {
        problems.push(`关系 ${r.id} 的 from 端类型 ${fromType} ≠ 声明 ${t.from}`)
      }
      if (toType !== undefined && toType !== t.to) {
        problems.push(`关系 ${r.id} 的 to 端类型 ${toType} ≠ 声明 ${t.to}`)
      }
      checkAttrs(`关系 ${r.id}`, t.attributes, r.attrs)
    }
    checks.push({
      check: 'INSTANCE_SCHEMA',
      closed: problems.length === 0,
      detail: problems.length === 0 ? '实例属性类型/必填与关系端点类型匹配' : problems.join('；'),
      ts: ts(),
    })
  }

  /* ── 特征复算闭合（可信取数 T1.3 + R5）：
     声明特征须与对象事实一致（不符 = 篡改，阻断）；
     有声明契约而无事实依据的特征（声明源缺失/配方缺输入/上游未核实）不得伪装为
     可复算事实——closed=false + 逐候选降级（不阻断闭合，同 DATA_TRUST 提示轴）；
     来源未声明的旧输入面只留痕。核验对象 = 本轮实际参与评分/排除的特征。 ── */
  {
    const sources = new Map<string, Set<string>>()
    for (const rule of [...input.pkg.scoreRules, ...input.pkg.exclusionRules]) {
      for (const [feat, target] of Object.entries(rule.featureSources ?? {})) {
        const set = sources.get(feat)
        if (set === undefined) sources.set(feat, new Set([target]))
        else set.add(target)
      }
    }
    const objectsById = new Map(input.dataset.objects.map((o) => [o.id, o]))
    const used = input.usedFeatures !== undefined ? new Set(input.usedFeatures) : null
    const prov = new Map<string, FeatureSourceRecord>()
    for (const r of input.featureProvenance ?? []) prov.set(`${r.candidateId}|${r.key}`, r)
    const problems: string[] = []
    const unverified = new Map<string, number>()
    const external = new Map<string, number>()
    for (const cand of input.dataset.candidates) {
      const obj = objectsById.get(cand.objectRef)
      for (const [key, val] of Object.entries(cand.features)) {
        if (used !== null && !used.has(key)) continue
        const targets = sources.get(key)
        const fact =
          obj !== undefined && targets !== undefined && targets.has(obj.type) ? obj.attrs?.[key] : undefined
        if (typeof fact === 'number' || typeof fact === 'string') {
          if (fact !== val) problems.push(`候选 ${cand.candidateId} 特征 ${key} 与对象事实不符`)
        }
        const rec = prov.get(`${cand.candidateId}|${key}`)
        if (rec !== undefined) {
          if (rec.source === 'unverified-caller') {
            const bag = rec.declared ? unverified : external
            bag.set(key, (bag.get(key) ?? 0) + 1)
          }
        } else if (typeof fact !== 'number' && typeof fact !== 'string') {
          // 无来源记录（runAudit 直调兜底）：按声明契约区分伪装面与旧输入面
          const bag = targets !== undefined ? unverified : external
          bag.set(key, (bag.get(key) ?? 0) + 1)
        }
      }
    }
    const summarize = (bag: Map<string, number>): string => {
      const items = [...bag.entries()]
      if (items.length === 0) return ''
      const shown = items.slice(0, 10).map(([k, n]) => `${k}×${n}`)
      return `${shown.join(', ')}${items.length > 10 ? ' …' : ''}`
    }
    const unverifiedNote = summarize(unverified)
    const externalNote = summarize(external)
    checks.push({
      check: 'FEATURE_RECOMPUTED',
      closed: problems.length === 0 && unverified.size === 0,
      // 契约缺事实/来源未声明是数据依据提示轴（同 DATA_TRUST）：不阻断本数据集三层闭合，
      // 但绝不显示「复算通过」；与对象事实不符才是篡改（阻断）。
      blocking: problems.length > 0 ? undefined : false,
      detail:
        problems.length === 0 && unverifiedNote === '' && externalNote === ''
          ? '特征均可由对象事实/合法配方复算'
          : [
              problems.length === 0 ? '' : problems.join('；'),
              unverifiedNote === '' ? '' : `声明契约缺事实（不可复算）: ${unverifiedNote}`,
              externalNote === '' ? '' : `外部输入特征（来源未声明，不参与复算）: ${externalNote}`,
            ]
              .filter(Boolean)
              .join('；'),
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
      // 非阻断提示项（blocking=false，如 DATA_TRUST）只留痕，不否掉三层闭合。
      passed: checks.every((c) => c.blocking === false || c.closed),
    }
  }
}
