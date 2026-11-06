/**
 * 校验器（规范 §7）：引用闭合 / 属性可解析 / 权重合计 / 字典可解析 / 事件不进 Schema；
 * warn：ID 未被引用（AGT-/AUD-/TOOL- 豁免）；info：覆盖统计。
 * 质量分 = clamp(0, 100, 100 - 10×errors - 2×warnings)。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractAttrRefs, parseAttrRef, UNREFERENCED_EXEMPT_PREFIXES } from './ids.js'
import { validateExpression } from './rules.js'
import { listSourceFiles, loadPackage, readPackageMeta, QUALITY_REPORT_FILE } from './store.js'
import type { OntologyPackage, QualityReport, SkeletonRecord, ValidationIssue } from './types.js'
import { loadYaml } from './yamlio.js'

const WEIGHT_SUM_TOLERANCE = 1e-6

/** 校验可选项（conversational-modeling P3/I6）。 */
export interface ValidateOptions {
  /** 对话骨架：提供时启用 SKELETON_OUT_OF_SCOPE 门（骨架外 ID → error）。 */
  skeleton?: SkeletonRecord | null
}

/** 深度遍历任意值里的所有字符串。 */
function walkStrings(value: unknown, visit: (s: string) => void): void {
  if (typeof value === 'string') {
    visit(value)
    return
  }
  if (Array.isArray(value)) {
    for (const v of value) walkStrings(v, visit)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) walkStrings(v, visit)
  }
}

/** 深度查找是否存在 `events` 建模键（§3.2：事件不是本体 Schema 要素）。 */
function findEventsKey(value: unknown, path: string, hits: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => findEventsKey(v, `${path}[${i}]`, hits))
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'events') hits.push(path === '' ? k : `${path}.${k}`)
      findEventsKey(v, path === '' ? k : `${path}.${k}`, hits)
    }
  }
}

/** 收集包内全部定义的 Schema ID；跨类/同类重复记入 dupes（§3.3：ID 全包唯一）。 */
function collectDefinedIds(pkg: OntologyPackage): {
  ids: Map<string, string>
  dupes: Array<{ id: string; first: string; second: string }>
  empty: string[]
} {
  const ids = new Map<string, string>()
  const dupes: Array<{ id: string; first: string; second: string }> = []
  const empty: string[] = []
  const add = (id: string, where: string): void => {
    if (!id) {
      empty.push(where)
      return
    }
    const first = ids.get(id)
    if (first === undefined) ids.set(id, where)
    else dupes.push({ id, first, second: where })
  }
  for (const o of pkg.objects) add(o.id, 'o1-objects/object-types.yaml')
  for (const r of pkg.relations) add(r.id, 'o1-objects/relation-types.yaml')
  for (const d of pkg.dictionaries) add(d.id, `o1-objects/dictionaries/${d.id}.yaml`)
  for (const b of pkg.behaviors) add(b.id, 'o2-behavior-rules/behavior-types.yaml')
  for (const r of pkg.scoreRules) add(r.id, 'o2-behavior-rules/rules/score-rules.yaml')
  for (const r of pkg.exclusionRules) add(r.id, 'o2-behavior-rules/rules/exclusion-rules.yaml')
  for (const s of pkg.skillTemplates) add(s.id, `o2-behavior-rules/skill-templates/${s.id}.yaml`)
  for (const s of pkg.scenarios) add(s.id, `o3-scenarios/${s.id}.yaml`)
  for (const f of pkg.fieldMaps) add(f.id, 'bindings/field-maps.yaml')
  for (const s of pkg.apiSources) add(s.id, 'bindings/api-sources.yaml')
  return { ids, dupes, empty }
}

/**
 * 对一个包版本目录执行全部校验规则，返回问题清单（不落盘）。
 */
export function validatePackageDir(versionDir: string, opts?: ValidateOptions): {
  pkg: OntologyPackage
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
  info: ValidationIssue[]
} {
  const pkg = loadPackage(versionDir)
  return { pkg, ...validatePackage(pkg, versionDir, opts) }
}

/** 对内存模型执行校验；versionDir 仅用于 events 扫描与 where 定位。 */
export function validatePackage(
  pkg: OntologyPackage,
  versionDir?: string,
  opts?: ValidateOptions,
): { errors: ValidationIssue[]; warnings: ValidationIssue[]; info: ValidationIssue[] } {
  const errors: ValidationIssue[] = []
  const warnings: ValidationIssue[] = []
  const info: ValidationIssue[] = []
  const external = new Set(pkg.meta.externalRefs ?? [])
  const { ids: defined, dupes, empty } = collectDefinedIds(pkg)

  const err = (code: string, where: string, message: string): void => {
    errors.push({ level: 'error', code, where, message })
  }
  const warn = (code: string, where: string, message: string): void => {
    warnings.push({ level: 'warn', code, where, message })
  }

  const resolved = (id: string): boolean => defined.has(id) || external.has(id)

  /* ── error: 骨架外 ID（conversational-modeling I6） ────────────────────── */

  const skeleton = opts?.skeleton
  if (skeleton) {
    const allowed = new Set(skeleton.ids)
    for (const id of defined.keys()) {
      if (!allowed.has(id)) err('SKELETON_OUT_OF_SCOPE', id, `ID 不在骨架内: ${id}`)
    }
  }

  /* ── error: ID 全包唯一（§3.3；score/exclusion 共用 RULE-* 也算重复） ── */

  for (const d of dupes) {
    err('DUP_ID', d.id, `ID 重复: ${d.id}（已定义于 ${d.first}）`)
  }
  for (const where of empty) {
    err('ID_EMPTY', where, 'ID 为空')
  }

  /* ── error: 引用闭合（§7.1） ─────────────────────────────────────────── */

  for (const r of pkg.relations) {
    if (!resolved(r.from)) err('REF_UNCLOSED', `REL ${r.id}`, `from 引用未闭合: ${r.from}`)
    if (!resolved(r.to)) err('REF_UNCLOSED', `REL ${r.id}`, `to 引用未闭合: ${r.to}`)
  }
  for (const b of pkg.behaviors) {
    if (!resolved(b.anchor)) err('REF_UNCLOSED', `BHV ${b.id}`, `anchor 引用未闭合: ${b.anchor}`)
    for (const rel of b.relations ?? []) {
      if (!resolved(rel)) err('REF_UNCLOSED', `BHV ${b.id}`, `relations 引用未闭合: ${rel}`)
    }
  }
  for (const s of pkg.skillTemplates) {
    for (const ruleId of Object.keys(s.weights)) {
      if (!resolved(ruleId)) err('REF_UNCLOSED', `SKL ${s.id}`, `weights 引用未闭合: ${ruleId}`)
    }
  }
  for (const sc of pkg.scenarios) {
    for (const step of sc.pipeline) {
      for (const skillId of step.skillRefs ?? []) {
        if (!resolved(skillId)) err('REF_UNCLOSED', `SCN ${sc.id}`, `skillRefs 引用未闭合: ${skillId}`)
      }
    }
    // behaviorRefs/exclusionRefs（v1.1 引用位）：缺省 = 全部；显式数组须指向同类型元素
    for (const bhvId of sc.behaviorRefs ?? []) {
      if (!pkg.behaviors.some((b) => b.id === bhvId)) {
        err('REF_UNCLOSED', `SCN ${sc.id}`, `behaviorRefs 引用未闭合: ${bhvId}`)
      }
    }
    for (const ruleId of sc.exclusionRefs ?? []) {
      if (!pkg.exclusionRules.some((r) => r.id === ruleId)) {
        err('REF_UNCLOSED', `SCN ${sc.id}`, `exclusionRefs 引用未闭合: ${ruleId}`)
      }
    }
  }

  /* ── error: 属性可解析 + 字典可解析（属性表内） ───────────────────────── */

  const attrTables = new Map<string, Map<string, true>>()
  for (const o of pkg.objects) {
    const attrs = new Map<string, true>()
    for (const a of o.attributes) attrs.set(a.name, true)
    attrTables.set(o.id, attrs)
    for (const a of o.attributes) {
      if (a.type === 'enum') {
        if (!a.enumValuesRef || !resolved(a.enumValuesRef)) {
          err('DICT_UNRESOLVED', `OBJ ${o.id}.${a.name}`, `enumValuesRef 不可解析: ${a.enumValuesRef ?? '(空)'}`)
        }
      }
      if (a.type === 'ref') {
        if (!a.refObject || !resolved(a.refObject)) {
          err('REF_UNCLOSED', `OBJ ${o.id}.${a.name}`, `refObject 引用未闭合: ${a.refObject ?? '(空)'}`)
        }
      }
    }
  }
  for (const r of pkg.relations) {
    const attrs = new Map<string, true>()
    for (const a of r.attributes ?? []) attrs.set(a.name, true)
    attrTables.set(r.id, attrs)
    for (const a of r.attributes ?? []) {
      if (a.type === 'enum') {
        if (!a.enumValuesRef || !resolved(a.enumValuesRef)) {
          err('DICT_UNRESOLVED', `REL ${r.id}.${a.name}`, `enumValuesRef 不可解析: ${a.enumValuesRef ?? '(空)'}`)
        }
      }
      if (a.type === 'ref') {
        if (!a.refObject || !resolved(a.refObject)) {
          err('REF_UNCLOSED', `REL ${r.id}.${a.name}`, `refObject 引用未闭合: ${a.refObject ?? '(空)'}`)
        }
      }
    }
  }

  /* ── error: 全包文本里的属性引用 `<OBJ|REL>.<attr>` 可解析 ───────────── */

  const seenAttrRef = new Set<string>()
  walkStrings(pkg, (s) => {
    for (const ref of extractAttrRefs(s)) {
      const key = `${ref.ownerId}.${ref.attrName}`
      if (seenAttrRef.has(key)) continue
      seenAttrRef.add(key)
      const owner = ref.ownerId
      if (!resolved(owner)) {
        err('ATTR_UNRESOLVED', 'package', `属性引用 owner 未闭合: ${key}`)
        continue
      }
      const attrs = attrTables.get(owner)
      if (attrs === undefined) {
        // owner 是外部声明的 ID：包内无属性表，视为已声明豁免。
        if (!external.has(owner)) err('ATTR_UNRESOLVED', 'package', `属性引用 owner 无属性表: ${key}`)
        continue
      }
      if (!attrs.has(ref.attrName)) {
        err('ATTR_UNRESOLVED', owner, `属性不可解析: ${key}`)
      }
    }
  })

  /* ── error: 权重合计 = 1.0 + 方法论模板权重集合一致（§7.1） ──────────── */

  const ruleWeights = new Map<string, number>()
  for (const r of pkg.scoreRules) ruleWeights.set(r.id, r.weight)
  if (pkg.scoreRules.length === 0) {
    warn('WEIGHT_EMPTY', 'o2-behavior-rules/rules/score-rules.yaml', '包内没有打分规则')
  } else {
    const sum = pkg.scoreRules.reduce((acc, r) => acc + (Number.isFinite(r.weight) ? r.weight : 0), 0)
    if (Math.abs(sum - 1.0) > WEIGHT_SUM_TOLERANCE) {
      err(
        'WEIGHT_SUM',
        'o2-behavior-rules/rules/score-rules.yaml',
        `打分规则权重合计 ${sum} ≠ 1.0`,
      )
    }
    for (const r of pkg.scoreRules) {
      if (!Number.isFinite(r.weight) || r.weight < 0) {
        err('WEIGHT_SUM', `RULE ${r.id}`, `权重非法: ${r.weight}`)
      }
      // 表达式语法在门禁拦截（round-13）：坏语法若漏到运行时，排除规则求值异常
      // 会被静默吞成「不匹配」（方向保守但不可见），打分规则则落待核实。
      const exprErr = validateExpression(r.expression)
      if (exprErr !== null) {
        err('EXPR_INVALID', `RULE ${r.id}`, `打分表达式语法错误: ${exprErr}`)
      }
    }
  }
  // 排除条件语法独立于权重分支检查（scoreRules 为空也必须过闸）。
  for (const r of pkg.exclusionRules) {
    const condErr = validateExpression(r.condition)
    if (condErr !== null) {
      err('EXPR_INVALID', `RULE ${r.id}`, `排除条件语法错误: ${condErr}`)
    }
  }
  for (const s of pkg.skillTemplates) {
    const keys = Object.keys(s.weights).sort()
    const ruleIds = [...ruleWeights.keys()].sort()
    const sameKeys = keys.length === ruleIds.length && keys.every((k, i) => k === ruleIds[i])
    if (!sameKeys) {
      err(
        'WEIGHT_SET_MISMATCH',
        `SKL ${s.id}`,
        `方法论模板权重集合与规则集合不一致（模板: ${keys.join(',') || '(空)'}；规则: ${ruleIds.join(',') || '(空)'}）`,
      )
      continue
    }
    for (const [ruleId, w] of Object.entries(s.weights)) {
      const expect = ruleWeights.get(ruleId)
      if (expect !== undefined && Math.abs(expect - w) > WEIGHT_SUM_TOLERANCE) {
        err('WEIGHT_SET_MISMATCH', `SKL ${s.id}`, `权重与规则 ${ruleId} 不一致: ${w} ≠ ${expect}`)
      }
    }
  }

  /* ── error: 事件不进 Schema（§3.2） ─────────────────────────────────── */

  if (versionDir && existsSync(versionDir)) {
    for (const rel of listSourceFiles(versionDir)) {
      if (rel === QUALITY_REPORT_FILE) continue
      let doc: unknown
      try {
        doc = loadYaml(readFileSync(join(versionDir, rel), 'utf8'))
      } catch {
        continue
      }
      const hits: string[] = []
      findEventsKey(doc, '', hits)
      for (const h of hits) {
        err('EVENTS_IN_SCHEMA', rel, `出现 events 建模元素: ${h}`)
      }
    }
  } else {
    const hits: string[] = []
    findEventsKey(pkg, '', hits)
    for (const h of hits) err('EVENTS_IN_SCHEMA', 'package', `出现 events 建模元素: ${h}`)
  }

  /* ── warn: ID 未被引用（AGT-/AUD-/TOOL- 豁免） ──────────────────────── */

  // 自身 `id` 字段不算引用；对象键（如 skillTemplate.weights 的键）计入引用。
  const referenced = new Set<string>()
  const markRefs = (value: unknown, underIdKey: boolean): void => {
    if (typeof value === 'string') {
      if (underIdKey) return
      for (const ref of extractAttrRefs(value)) referenced.add(ref.ownerId)
      for (const m of value.matchAll(/\b(?:[A-Z]+-[A-Z0-9]+(?:-[A-Z0-9]+)*|dict-[a-z0-9]+(?:-[a-z0-9]+)*)\b/g)) {
        referenced.add(m[0])
      }
      return
    }
    if (Array.isArray(value)) {
      for (const v of value) markRefs(v, false)
      return
    }
    if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        if (k !== 'id' && (/^[A-Z]+-[A-Z0-9-]+$/.test(k) || k.startsWith('dict-'))) referenced.add(k)
        markRefs(v, k === 'id')
      }
    }
  }
  markRefs(pkg, false)
  for (const id of defined.keys()) {
    if (referenced.has(id)) continue
    if (UNREFERENCED_EXEMPT_PREFIXES.some((p) => id.startsWith(p))) continue
    warn('ID_UNREFERENCED', id, `ID 未被引用: ${id}`)
  }

  /* ── info: 覆盖统计（§7.1） ─────────────────────────────────────────── */

  info.push({
    level: 'info',
    code: 'COVERAGE',
    where: 'package',
    message:
      `对象 ${pkg.objects.length} / 关系 ${pkg.relations.length} / 字典 ${pkg.dictionaries.length} / ` +
      `行为 ${pkg.behaviors.length} / 打分规则 ${pkg.scoreRules.length} / 排除规则 ${pkg.exclusionRules.length} / ` +
      `方法论模板 ${pkg.skillTemplates.length} / 场景 ${pkg.scenarios.length} / ` +
      `字段映射 ${pkg.fieldMaps.length} / 数据源 ${pkg.apiSources.length}`,
  })

  return { errors, warnings, info }
}

/**
 * 生成 quality-report.json 并落盘（校验器生成，不手改）。
 */
export function writeQualityReport(versionDir: string): QualityReport {
  const report = buildQualityReport(versionDir)
  writeFileSync(join(versionDir, QUALITY_REPORT_FILE), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return report
}

/** 计算质量报告（不落盘）。 */
export function buildQualityReport(versionDir: string): QualityReport {
  const meta = readPackageMeta(versionDir)
  const { errors, warnings, info } = validatePackageDir(versionDir)
  const score = Math.max(0, Math.min(100, 100 - 10 * errors.length - 2 * warnings.length))
  return {
    package: meta.name,
    version: meta.version,
    generatedAt: new Date().toISOString(),
    errors,
    warnings,
    info,
    score,
    passed: errors.length === 0,
  }
}
