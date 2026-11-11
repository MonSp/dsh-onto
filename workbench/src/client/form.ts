/* ═══════════════════════════════════════════════════════════════
 * 建模 —— 元素表格 + 编辑/删除 + YAML 通道 + pipeline 可视化
 * ═══════════════════════════════════════════════════════════════ */

import { t } from './i18n'

export type ElemKind =
  | 'objects'
  | 'relations'
  | 'behaviors'
  | 'scoreRules'
  | 'exclusionRules'
  | 'scenarios'

export const ELEM_LABEL: Record<ElemKind, string> = {
  objects: 'objects',
  relations: 'relations',
  behaviors: 'behaviors',
  scoreRules: 'scoreRules',
  exclusionRules: 'exclusionRules',
  scenarios: 'scenarios',
}

/** 元素编辑状态：idx = -1 表示新增。data 全部为字符串原始值。 */
export interface ElemEdit {
  kind: ElemKind
  idx: number
  data: Record<string, string>
}

export function lines(v: string): string[] {
  return v.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
}

export function csv(v: string): string[] {
  return v.split(/[,\n]/).map((s) => s.trim()).filter(Boolean)
}

/**
 * 属性 ↔ 行文本：`name:type` 或 `name:type:{扩展 JSON}`。
 * 扩展字段（enumValuesRef/refObject/required/description 等）无损往返，编辑保存不丢字段。
 * name/type 段转义 `\ : 换行`，含这些字符的属性名也能无损往返。
 */
export function escapeAttrSeg(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/\r/g, '\\r').replace(/\n/g, '\\n')
}

export function unescapeAttrSeg(s: string): string {
  return s.replace(/\\([:\\rn])/g, (_, c: string) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c))
}

/** 找第一个未转义的 sep 位置（\x 成对跳过）。 */
export function splitUnescaped(s: string, sep = ':'): number {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') {
      i++
      continue
    }
    if (s[i] === sep) return i
  }
  return -1
}

export function attrsToLines(attrs: unknown): string {
  return ((attrs as Array<Record<string, unknown>>) ?? [])
    .map((a) => {
      const rec = { ...(a as Record<string, unknown>) }
      const name = escapeAttrSeg(String(rec['name'] ?? ''))
      const type = escapeAttrSeg(String(rec['type'] ?? 'string'))
      delete rec['name']
      delete rec['type']
      return Object.keys(rec).length > 0 ? `${name}:${type}:${JSON.stringify(rec)}` : `${name}:${type}`
    })
    .join('\n')
}

export function linesToAttrs(raw: string): Array<Record<string, unknown>> {
  return lines(raw).map((line) => {
    const i = splitUnescaped(line)
    if (i < 0) return { name: unescapeAttrSeg(line.trim()), type: 'string' }
    const name = unescapeAttrSeg(line.slice(0, i).trim())
    const rest = line.slice(i + 1)
    const j = splitUnescaped(rest)
    if (j < 0) return { name, type: unescapeAttrSeg(rest.trim()) || 'string' }
    const type = unescapeAttrSeg(rest.slice(0, j).trim()) || 'string'
    let extra: unknown
    try {
      extra = JSON.parse(rest.slice(j + 1))
    } catch {
      throw new Error(`${t('errAttrExtra')}: ${line.slice(0, 60)}`)
    }
    if (!extra || typeof extra !== 'object' || Array.isArray(extra)) {
      throw new Error(`${t('errAttrExtra')}: ${line.slice(0, 60)}`)
    }
    const fields: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(extra as Record<string, unknown>)) {
      if (k !== 'name' && k !== 'type') fields[k] = v
    }
    return { name, type, ...fields }
  })
}

/** 元素 → 表单字符串。 */
export function toFormData(kind: ElemKind, el: Record<string, unknown>): Record<string, string> {
  const d: Record<string, string> = {
    id: String(el['id'] ?? ''),
    name: String(el['name'] ?? ''),
  }
  if (kind === 'objects') {
    d['idRule'] = String(el['idRule'] ?? '')
    d['attributes'] = attrsToLines(el['attributes'])
    d['lifecycle'] = ((el['lifecycle'] as string[]) ?? []).join('\n')
    d['description'] = String(el['description'] ?? '')
  } else if (kind === 'relations') {
    d['from'] = String(el['from'] ?? '')
    d['to'] = String(el['to'] ?? '')
    d['attributes'] = attrsToLines(el['attributes'])
    d['description'] = String(el['description'] ?? '')
  } else if (kind === 'behaviors') {
    d['anchor'] = String(el['anchor'] ?? '')
    d['relations'] = ((el['relations'] as string[]) ?? []).join('\n')
    d['states'] = ((el['states'] as string[]) ?? []).join('\n')
    d['trigger'] = String(el['trigger'] ?? '')
    d['description'] = String(el['description'] ?? '')
  } else if (kind === 'scoreRules') {
    d['weight'] = String(el['weight'] ?? 0)
    d['expression'] = String(el['expression'] ?? '')
    d['threshold'] = el['threshold'] === undefined || el['threshold'] === null ? '' : String(el['threshold'])
    d['evidenceTemplate'] = String(el['evidenceTemplate'] ?? '')
    d['description'] = String(el['description'] ?? '')
  } else if (kind === 'exclusionRules') {
    d['action'] = String(el['action'] ?? 'drop')
    d['factor'] = el['factor'] === undefined || el['factor'] === null ? '' : String(el['factor'])
    d['condition'] = String(el['condition'] ?? '')
    d['description'] = String(el['description'] ?? '')
  } else if (kind === 'scenarios') {
    d['goal'] = String(el['goal'] ?? '')
    d['boundary'] = String(el['boundary'] ?? '')
    d['inputs'] = JSON.stringify(el['inputs'] ?? [], null, 2)
    d['outputs'] = ((el['outputs'] as { fields?: string[] })?.fields ?? []).join('\n')
    d['pipeline'] = JSON.stringify(el['pipeline'] ?? [], null, 2)
    const oc = (el['outputContract'] ?? {}) as { mustInclude?: string[]; forbiddenPhrases?: string[] }
    d['mustInclude'] = (oc.mustInclude ?? []).join('\n')
    d['forbiddenPhrases'] = (oc.forbiddenPhrases ?? []).join('\n')
    const rg = (el['reviewGate'] ?? {}) as { required?: boolean; threshold?: number }
    d['reviewRequired'] = rg.required === false ? 'no' : 'yes'
    d['reviewThreshold'] = String(rg.threshold ?? 0.75)
    d['auditChecks'] = ((el['auditChecks'] as string[]) ?? []).join('\n')
  }
  return d
}

/** 解析非空有限数字；非法返回 null（调用方报错拒绝保存）。 */
export function numOrNull(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

export function parseJsonField(raw: string, fallback: string): unknown {
  try {
    return JSON.parse(raw || fallback)
  } catch {
    throw new Error(`${t('errInvalidJson')}: ${raw.slice(0, 80)}`)
  }
}

/** 表单字符串 → 元素对象；校验失败 throw，由 doSaveEdit 展示。 */
export function fromFormData(kind: ElemKind, d: Record<string, string>): Record<string, unknown> {
  const el: Record<string, unknown> = { id: d['id']?.trim(), name: d['name']?.trim() }
  if (kind === 'objects') {
    if (d['idRule']?.trim()) el['idRule'] = d['idRule'].trim()
    el['attributes'] = linesToAttrs(d['attributes'] ?? '')
    if (lines(d['lifecycle'] ?? '').length > 0) el['lifecycle'] = lines(d['lifecycle'])
    if (d['description']?.trim()) el['description'] = d['description'].trim()
  } else if (kind === 'relations') {
    el['from'] = d['from']?.trim() ?? ''
    el['to'] = d['to']?.trim() ?? ''
    const relAttrs = linesToAttrs(d['attributes'] ?? '')
    if (relAttrs.length > 0) el['attributes'] = relAttrs
    if (d['description']?.trim()) el['description'] = d['description'].trim()
  } else if (kind === 'behaviors') {
    el['anchor'] = d['anchor']?.trim() ?? ''
    if (lines(d['relations'] ?? '').length) el['relations'] = lines(d['relations'])
    if (lines(d['states'] ?? '').length) el['states'] = lines(d['states'])
    if (d['trigger']?.trim()) el['trigger'] = d['trigger'].trim()
    if (d['description']?.trim()) el['description'] = d['description'].trim()
  } else if (kind === 'scoreRules') {
    const weight = numOrNull(d['weight'])
    if (weight === null) throw new Error(`${t('weight')} ${t('errFinite')}`)
    el['weight'] = weight
    el['expression'] = d['expression'] ?? ''
    if (d['threshold'] !== '' && d['threshold'] !== undefined) {
      const th = numOrNull(d['threshold'])
      if (th === null) throw new Error(`${t('threshold')} ${t('errFinite')}`)
      el['threshold'] = th
    }
    if (d['evidenceTemplate']?.trim()) el['evidenceTemplate'] = d['evidenceTemplate'].trim()
    if (d['description']?.trim()) el['description'] = d['description'].trim()
  } else if (kind === 'exclusionRules') {
    el['action'] = d['action'] === 'downweight' ? 'downweight' : 'drop'
    if (d['factor'] !== '' && d['factor'] !== undefined) {
      const f = numOrNull(d['factor'])
      if (f === null) throw new Error(`${t('factor')} ${t('errFinite')}`)
      el['factor'] = f
    }
    el['condition'] = d['condition'] ?? ''
    if (d['description']?.trim()) el['description'] = d['description'].trim()
  } else if (kind === 'scenarios') {
    el['goal'] = d['goal'] ?? ''
    el['boundary'] = d['boundary'] ?? ''
    const inputs = parseJsonField(d['inputs'] ?? '', '[]')
    if (!Array.isArray(inputs)) throw new Error(`${t('inputs')} ${t('errMustBeArray')}`)
    el['inputs'] = inputs
    el['outputs'] = { fields: csv(d['outputs'] ?? '') }
    const pipeline = parseJsonField(d['pipeline'] ?? '', '[]')
    if (!Array.isArray(pipeline)) throw new Error(`${t('pipeline')} ${t('errMustBeArray')}`)
    el['pipeline'] = pipeline
    el['outputContract'] = {
      mustInclude: lines(d['mustInclude'] ?? ''),
      forbiddenPhrases: lines(d['forbiddenPhrases'] ?? ''),
    }
    let th = 0.75
    const thrRaw = d['reviewThreshold']
    if (thrRaw !== undefined && thrRaw.trim() !== '') {
      const thr = numOrNull(thrRaw)
      if (thr === null) throw new Error(`${t('reviewGate')} ${t('errFinite')}`)
      th = thr
    }
    el['reviewGate'] = {
      required: d['reviewRequired'] !== 'no',
      threshold: th,
    }
    el['auditChecks'] = lines(d['auditChecks'] ?? '')
  }
  return el
}

/** 收集全包已用 ID（跨类查重：score/exclusion 共用 RULE 前缀；含全部集合，防与 SKL/FM 等撞车）。 */
export function collectAllIds(model: Record<string, Array<Record<string, unknown>>>): Set<string> {
  const taken = new Set<string>()
  for (const kind of ['objects', 'relations', 'dictionaries', 'behaviors', 'scoreRules', 'exclusionRules', 'skillTemplates', 'scenarios', 'fieldMaps', 'apiSources']) {
    for (const e of model[kind] ?? []) {
      const id = String(e['id'] ?? '')
      if (id) taken.add(id)
    }
  }
  return taken
}

export function emptyFormData(kind: ElemKind, taken: Set<string>): Record<string, string> {
  const prefix = {
    objects: 'OBJ', relations: 'REL', behaviors: 'BHV',
    scoreRules: 'RULE', exclusionRules: 'RULE', scenarios: 'SCN',
  }[kind]
  let n = 1
  while (taken.has(`${prefix}-GEN-${n}`)) n++
  const base: Record<string, string> = { id: `${prefix}-GEN-${n}`, name: '' }
  if (kind === 'objects') return { ...base, idRule: '', attributes: '', lifecycle: '', description: '' }
  if (kind === 'relations') return { ...base, from: '', to: '', attributes: '', description: '' }
  if (kind === 'behaviors') return { ...base, anchor: '', relations: '', states: '', trigger: '', description: '' }
  if (kind === 'scoreRules') return { ...base, weight: '0.25', expression: 'min(1, f1)', threshold: '0.5', evidenceTemplate: '', description: '' }
  if (kind === 'exclusionRules') return { ...base, action: 'drop', factor: '', condition: "tag == 'unknown'", description: '' }
  return {
    ...base,
    goal: '', boundary: '',
    inputs: '[]',
    outputs: 'candidateId,riskScore,hitRuleIds,evidenceChains,pendingChecks',
    pipeline: JSON.stringify([
      { stepId: 's1', stepType: 'DATA_INGEST' },
      { stepId: 's2', stepType: 'BEHAVIOR_CALL' },
      { stepId: 's3', stepType: 'RULE_EVALUATE', order: 'before-scoring' },
      { stepId: 's4', stepType: 'RULE_EVALUATE' },
      { stepId: 's5', stepType: 'AUDIT_CHECK' },
      { stepId: 's6', stepType: 'HUMAN_REVIEW' },
    ], null, 2),
    mustInclude: 'candidateList,riskScore,evidenceChains,pendingChecks',
    forbiddenPhrases: '',
    reviewRequired: 'yes',
    reviewThreshold: '0.75',
    auditChecks: 'O1_CLOSED\nO2_CLOSED\nO3_CLOSED',
  }
}
