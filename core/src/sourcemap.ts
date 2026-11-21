/**
 * 配置驱动源映射转换（api-to-plugin S2.1）——纯函数。
 *
 * CLI 预览（`source map preview`）、runtime 配置驱动连接器、发布前回放三方共用同一转换，
 * 保证「配置真正驱动取数」且页面/Agent/回放口径一致。
 *
 * - 对象 id 按 `idTemplate`（`<field>` 占位 + 字面分隔）组装；
 * - 关系 FK 式（含数组 FK）；值连接（按值 join）不在 v1（见 spec S3）；
 * - 关系/候选仅保留同批内闭合的实例（ingest 闭合），未闭合者进诊断而非静默丢弃。
 * @module @dsh-onto/core/sourcemap
 */
import type {
  ApiShape,
  OntologyPackage,
  OntoAttribute,
  O1BehaviorSourceMap,
  O1CandidateSourceMap,
  O1ObjectSourceMap,
  O1RelationSourceMap,
  O1SourceMap,
  O1SourceFieldMap,
  RuntimeBehaviorInstance,
  RuntimeCandidate,
  RuntimeDataset,
  RuntimeObjectInstance,
  RuntimeRelationInstance,
  ValidationIssue,
} from './types.js'
import { inferFeatureSources } from './features.js'

export type SourceRow = Record<string, unknown>
/** 集合键 → 行数组（collections 模式或 snapshot 解析后的产物同形）。 */
export type SourceRows = Record<string, SourceRow[]>

export interface SourceMapTransformInput {
  rows: SourceRows
  maps: O1SourceMap[]
  /** 业务时间窗过滤（ISO）。 */
  timeWindow?: { from: string; to: string }
  /** 数据信任面标注；缺省 connector（与 tax-connector 同口径）。 */
  provenance?: 'inline' | 'file' | 'connector'
}

export interface SourceMapTransformResult {
  dataset: RuntimeDataset
  diagnostics: ValidationIssue[]
  /** 数据覆盖的业务时间窗（按存活对象的 timeField；无时间字段不冒充时效 → to 留空）。 */
  businessWindow: { from: string; to: string }
}

const diag = (code: string, where: string, message: string): ValidationIssue => ({
  level: 'warn',
  code,
  where,
  message,
})

/** 点路径读字段（`a.b`；仅下钻普通对象/数组首层不展开）。 */
export function readField(row: SourceRow, path: string): unknown {
  if (!path.includes('.')) return row[path]
  let cur: unknown = row
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined
    cur = (cur as SourceRow)[seg]
  }
  return cur
}

export interface IdTemplateSegment {
  /** `<field>` 占位字段名；与 literal 二选一。 */
  field?: string
  literal?: string
}

/** 解析 id 模板：`<invoiceCode>:<invoiceNo>` → [{field},{literal:':'},{field}]。 */
export function parseIdTemplate(template: string): IdTemplateSegment[] {
  const out: IdTemplateSegment[] = []
  const re = /<([^<>]+)>|[^<]+/g
  for (const m of template.matchAll(re)) {
    if (m[1] !== undefined) out.push({ field: m[1] })
    else out.push({ literal: m[0] })
  }
  return out
}

/**
 * 渲染 id 模板；任一占位缺字段/空值/非有限 → null（SM_ID_EMPTY）。
 */
export function renderIdTemplate(template: string, row: SourceRow): string | null {
  let out = ''
  for (const seg of parseIdTemplate(template)) {
    if (seg.literal !== undefined) {
      out += seg.literal
      continue
    }
    const v = readField(row, seg.field as string)
    if (v === undefined || v === null || v === '') return null
    if (typeof v === 'number' && !Number.isFinite(v)) return null
    out += String(v)
  }
  return out
}

/** id 模板里引用的源字段名。 */
export function idTemplateFields(template: string): string[] {
  return parseIdTemplate(template)
    .filter((s) => s.field !== undefined)
    .map((s) => s.field as string)
}

/** 业务记录时间（ms）：ISO 串或数字 epoch（>1e12 视为毫秒）。 */
function recordTimeMs(value: unknown): number | undefined {
  if (typeof value === 'string' && value !== '') {
    const ms = Date.parse(value)
    return Number.isFinite(ms) ? ms : undefined
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000
  }
  return undefined
}

function isObjectMap(m: O1SourceMap): m is O1ObjectSourceMap {
  return m.kind === undefined || m.kind === 'object'
}
function isRelationMap(m: O1SourceMap): m is O1RelationSourceMap {
  return m.kind === 'relation'
}
function isCandidateMap(m: O1SourceMap): m is O1CandidateSourceMap {
  return m.kind === 'candidate'
}
function isBehaviorMap(m: O1SourceMap): m is O1BehaviorSourceMap {
  return m.kind === 'behavior' || m.kind === 'behavior-list'
}

/** 对象映射行属性：显式 fields 只出映射对；缺省同名全映（与 tax-connector 裸行同口径）。 */
function mapRowAttrs(row: SourceRow, fields: O1SourceFieldMap[] | undefined): Record<string, unknown> {
  if (fields === undefined) return { ...row }
  const attrs: Record<string, unknown> = {}
  for (const f of fields) {
    const v = readField(row, f.source)
    if (v !== undefined) attrs[f.target] = v
  }
  return attrs
}

/** 特征值过滤（与 tax-connector 同口径）：有限数值或非空字符串才收。 */
function coerceFeatureValue(v: unknown): number | string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v !== '') return v
  return undefined
}

/**
 * 核心转换：行 → RuntimeDataset + 诊断 + 业务时间窗。
 * 时间窗过滤后关系/候选/行为只保留两端/归属仍存活的实例。
 */
export function transformSourceRows(input: SourceMapTransformInput): SourceMapTransformResult {
  const diagnostics: ValidationIssue[] = []
  const objectMaps = input.maps.filter(isObjectMap)
  const relationMaps = input.maps.filter(isRelationMap)
  const candidateMaps = input.maps.filter(isCandidateMap)
  const behaviorMaps = input.maps.filter(isBehaviorMap)

  const objects: RuntimeObjectInstance[] = []
  const objIdToCollection = new Map<string, string>()
  const collectionObjMaps = new Map<string, O1ObjectSourceMap>()
  const recordTimes = new Map<string, number>() // object id → record time ms

  for (const om of objectMaps) {
    if (!collectionObjMaps.has(om.collection)) collectionObjMaps.set(om.collection, om)
    const rows = input.rows[om.collection] ?? []
    const seenIds = new Set<string>()
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const where = `${om.id}#${om.collection}[${i}]`
      const id = renderIdTemplate(om.idTemplate, row)
      if (id === null) {
        diagnostics.push(diag('SM_ID_EMPTY', where, `idTemplate 渲染为空（占位缺字段/空值）: ${om.idTemplate}`))
        continue
      }
      if (seenIds.has(id)) {
        diagnostics.push(diag('SM_ID_CONFLICT', where, `批内实例 id 重复，保留首条: ${id}`))
        continue
      }
      seenIds.add(id)
      objects.push({ id, type: om.objectType, attrs: mapRowAttrs(row, om.fields) })
      objIdToCollection.set(id, om.collection)
      if (om.timeField !== undefined) {
        const ms = recordTimeMs(readField(row, om.timeField))
        if (ms !== undefined) recordTimes.set(id, ms)
      }
    }
  }

  const relations: RuntimeRelationInstance[] = []
  const relSeen = new Set<string>()
  const endpointId = (
    ep: 'self' | { field: string },
    row: SourceRow,
    selfId: string | null,
  ): { ids: string[]; field?: string } => {
    if (ep === 'self') return { ids: selfId !== null ? [selfId] : [] }
    const raw = readField(row, ep.field)
    const vals = Array.isArray(raw) ? raw : [raw]
    return {
      ids: vals
        .filter((v) => v !== undefined && v !== null && v !== '')
        .map((v) => String(v)),
      field: ep.field,
    }
  }

  const noteUnclosed = (
    where: string,
    missingId: string,
    hintCollection: string | undefined,
  ): void => {
    const targetLoaded =
      hintCollection === undefined
        ? true
        : input.rows[hintCollection] !== undefined
    diagnostics.push(
      targetLoaded
        ? diag('SM_REF_BROKEN', where, `关系端点断引用：${missingId} 不在本批对象 id 集`)
        : diag('SM_REF_PENDING', where, `关系端点待补：对端集合 ${hintCollection} 本批未取数（${missingId}）`),
    )
  }

  for (const rm of relationMaps) {
    const om = collectionObjMaps.get(rm.collection)
    const rows = input.rows[rm.collection] ?? []
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const where = `${rm.id}#${rm.collection}[${i}]`
      const selfId = om !== undefined ? renderIdTemplate(om.idTemplate, row) : null
      const fromIds = endpointId(rm.from, row, selfId)
      const toIds = endpointId(rm.to, row, selfId)
      for (const f of fromIds.ids) {
        for (const t of toIds.ids) {
          const closed = objIdToCollection.has(f) && objIdToCollection.has(t)
          if (!closed) {
            const missing = objIdToCollection.has(f) ? t : f
            const hint =
              !objIdToCollection.has(f) && rm.from !== 'self'
                ? rm.targetCollection
                : !objIdToCollection.has(t) && rm.to !== 'self'
                  ? rm.targetCollection
                  : objIdToCollection.get(missing)
            noteUnclosed(where, missing, hint)
            continue
          }
          const rid = `R-${rm.relationType}-${f}-${t}`
          if (relSeen.has(rid)) continue
          relSeen.add(rid)
          relations.push({ id: rid, type: rm.relationType, from: f, to: t })
        }
      }
    }
  }

  const candidates: RuntimeCandidate[] = []
  const candSeen = new Set<string>()
  for (const cm of candidateMaps) {
    const rows = input.rows[cm.collection] ?? []
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const where = `${cm.id}#${cm.collection}[${i}]`
      const candidateId = readField(row, cm.idField)
      const objectRef = readField(row, cm.objectRefField)
      if (typeof candidateId !== 'string' || candidateId === '') {
        diagnostics.push(diag('SM_ID_EMPTY', where, `候选 id 字段 ${cm.idField} 缺失/空`))
        continue
      }
      const ref = typeof objectRef === 'string' ? objectRef : ''
      const refCollection = ref !== '' ? objIdToCollection.get(ref) : undefined
      const refOk =
        ref !== '' &&
        objIdToCollection.has(ref) &&
        (cm.objectType === undefined ||
          objects.some((o) => o.id === ref && o.type === cm.objectType))
      if (!refOk) {
        const targetLoaded =
          cm.objectType === undefined
            ? refCollection !== undefined
            : [...collectionObjMaps.entries()].some(
                ([c, om]) => om.objectType === cm.objectType && input.rows[c] !== undefined,
              )
        diagnostics.push(
          targetLoaded
            ? diag('SM_REF_BROKEN', where, `候选 objectRef 断引用：${String(objectRef)}`)
            : diag('SM_REF_PENDING', where, `候选待补：归属对象类型 ${cm.objectType ?? '(未声明)'} 本批未取数（${String(objectRef)}）`),
        )
        continue
      }
      if (candSeen.has(candidateId)) {
        diagnostics.push(diag('SM_ID_CONFLICT', where, `候选 id 重复，保留首条: ${candidateId}`))
        continue
      }
      candSeen.add(candidateId)
      const features: Record<string, number | string> = {}
      for (const [name, src] of Object.entries(cm.features ?? {})) {
        const v = coerceFeatureValue(readField(row, src))
        if (v !== undefined) features[name] = v
      }
      const tagsRaw = cm.tagsField !== undefined ? readField(row, cm.tagsField) : undefined
      const tags = Array.isArray(tagsRaw) ? tagsRaw.filter((x): x is string => typeof x === 'string') : []
      candidates.push({ candidateId, objectRef: ref, features, tags })
    }
  }

  const behaviors: RuntimeBehaviorInstance[] = []
  const behSeen = new Set<string>()
  for (const bm of behaviorMaps) {
    const rows = input.rows[bm.collection] ?? []
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const where = `${bm.id}#${bm.collection}[${i}]`
      const ownerRow = row
      const objectRef = renderIdTemplate(bm.objectRefTemplate, ownerRow)
      const events: SourceRow[] =
        bm.kind === 'behavior-list'
          ? (() => {
              const raw = bm.eventsPath !== undefined ? readField(row, bm.eventsPath) : undefined
              return Array.isArray(raw) ? (raw.filter((e) => e !== null && typeof e === 'object') as SourceRow[]) : []
            })()
          : [row]
      for (let j = 0; j < events.length; j++) {
        const ev = events[j]
        const ewhere = `${where}(${j})`
        if (objectRef === null) {
          diagnostics.push(diag('SM_ID_EMPTY', ewhere, `行为归属对象渲染为空: ${bm.objectRefTemplate}`))
          continue
        }
        if (!objIdToCollection.has(objectRef)) {
          diagnostics.push(diag('SM_REF_BROKEN', ewhere, `行为归属断引用：${objectRef}`))
          continue
        }
        const occurredAt = bm.timeField !== undefined ? readField(ev, bm.timeField) : undefined
        const bid = `BVI-${bm.id}-${i}-${j}`
        if (behSeen.has(bid)) continue
        behSeen.add(bid)
        behaviors.push({
          id: bid,
          type: bm.behaviorType,
          anchorRef: objectRef,
          objectRef,
          occurredAt: occurredAt !== undefined && occurredAt !== null ? String(occurredAt) : '',
        })
      }
    }
  }

  // 时间窗过滤（data-source-ext 同口径：无记录时间的维表保留；窗外对象剔除）
  const winFrom = input.timeWindow !== undefined ? Date.parse(input.timeWindow.from) : NaN
  const winTo = input.timeWindow !== undefined ? Date.parse(input.timeWindow.to) : NaN
  const hasWin = input.timeWindow !== undefined && Number.isFinite(winFrom) && Number.isFinite(winTo)
  let kept = objects
  if (hasWin) {
    kept = objects.filter((o) => {
      const ms = recordTimes.get(o.id)
      if (ms === undefined) return true
      return ms >= winFrom && ms <= winTo
    })
  }
  const keptIds = new Set(kept.map((o) => o.id))
  const keptRelations = relations.filter((r) => keptIds.has(r.from) && keptIds.has(r.to))
  const keptCands = candidates.filter((c) => keptIds.has(c.objectRef))
  const keptBehaviors = behaviors.filter((b) => keptIds.has(b.objectRef))

  const keptTimes = kept
    .map((o) => recordTimes.get(o.id))
    .filter((ms): ms is number => ms !== undefined)
  const businessWindow =
    keptTimes.length > 0
      ? {
          from: new Date(Math.min(...keptTimes)).toISOString(),
          to: new Date(Math.max(...keptTimes)).toISOString(),
        }
      : {
          from: input.timeWindow?.from ?? '1970-01-01T00:00:00.000Z',
          to: '',
        }

  return {
    dataset: {
      objects: kept,
      relations: keptRelations,
      behaviors: keptBehaviors,
      candidates: keptCands,
      provenance: input.provenance ?? 'connector',
    },
    diagnostics,
    businessWindow,
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 静态校验（validate.ts 与预览共用）
 * ═══════════════════════════════════════════════════════════════════════════ */

function normTemplate(s: string): string {
  return s.toLowerCase().replace(/_/g, '')
}

/** 映射字段 → 目标属性名（无 fields 时同名）。 */
function targetAttrOf(fields: O1SourceFieldMap[] | undefined, sourceName: string): string {
  const hit = fields?.find((f) => f.source === sourceName)
  return hit !== undefined ? hit.target : sourceName
}

/**
 * idTemplate 与 O1 idRule 同构性：占位序列（经 fields 归到属性名）与字面分隔一致。
 * idRule 缺省不检查（描述性字段）。
 */
function idRuleMatches(idRule: string, idTemplate: string, fields: O1SourceFieldMap[] | undefined): boolean {
  const mapSeg = (segs: IdTemplateSegment[], mapped: boolean): string =>
    segs
      .map((s) =>
        s.literal !== undefined
          ? s.literal
          : `<${normTemplate(mapped ? targetAttrOf(fields, s.field as string) : (s.field as string))}>`,
      )
      .join('')
  return normTemplate(mapSeg(parseIdTemplate(idRule), false)) === normTemplate(mapSeg(parseIdTemplate(idTemplate), true))
}

function attrTable(pkg: OntologyPackage): Map<string, Map<string, OntoAttribute>> {
  const t = new Map<string, Map<string, OntoAttribute>>()
  for (const o of pkg.objects) {
    t.set(o.id, new Map(o.attributes.map((a) => [a.name, a])))
  }
  for (const r of pkg.relations) {
    if (r.attributes !== undefined) t.set(r.id, new Map(r.attributes.map((a) => [a.name, a])))
  }
  return t
}

function checkAttrType(
  value: unknown,
  attr: OntoAttribute,
  pkg: OntologyPackage,
): string | null {
  const t = attr.type
  if (t === 'int' || t === 'float') {
    const ok =
      typeof value === 'number' && Number.isFinite(value) && (t === 'float' || Number.isInteger(value))
    return ok ? null : `期望 ${t}，实得 ${typeof value}`
  }
  if (t === 'bool') {
    return typeof value === 'boolean' ? null : `期望 bool，实得 ${typeof value}`
  }
  if (t === 'date') {
    if (typeof value !== 'string') return `期望 date，实得 ${typeof value}`
    return Number.isFinite(Date.parse(value)) ? null : `期望 date，实得不可解析: ${String(value)}`
  }
  if (t === 'enum') {
    const dictId = attr.enumValuesRef
    const dict = dictId !== undefined ? pkg.dictionaries.find((d) => d.id === dictId) : undefined
    if (dict === undefined) return `enum 字典不可解析: ${dictId ?? '(缺省)'}`
    return dict.values.includes(String(value)) ? null : `枚举值不在 ${dictId}: ${String(value)}`
  }
  if (t === 'ref') {
    return typeof value === 'string' && value !== '' ? null : `期望 ref，实得 ${typeof value}`
  }
  return typeof value === 'string' ? null : `期望 string，实得 ${typeof value}`
}

/** 源映射静态闭合检查（SM_* error）；供 validate.ts 与预览共用。 */
export function checkSourceMapsStatic(pkg: OntologyPackage): ValidationIssue[] {
  const out: ValidationIssue[] = []
  const sourceMaps = pkg.sourceMaps ?? []
  const objectIds = new Set(pkg.objects.map((o) => o.id))
  const relationIds = new Set(pkg.relations.map((r) => r.id))
  const behaviorIds = new Set(pkg.behaviors.map((b) => b.id))
  const external = new Set(pkg.meta.externalRefs ?? [])
  const attrs = attrTable(pkg)
  const objectMaps = sourceMaps.filter(isObjectMap)
  const objTypeOfCollection = new Map<string, string>()
  for (const om of objectMaps) {
    if (!objTypeOfCollection.has(om.collection)) objTypeOfCollection.set(om.collection, om.objectType)
  }

  const err = (code: string, where: string, message: string): void => {
    out.push({ level: 'error', code, where, message })
  }

  for (const m of sourceMaps) {
    const where = `bindings/source-maps.yaml#${m.id}`
    if (isObjectMap(m)) {
      if (!objectIds.has(m.objectType) && !external.has(m.objectType)) {
        err('SM_OBJECT_UNKNOWN', where, `objectType 未闭合: ${m.objectType}`)
      }
      const table = attrs.get(m.objectType)
      for (const f of m.fields ?? []) {
        if (table !== undefined && !table.has(f.target)) {
          err('SM_FIELD_UNKNOWN', where, `目标属性不存在: ${m.objectType}.${f.target}（源 ${f.source}）`)
        }
      }
      const rule = pkg.objects.find((o) => o.id === m.objectType)?.idRule
      if (rule !== undefined && rule !== '' && !idRuleMatches(rule, m.idTemplate, m.fields)) {
        err('SM_IDRULE_MISMATCH', where, `idTemplate 与 idRule 不一致: ${m.idTemplate} ↔ ${rule}`)
      }
    } else if (isRelationMap(m)) {
      if (!relationIds.has(m.relationType) && !external.has(m.relationType)) {
        err('SM_REL_UNKNOWN', where, `relationType 未闭合: ${m.relationType}`)
      }
      const rel = pkg.relations.find((r) => r.id === m.relationType)
      const selfType = objTypeOfCollection.get(m.collection)
      const targetType =
        m.targetCollection !== undefined ? objTypeOfCollection.get(m.targetCollection) : undefined
      if (rel !== undefined && selfType !== undefined) {
        const fromIsSelf = m.from === 'self'
        const fromType = fromIsSelf ? selfType : targetType
        const toType = fromIsSelf ? targetType : selfType
        if (fromType !== undefined && rel.from !== fromType) {
          err('SM_REL_ENDPOINT', where, `关系 from 端类型不符: ${rel.from} ↔ ${fromType}`)
        }
        if (toType !== undefined && rel.to !== toType) {
          err('SM_REL_ENDPOINT', where, `关系 to 端类型不符: ${rel.to} ↔ ${toType}`)
        }
      }
    } else if (isCandidateMap(m)) {
      if (m.objectType !== undefined && !objectIds.has(m.objectType) && !external.has(m.objectType)) {
        err('SM_CAND_UNKNOWN', where, `候选 objectType 未闭合: ${m.objectType}`)
      }
    } else if (isBehaviorMap(m)) {
      if (!behaviorIds.has(m.behaviorType) && !external.has(m.behaviorType)) {
        err('SM_BHV_UNKNOWN', where, `behaviorType 未闭合: ${m.behaviorType}`)
      }
      if (m.kind === 'behavior-list' && (m.eventsPath === undefined || m.eventsPath === '')) {
        err('SM_FIELD_MISSING', where, 'behavior-list 缺 eventsPath')
      }
    }
  }
  return out
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 映射预览（CLI source map preview / 工作台接入面板共用）
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface SourceMapPreviewCounts {
  objects: number
  relations: number
  candidates: number
  behaviors: number
  byCollection: Record<string, number>
}

export interface EvidenceReadiness {
  feature: string
  /** ready=可复算（object-fact/derived/connector）；pending=待补（unverified-caller 或声明缺）。 */
  verdict: 'ready' | 'pending'
  basis: string
}

export interface SourceMapPreviewResult {
  counts: SourceMapPreviewCounts
  diagnostics: ValidationIssue[]
  /** 场景特征证据就绪度（C4：哪些证据够用、哪些仍待补）。 */
  evidence: EvidenceReadiness[]
  businessWindow: { from: string; to: string }
}

/** 映射预览：样本行 → 计数 + 诊断（缺字段/类型不符/断引用/id 问题/必填未覆盖）+ 证据就绪度。 */
export function previewSourceMaps(pkg: OntologyPackage, rows: SourceRows): SourceMapPreviewResult {
  const diagnostics: ValidationIssue[] = checkSourceMapsStatic(pkg)
  const { dataset, diagnostics: dyn, businessWindow } = transformSourceRows({
    rows,
    maps: pkg.sourceMaps ?? [],
    provenance: 'connector',
  })
  diagnostics.push(...dyn.map((d) => ({ ...d, level: 'warn' as const })))

  const attrs = attrTable(pkg)
  const sourceMaps = pkg.sourceMaps ?? []
  const objectMaps = sourceMaps.filter(isObjectMap)

  // 缺字段 + 类型不符 + 必填未覆盖（按样本行检查）
  for (const om of objectMaps) {
    const sample = rows[om.collection] ?? []
    const where = `bindings/source-maps.yaml#${om.id}`
    const neededFields = new Set<string>(idTemplateFields(om.idTemplate))
    if (om.timeField !== undefined) neededFields.add(om.timeField)
    for (const f of om.fields ?? []) neededFields.add(f.source)
    for (const f of neededFields) {
      const present = sample.some((r) => readField(r, f) !== undefined)
      if (sample.length > 0 && !present) {
        diagnostics.push(diag('SM_FIELD_MISSING', where, `样本缺源字段: ${om.collection}.${f}`))
      }
    }
    if (om.fields !== undefined) {
      const table = attrs.get(om.objectType)
      for (const f of om.fields) {
        const attr = table?.get(f.target)
        if (attr === undefined) continue
        for (let i = 0; i < Math.min(sample.length, 20); i++) {
          const v = readField(sample[i], f.source)
          if (v === undefined) continue
          const bad = checkAttrType(v, attr, pkg)
          if (bad !== null) {
            diagnostics.push(diag('SM_TYPE_MISMATCH', `${where}#${om.collection}[${i}]`, `${f.source}→${f.target}: ${bad}`))
            break // 每字段一条，避免样本刷屏
          }
        }
      }
    }
    const table = attrs.get(om.objectType)
    if (table !== undefined) {
      for (const attr of table.values()) {
        if (attr.required !== true) continue
        const mapped = om.fields === undefined || om.fields.some((f) => f.target === attr.name)
        const inSample = sample.some((r) => readField(r, attr.name) !== undefined)
        if (!mapped && !inSample) {
          diagnostics.push(diag('SM_REQUIRED_UNMAPPED', where, `必填属性未覆盖: ${om.objectType}.${attr.name}`))
        }
      }
    }
  }

  for (const cm of sourceMaps.filter(isCandidateMap)) {
    const sample = rows[cm.collection] ?? []
    const where = `bindings/source-maps.yaml#${cm.id}`
    const needed = new Set<string>([cm.idField, cm.objectRefField])
    if (cm.tagsField !== undefined) needed.add(cm.tagsField)
    for (const src of Object.values(cm.features ?? {})) needed.add(src)
    for (const f of needed) {
      const present = sample.some((r) => readField(r, f) !== undefined)
      if (sample.length > 0 && !present) {
        diagnostics.push(diag('SM_FIELD_MISSING', where, `样本缺源字段: ${cm.collection}.${f}`))
      }
    }
  }

  for (const bm of sourceMaps.filter(isBehaviorMap)) {
    const sample = rows[bm.collection] ?? []
    const where = `bindings/source-maps.yaml#${bm.id}`
    const needed = new Set<string>(idTemplateFields(bm.objectRefTemplate))
    if (bm.timeField !== undefined) needed.add(bm.timeField)
    for (const src of Object.values(bm.attrMap ?? {})) needed.add(src)
    if (bm.eventsPath !== undefined) needed.add(bm.eventsPath)
    for (const f of needed) {
      const present = sample.some((r) => readField(r, f) !== undefined)
      if (sample.length > 0 && !present) {
        diagnostics.push(diag('SM_FIELD_MISSING', where, `样本缺源字段: ${bm.collection}.${f}`))
      }
    }
  }

  // 证据就绪度：对转换出的候选跑 inferFeatureSources（connector 口径），逐特征取最差档
  const records = inferFeatureSources(pkg, dataset, dataset.candidates)
  const byFeature = new Map<string, EvidenceReadiness>()
  for (const rec of records) {
    const ready = rec.declared && rec.source !== 'unverified-caller'
    const prev = byFeature.get(rec.key)
    if (prev === undefined) {
      byFeature.set(rec.key, {
        feature: rec.key,
        verdict: ready ? 'ready' : 'pending',
        basis: `${rec.source}${rec.declared ? '' : '（未声明）'}：${rec.detail}`,
      })
    } else if (!ready && prev.verdict === 'ready') {
      byFeature.set(rec.key, {
        feature: rec.key,
        verdict: 'pending',
        basis: `${rec.source}${rec.declared ? '' : '（未声明）'}：${rec.detail}`,
      })
    }
  }

  const byCollection: Record<string, number> = {}
  for (const [c, rs] of Object.entries(rows)) byCollection[c] = rs.length

  return {
    counts: {
      objects: dataset.objects.length,
      relations: dataset.relations.length,
      candidates: dataset.candidates.length,
      behaviors: (dataset.behaviors ?? []).length,
      byCollection,
    },
    diagnostics,
    evidence: [...byFeature.values()].sort((a, b) => a.feature.localeCompare(b.feature)),
    businessWindow,
  }
}

/** 形状声明可支持的集合键（collections 模式为任意键；snapshot 模式为 collectionPaths 键）。 */
export function shapeCollectionKeys(shape: ApiShape | undefined): Set<string> {
  const out = new Set<string>()
  if (shape === undefined) return out
  if (shape.mode === 'snapshot') {
    for (const k of Object.keys(shape.collectionPaths ?? {})) out.add(k)
    return out
  }
  return out // collections 模式集合键开放（模板驱动），由调用方按需生成
}

/** 通用点路径读取（响应体/行内嵌套均可；`a.b`）。 */
export function readPath(value: unknown, path: string): unknown {
  if (path === '') return value
  let cur: unknown = value
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

/** collections 模式：单页响应体 → 行数组（itemsPath 缺省 items）。 */
export function extractPageItems(body: unknown, itemsPath?: string): SourceRow[] {
  const raw = readPath(body, itemsPath === undefined || itemsPath === '' ? 'items' : itemsPath)
  return Array.isArray(raw) ? (raw.filter((x) => x !== null && typeof x === 'object') as SourceRow[]) : []
}

/** snapshot 模式：整包响应体 → 各集合行（collectionPaths：集合键 → 体上点路径）。 */
export function extractSnapshotRows(body: unknown, shape: ApiShape): SourceRows {
  const out: SourceRows = {}
  for (const [key, path] of Object.entries(shape.collectionPaths ?? {})) {
    const raw = readPath(body, path)
    out[key] = Array.isArray(raw)
      ? (raw.filter((x) => x !== null && typeof x === 'object') as SourceRow[])
      : []
  }
  return out
}

/**
 * 按 shape 取样（HTTP 由调用方注入 request，core 不发网络请求）：
 * snapshot 一次 GET；collections 按分页模式取到 samples 上限/页尽。
 * CLI 采样、backend probe、预览共用同一取行口径。
 */
export async function fetchShapeRows(opts: {
  shape: ApiShape
  collections: string[]
  /** 每集合行数上限（缺省 50；0 = 不限，跟分页走完）。 */
  samples?: number
  /** 注入 HTTP GET：返回响应体（解析后的 JSON）。路径含 query。 */
  request: (pathWithQuery: string) => Promise<unknown>
  maxPages?: number
}): Promise<SourceRows> {
  const { shape } = opts
  const samples = opts.samples ?? 50
  const maxPages = opts.maxPages ?? 20
  if (shape.mode === 'snapshot') {
    return extractSnapshotRows(await opts.request(shape.path ?? ''), shape)
  }
  const tpl = shape.collectionPath ?? '/api/v1/data/{collection}'
  const page = shape.pagination
  const out: SourceRows = {}
  for (const c of opts.collections) {
    const rows: SourceRow[] = []
    let cursor: string | null = null
    for (let i = 0; i < maxPages && (samples === 0 || rows.length < samples); i++) {
      const params = new URLSearchParams()
      if (page.mode === 'cursor' && cursor !== null) params.set(page.cursorParam ?? 'cursor', cursor)
      if (page.mode === 'offset') {
        params.set(page.limitParam ?? 'limit', String(page.pageSize ?? 100))
        params.set(page.offsetParam ?? 'offset', String(rows.length))
      }
      const qs = params.toString()
      const body = await opts.request(`${tpl.replace('{collection}', c)}${qs ? `?${qs}` : ''}`)
      rows.push(...extractPageItems(body, shape.itemsPath))
      if (page.mode !== 'cursor') break
      const next = readPath(body, page.nextField ?? 'nextCursor')
      cursor = typeof next === 'string' && next !== '' ? next : null
      if (cursor === null) break
    }
    out[c] = samples === 0 ? rows : rows.slice(0, samples)
  }
  return out
}
