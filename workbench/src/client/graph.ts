import { h, useMemo, useState, useRef, useCallback, useEffect } from './react'
import type { ReactNode } from './types'

/* ═══════════════════════════════════════════════════════════════
 * 图谱画布（conversational-modeling P1）：分层力导 GraphCanvas + 检视器
 * ═══════════════════════════════════════════════════════════════ */

export interface OgNode {
  id: string
  kind: string
  layer: 'O1' | 'O2' | 'O3'
  name: string
  draft: boolean
  provenance?: { turnId?: string; sourceId?: string; runId?: string }
  issueLevel?: 'error' | 'warn' | 'info'
  forcedReview?: boolean
  runHit?: boolean
}
export interface OgEdge {
  from: string
  to: string
  kind: string
  label?: string
}
export interface OgIssue {
  level: 'error' | 'warn' | 'info'
  code: string
  message: string
  where: string
}
export interface OgGraph {
  package: string
  version: string
  status: string
  nodes: OgNode[]
  edges: OgEdge[]
  issues: OgIssue[]
  revision: number
  skeleton?: { confirmed: boolean; ids: string[] }
}

export const OG_W = 1040
export const OG_H = 720
/** 原型口径：白底 + 彩描边。 */
export const OG_FILL: Record<string, string> = { O1: '#ffffff', O2: '#ffffff', O3: '#ffffff', draft: '#fafafa' }
export const OG_STROKE: Record<string, string> = { O1: '#3b6fd4', O2: '#d97706', O3: '#16a34a', draft: '#9ca3af' }
export const OG_EDGE: Record<string, string> = {
  relation: '#a8b0c3',
  anchor: '#c4b5a0',
  dict: '#c4b5a0',
  'skill-rule': '#c4b5a0',
  'scenario-step': '#a8b0c3',
  // v0.2.1 full-chain: scenario semantic refs (synced with core buildModelGraph)
  'behavior-ref': '#7c9cbf',
  'score-ref': '#d4a574',
  'exclusion-ref': '#c48a8a',
  feature: '#5b9fd4',
  ref: '#c5cbd6',
  applies: '#c5cbd6',
}

/** Cross-layer edge (O1-O2-O3): thicker for full-chain visibility. */
export function isCrossLayerEdge(kind: string, fromLayer?: string, toLayer?: string): boolean {
  if (!fromLayer || !toLayer || fromLayer === toLayer) return false
  return ['behavior-ref', 'score-ref', 'exclusion-ref', 'feature', 'scenario-step', 'anchor', 'skill-rule', 'relation', 'ref'].includes(kind)
}

export type ScStepLike = { stepId: string; stepType: string; order?: string; skillRefs?: string[] }

/**
 * 确定性力导：圆环初值 + 固定迭代（无 random），层向弱引力保 O1/O2/O3 大致分区。
 */
export function layoutForce(graph: OgGraph): { pos: Map<string, { x: number; y: number }>; height: number } {
  const pos = new Map<string, { x: number; y: number }>()
  const nodes = graph.nodes
  const n = nodes.length
  if (n === 0) return { pos, height: OG_H }
  const cx = OG_W / 2
  const cy = OG_H / 2
  const R = Math.min(OG_W, OG_H) * 0.32
  const byLayer: Record<string, OgNode[]> = { O1: [], O2: [], O3: [], draft: [] }
  for (const nd of nodes) {
    const k = nd.draft ? 'draft' : nd.layer
    byLayer[k].push(nd)
  }
  const layerAngle: Record<string, [number, number]> = {
    O1: [Math.PI * 0.7, Math.PI * 1.3],
    O2: [Math.PI * 1.4, Math.PI * 1.9],
    O3: [Math.PI * 0.1, Math.PI * 0.55],
    draft: [Math.PI * 0.55, Math.PI * 0.7],
  }
  for (const layer of ['O1', 'O2', 'O3', 'draft']) {
    const arr = byLayer[layer]
    if (!arr.length) continue
    const [a0, a1] = layerAngle[layer]
    arr.forEach((nd, i) => {
      const t0 = arr.length === 1 ? 0.5 : i / (arr.length - 1)
      const ang = a0 + (a1 - a0) * t0
      const rr = R * (0.75 + 0.35 * ((i * 7) % 5) / 5)
      pos.set(nd.id, { x: cx + Math.cos(ang) * rr, y: cy + Math.sin(ang) * rr })
    })
  }
  const K = 3800
  const REST = 100
  const TICKS = 140
  const layerX: Record<string, number> = {
    O1: OG_W * 0.18,
    O2: OG_W * 0.5,
    O3: OG_W * 0.8,
    draft: OG_W * 0.92,
  }
  for (let tick = 0; tick < TICKS; tick++) {
    const fx = new Map<string, { x: number; y: number }>()
    const add = (id: string, dx: number, dy: number): void => {
      const cur = fx.get(id) ?? { x: 0, y: 0 }
      cur.x += dx
      cur.y += dy
      fx.set(id, cur)
    }
    for (const e of graph.edges) {
      const pa = pos.get(e.from)
      const pb = pos.get(e.to)
      if (!pa || !pb) continue
      const dx = pb.x - pa.x
      const dy = pb.y - pa.y
      const d = Math.sqrt(dx * dx + dy * dy) || 1
      const f = (d - REST) * 0.035
      add(e.from, (dx / d) * f, (dy / d) * f)
      add(e.to, (-dx / d) * f, (-dy / d) * f)
    }
    if (n <= 280) {
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const a = nodes[i]
          const b = nodes[j]
          const pa = pos.get(a.id)
          const pb = pos.get(b.id)
          if (!pa || !pb) continue
          let dx = pb.x - pa.x
          let dy = pb.y - pa.y
          let d2 = dx * dx + dy * dy
          if (d2 < 1) {
            dx = (i - j) * 0.5
            dy = (j - i) * 0.3
            d2 = dx * dx + dy * dy + 1
          }
          const d = Math.sqrt(d2)
          const f = Math.min(28, K / d2)
          add(a.id, (-dx / d) * f, (-dy / d) * f)
          add(b.id, (dx / d) * f, (dy / d) * f)
        }
      }
    }
    for (const nd of nodes) {
      const p = pos.get(nd.id)
      if (!p) continue
      add(nd.id, (cx - p.x) * 0.012, (cy - p.y) * 0.012)
      const lx = layerX[nd.draft ? 'draft' : nd.layer]
      if (lx !== undefined) add(nd.id, (lx - p.x) * 0.02, 0)
    }
    for (const nd of nodes) {
      const d = fx.get(nd.id)
      const p = pos.get(nd.id)
      if (!d || !p) continue
      const mag = Math.sqrt(d.x * d.x + d.y * d.y) || 1
      const lim = Math.max(11 - tick * 0.06, 1.2)
      const step = Math.min(mag, lim) * 0.55
      p.x += (d.x / mag) * step
      p.y += (d.y / mag) * step
      p.x = Math.max(56, Math.min(OG_W - 56, p.x))
      p.y = Math.max(40, Math.min(OG_H - 48, p.y))
    }
  }
  return { pos, height: OG_H }
}

/**
 * 场景步骤链布局（对齐 OBM 聚焦）：pipeline 横向分列，列内竖排。
 * 未归类节点挂在最右「相关」列。
 */
export function layoutScenarioChain(
  nodes: OgNode[],
  pipeline: ScStepLike[],
  scenarioId: string,
): { pos: Map<string, { x: number; y: number }>; height: number; cols: Array<{ x: number; label: string; stepId: string }> } {
  const pos = new Map<string, { x: number; y: number }>()
  const cols: Array<{ x: number; label: string; stepId: string }> = []
  if (nodes.length === 0) return { pos, height: OG_H, cols }

  const nSteps = Math.max(pipeline.length, 1)
  const marginX = 70
  const usable = OG_W - marginX * 2
  const colW = usable / nSteps

  // 每步归属 ID 集
  const stepIds: Set<string>[] = pipeline.map(() => new Set<string>())
  const assign = (stepIdx: number, ids: Iterable<string>): void => {
    if (stepIdx < 0 || stepIdx >= stepIds.length) return
    for (const id of ids) stepIds[stepIdx].add(id)
  }

  const kindIds = (kind: string): string[] => nodes.filter((n) => n.kind === kind).map((n) => n.id)

  pipeline.forEach((step, i) => {
    if (step.stepType === 'SKILL_RUN') assign(i, step.skillRefs ?? [])
    else if (step.stepType === 'BEHAVIOR_CALL') assign(i, kindIds('behavior'))
    else if (step.stepType === 'RULE_EVALUATE') {
      if (step.order === 'before-scoring') assign(i, kindIds('exclusionRule'))
      else assign(i, kindIds('scoreRule'))
    } else if (step.stepType === 'DATA_INGEST') {
      assign(i, [scenarioId, ...kindIds('object').slice(0, 0)]) // 场景 + 可后续扩对象
    } else if (step.stepType === 'AUDIT_CHECK' || step.stepType === 'HUMAN_REVIEW') {
      assign(i, [scenarioId])
    } else if (step.stepType === 'SKILL_RUN') {
      assign(i, step.skillRefs ?? [])
    }
  })
  // 场景本体：挂到第一步，避免重复
  if (stepIds.length > 0) stepIds[0].add(scenarioId)

  // 未分配 → 「相关」虚拟列
  const assigned = new Set<string>()
  for (const s of stepIds) for (const id of s) assigned.add(id)
  const related = nodes.filter((n) => !assigned.has(n.id)).map((n) => n.id)

  const totalCols = nSteps + (related.length ? 1 : 0)
  const colW2 = (OG_W - marginX * 2) / Math.max(totalCols, 1)

  pipeline.forEach((step, i) => {
    cols.push({
      x: marginX + colW2 * i + colW2 / 2,
      label: step.stepType.replace(/_/g, ' '),
      stepId: step.stepId,
    })
  })
  if (related.length) {
    cols.push({
      x: marginX + colW2 * nSteps + colW2 / 2,
      label: 'RELATED',
      stepId: '…',
    })
  }

  const NODE_H = 36
  const MIN_GAP = 48
  const top = 72
  const buckets: OgNode[][] = pipeline.map((_, i) =>
    nodes.filter((n) => stepIds[i]?.has(n.id)),
  )
  // 场景可能在多个步——只放第一步
  const seen = new Set<string>()
  buckets.forEach((arr, i) => {
    buckets[i] = arr.filter((n) => {
      if (seen.has(n.id)) return false
      seen.add(n.id)
      return true
    })
  })
  if (related.length) buckets.push(nodes.filter((n) => related.includes(n.id)))

  const maxN = Math.max(1, ...buckets.map((a) => a.length))
  const height = Math.max(OG_H, top + (maxN - 1) * MIN_GAP + NODE_H + 72)
  const bottom = height - 72

  buckets.forEach((arr, ci) => {
    if (!arr.length) return
    const x = marginX + colW2 * ci + colW2 / 2
    if (arr.length === 1) {
      pos.set(arr[0].id, { x, y: (top + bottom) / 2 })
      return
    }
    const span = bottom - top
    const step = Math.max(MIN_GAP, span / (arr.length - 1))
    arr.forEach((nd, i) => pos.set(nd.id, { x, y: top + step * i }))
  })

  let maxY = 0
  for (const pt of pos.values()) maxY = Math.max(maxY, pt.y)
  return { pos, height: Math.max(height, maxY + 72), cols }
}

/** 列对齐布局：保证最小竖距，节点多时自动拉高 viewBox，杜绝叠字。 */
export type LayoutMode = 'force' | 'column' | 'scenario-chain'
export function layoutGraph(
  graph: OgGraph,
  opts?: { mode?: LayoutMode; pipeline?: ScStepLike[]; scenarioId?: string },
): { pos: Map<string, { x: number; y: number }>; height: number; cols?: Array<{ x: number; label: string; stepId: string }> } {
  if (opts?.mode === 'scenario-chain' && opts.pipeline && opts.scenarioId) {
    return layoutScenarioChain(graph.nodes, opts.pipeline, opts.scenarioId)
  }
  if (opts?.mode === 'force') {
    return layoutForce(graph)
  }
  const pos = new Map<string, { x: number; y: number }>()
  const nodes = graph.nodes
  if (nodes.length === 0) return { pos, height: OG_H }
  const colX: Record<string, number> = {
    O1: OG_W * 0.14,
    O2: OG_W * 0.44,
    O3: OG_W * 0.72,
    draft: OG_W * 0.9,
  }
  const buckets: Record<string, OgNode[]> = { O1: [], O2: [], O3: [], draft: [] }
  for (const nd of nodes) buckets[nd.draft ? 'draft' : nd.layer].push(nd)
  for (const key of Object.keys(buckets)) {
    buckets[key].sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  }
  const NODE_H = 36
  const MIN_GAP = 48
  const top = 56
  const maxN = Math.max(...Object.values(buckets).map((a) => a.length), 1)
  const contentH = top + (maxN - 1) * MIN_GAP + NODE_H + 72
  const height = Math.max(OG_H, contentH)
  const bottom = height - 72
  for (const key of Object.keys(buckets)) {
    const arr = buckets[key]
    if (arr.length === 0) continue
    if (arr.length === 1) {
      pos.set(arr[0].id, { x: colX[key], y: (top + bottom) / 2 })
      continue
    }
    const span = bottom - top
    const step = Math.max(MIN_GAP, span / (arr.length - 1))
    arr.forEach((nd, i) => {
      pos.set(nd.id, { x: colX[key], y: top + step * i })
    })
  }
  let maxY = 0
  for (const pt of pos.values()) maxY = Math.max(maxY, pt.y)
  const finalH = Math.max(height, maxY + 72)
  return { pos, height: finalH }
}

export function edgePath(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const mx = (a.x + b.x) / 2
  const my = (a.y + b.y) / 2
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.sqrt(dx * dx + dy * dy) || 1
  const nx = -dy / len
  const ny = dx / len
  const bulge = Math.min(40, len * 0.1)
  return `M ${a.x} ${a.y} Q ${mx + nx * bulge} ${my + ny * bulge} ${b.x} ${b.y}`
}

export function nodeWidth(name: string): number {
  const units = [...name].reduce((s, ch) => s + (ch.charCodeAt(0) > 255 ? 12 : 7), 0)
  return Math.max(88, Math.min(168, units + 28))
}

export function GraphCanvas(props: {
  t: (k: string) => string
  graph: OgGraph
  selected: string | null
  selectedEdge: OgEdge | null
  onSelect: (id: string | null) => void
  onSelectEdge: (e: OgEdge | null) => void
  onDraftAction?: (id: string, action: 'approve' | 'reject') => void
  actionOff?: boolean
  focusId?: string | null
  onViewportResetKey?: number
  /** 场景聚焦：只亮焦点集；播放时再亮当前步。 */
  focusSet?: Set<string> | null
  playSet?: Set<string> | null
  layoutMode?: 'force' | 'column' | 'scenario-chain'
  pipeline?: ScStepLike[]
  scenarioId?: string
  labelMode?: 'main' | 'all' | 'hover'
}) {
  const {
    t, graph, selected, selectedEdge, onSelect, onSelectEdge,
    onDraftAction, actionOff, focusId, onViewportResetKey = 0,
    focusSet, playSet, layoutMode = 'force', pipeline, scenarioId,
    labelMode = 'main',
  } = props
  const { pos, height: vbH, cols } = useMemo(
    () =>
      layoutGraph(graph, {
        mode: layoutMode,
        ...(pipeline ? { pipeline } : {}),
        ...(scenarioId ? { scenarioId } : {}),
      }),
    [graph, layoutMode, pipeline, scenarioId],
  )
  const NODE_H = 36
  const [view, setView] = useState({ k: 1, x: 0, y: 0 })
  const dragRef = useRef<{ x: number; y: number; vx: number; vy: number; id: number; el: Element; active: boolean } | null>(null)

  useEffect(() => {
    setView({ k: 1, x: 0, y: 0 })
  }, [onViewportResetKey, graph.revision])

  const neighbor = useMemo(() => {
    // 场景聚焦优先：焦点集内再按播放步收窄
    if (focusSet) {
      if (playSet) {
        const s = new Set<string>()
        for (const id of playSet) if (focusSet.has(id)) s.add(id)
        // 播放时始终保留场景本体可见
        for (const id of focusSet) {
          if (id.startsWith('SCN-')) s.add(id)
        }
        return s.size > 0 ? s : focusSet
      }
      return focusSet
    }
    const set = new Set<string>()
    if (!selected) return set
    set.add(selected)
    for (const e of graph.edges) {
      if (e.from === selected) set.add(e.to)
      if (e.to === selected) set.add(e.from)
    }
    return set
  }, [selected, graph.edges, focusSet, playSet])

  const degree = useMemo(() => {
    const m = new Map<string, number>()
    for (const e of graph.edges) {
      m.set(e.from, (m.get(e.from) ?? 0) + 1)
      m.set(e.to, (m.get(e.to) ?? 0) + 1)
    }
    return m
  }, [graph.edges])
  /** 主节点标签阈值：度数排序约前 28（对齐 OBM labelCut）。 */
  const labelCut = useMemo(() => {
    const degs = graph.nodes.map((n) => degree.get(n.id) ?? 0).sort((a, b) => b - a)
    if (!degs.length) return 1
    // 比 OBM 更收敛：默认只标约前 12 个枢纽，避免整屏文字
    return degs[Math.min(11, degs.length - 1)]
  }, [graph.nodes, degree])

  useEffect(() => {
    if (!focusId) return
    const id = focusId.split('#')[0]
    const p = pos.get(id)
    if (!p) return
    const k = view.k || 1
    setView({ k, x: (OG_W / 2 - p.x) * k, y: (vbH / 2 - p.y) * k })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId])

  const onWheel = (e: { preventDefault: () => void; deltaY: number; clientX: number; clientY: number; currentTarget: Element }): void => {
    e.preventDefault()
    const rect = e.currentTarget.getBoundingClientRect()
    const mx = ((e.clientX - rect.left) / rect.width) * OG_W
    const my = ((e.clientY - rect.top) / rect.height) * vbH
    setView((v) => {
      const factor = e.deltaY > 0 ? 0.9 : 1.1
      const k = Math.min(3.5, Math.max(0.35, v.k * factor))
      const x = mx - ((mx - v.x) / v.k) * k
      const y = my - ((my - v.y) / v.k) * k
      return { k, x, y }
    })
  }

  // 拖拽：仅在移动超过阈值后捕获，避免吞掉节点/边的 click
  const onPointerDown = (e: { button: number; clientX: number; clientY: number; pointerId: number; currentTarget: Element }): void => {
    if (e.button !== 0) return
    dragRef.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, id: e.pointerId, el: e.currentTarget, active: false }
  }
  const onPointerMove = (e: { clientX: number; clientY: number; currentTarget: Element }): void => {
    const d = dragRef.current
    if (!d) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (!d.active) {
      if (Math.abs(dx) + Math.abs(dy) < 5) return
      d.active = true
      try {
        ;(d.el as Element & { setPointerCapture: (n: number) => void }).setPointerCapture?.(d.id)
      } catch { /* ignore */ }
    }
    const rect = e.currentTarget.getBoundingClientRect()
    const scaleX = rect ? OG_W / rect.width : 1
    const scaleY = rect ? vbH / rect.height : 1
    setView((v) => ({ ...v, x: d.vx + dx * scaleX, y: d.vy + dy * scaleY }))
  }
  const onPointerUp = (): void => {
    dragRef.current = null
  }

  const hitKind = selectedEdge?.kind ?? null

  return h(
    'div',
    {
      style: { flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' },
      onWheel,
    },
    h(
      'svg',
      {
        viewBox: `0 0 ${OG_W} ${vbH}`,
        role: 'img',
        'aria-label': 'ontology graph',
        preserveAspectRatio: 'xMidYMid meet',
        style: { width: '100%', height: '100%', display: 'block', touchAction: 'none', cursor: 'grab' },
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerLeave: onPointerUp,
        onClick: (e: { target: EventTarget }) => {
          const el = e.target as Element
          if (el.tagName === 'svg') {
            onSelect(null)
            onSelectEdge(null)
          }
        },
      },
      h(
        'g',
        { transform: `translate(${view.x},${view.y}) scale(${view.k})` },
        h(
          'defs',
          null,
          h(
            'marker',
            { id: 'ogc-ar', viewBox: '0 0 8 8', refX: 7, refY: 3.5, markerWidth: 6, markerHeight: 6, orient: 'auto' },
            h('path', { d: 'M1,1 L6,3.5 L1,6', fill: 'none', stroke: '#b0b7c3', strokeWidth: 1.1, strokeLinecap: 'round', strokeLinejoin: 'round' }),
          ),
        ),
        // 列头由画布上方 HTML 条渲染（更清晰）
        ...graph.edges.map((e, i) => {
          const a = pos.get(e.from)
          const b = pos.get(e.to)
          if (!a || !b) return null
          const on = selected === e.from || selected === e.to
          const hot = !!(selectedEdge && selectedEdge.from === e.from && selectedEdge.to === e.to && selectedEdge.kind === e.kind)
const dimE = (!!focusSet || !!selected) && !on
          const d = edgePath(a, b)
          const layerOf = (id: string): string | undefined => graph.nodes.find((n) => n.id === id)?.layer
          const cross = isCrossLayerEdge(e.kind, layerOf(e.from), layerOf(e.to))
          const playing = !!(playSet && (playSet.has(e.from) || playSet.has(e.to)))
          const op = hitKind && e.kind !== hitKind && !hot ? 0.12 : dimE ? 0.12 : cross ? 0.92 : 0.75
          
          return h(
            'g',
            { key: `eg-${i}` },
            h('path', {
              className: `ogc-edge${dimE ? ' dim' : ''}${hot ? ' hot' : ''}${cross ? ' cross' : ''}`,
              d,
              fill: 'none',
              stroke: OG_EDGE[e.kind] ?? '#c5cbd6',
              strokeWidth: hot || playing ? 2.4 : cross ? 1.6 : 1.15,
              markerEnd: 'url(#ogc-ar)',
              style: { pointerEvents: 'none', opacity: op },
            }),
            h('path', {
              className: 'ogc-edge-hit',
              d,
              onClick: (ev: { stopPropagation: () => void }) => {
                ev.stopPropagation()
                onSelect(null)
                onSelectEdge(e)
              },
            }),
            h('title', null, `${e.kind}: ${e.from} → ${e.to}`),
          )
        }),
        ...graph.nodes.map((nd) => {
          const p = pos.get(nd.id)
          if (!p) return null
          const short = nd.name.length > 8 ? `${nd.name.slice(0, 7)}…` : nd.name
          const stroke =
            nd.runHit || nd.issueLevel === 'error'
              ? '#dc2626'
              : nd.issueLevel === 'warn'
                ? '#d97706'
                : OG_STROKE[nd.draft ? 'draft' : nd.layer] ?? '#9aa3b2'
          const fillC =
            nd.draft ? '#fafafa'
            : nd.layer === 'O1' ? '#eaf0fb'
            : nd.layer === 'O2' ? '#fdf3e4'
            : '#e8f7ef'
          const isSel = selected === nd.id || !!(playSet && playSet.has(nd.id))
          const dimFinal = (!!focusSet || !!selected) && !neighbor.has(nd.id)
          const deg = degree.get(nd.id) ?? 0
          // OBM 标签密度：main=高阶+焦点；all=全显；hover=仅悬停/CSS
          const showLabel =
            labelMode === 'all' ||
            isSel ||
            (focusSet ? neighbor.has(nd.id) && (playSet ? playSet.has(nd.id) || nd.id.startsWith('SCN-') : true) : false) ||
            (labelMode === 'main' && deg >= labelCut)
          const R = 13
          return h(
            'g',
            {
              key: nd.id,
              className: `ogc-node${dimFinal ? ' dim' : ''}${isSel ? ' selected' : ''}${showLabel ? ' show-label' : ''}`,
              transform: `translate(${p.x},${p.y})`,
              onClick: (ev: { stopPropagation: () => void }) => {
                ev.stopPropagation()
                onSelectEdge(null)
                onSelect(nd.id)
              },
            },
            h('title', null, `${nd.name}\n${nd.id}\n${nd.layer} · 度数 ${deg}${nd.draft ? ' · 草案' : ''}`),
            h('circle', {
              r: R,
              fill: fillC,
              stroke,
              strokeWidth: isSel ? 2.6 : 1.5,
              strokeDasharray: nd.draft ? '3 2' : undefined,
              filter: isSel ? 'drop-shadow(0 2px 6px rgba(59,111,212,.3))' : undefined,
            }),
            // 度数指示：中心小点
            h('circle', {
              r: deg >= labelCut ? 3.5 : 2.2,
              fill: stroke,
              opacity: 0.85,
              style: { pointerEvents: 'none' },
            }),
            h(
              'text',
              {
                className: 'nlabel',
                x: R + 6,
                y: 1,
                textAnchor: 'start',
                dominantBaseline: 'central',
                style: {
                  fontSize: '11px',
                  fontWeight: isSel ? 700 : 500,
                  fill: dimFinal ? '#9ca3af' : '#1c2333',
                  paintOrder: 'stroke',
                  stroke: '#ffffff',
                  strokeWidth: 3,
                  strokeLinejoin: 'round',
                },
              },
              short,
            ),
          )
        }),
        ...graph.nodes.filter((nd) => nd.draft).map((nd) => {
          const p = pos.get(nd.id)
          if (!p) return null
          const actOff = actionOff === true || !onDraftAction
          const bw = 22
          const bh = 18
          const gap = 6
          const bx = -(bw + gap)
          const actBtn = (dx: number, ch: string, action: 'approve' | 'reject', fill: string, fg: string, tip: string): ReactNode =>
            h(
              'g',
              {
                key: action,
                className: actOff ? 'ogc-act off' : 'ogc-act',
                transform: `translate(${bx + dx},${NODE_H + 6})`,
                onClick: actOff
                  ? undefined
                  : (e: { stopPropagation: () => void }) => {
                      e.stopPropagation()
                      onDraftAction?.(nd.id, action)
                    },
              },
              h('title', null, tip),
              h('rect', { width: bw, height: bh, rx: 6, fill, stroke: fg, strokeWidth: 1.2, opacity: actOff ? 0.45 : 1 }),
              h('text', {
                x: bw / 2, y: bh / 2, textAnchor: 'middle', dominantBaseline: 'central',
                style: { fontSize: '12px', fontWeight: 700, fill: fg, pointerEvents: 'none' },
              }, ch),
            )
          return h(
            'g',
            { key: `act-${nd.id}`, className: 'ogc-node-acts', transform: `translate(${p.x},${p.y + 16})` },
            actBtn(0, '✓', 'approve', '#ecfdf5', '#16a34a', t('approveMat')),
            actBtn(bw + gap, '✕', 'reject', '#fef2f2', '#dc2626', t('reject')),
          )
        }),
      ),
    ),
    h(
      'div',
      {
        style: {
          position: 'absolute', left: 12, bottom: 44, fontSize: 11, color: '#6b7280',
          background: 'rgba(255,255,255,.92)', border: '1px solid #e5e7eb', borderRadius: 8,
          padding: '4px 8px', pointerEvents: 'none',
        },
      },
      `${Math.round(view.k * 100)}%`,
    ),
    selected || selectedEdge
      ? h(
          'div',
          {
            style: {
              position: 'absolute', left: 12, top: 12, fontSize: 11, color: '#3b6fd4',
              background: '#eef2ff', border: '1px solid #c7d7f8', borderRadius: 8,
              padding: '4px 8px', pointerEvents: 'none',
            },
          },
          t('neighborHint'),
        )
      : null,
  )
}
