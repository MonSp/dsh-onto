/**
 * A2UI 1.0 子集 surface 契约（spec chat-run-report S2.2）：报表对话视图的声明式布局。
 *
 * - catalog `dsh-onto/report/v1`：Card/Stat/Row/Column/Text/Table/Accordion/Button
 *   （同名沿用 A2UI 1.0 basic catalog，Table/Stat/Accordion 为本 catalog 扩展）；
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
  'Stat', 'Text', 'Table', 'Accordion', 'Button', 'KeyValue', 'Badge', 'Callout', 'Progress', 'Timeline', 'Tabs',
])
const NAVIGATE_TARGETS = new Set(['result-page'])
const FILTER_OPS = new Set(['eq', 'ne', 'gte', 'lte', 'contains'])
const BADGE_TONES = new Set(['success', 'warn', 'danger', 'accent', 'info', 'muted'])
const CALLOUT_TONES = new Set(['info', 'success', 'warning', 'error'])
/** Accordion 可绑定的明细列表（候选表行内展开之外的整体绑定面）。 */
const ACCORDION_LIST_REFS = new Set([
  'candidates[].evidenceChains',
  'candidates[].pendingChecks',
  'candidates[].narrative',
  'candidates[].hitRuleIds',
])
/** Timeline 行字段映射面（对象列表的元素字段；纯字符串列表不接受字段映射）。 */
const TIMELINE_ITEM_FIELDS: Record<string, readonly string[]> = {
  candidates: CANDIDATE_ROW_FIELDS,
  'candidates[].evidenceChains': ['ruleId', 'score', 'evidence'],
  'candidates[].pendingChecks': ['ruleId', 'missing', 'note'],
  ruleHitLog: ['ruleId', 'candidateId', 'score', 'ts'],
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
        rejectUnknownKeys(props, ['title'], where, err)
        if (props.title !== undefined && typeof props.title !== 'string') {
          err('SF_SHAPE', `${where}.props.title`, 'title 必须是字符串')
        }
        break
      }
      case 'Row':
      case 'Column': {
        rejectUnknownKeys(props, [], where, err)
        break
      }
      case 'Stat': {
        rejectUnknownKeys(props, ['label', 'bind'], where, err)
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
        break
      }
      case 'Text': {
        rejectUnknownKeys(props, ['text', 'bind'], where, err)
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
        rejectUnknownKeys(props, ['columns', 'rowsBind', 'expandField', 'sort', 'filter'], where, err)
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
          rejectUnknownKeys(col, ['field', 'header', 'align'], cw, err)
          if (!isNonEmptyString(col.field) || !isCandidateRowField(col.field)) {
            err('SF_FIELD_INVALID', `${cw}.field`, `列字段不是候选行字段: ${String(col.field)}`)
          }
          if (!isNonEmptyString(col.header)) err('SF_SHAPE', `${cw}.header`, 'header 必填')
          if (col.align !== undefined && col.align !== 'left' && col.align !== 'right') {
            err('SF_SHAPE', `${cw}.align`, "align 只能是 'left'|'right'")
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
        rejectUnknownKeys(props, ['title', 'bind', 'defaultExpanded'], where, err)
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
        rejectUnknownKeys(props, ['label', 'action', 'target'], where, err)
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
        rejectUnknownKeys(props, ['pairs'], where, err)
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
        rejectUnknownKeys(props, ['label', 'bind', 'tone'], where, err)
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
        rejectUnknownKeys(props, ['tone', 'title', 'content', 'bind'], where, err)
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
        rejectUnknownKeys(props, ['label', 'bind', 'max', 'display'], where, err)
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
        rejectUnknownKeys(props, ['title', 'bind', 'titleField', 'descField', 'timeField'], where, err)
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
          const allowed = tRef !== null ? TIMELINE_ITEM_FIELDS[tRef] : undefined
          if (allowed === undefined || !allowed.includes(f)) {
            err('SF_FIELD_INVALID', `${where}.props.${key}`, `${key} 不是该列表元素字段: ${f}`)
          }
        }
        break
      }
      case 'Tabs': {
        rejectUnknownKeys(props, ['tabs'], where, err)
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
