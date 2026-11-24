/**
 * A2UI 1.0 子集 surface 契约（spec chat-run-report S2.2）：报表对话视图的声明式布局。
 *
 * - catalog `dsh-onto/report/v1`（18 组件，见 SURFACE_COMPONENT_TYPES）：
 *   Card/Stat/Row/Column/Text/Table/Accordion/Button（基础 8 件同名沿用 A2UI 1.0 basic
 *   catalog，Table/Stat/Accordion 为本 catalog 扩展）+ KeyValue/Badge/Callout/Progress/
 *   Timeline/Tabs/Chart/Input/Select/Compare；
 * - 红线：数值/分数/规则 ID/证据等数据槽位只接受字段绑定（`bind`/`field`），
 *   字面量数据 → 校验拒绝；标题/列名/标签等叙事文本允许字面量；
 * - 一次调用一个自包含快照（createSurface），不跨调用改写历史卡片。
 * @module @dsh-onto/core/surface
 */
import {
  CANDIDATE_ROW_FIELDS,
  isCandidateRowField,
  isReportListPointer,
  isReportPointer,
  reportPointerToRef,
} from './report.js'

export const SURFACE_CATALOG_ID = 'dsh-onto/report/v1'

export const SURFACE_COMPONENT_TYPES = [
  'Card',
  'Stat',
  'Row',
  'Column',
  'Text',
  'Table',
  'Accordion',
  'Button',
  'KeyValue',
  'Badge',
  'Callout',
  'Progress',
  'Timeline',
  'Tabs',
  'Chart',
  'Input',
  'Select',
  'Compare',
] as const
export type SurfaceComponentType = (typeof SURFACE_COMPONENT_TYPES)[number]

/** v1 配额（对齐参考仓库防御面，以报表切片够用为度）。 */
export const SURFACE_LIMITS = { maxNodes: 200, maxDepth: 8, maxColumns: 12, maxIdLength: 64 }

export interface SurfaceNode {
  id: string
  type: SurfaceComponentType
  props?: Record<string, unknown>
  children?: SurfaceNode[]
}

export interface A2uiSurfaceMessage {
  version: '1.0'
  type: 'createSurface'
  surfaceId: string
  catalogId: typeof SURFACE_CATALOG_ID
  title?: string
  root: SurfaceNode
}

export interface SurfaceDiagnostic {
  code: string
  where: string
  message: string
}

export type SurfaceValidation =
  | { ok: true; value: A2uiSurfaceMessage }
  | { ok: false; errors: SurfaceDiagnostic[] }

const LEAF_TYPES = new Set<SurfaceComponentType>([
  'Stat', 'Text', 'Table', 'Accordion', 'Button', 'KeyValue', 'Badge', 'Callout', 'Progress', 'Timeline', 'Tabs', 'Chart', 'Input', 'Select', 'Compare',
])
const NAVIGATE_TARGETS = new Set(['result-page'])
const FILTER_OPS = new Set(['eq', 'ne', 'gte', 'lte', 'contains'])
const BADGE_TONES = new Set(['success', 'warn', 'danger', 'accent', 'info', 'muted'])
const CALLOUT_TONES = new Set(['info', 'success', 'warning', 'error'])
const CHART_KINDS = new Set(['bars', 'line', 'donut'])
/** Accordion 可绑定的明细列表（候选表行内展开之外的整体绑定面）。 */
const ACCORDION_LIST_REFS = new Set([
  'candidates[].evidenceChains',
  'candidates[].pendingChecks',
  'candidates[].narrative',
  'candidates[].hitRuleIds',
])
/** 列表元素字段表（Timeline/Chart 共用；同一投影的唯一映射白名单，防两表漂移）。 */
export const LIST_ITEM_FIELDS: Record<string, readonly string[]> = {
  candidates: CANDIDATE_ROW_FIELDS,
  'candidates[].evidenceChains': ['ruleId', 'score', 'evidence'],
  'candidates[].pendingChecks': ['ruleId', 'missing', 'note'],
  ruleHitLog: ['ruleId', 'candidateId', 'score', 'ts'],
}
/** 各列表元素的数值字段（Chart.valueField 白名单；恒为 LIST_ITEM_FIELDS 子集）。 */
export const LIST_NUMERIC_FIELDS: Record<string, readonly string[]> = {
  candidates: ['riskScore', 'hitRuleCount', 'evidenceCount'],
  'candidates[].evidenceChains': ['score'],
  ruleHitLog: ['score'],
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== ''
}

/**
 * 绑定信封归一：`{"@path": "/…"}`（A2UI 形态）或裸指针字符串 → 指针字符串；
 * 数字/布尔等数据字面量、残缺信封 → null（数据槽位据此拒字面量）。
 */
export function bindPointer(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() !== '' ? value : null
  if (isRecord(value)) {
    const keys = Object.keys(value)
    if (keys.length !== 1 || keys[0] !== '@path') return null
    const p = value['@path']
    return isNonEmptyString(p) ? p : null
  }
  return null
}

/** 校验 surface（工具入参与 client 渲染前共用同一闸口）。 */
export function validateReportSurface(input: unknown): SurfaceValidation {
  const errors: SurfaceDiagnostic[] = []
  const err = (code: string, where: string, message: string): void => {
    errors.push({ code, where, message })
  }
  if (!isRecord(input)) {
    return { ok: false, errors: [{ code: 'SF_SHAPE', where: '$', message: 'surface 必须是对象' }] }
  }
  if (input.version !== '1.0') err('SF_SHAPE', '$.version', "version 必须是 '1.0'")
  if (input.type !== 'createSurface') err('SF_SHAPE', '$.type', "type 必须是 'createSurface'")
  if (input.catalogId !== SURFACE_CATALOG_ID) {
    err('SF_SHAPE', '$.catalogId', `catalogId 必须是 '${SURFACE_CATALOG_ID}'`)
  }
  if (!isNonEmptyString(input.surfaceId)) err('SF_SHAPE', '$.surfaceId', 'surfaceId 必须是非空字符串')
  if (input.title !== undefined && typeof input.title !== 'string') {
    err('SF_SHAPE', '$.title', 'title 必须是字符串')
  }
  const seenIds = new Set<string>()
  const seenStateIds = new Set<string>()
  let nodeCount = 0

  const walk = (node: unknown, where: string, depth: number): void => {
    if (!isRecord(node)) {
      err('SF_SHAPE', where, '节点必须是对象')
      return
    }
    nodeCount += 1
    if (nodeCount > SURFACE_LIMITS.maxNodes) {
      err('SF_NODE_LIMIT', where, `节点数超过 ${SURFACE_LIMITS.maxNodes}`)
      return
    }
    if (depth > SURFACE_LIMITS.maxDepth) {
      err('SF_DEPTH_EXCEEDED', where, `深度超过 ${SURFACE_LIMITS.maxDepth}`)
      return
    }
    const id = node.id
    if (!isNonEmptyString(id) || id.length > SURFACE_LIMITS.maxIdLength) {
      err('SF_ID_INVALID', where, 'id 必须是非空短字符串')
    } else if (seenIds.has(id)) {
      err('SF_ID_DUP', where, `重复 id: ${id}`)
    } else {
      seenIds.add(id)
    }
    const type = node.type
    if (
      typeof type !== 'string' ||
      !(SURFACE_COMPONENT_TYPES as readonly string[]).includes(type)
    ) {
      err('SF_TYPE_UNKNOWN', where, `未知组件类型: ${String(type)}`)
      return
    }
    const t = type as SurfaceComponentType
    const props = node.props === undefined ? {} : node.props
    if (!isRecord(props)) {
      err('SF_SHAPE', `${where}.props`, 'props 必须是对象')
      return
    }
    if ('when' in props) {
      validateWhen(props.when, `${where}.props.when`, err)
    }
    const children = node.children
    if (children !== undefined && !Array.isArray(children)) {
      err('SF_SHAPE', `${where}.children`, 'children 必须是数组')
      return
    }
    if (LEAF_TYPES.has(t) && Array.isArray(children) && children.length > 0) {
      err('SF_CHILDREN_FORBIDDEN', `${where}.children`, `${t} 不接受 children`)
      return
    }

    switch (t) {
      case 'Card': {
        rejectUnknownKeys(props, ['title', 'when'], where, err)
        if (props.title !== undefined && typeof props.title !== 'string') {
          err('SF_SHAPE', `${where}.props.title`, 'title 必须是字符串')
        }
        break
      }
      case 'Row':
      case 'Column': {
        rejectUnknownKeys(props, ['when'], where, err)
        break
      }
      case 'Stat': {
        rejectUnknownKeys(props, ['label', 'bind', 'spark', 'when'], where, err)
        if ('value' in props || 'text' in props) {
          err('SF_SLOT_LITERAL', where, 'Stat 数值槽位只允许 bind 绑定，拒绝字面量')
        }
        if (!isNonEmptyString(props.label)) err('SF_SHAPE', `${where}.props.label`, 'label 必填')
        const statBind = bindPointer(props.bind)
        if (statBind === null) {
          err('SF_SLOT_LITERAL', `${where}.props.bind`, 'Stat 数值槽位只允许 bind 字段绑定（{"@path":"/…"} 或指针字符串）')
        } else if (!isReportPointer(statBind)) {
          err('SF_BIND_INVALID', `${where}.props.bind`, `绑定不在报表契约内: ${statBind}`)
        }
        if (props.spark !== undefined) {
          const sparkWhere = `${where}.props.spark`
          if (!isRecord(props.spark)) {
            err('SF_SHAPE', sparkWhere, 'spark 必须是对象')
          } else {
            rejectUnknownKeys(props.spark, ['rowsBind', 'valueField'], sparkWhere, err)
            const sRows = bindPointer(props.spark.rowsBind)
            let sRef: string | null = null
            if (sRows === null) {
              err('SF_SLOT_LITERAL', `${sparkWhere}.rowsBind`, 'spark 数据槽位只允许列表绑定，拒绝字面量')
            } else if (!isReportListPointer(sRows)) {
              err('SF_BIND_INVALID', `${sparkWhere}.rowsBind`, `rowsBind 不是报表列表引用: ${sRows}`)
            } else {
              sRef = reportPointerToRef(sRows)
            }
            const sVal = props.spark.valueField
            const sAllowed = sRef !== null ? LIST_NUMERIC_FIELDS[sRef] : undefined
            if (!isNonEmptyString(sVal) || sAllowed === undefined || !sAllowed.includes(sVal)) {
              err('SF_FIELD_INVALID', `${sparkWhere}.valueField`, `valueField 不是该列表数值字段: ${String(sVal)}`)
            }
          }
        }
        break
      }
      case 'Text': {
        rejectUnknownKeys(props, ['text', 'bind', 'when'], where, err)
        const hasText = props.text !== undefined
        const hasBind = props.bind !== undefined
        if (hasText === hasBind) {
          err('SF_SHAPE', where, 'Text 必须且只能给 text（叙事）或 bind（数据）之一')
        }
        if (hasText && !isNonEmptyString(props.text)) {
          err('SF_SHAPE', `${where}.props.text`, 'text 必须是非空字符串')
        }
        if (hasBind) {
          const textBind = bindPointer(props.bind)
          if (textBind === null) {
            err('SF_SLOT_LITERAL', `${where}.props.bind`, 'Text 数据槽位只允许字段绑定，拒绝字面量')
          } else if (!isReportPointer(textBind)) {
            err('SF_BIND_INVALID', `${where}.props.bind`, `绑定不在报表契约内: ${textBind}`)
          }
        }
        break
      }
      case 'Table': {
        rejectUnknownKeys(props, ['columns', 'rowsBind', 'expandField', 'sort', 'filter', 'filterBy', 'export', 'when'], where, err)
        if (props.export !== undefined && typeof props.export !== 'boolean') {
          err('SF_SHAPE', `${where}.props.export`, 'export 必须是布尔')
        }
        if (props.filterBy !== undefined && !isValidStateId(props.filterBy)) {
          err('SF_SHAPE', `${where}.props.filterBy`, 'filterBy 必须是非空短 id（input 的 id）')
        }
        const rowsBind = bindPointer(props.rowsBind)
        if (rowsBind === null || reportPointerToRef(rowsBind) !== 'candidates') {
          err('SF_BIND_INVALID', `${where}.props.rowsBind`, "v1 候选表 rowsBind 必须绑定 '/candidates'（{\"@path\":\"/candidates\"} 或指针字符串）")
        }
        const columns = props.columns
        if (!Array.isArray(columns) || columns.length === 0) {
          err('SF_COLUMNS_INVALID', `${where}.props.columns`, 'columns 必须是非空数组')
          break
        }
        if (columns.length > SURFACE_LIMITS.maxColumns) {
          err('SF_COLUMNS_INVALID', `${where}.props.columns`, `列数超过 ${SURFACE_LIMITS.maxColumns}`)
        }
        columns.forEach((col, i) => {
          const cw = `${where}.props.columns[${i}]`
          if (!isRecord(col)) {
            err('SF_COLUMNS_INVALID', cw, '列声明必须是对象')
            return
          }
          rejectUnknownKeys(col, ['field', 'header', 'align', 'type'], cw, err)
          if (!isNonEmptyString(col.field) || !isCandidateRowField(col.field)) {
            err('SF_FIELD_INVALID', `${cw}.field`, `列字段不是候选行字段: ${String(col.field)}`)
          }
          if (!isNonEmptyString(col.header)) err('SF_SHAPE', `${cw}.header`, 'header 必填')
          if (col.align !== undefined && col.align !== 'left' && col.align !== 'right') {
            err('SF_SHAPE', `${cw}.align`, "align 只能是 'left'|'right'")
          }
          if (col.type !== undefined && (typeof col.type !== 'string' || !COLUMN_TYPES.has(col.type))) {
            err('SF_SHAPE', `${cw}.type`, `type 只能是 ${[...COLUMN_TYPES].join('|')}`)
          }
        })
        if (props.expandField !== undefined) {
          if (!isNonEmptyString(props.expandField) || !isCandidateRowField(props.expandField)) {
            err('SF_FIELD_INVALID', `${where}.props.expandField`, `展开字段不是候选行字段: ${String(props.expandField)}`)
          }
        }
        if (props.sort !== undefined) {
          const s = props.sort
          if (!isRecord(s)) {
            err('SF_SORT_INVALID', `${where}.props.sort`, 'sort 必须是对象')
          } else {
            rejectUnknownKeys(s, ['field', 'dir'], `${where}.props.sort`, err)
            if (!isNonEmptyString(s.field) || !isCandidateRowField(s.field)) {
              err('SF_SORT_INVALID', `${where}.props.sort.field`, `排序字段不是候选行字段: ${String(s.field)}`)
            }
            if (s.dir !== 'asc' && s.dir !== 'desc') {
              err('SF_SORT_INVALID', `${where}.props.sort.dir`, "dir 只能是 'asc'|'desc'")
            }
          }
        }
        if (props.filter !== undefined) {
          const f = props.filter
          if (!isRecord(f)) {
            err('SF_FILTER_INVALID', `${where}.props.filter`, 'filter 必须是对象')
          } else {
            rejectUnknownKeys(f, ['field', 'op', 'value'], `${where}.props.filter`, err)
            if (!isNonEmptyString(f.field) || !isCandidateRowField(f.field)) {
              err('SF_FILTER_INVALID', `${where}.props.filter.field`, `过滤字段不是候选行字段: ${String(f.field)}`)
            }
            if (typeof f.op !== 'string' || !FILTER_OPS.has(f.op)) {
              err('SF_FILTER_INVALID', `${where}.props.filter.op`, `未知过滤算子: ${String(f.op)}`)
            }
            if (!(typeof f.value === 'string' || typeof f.value === 'number')) {
              err('SF_FILTER_INVALID', `${where}.props.filter.value`, 'value 只能是字符串或数字')
            }
          }
        }
        break
      }
      case 'Accordion': {
        rejectUnknownKeys(props, ['title', 'bind', 'defaultExpanded', 'when'], where, err)
        if (!isNonEmptyString(props.title)) err('SF_SHAPE', `${where}.props.title`, 'title 必填')
        const bind = bindPointer(props.bind)
        if (bind === null) {
          err('SF_SLOT_LITERAL', `${where}.props.bind`, 'Accordion 列表槽位只允许字段绑定，拒绝字面量')
        } else if (!isReportListPointer(bind)) {
          err('SF_BIND_INVALID', `${where}.props.bind`, `绑定不是报表列表引用: ${bind}`)
        } else {
          const ref = reportPointerToRef(bind)
          if (ref === 'candidates' || !(ref !== null && ACCORDION_LIST_REFS.has(ref))) {
            err('SF_BIND_INVALID', `${where}.props.bind`, `Accordion 不可绑定该列表: ${bind}`)
          }
        }
        if (props.defaultExpanded !== undefined && typeof props.defaultExpanded !== 'boolean') {
          err('SF_SHAPE', `${where}.props.defaultExpanded`, 'defaultExpanded 必须是布尔')
        }
        break
      }
      case 'Button': {
        rejectUnknownKeys(props, ['label', 'action', 'target', 'when'], where, err)
        if (!isNonEmptyString(props.label)) err('SF_SHAPE', `${where}.props.label`, 'label 必填')
        if (props.action !== 'navigate') {
          err('SF_ACTION_INVALID', `${where}.props.action`, "v1 action 只支持 'navigate'")
        }
        if (typeof props.target !== 'string' || !NAVIGATE_TARGETS.has(props.target)) {
          err('SF_ACTION_INVALID', `${where}.props.target`, "v1 target 只支持 'result-page'")
        }
        break
      }
      case 'KeyValue': {
        rejectUnknownKeys(props, ['pairs', 'when'], where, err)
        const pairs = props.pairs
        if (!Array.isArray(pairs) || pairs.length === 0) {
          err('SF_SHAPE', `${where}.props.pairs`, 'pairs 必须是非空数组')
          break
        }
        if (pairs.length > 20) err('SF_SHAPE', `${where}.props.pairs`, 'pairs 超过 20')
        pairs.forEach((p, i) => {
          const pw = `${where}.props.pairs[${i}]`
          if (!isRecord(p)) {
            err('SF_SHAPE', pw, 'pair 必须是对象')
            return
          }
          rejectUnknownKeys(p, ['key', 'bind'], pw, err)
          if (!isNonEmptyString(p.key)) err('SF_SHAPE', `${pw}.key`, 'key 必须是非空叙事文本')
          const pBind = bindPointer(p.bind)
          if (pBind === null) {
            err('SF_SLOT_LITERAL', `${pw}.bind`, 'KeyValue 值槽位只允许字段绑定，拒绝字面量')
          } else if (!isReportPointer(pBind)) {
            err('SF_BIND_INVALID', `${pw}.bind`, `绑定不在报表契约内: ${pBind}`)
          }
        })
        break
      }
      case 'Badge': {
        rejectUnknownKeys(props, ['label', 'bind', 'tone', 'when'], where, err)
        if (props.label === undefined && props.bind === undefined) {
          err('SF_SHAPE', where, 'Badge 须给 label（叙事）或 bind（数据）')
        }
        if (props.label !== undefined && !isNonEmptyString(props.label)) {
          err('SF_SHAPE', `${where}.props.label`, 'label 必须是非空字符串')
        }
        if (props.bind !== undefined) {
          const bBind = bindPointer(props.bind)
          if (bBind === null) {
            err('SF_SLOT_LITERAL', `${where}.props.bind`, 'Badge 值槽位只允许字段绑定，拒绝字面量')
          } else if (!isReportPointer(bBind)) {
            err('SF_BIND_INVALID', `${where}.props.bind`, `绑定不在报表契约内: ${bBind}`)
          }
        }
        if (props.tone !== undefined && (typeof props.tone !== 'string' || !BADGE_TONES.has(props.tone))) {
          err('SF_SHAPE', `${where}.props.tone`, `tone 只能是 ${[...BADGE_TONES].join('|')}`)
        }
        break
      }
      case 'Callout': {
        rejectUnknownKeys(props, ['tone', 'title', 'content', 'bind', 'when'], where, err)
        const hasContent = props.content !== undefined
        const hasBind = props.bind !== undefined
        if (hasContent === hasBind) {
          err('SF_SHAPE', where, 'Callout 必须且只能给 content（叙事）或 bind（数据）之一')
        }
        if (hasContent && !isNonEmptyString(props.content)) {
          err('SF_SHAPE', `${where}.props.content`, 'content 必须是非空字符串')
        }
        if (hasBind) {
          const cBind = bindPointer(props.bind)
          if (cBind === null) {
            err('SF_SLOT_LITERAL', `${where}.props.bind`, 'Callout 数据槽位只允许字段绑定，拒绝字面量')
          } else if (!isReportPointer(cBind)) {
            err('SF_BIND_INVALID', `${where}.props.bind`, `绑定不在报表契约内: ${cBind}`)
          }
        }
        if (props.title !== undefined && !isNonEmptyString(props.title)) {
          err('SF_SHAPE', `${where}.props.title`, 'title 必须是非空字符串')
        }
        if (props.tone !== undefined && (typeof props.tone !== 'string' || !CALLOUT_TONES.has(props.tone))) {
          err('SF_SHAPE', `${where}.props.tone`, `tone 只能是 ${[...CALLOUT_TONES].join('|')}`)
        }
        break
      }
      case 'Progress': {
        rejectUnknownKeys(props, ['label', 'bind', 'max', 'display', 'when'], where, err)
        if ('value' in props) {
          err('SF_SLOT_LITERAL', where, 'Progress 数值槽位只允许 bind 绑定，拒绝字面量')
        }
        const prBind = bindPointer(props.bind)
        if (prBind === null) {
          err('SF_SLOT_LITERAL', `${where}.props.bind`, 'Progress 数值槽位只允许 bind 字段绑定')
        } else if (!isReportPointer(prBind)) {
          err('SF_BIND_INVALID', `${where}.props.bind`, `绑定不在报表契约内: ${prBind}`)
        }
        if (props.max !== undefined && (typeof props.max !== 'number' || !Number.isFinite(props.max) || props.max <= 0)) {
          err('SF_SHAPE', `${where}.props.max`, 'max 必须是正有限数（刻度配置）')
        }
        if (props.display !== undefined && props.display !== 'bar' && props.display !== 'ring') {
          err('SF_SHAPE', `${where}.props.display`, "display 只能是 'bar'|'ring'")
        }
        if (props.label !== undefined && !isNonEmptyString(props.label)) {
          err('SF_SHAPE', `${where}.props.label`, 'label 必须是非空字符串')
        }
        break
      }
      case 'Timeline': {
        rejectUnknownKeys(props, ['title', 'bind', 'titleField', 'descField', 'timeField', 'when'], where, err)
        if (props.title !== undefined && !isNonEmptyString(props.title)) {
          err('SF_SHAPE', `${where}.props.title`, 'title 必须是非空字符串')
        }
        const tBind = bindPointer(props.bind)
        let tRef: string | null = null
        if (tBind === null) {
          err('SF_SLOT_LITERAL', `${where}.props.bind`, 'Timeline 列表槽位只允许字段绑定，拒绝字面量')
        } else if (!isReportListPointer(tBind)) {
          err('SF_BIND_INVALID', `${where}.props.bind`, `绑定不是报表列表引用: ${tBind}`)
        } else {
          tRef = reportPointerToRef(tBind)
        }
        for (const key of ['titleField', 'descField', 'timeField'] as const) {
          const f = props[key]
          if (f === undefined) continue
          if (!isNonEmptyString(f)) {
            err('SF_FIELD_INVALID', `${where}.props.${key}`, `${key} 必须是非空字段名`)
            continue
          }
          const allowed = tRef !== null ? LIST_ITEM_FIELDS[tRef] : undefined
          if (allowed === undefined || !allowed.includes(f)) {
            err('SF_FIELD_INVALID', `${where}.props.${key}`, `${key} 不是该列表元素字段: ${f}`)
          }
        }
        break
      }
      case 'Tabs': {
        rejectUnknownKeys(props, ['tabs', 'when'], where, err)
        const tabs = props.tabs
        if (!Array.isArray(tabs) || tabs.length === 0) {
          err('SF_SHAPE', `${where}.props.tabs`, 'tabs 必须是非空数组')
          break
        }
        if (tabs.length > 10) err('SF_SHAPE', `${where}.props.tabs`, 'tabs 超过 10')
        tabs.forEach((t, i) => {
          const tw = `${where}.props.tabs[${i}]`
          if (!isRecord(t)) {
            err('SF_SHAPE', tw, 'tab 必须是对象')
            return
          }
          rejectUnknownKeys(t, ['label', 'items'], tw, err)
          if (!isNonEmptyString(t.label)) err('SF_SHAPE', `${tw}.label`, 'label 必填')
          const items = t.items
          if (items !== undefined) {
            if (!Array.isArray(items)) {
              err('SF_SHAPE', `${tw}.items`, 'items 必须是数组')
              return
            }
            items.forEach((c, j) => walk(c, `${tw}.items[${j}]`, depth + 1))
          }
        })
        break
      }
      case 'Chart': {
        // 绑定红线的图表延伸：点值只能经 valueField 从绑定列表取数，数据数组字面量整体拒
        if ('data' in props || 'values' in props || 'series' in props || 'points' in props) {
          err('SF_SLOT_LITERAL', where, 'Chart 只接受序列绑定（rowsBind+labelField+valueField），拒绝字面量数据')
        }
        rejectUnknownKeys(props, ['kind', 'rowsBind', 'labelField', 'valueField', 'valueFields', 'mode', 'stackFrom', 'seriesField', 'title', 'horizontal', 'height', 'palette', 'when'], where, err)
        if (typeof props.kind !== 'string' || !CHART_KINDS.has(props.kind)) {
          err('SF_SHAPE', `${where}.props.kind`, `kind 只能是 ${[...CHART_KINDS].join('|')}`)
        }
        const cRows = bindPointer(props.rowsBind)
        let cRef: string | null = null
        if (cRows === null) {
          err('SF_SLOT_LITERAL', `${where}.props.rowsBind`, 'Chart 数据槽位只允许列表绑定，拒绝字面量')
        } else if (!isReportListPointer(cRows)) {
          err('SF_BIND_INVALID', `${where}.props.rowsBind`, `rowsBind 不是报表列表引用: ${cRows}`)
        } else {
          cRef = reportPointerToRef(cRows)
        }
        const labelField = props.labelField
        if (!isNonEmptyString(labelField)) {
          err('SF_FIELD_INVALID', `${where}.props.labelField`, 'labelField 必填')
        } else {
          const allowedLabels = cRef !== null ? LIST_ITEM_FIELDS[cRef] : undefined
          if (allowedLabels === undefined || !allowedLabels.includes(labelField)) {
            err('SF_FIELD_INVALID', `${where}.props.labelField`, `labelField 不是该列表元素字段: ${labelField}`)
          }
        }
        // 模式（report-series-state S2.1）：grouped=同行多列；stacked=行内嵌套列表堆叠
        const mode = props.mode
        const isGrouped = mode === 'grouped'
        const isStacked = mode === 'stacked'
        if (mode !== undefined && !isGrouped && !isStacked) {
          err('SF_SHAPE', `${where}.props.mode`, "mode 只能是 'grouped'|'stacked'")
        }
        if ((isGrouped || isStacked) && props.kind !== 'bars') {
          err('SF_SHAPE', `${where}.props.mode`, 'mode 仅 bars 支持')
        }
        const dualHitValue = (f: unknown, w: string): void => {
          if (!isNonEmptyString(f)) {
            err('SF_FIELD_INVALID', w, '数值字段必填')
            return
          }
          const items = cRef !== null ? LIST_ITEM_FIELDS[cRef] : undefined
          const nums = cRef !== null ? LIST_NUMERIC_FIELDS[cRef] : undefined
          if (items === undefined || nums === undefined || !items.includes(f) || !nums.includes(f)) {
            err('SF_FIELD_INVALID', w, `不是该列表数值字段: ${f}`)
          }
        }
        if (isStacked) {
          if (props.valueField !== undefined || props.valueFields !== undefined) {
            err('SF_SHAPE', where, 'stacked 使用 stackFrom，不接受 valueField/valueFields')
          }
          const sf = props.stackFrom
          if (!isRecord(sf)) {
            err('SF_SHAPE', `${where}.props.stackFrom`, 'stacked 须给 stackFrom 对象')
          } else {
            rejectUnknownKeys(sf, ['listField', 'labelField', 'valueField'], `${where}.props.stackFrom`, err)
            const listField = sf.listField
            if (!isNonEmptyString(listField)) {
              err('SF_FIELD_INVALID', `${where}.props.stackFrom.listField`, 'listField 必填')
            } else {
              const nested = cRef !== null ? `${cRef}[].${listField}` : null
              const nestedItems = nested !== null ? LIST_ITEM_FIELDS[nested] : undefined
              const nestedNums = nested !== null ? LIST_NUMERIC_FIELDS[nested] : undefined
              if (nestedItems === undefined) {
                err('SF_FIELD_INVALID', `${where}.props.stackFrom.listField`, `listField 不是该列表的嵌套列表字段: ${listField}`)
              } else {
                if (!isNonEmptyString(sf.labelField) || !nestedItems.includes(sf.labelField)) {
                  err('SF_FIELD_INVALID', `${where}.props.stackFrom.labelField`, `labelField 不是嵌套元素字段: ${String(sf.labelField)}`)
                }
                if (!isNonEmptyString(sf.valueField) || nestedNums === undefined || !nestedNums.includes(sf.valueField)) {
                  err('SF_FIELD_INVALID', `${where}.props.stackFrom.valueField`, `valueField 不是嵌套数值字段: ${String(sf.valueField)}`)
                }
              }
            }
          }
        } else if (isGrouped) {
          if (props.valueField !== undefined || props.stackFrom !== undefined) {
            err('SF_SHAPE', where, 'grouped 使用 valueFields，不接受 valueField/stackFrom')
          }
          const vfs = props.valueFields
          if (!Array.isArray(vfs) || vfs.length < 2 || vfs.length > 4) {
            err('SF_SHAPE', `${where}.props.valueFields`, 'valueFields 必须是 2–4 个数值字段的数组')
          } else if (new Set(vfs.map((f) => String(f))).size !== vfs.length) {
            err('SF_SHAPE', `${where}.props.valueFields`, 'valueFields 不得重复')
          } else {
            vfs.forEach((f, i) => dualHitValue(f, `${where}.props.valueFields[${i}]`))
          }
        } else {
          if (props.valueFields !== undefined || props.stackFrom !== undefined) {
            err('SF_SHAPE', where, '单序列不接受 valueFields/stackFrom（请给 mode）')
          }
          dualHitValue(props.valueField, `${where}.props.valueField`)
        }
        if (props.seriesField !== undefined) {
          if (props.kind !== 'line') {
            err('SF_SHAPE', `${where}.props.seriesField`, 'seriesField 仅 line 支持')
          }
          const items = cRef !== null ? LIST_ITEM_FIELDS[cRef] : undefined
          if (!isNonEmptyString(props.seriesField) || items === undefined || !items.includes(props.seriesField)) {
            err('SF_FIELD_INVALID', `${where}.props.seriesField`, `seriesField 不是该列表元素字段: ${String(props.seriesField)}`)
          }
        }
        if (props.title !== undefined && !isNonEmptyString(props.title)) {
          err('SF_SHAPE', `${where}.props.title`, 'title 必须是非空字符串')
        }
        if (props.horizontal !== undefined) {
          if (typeof props.horizontal !== 'boolean') {
            err('SF_SHAPE', `${where}.props.horizontal`, 'horizontal 必须是布尔')
          } else if (props.horizontal === true && props.kind !== 'bars') {
            err('SF_SHAPE', `${where}.props.horizontal`, 'horizontal 仅 bars 支持')
          }
        }
        if (
          props.height !== undefined &&
          (typeof props.height !== 'number' || !Number.isFinite(props.height) || props.height < 80 || props.height > 400)
        ) {
          err('SF_SHAPE', `${where}.props.height`, 'height 必须是 80–400 的有限数')
        }
        if (props.palette !== undefined) {
          const pal = props.palette
          if (!Array.isArray(pal) || pal.length === 0 || pal.length > 8) {
            err('SF_SHAPE', `${where}.props.palette`, 'palette 必须是 1–8 个颜色的数组')
          } else {
            for (const [i, c] of pal.entries()) {
              if (typeof c !== 'string' || !/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(c)) {
                err('SF_SHAPE', `${where}.props.palette[${i}]`, 'palette 项须为 #rgb 或 #rrggbb')
              }
            }
          }
        }
        break
      }
      case 'Input': {
        rejectUnknownKeys(props, ['id', 'label', 'placeholder', 'when'], where, err)
        const id = props.id
        if (!isValidStateId(id)) {
          err('SF_SHAPE', `${where}.props.id`, 'id 必须是非空短 id')
        } else if (seenStateIds.has(id)) {
          err('SF_ID_DUP', `${where}.props.id`, `重复交互 id: ${id}`)
        } else {
          seenStateIds.add(id)
        }
        if (props.label !== undefined && !isNonEmptyString(props.label)) {
          err('SF_SHAPE', `${where}.props.label`, 'label 必须是非空字符串')
        }
        if (props.placeholder !== undefined && !isNonEmptyString(props.placeholder)) {
          err('SF_SHAPE', `${where}.props.placeholder`, 'placeholder 必须是非空字符串')
        }
        break
      }
      case 'Select': {
        rejectUnknownKeys(props, ['id', 'label', 'options', 'value', 'when'], where, err)
        const id = props.id
        if (!isValidStateId(id)) {
          err('SF_SHAPE', `${where}.props.id`, 'id 必须是非空短 id')
        } else if (seenStateIds.has(id)) {
          err('SF_ID_DUP', `${where}.props.id`, `重复交互 id: ${id}`)
        } else {
          seenStateIds.add(id)
        }
        if (props.label !== undefined && !isNonEmptyString(props.label)) {
          err('SF_SHAPE', `${where}.props.label`, 'label 必须是非空字符串')
        }
        const opts = props.options
        if (!Array.isArray(opts) || opts.length < 2 || opts.length > 20 || opts.some((o) => !isNonEmptyString(o))) {
          err('SF_SHAPE', `${where}.props.options`, 'options 必须是 2–20 个非空字符串')
        } else if (props.value !== undefined && !opts.includes(props.value)) {
          err('SF_SHAPE', `${where}.props.value`, 'value 必须是 options 之一')
        }
        break
      }
      case 'Compare': {
        // 对比面（report-export-compare S2.3）：固定布局，数据随上下文（diff 视图）绑定
        rejectUnknownKeys(props, ['title', 'when'], where, err)
        if (props.title !== undefined && !isNonEmptyString(props.title)) {
          err('SF_SHAPE', `${where}.props.title`, 'title 必须是非空字符串')
        }
        break
      }
    }

    if (Array.isArray(children)) {
      children.forEach((c, i) => walk(c, `${where}.children[${i}]`, depth + 1))
    }
  }

  walk(input.root, '$.root', 1)

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value: input as unknown as A2uiSurfaceMessage }
}

function rejectUnknownKeys(
  props: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
  err: (code: string, where: string, message: string) => void,
): void {
  for (const key of Object.keys(props)) {
    if (!allowed.includes(key)) {
      err('SF_PROPS_UNKNOWN', `${where}.props.${key}`, `未知属性: ${key}`)
    }
  }
}

const WHEN_OPS = new Set(['eq', 'neq', 'in', 'not-in', 'gt', 'gte', 'lt', 'lte', 'empty', 'not-empty'])
const COLUMN_TYPES = new Set(['text', 'num', 'bar', 'badge', 'delta'])
/** 交互 id 保留字（防原型链读取面）；id/when.field/filterBy 一律拒绝。 */
const RESERVED_STATE_IDS = new Set(['__proto__', 'constructor', 'prototype'])

function isValidStateId(id: unknown): id is string {
  return isNonEmptyString(id) && id.length <= 64 && !RESERVED_STATE_IDS.has(id)
}

/** `when` 谓词槽校验（全组件通用；report-extras S2.1）。 */
function validateWhen(
  when: unknown,
  where: string,
  err: (code: string, where: string, message: string) => void,
): void {
  if (!isRecord(when)) {
    err('SF_SHAPE', where, 'when 必须是对象')
    return
  }
  rejectUnknownKeys(when, ['bind', 'field', 'op', 'value'], where, err)
  const hasBind = when.bind !== undefined
  const hasField = when.field !== undefined
  if (hasBind === hasField) {
    err('SF_SHAPE', where, 'when 必须且只能给 bind（数据源）或 field（UI 状态源）之一')
  }
  if (hasBind) {
    const bind = bindPointer(when.bind)
    if (bind === null) {
      err('SF_SLOT_LITERAL', `${where}.bind`, 'when.bind 只允许字段绑定，拒绝字面量')
    } else {
      // empty/not-empty 放行列表指针（数组空/非空语义）；比较族仍限元素字段
      const listOp = when.op === 'empty' || when.op === 'not-empty'
      if (!isReportPointer(bind) && !(listOp && isReportListPointer(bind))) {
        err('SF_BIND_INVALID', `${where}.bind`, `绑定不在报表契约内: ${bind}`)
      }
    }
  }
  if (hasField) {
    if (!isValidStateId(when.field)) {
      err('SF_SHAPE', `${where}.field`, 'field 必须是非空短 id（input/select 的 id，避开保留字）')
    }
  }
  if (typeof when.op !== 'string' || !WHEN_OPS.has(when.op)) {
    err('SF_SHAPE', `${where}.op`, `op 只能是 ${[...WHEN_OPS].join('|')}`)
    return
  }
  const op = String(when.op)
  if (op === 'empty' || op === 'not-empty') {
    if ('value' in when) {
      err('SF_SHAPE', `${where}.value`, `${op} 不接受 value`)
    }
  } else if (op === 'in' || op === 'not-in') {
    if (
      !Array.isArray(when.value) ||
      when.value.length === 0 ||
      when.value.some((v) => !(typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'))
    ) {
      err('SF_SHAPE', `${where}.value`, `${op} 的 value 必须是非空原语数组`)
    }
  } else {
    if (!(typeof when.value === 'string' || typeof when.value === 'number' || typeof when.value === 'boolean')) {
      err('SF_SHAPE', `${where}.value`, `${op} 需要字符串/数字/布尔 value`)
    }
  }
}

/** 缺省报表 surface（摘要卡 + 候选表 + 证据行内展开）。 */
export function buildDefaultReportSurface(opts: { title?: string; surfaceId?: string } = {}): A2uiSurfaceMessage {
  return {
    version: '1.0',
    type: 'createSurface',
    surfaceId: opts.surfaceId ?? 'run-report-default',
    catalogId: SURFACE_CATALOG_ID,
    ...(opts.title === undefined ? {} : { title: opts.title }),
    root: {
      id: 'root',
      type: 'Card',
      props: { title: '运行报表' },
      children: [
        {
          id: 'meta',
          type: 'KeyValue',
          props: {
            pairs: [
              { key: 'runId', bind: '/runRef/runId' },
              { key: '包', bind: '/runRef/package/name' },
              { key: '场景', bind: '/runRef/scenarioId' },
              { key: '数据集候选', bind: '/summary/datasetSummary/candidates' },
              { key: '数据状态', bind: '/summary/dataStatus' },
            ],
          },
        },
        {
          id: 'hr-badge',
          type: 'Badge',
          props: { label: 'humanReviewRequired', bind: '/summary/humanReviewRequired', tone: 'warn' },
        },
        {
          id: 'summary',
          type: 'Row',
          children: [
            { id: 'stat-candidates', type: 'Stat', props: { label: '候选数', bind: '/summary/candidateCount' } },
            { id: 'stat-max-risk', type: 'Stat', props: { label: '最高风险分', bind: '/summary/maxRiskScore' } },
            { id: 'stat-hit-rules', type: 'Stat', props: { label: '命中规则数', bind: '/summary/hitRuleCount' } },
            { id: 'stat-review', type: 'Stat', props: { label: '人审必需', bind: '/summary/humanReviewRequired' } },
          ],
        },
        {
          id: 'risk-chart',
          type: 'Chart',
          props: {
            kind: 'bars',
            title: '风险分布',
            rowsBind: '/candidates',
            labelField: 'candidateId',
            valueField: 'riskScore',
          },
        },
        {
          id: 'candidate-table',
          type: 'Table',
          props: {
            rowsBind: '/candidates',
            columns: [
              { field: 'candidateId', header: '候选' },
              { field: 'objectRef', header: '对象' },
              { field: 'riskScore', header: '风险分', align: 'right' },
              { field: 'hitRuleIds', header: '命中规则' },
            ],
            expandField: 'evidenceChains',
            sort: { field: 'riskScore', dir: 'desc' },
          },
        },
      ],
    },
  }
}
