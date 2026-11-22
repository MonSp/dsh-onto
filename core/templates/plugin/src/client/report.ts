/**
 * A2UI 1.0 子集报表渲染（spec chat-run-report S2.5）：
 * 读 toolview meta（runRef+surface）→ wire getRunReport 受权取数 → 按绑定解析渲染；
 * 事件只做筛选（含表头排序）/展开/跳转；渲染或取数失败回退工具文本。
 * surface 校验与 core 共用同一实现（@dsh-onto/core/surface 纯子路径）。
 */
import { h, useState, useEffect, Component } from './react'
import type { ReactNode } from './types'
import {
  bindPointer,
  buildDefaultReportSurface,
  validateReportSurface,
  type A2uiSurfaceMessage,
  type SurfaceNode,
} from '@dsh-onto/core/surface'
import { resolveReportPointer, type RunReport } from '@dsh-onto/core/report'

type T = (key: string) => string

export interface ToolResultContentBlock {
  type: string
  text?: string
}

export interface ToolViewProps {
  phase: 'preparing' | 'start' | 'result'
  block: {
    name?: string
    content?: readonly ToolResultContentBlock[]
    isError?: boolean
    meta?: unknown
    args?: unknown
  }
}

interface ReportMeta {
  runRef: { runId: string }
  surface: unknown
  surfaceSource: string
}

interface ReportApi {
  getRunReport(request: { runId: string }): Promise<unknown>
}

function unwrap<T2>(result: unknown): T2 {
  if (result && typeof result === 'object' && 'ok' in (result as Record<string, unknown>)) {
    const r = result as {
      ok: boolean
      value?: T2
      error?: { message: string; code?: string; details?: { origCode?: string } }
    }
    if (r.ok) return r.value as T2
    const code = r.error?.details?.origCode ?? r.error?.code
    const msg = r.error?.message ?? 'remote error'
    throw new Error(code ? `${code}: ${msg}` : msg)
  }
  return result as T2
}

function errText(e: unknown): string {
  if (e && typeof e === 'object') {
    const anyE = e as { code?: string; details?: { origCode?: string }; message?: string }
    const code = anyE.details?.origCode ?? anyE.code
    const msg = anyE.message ?? String(e)
    if (code && !msg.startsWith(code)) return `${code}: ${msg}`
    return msg
  }
  return String(e)
}

export function fallbackText(block: ToolViewProps['block']): string {
  return (block.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
}

function parseMeta(meta: unknown): ReportMeta | null {
  if (meta === null || typeof meta !== 'object') return null
  const m = meta as Record<string, unknown>
  const runRef = m.runRef
  if (runRef === null || typeof runRef !== 'object') return null
  const runId = (runRef as Record<string, unknown>).runId
  if (typeof runId !== 'string' || runId === '') return null
  return { runRef: { runId }, surface: m.surface, surfaceSource: String(m.surfaceSource ?? '') }
}

function fmtValue(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (Array.isArray(v)) {
    return v
      .map((x) => (x !== null && typeof x === 'object' ? JSON.stringify(x) : fmtValue(x)))
      .join(', ')
  }
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

function listItems(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

interface RenderCtx {
  report: RunReport
  t: T
  navigate: () => void
}

function renderBound(props: Record<string, unknown>, ctx: RenderCtx): ReactNode {
  const pointer = bindPointer(props.bind)
  if (pointer === null) return fmtValue(null)
  return fmtValue(resolveReportPointer(ctx.report, pointer))
}

function renderListBlock(items: unknown[], t: T): ReactNode {
  if (items.length === 0) return h('p', { className: 'txri-note' }, '—')
  return h(
    'ul',
    null,
    ...items.map((it, i) => {
      if (it === null || typeof it !== 'object') return h('li', { key: i }, fmtValue(it))
      const rec = it as Record<string, unknown>
      const parts = Object.entries(rec).map(([k, v]) => `${k}: ${fmtValue(v)}`)
      return h('li', { key: i, className: 'txri-mono' }, parts.join(' · ') || t('evidenceEmpty'))
    }),
  )
}

function ReportTable(props: { node: SurfaceNode; ctx: RenderCtx }): ReactNode {
  const { node, ctx } = props
  const t = ctx.t
  const p = (node.props ?? {}) as Record<string, unknown>
  const columns = Array.isArray(p.columns)
    ? (p.columns as Array<Record<string, unknown>>).filter(
        (c) => c !== null && typeof c === 'object' && typeof c.field === 'string',
      )
    : []
  const rowsRaw = listItems(resolveReportPointer(ctx.report, bindPointer(p.rowsBind) ?? '/'))
  const declaredSort = (p.sort ?? null) as { field: string; dir: 'asc' | 'desc' } | null
  const [sort, setSort] = useState<{ field: string; dir: 'asc' | 'desc' } | null>(
    declaredSort && typeof declaredSort.field === 'string' ? declaredSort : null,
  )
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const expandField = typeof p.expandField === 'string' ? p.expandField : ''
  const filter = (p.filter ?? null) as { field: string; op: string; value: unknown } | null

  let rows = rowsRaw.filter((r) => r !== null && typeof r === 'object') as Array<Record<string, unknown>>
  if (filter !== null && typeof filter.field === 'string') {
    rows = rows.filter((r) => {
      const v = r[filter.field]
      const s = fmtValue(v)
      switch (filter.op) {
        case 'eq':
          return fmtValue(filter.value) === s
        case 'ne':
          return fmtValue(filter.value) !== s
        case 'gte':
          return Number(v) >= Number(filter.value)
        case 'lte':
          return Number(v) <= Number(filter.value)
        case 'contains':
          return s.includes(String(filter.value))
        default:
          return true
      }
    })
  }
  const q = query.trim().toLowerCase()
  if (q !== '') {
    rows = rows.filter((r) => JSON.stringify(r).toLowerCase().includes(q))
  }
  if (sort !== null) {
    const dir = sort.dir === 'desc' ? -1 : 1
    rows = [...rows].sort((a, b) => {
      const x = a[sort.field]
      const y = b[sort.field]
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir
      return (fmtValue(x) < fmtValue(y) ? -1 : fmtValue(x) > fmtValue(y) ? 1 : 0) * dir
    })
  }

  const toggleSort = (field: string) => {
    if (sort !== null && sort.field === field) {
      setSort(sort.dir === 'asc' ? { field, dir: 'desc' } : null)
    } else {
      setSort({ field, dir: 'asc' })
    }
  }

  return h(
    'div',
    null,
    h(
      'div',
      { className: 'txri-bar' },
      h('input', {
        type: 'search',
        value: query,
        placeholder: `${t('filter')}…`,
        onChange: (e: { target: { value: string } }) => setQuery(e.target.value),
      }),
      h('span', { className: 'txri-note' }, t('sortHint')),
    ),
    rows.length === 0
      ? h('p', { className: 'txri-note' }, t('noCandidates'))
      : h(
          'table',
          null,
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              ...columns.map((c) => {
                const field = String(c.field)
                const mark =
                  sort !== null && sort.field === field ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''
                return h(
                  'th',
                  { key: field },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'txri-thbtn',
                      onClick: () => toggleSort(field),
                    },
                    `${String(c.header ?? field)}${mark}`,
                  ),
                )
              }),
            ),
          ),
          h(
            'tbody',
            null,
            ...rows.map((r, i) =>
              h(
                'tr',
                { key: i },
                ...columns.map((c) =>
                  h('td', { key: String(c.field), className: 'txri-mono' }, fmtValue(r[String(c.field)])),
                ),
              ),
            ),
          ),
        ),
    expandField === ''
      ? null
      : h(
          'div',
          null,
          ...rows.map((r, i) => {
            const rowKey = String(r.candidateId ?? i)
            const isOpen = open[rowKey] === true
            return h(
              'div',
              { key: `x${rowKey}` },
              h(
                'button',
                {
                  type: 'button',
                  onClick: () => setOpen({ ...open, [rowKey]: !isOpen }),
                },
                `${isOpen ? t('collapse') : t('expand')} · ${fmtValue(r.candidateId ?? i)}`,
              ),
              isOpen
                ? h('div', { className: 'txri-exp' }, renderListBlock(listItems(r[expandField]), t))
                : null,
            )
          }),
        ),
  )
}

function renderNode(node: SurfaceNode, ctx: RenderCtx, key: string | number): ReactNode {
  const props = (node.props ?? {}) as Record<string, unknown>
  const children = Array.isArray(node.children) ? node.children : []
  switch (node.type) {
    case 'Card':
      return h(
        'div',
        { key, className: 'txri-card' },
        typeof props.title === 'string' ? h('h4', null, props.title) : null,
        ...children.map((c, i) => renderNode(c, ctx, i)),
      )
    case 'Row':
      return h('div', { key, className: 'txri-row' }, ...children.map((c, i) => renderNode(c, ctx, i)))
    case 'Column':
      return h('div', { key }, ...children.map((c, i) => renderNode(c, ctx, i)))
    case 'Stat':
      return h(
        'div',
        { key, className: 'txri-stat' },
        h('span', { className: 'k' }, String(props.label ?? '')),
        h('span', { className: 'v' }, renderBound(props, ctx)),
      )
    case 'Text':
      return h(
        'p',
        { key, className: 'txri-note' },
        props.bind !== undefined ? renderBound(props, ctx) : String(props.text ?? ''),
      )
    case 'Table':
      return h('div', { key }, h(ReportTable, { node, ctx }))
    case 'Accordion': {
      return h(AccordionBox, { key, node, ctx })
    }
    case 'Button':
      return h(
        'button',
        {
          key,
          type: 'button',
          onClick: () => {
            if (props.action === 'navigate') ctx.navigate()
          },
        },
        String(props.label ?? ''),
      )
    case 'KeyValue':
      return h(
        'table',
        { key, className: 'txri-kv' },
        h(
          'tbody',
          null,
          ...(Array.isArray(props.pairs) ? props.pairs : []).map((pair, i) => {
            const pr = (pair ?? {}) as Record<string, unknown>
            return h(
              'tr',
              { key: i },
              h('td', { className: 'txri-note' }, String(pr.key ?? '')),
              h('td', { className: 'txri-mono' }, renderBound(pr, ctx)),
            )
          }),
        ),
      )
    case 'Badge':
      return h(
        'span',
        {
          key,
          className: `tag ${String(props.tone ?? '')}`,
          title: props.label !== undefined ? String(props.label) : undefined,
        },
        props.bind !== undefined ? renderBound(props, ctx) : String(props.label ?? ''),
      )
    case 'Callout':
      return h(
        'div',
        { key, className: `txri-callout txri-callout-${String(props.tone ?? 'info')}` },
        props.title !== undefined ? h('strong', null, String(props.title)) : null,
        h('div', null, props.bind !== undefined ? renderBound(props, ctx) : String(props.content ?? '')),
      )
    case 'Progress': {
      const resolved = resolveReportPointer(ctx.report, bindPointer(props.bind) ?? '/')
      const raw = typeof resolved === 'number' ? resolved : Number.NaN
      const valid = Number.isFinite(raw)
      const max = typeof props.max === 'number' && props.max > 0 ? props.max : 100
      const pct = valid ? Math.max(0, Math.min(100, (raw / max) * 100)) : 0
      return h(
        'div',
        { key, className: 'txri-stat' },
        props.label !== undefined ? h('span', { className: 'k' }, String(props.label)) : null,
        // 无候选 null 等不可数值化：只显 '—'，不画 0 水位（不得展示为 0 分低风险）
        !valid
          ? h('span', { className: 'v' }, '—')
          : props.display === 'ring'
            ? h(
                'svg',
                { viewBox: '0 0 36 36', width: 48, height: 48, 'aria-hidden': true },
                h('circle', { cx: 18, cy: 18, r: 15.9, fill: 'none', stroke: 'currentColor', strokeOpacity: 0.2, strokeWidth: 3 }),
                h('circle', {
                  cx: 18,
                  cy: 18,
                  r: 15.9,
                  fill: 'none',
                  stroke: 'currentColor',
                  strokeWidth: 3,
                  strokeDasharray: `${pct} 100`,
                  strokeLinecap: 'round',
                  transform: 'rotate(-90 18 18)',
                }),
              )
            : h('div', { className: 'txri-pbar' }, h('div', { className: 'txri-pfill', style: { width: `${pct}%` } })),
        valid ? h('span', { className: 'txri-note' }, fmtValue(raw)) : null,
      )
    }
    case 'Timeline': {
      const items = listItems(resolveReportPointer(ctx.report, bindPointer(props.bind) ?? '/'))
      const tf = typeof props.titleField === 'string' ? props.titleField : ''
      const df = typeof props.descField === 'string' ? props.descField : ''
      const timef = typeof props.timeField === 'string' ? props.timeField : ''
      return h(
        'div',
        { key, className: 'txri-timeline' },
        props.title !== undefined ? h('strong', null, String(props.title)) : null,
        h(
          'ul',
          null,
          ...items.map((it, i) => {
            const rec = it !== null && typeof it === 'object' ? (it as Record<string, unknown>) : null
            const time = rec !== null && timef !== '' ? fmtValue(rec[timef]) : ''
            const title = rec !== null && tf !== '' ? fmtValue(rec[tf]) : fmtValue(it)
            const desc = rec !== null && df !== '' ? fmtValue(rec[df]) : ''
            return h(
              'li',
              { key: i },
              time !== '' ? h('div', { className: 'txri-note txri-mono' }, time) : null,
              h('div', null, title),
              desc !== '' && desc !== '—' ? h('div', { className: 'txri-note' }, desc) : null,
            )
          }),
        ),
      )
    }
    case 'Tabs':
      return h(TabsBox, { key, node, ctx })
    case 'Chart':
      return h('div', { key }, h(ChartBox, { node, ctx }))
    default:
      return h('p', { key, className: 'txri-err' }, `unknown component: ${String(node.type)}`)
  }
}

interface ChartPoint {
  label: string
  value: number
}

/** 图表取点（null-safe）：非有限值跳过（绝不补 0）并断线分段，行序即 x 序。 */
function chartPoints(node: SurfaceNode, ctx: RenderCtx): { points: ChartPoint[]; segments: ChartPoint[][] } {
  const p = (node.props ?? {}) as Record<string, unknown>
  const rows = listItems(resolveReportPointer(ctx.report, bindPointer(p.rowsBind) ?? '/'))
  const labelField = String(p.labelField ?? '')
  const valueField = String(p.valueField ?? '')
  const points: ChartPoint[] = []
  const segments: ChartPoint[][] = []
  let current: ChartPoint[] = []
  for (const r of rows) {
    const rec = r !== null && typeof r === 'object' ? (r as Record<string, unknown>) : null
    const raw = rec === null ? undefined : rec[valueField]
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      const pt = { label: rec === null ? '' : fmtValue(rec[labelField]), value: raw }
      points.push(pt)
      current.push(pt)
    } else if (current.length > 0) {
      segments.push(current)
      current = []
    }
  }
  if (current.length > 0) segments.push(current)
  return { points, segments }
}

function ChartBox(props: { node: SurfaceNode; ctx: RenderCtx }): ReactNode {
  const { node, ctx } = props
  const p = (node.props ?? {}) as Record<string, unknown>
  const kind = String(p.kind ?? 'bars')
  const height = typeof p.height === 'number' ? p.height : 160
  const { points, segments } = chartPoints(node, ctx)
  const title = props.node.props?.title !== undefined ? h('strong', null, String(props.node.props.title)) : null
  if (points.length === 0) {
    return h('div', { className: 'txri-stat' }, title, h('span', { className: 'v' }, '—'))
  }
  const max = Math.max(...points.map((pt) => pt.value), 0)
  const min = Math.min(...points.map((pt) => pt.value), 0)
  const span = max - min || 1

  if (kind === 'donut') {
    const total = points.reduce((s, pt) => s + Math.max(pt.value, 0), 0) || 1
    let offset = 0
    const shades = [1, 0.72, 0.5, 0.34, 0.22, 0.14]
    return h(
      'div',
      { className: 'txri-row' },
      title,
      h(
        'svg',
        { viewBox: '0 0 36 36', width: 96, height: 96, 'aria-hidden': true },
        ...points.map((pt, i) => {
          const seg = (Math.max(pt.value, 0) / total) * 100
          const el = h('circle', {
            key: i,
            cx: 18,
            cy: 18,
            r: 15.9,
            fill: 'none',
            stroke: 'currentColor',
            strokeOpacity: shades[i % shades.length],
            strokeWidth: 5,
            strokeDasharray: `${seg} ${100 - seg}`,
            strokeDashoffset: -offset,
            transform: 'rotate(-90 18 18)',
          })
          offset += seg
          return el
        }),
      ),
      h(
        'ul',
        { className: 'txri-note' },
        ...points.map((pt, i) =>
          h('li', { key: i }, `${pt.label} · ${fmtValue(pt.value)}（${Math.round((Math.max(pt.value, 0) / total) * 100)}%）`),
        ),
      ),
    )
  }

  if (kind === 'line') {
    const w = Math.max(points.length * 28, 120)
    const pad = 12
    const x = (i: number) => (points.length === 1 ? w / 2 : pad + (i * (w - pad * 2)) / (points.length - 1))
    const y = (v: number) => height - pad - ((v - min) / span) * (height - pad * 2)
    // 断线分段：缺断点两侧不连线（不补 0）
    let idx = 0
    const paths = segments.map((seg) => {
      const d = seg
        .map((pt, j) => `${j === 0 ? 'M' : 'L'}${x(idx + j).toFixed(1)},${y(pt.value).toFixed(1)}`)
        .join(' ')
      idx += seg.length
      return d
    })
    return h(
      'div',
      { className: 'txri-chart' },
      title,
      h(
        'svg',
        { viewBox: `0 0 ${w} ${height}`, width: '100%', height, role: 'img' },
        ...paths.map((d, i) =>
          h('path', { key: i, d, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinejoin: 'round' }),
        ),
        ...points.map((pt, i) =>
          h('circle', { key: i, cx: x(i).toFixed(1), cy: y(pt.value).toFixed(1), r: 2.6, fill: 'currentColor' }),
        ),
        h('text', { x: x(0).toFixed(1), y: (y(points[0].value) - 6).toFixed(1), 'font-size': 9, fill: 'currentColor' }, fmtValue(points[0].value)),
        h(
          'text',
          {
            x: x(points.length - 1).toFixed(1),
            y: (y(points[points.length - 1].value) - 6).toFixed(1),
            'font-size': 9,
            fill: 'currentColor',
            'text-anchor': 'end',
          },
          fmtValue(points[points.length - 1].value),
        ),
      ),
    )
  }

  // bars（vertical / horizontal）
  const horizontal = p.horizontal === true
  const labelOf = (s: string) => (s.length > 8 ? `${s.slice(0, 7)}…` : s)
  if (horizontal) {
    const w = 240
    const rowH = 22
    const h2 = Math.max(points.length * rowH, 60)
    return h(
      'div',
      { className: 'txri-chart' },
      title,
      h(
        'svg',
        { viewBox: `0 0 ${w} ${h2}`, width: '100%', height: h2, role: 'img' },
        ...points.map((pt, i) =>
          h(
            'g',
            { key: i },
            h('text', { x: 0, y: i * rowH + 13, 'font-size': 9, fill: 'currentColor' }, labelOf(pt.label)),
            h('rect', {
              x: 64,
              y: i * rowH + 4,
              width: Math.max(2, ((pt.value - min) / span) * (w - 110)),
              height: 12,
              rx: 2,
              fill: 'currentColor',
              fillOpacity: 0.75,
            }),
            h('text', { x: w - 2, y: i * rowH + 13, 'font-size': 9, fill: 'currentColor', 'text-anchor': 'end' }, fmtValue(pt.value)),
          ),
        ),
      ),
    )
  }
  const w = Math.max(points.length * 28, 120)
  const barW = 16
  return h(
    'div',
    { className: 'txri-chart' },
    title,
    h(
      'svg',
      { viewBox: `0 0 ${w} ${height}`, width: '100%', height, role: 'img' },
      ...points.map((pt, i) => {
        const cx = (i + 0.5) * (w / points.length)
        const bh = Math.max(2, ((pt.value - min) / span) * (height - 28))
        return h(
          'g',
          { key: i },
          h('rect', { x: cx - barW / 2, y: height - 18 - bh, width: barW, height: bh, rx: 2, fill: 'currentColor', fillOpacity: 0.75 }),
          h('text', { x: cx, y: height - 22 - bh, 'font-size': 9, fill: 'currentColor', 'text-anchor': 'middle' }, fmtValue(pt.value)),
          h('text', { x: cx, y: height - 5, 'font-size': 9, fill: 'currentColor', 'text-anchor': 'middle', opacity: 0.7 }, labelOf(pt.label)),
        )
      }),
    ),
  )
}

function AccordionBox(props: { node: SurfaceNode; ctx: RenderCtx; key?: string | number }): ReactNode {
  const { node, ctx } = props
  const p = (node.props ?? {}) as Record<string, unknown>
  const [isOpen, setOpen] = useState(p.defaultExpanded === true)
  const items = listItems(resolveReportPointer(ctx.report, bindPointer(p.bind) ?? '/'))
  return h(
    'div',
    { className: 'txri-card' },
    h(
      'button',
      { type: 'button', onClick: () => setOpen(!isOpen) },
      `${isOpen ? ctx.t('collapse') : ctx.t('expand')} · ${String(p.title ?? '')}`,
    ),
    isOpen ? h('div', { className: 'txri-exp' }, renderListBlock(items, ctx.t)) : null,
  )
}

/** Tabs：本地切换（同 expand 族本地状态，事件集仍为筛选/展开/跳转）。 */
function TabsBox(props: { node: SurfaceNode; ctx: RenderCtx; key?: string | number }): ReactNode {
  const { node, ctx } = props
  const p = (node.props ?? {}) as Record<string, unknown>
  const tabs = Array.isArray(p.tabs) ? (p.tabs as Array<Record<string, unknown>>) : []
  const [sel, setSel] = useState(0)
  const current = tabs[Math.min(sel, Math.max(tabs.length - 1, 0))]
  const items =
    current !== undefined && Array.isArray(current.items) ? (current.items as SurfaceNode[]) : []
  return h(
    'div',
    { className: 'txri-tabs' },
    h(
      'div',
      { className: 'txri-bar' },
      ...tabs.map((t, i) =>
        h(
          'button',
          {
            type: 'button',
            className: i === sel ? 'txri-primary' : '',
            onClick: () => setSel(i),
          },
          String(t.label ?? ''),
        ),
      ),
    ),
    ...items.map((c, i) => renderNode(c, ctx, c.id ?? i)),
  )
}

class ReportBoundary extends Component<
  { fallback: ReactNode; children?: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  render(): ReactNode {
    return this.state.failed ? this.props.fallback : (this.props.children ?? null)
  }
}

/** 报表文字摘要（渲染失败回退面；spec chat-run-report S2.5/S2.7）。 */
export function reportTextSummary(report: RunReport, t: T): ReactNode {
  return h(
    'pre',
    { className: 'txri-mono' },
    [
      `${report.runRef.runId} · ${report.runRef.package.name}@${report.runRef.package.version}`
        + ` · ${t('candidates')} ${report.summary.candidateCount}`
        + ` · ${t('riskScore')} ${report.summary.maxRiskScore === null ? '—' : report.summary.maxRiskScore}`,
      ...report.candidates.map(
        (c) => `- ${c.candidateId} ${c.riskScore} [${c.hitRuleIds.join(',')}]`,
      ),
    ].join('\n'),
  )
}

export function ReportSurface(props: {
  surface: A2uiSurfaceMessage
  report: RunReport
  t: T
  navigate: () => void
  /** 渲染失败回退面；缺省为报表文字摘要。 */
  fallback?: ReactNode
}): ReactNode {
  const ctx: RenderCtx = { report: props.report, t: props.t, navigate: props.navigate }
  const fallback = props.fallback ?? reportTextSummary(props.report, props.t)
  try {
    return h(ReportBoundary, { fallback }, renderNode(props.surface.root, ctx, 'root'))
  } catch (e) {
    return h('p', { className: 'txri-err' }, `render error: ${errText(e)}`)
  }
}

/** toolview：读 meta → wire 取数 → 渲染；失败回退工具文本。 */
export function createReportToolView(deps: {
  api: ReportApi
  t: T
  navigate: () => void
}): (props: ToolViewProps) => ReactNode {
  return function ReportToolView(props: ToolViewProps): ReactNode {
    const { phase, block } = props
    const t = deps.t
    if (phase !== 'result') return h('div', { className: 'txri-note' }, t('reportPending'))
    const fallback = h(
      'div',
      { className: 'txri-gov' },
      h('p', { className: 'txri-note' }, t('reportFallback')),
      h('pre', { className: 'txri-mono' }, fallbackText(block)),
    )
    if (block.isError === true) return fallback
    const meta = parseMeta(block.meta)
    if (meta === null) return fallback
    return h(ReportLoader, { meta, api: deps.api, t, navigate: deps.navigate, fallback })
  }
}

function ReportLoader(props: {
  meta: ReportMeta
  api: ReportApi
  t: T
  navigate: () => void
  fallback: ReactNode
}): ReactNode {
  const { meta, api, t, navigate, fallback } = props
  const [report, setReport] = useState<RunReport | null>(null)
  const [error, setError] = useState('')
  const [surface, setSurface] = useState<A2uiSurfaceMessage | null>(null)
  const [badSurface, setBadSurface] = useState(false)

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const out = unwrap<{ report: RunReport }>(await api.getRunReport({ runId: meta.runRef.runId }))
        if (!live) return
        setReport(out.report)
      } catch (e) {
        if (!live) return
        setError(errText(e))
      }
    })()
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta.runRef.runId])

  useEffect(() => {
    const v = validateReportSurface(meta.surface)
    if (v.ok) {
      setSurface(v.value)
      setBadSurface(false)
    } else {
      setSurface(buildDefaultReportSurface())
      setBadSurface(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta.runRef.runId])

  if (error !== '') {
    return h('div', null, h('p', { className: 'txri-err' }, `${t('reportError')}: ${error}`), fallback)
  }
  if (report === null || surface === null) {
    return h('p', { className: 'txri-note' }, t('reportLoading'))
  }
  return h(
    'div',
    { className: 'txri-gov' },
    badSurface ? h('p', { className: 'txri-note' }, t('reportBadSurface')) : null,
    h(
      'p',
      { className: 'txri-note txri-mono' },
      `${report.runRef.runId} · ${report.runRef.package.name}@${report.runRef.package.version}`,
    ),
    h(ReportSurface, { surface, report, t, navigate, fallback }),
  )
}
