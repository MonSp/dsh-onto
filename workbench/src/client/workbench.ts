import { h, useState, useEffect, useCallback, useMemo, useRef } from './react'
import type { ReactNode } from './types'
import type { Ctx } from './types'
import { Tag, Field, ErrorBanner, OkBanner, Loading, Row, Card } from './ui'
import { unwrap, errText, fmt } from './helpers'
import {
  GraphCanvas, OG_EDGE, isCrossLayerEdge,
  type OgGraph, type OgNode, type OgEdge, type ScStepLike,
} from './graph'
import { InspectorView } from './inspector'

/* ═══════════════════════════════════════════════════════════════
 * GraphWorkbench —— 画布工作台（主区建模视图与右栏图谱 tab 共用）
 * 状态自带：图谱轮询 / 人审物化 / 骨架门（P1/P3）。草拟单一入口在
 * dsh 主对话（agent → draft_elements），画布只展示状态与人审动作。
 * ═══════════════════════════════════════════════════════════════ */

export function GraphWorkbench(props: {
  t: (k: string) => string
  apis: Ctx
  selected: { name: string; version: string } | null
  /** 主区视图传入：物化后刷新 pkg/统计（右栏 tab 不传）。 */
  onChanged?: () => void
}) {
  const { t, apis, selected, onChanged } = props
  const api = apis.remote['ontoModel']
  const kApi = apis.remote['ontoKnowledge']
  const [graph, setGraph] = useState<OgGraph | null>(null)
  const [selNode, setSelNode] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<Array<Record<string, unknown>>>([])
  const [skelOpen, setSkelOpen] = useState(false)
  const [skelIds, setSkelIds] = useState('')
  const [skelCode, setSkelCode] = useState('')
  const [skelConfirmed, setSkelConfirmed] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [pkg, setPkg] = useState<Record<string, unknown> | null>(null)
  const [quality, setQuality] = useState<{ score?: number; errors?: unknown[]; warnings?: unknown[] } | null>(null)
  const [gateOk, setGateOk] = useState<boolean | null>(null)
  const [derivedOpen, setDerivedOpen] = useState(false)
  const [derivedRuns, setDerivedRuns] = useState<Array<Record<string, unknown>>>([])
  const [needReviewN, setNeedReviewN] = useState<number | null>(null)
  const [layerFilter, setLayerFilter] = useState<'all' | 'O1' | 'O2' | 'O3'>('all')
  const [selectedEdge, setSelectedEdge] = useState<OgEdge | null>(null)
  const [searchQ, setSearchQ] = useState('')
  const [focusId, setFocusId] = useState<string | null>(null)
  const [vpReset, setVpReset] = useState(0)
  const [edgeKindFilter, setEdgeKindFilter] = useState<string | null>(null)
  const [focusScenario, setFocusScenario] = useState<string | null>(null)
  const [playIndex, setPlayIndex] = useState(-1)
  const [playing, setPlaying] = useState(false)
  const [playSpeed, setPlaySpeed] = useState(1)
  /** 用户布局偏好；聚焦场景时强制步骤链。 */
  const [layoutPref, setLayoutPref] = useState<'force' | 'column' | 'chain'>('force')
  const [labelMode, setLabelMode] = useState<'main' | 'all' | 'hover'>('main')
  /** 悬浮面板拖拽位置（相对 .ogc-stage）；key = floats | derived；null = CSS 默认位。 */
  const [panelPos, setPanelPos] = useState<Record<string, { left: number; top: number } | null>>({
    floats: null,
    derived: null,
  })
  const [boardCollapsed, setBoardCollapsed] = useState(false)
  const [derivedCollapsed, setDerivedCollapsed] = useState(false)
  const panelDragRef = useRef<{ key: string; dx: number; dy: number } | null>(null)

  const onPanelHandleDown = (e: {
    clientX: number
    clientY: number
    currentTarget: EventTarget
    target?: EventTarget | null
    pointerId?: number
    preventDefault?: () => void
    stopPropagation?: () => void
  }) => {
    // 折叠/关闭按钮在把手内：不进入拖拽，避免 pointer capture 吞掉 click
    const tgt = (e.target ?? null) as HTMLElement | null
    if (tgt?.closest?.('.ogc-float-toggle, .ogc-float-close')) {
      e.stopPropagation?.()
      return
    }
    const handle = e.currentTarget as HTMLElement
    const root = handle.closest('[data-panel]') as HTMLElement | null
    const stage = root?.closest('.ogc-stage') as HTMLElement | null
    if (!root || !stage) return
    const key = root.getAttribute('data-panel') || ''
    e.preventDefault?.()
    const rRect = root.getBoundingClientRect()
    const sRect = stage.getBoundingClientRect()
    const cur = panelPos[key]
    const left = cur ? cur.left : rRect.left - sRect.left
    const top = cur ? cur.top : rRect.top - sRect.top
    panelDragRef.current = { key, dx: e.clientX - sRect.left - left, dy: e.clientY - sRect.top - top }
    if (typeof e.pointerId === 'number' && handle.setPointerCapture) {
      try { handle.setPointerCapture(e.pointerId) } catch { /* ignore */ }
    }
  }

  const onPanelHandleMove = (e: { clientX: number; clientY: number }) => {
    const drag = panelDragRef.current
    if (!drag) return
    const stage = document.querySelector('.ogc-stage') as HTMLElement | null
    if (!stage) return
    const sRect = stage.getBoundingClientRect()
    const left = Math.max(0, Math.min(e.clientX - sRect.left - drag.dx, sRect.width - 100))
    const top = Math.max(0, Math.min(e.clientY - sRect.top - drag.dy, sRect.height - 36))
    setPanelPos((m) => ({ ...m, [drag.key]: { left, top } }))
  }

  const onPanelHandleUp = () => {
    panelDragRef.current = null
  }

  const panelStyle = (key: string): { left?: number; top?: number; right?: string; bottom?: string } | undefined => {
    const p = panelPos[key]
    if (!p) return undefined
    return { left: p.left, top: p.top, right: 'auto', bottom: 'auto' }
  }

  const loadGraph = useCallback(async () => {
    if (!api || !kApi || !selected) return
    try {
      const out = unwrap<{ graph: OgGraph }>(
        await api.getGraph({ name: selected.name, version: selected.version }),
      )
      setGraph(out.graph)
      const cq = unwrap<{ items: Array<Record<string, unknown>> }>(
        await kApi.listCandidates({ packageId: selected.name }),
      )
      setCandidates(cq.items)
      const p = unwrap<{ pkg: Record<string, unknown> }>(
        await api.load({ name: selected.name, version: selected.version }),
      )
      setPkg(p.pkg)
    } catch {
      /* 画布刷新失败静默（DRAFT/空包轮询） */
    }
  }, [apis, selected])

  // 状态板：校验分 + 门禁（OBM 门禁模式贴在画布旁，不进主模型层）
  const loadStatus = useCallback(async () => {
    if (!selected) return
    const vApi = apis.remote['ontoValidate']
    const dApi = apis.remote['ontoDerive']
    const rApi = apis.remote['ontoRuntime']
    if (vApi) {
      try {
        const out = unwrap<{ report: Record<string, unknown> }>(
          await vApi.validate({ name: selected.name, version: selected.version }),
        )
        const rep = out.report as { score?: number; errors?: unknown[]; warnings?: unknown[] }
        setQuality({ score: rep.score, errors: rep.errors ?? [], warnings: rep.warnings ?? [] })
      } catch {
        /* 状态板校验失败不打断画布 */
      }
    }
    if (dApi) {
      try {
        const g = unwrap<Record<string, unknown>>(
          await dApi.gate({ name: selected.name, version: selected.version }),
        )
        setGateOk(g['ok'] === true)
      } catch {
        setGateOk(null)
      }
    }
    if (rApi) {
      try {
        const out = unwrap<{ runs: Array<Record<string, unknown>> }>(await rApi.listRuns())
        const runs = out.runs ?? []
        setDerivedRuns(runs.slice(0, 6))
        setNeedReviewN(runs.filter((r) => r['humanReviewRequired'] === true || r['needReview'] === true).length)
      } catch {
        setDerivedRuns([])
      }
    }
  }, [apis, selected])

  useEffect(() => {
    void loadGraph()
  }, [loadGraph])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  // P1 订阅刷新：轮询 revision——dsh 会话起草 / 知识库人审后画布增量生长
  useEffect(() => {
    const timer = setInterval(() => {
      void loadGraph()
    }, 4000)
    return () => clearInterval(timer)
  }, [loadGraph])

  // 骨架输入只在非编辑态同步（防轮询覆盖正在输入的内容）
  useEffect(() => {
    if (!skelOpen && graph) {
      setSkelIds(graph.skeleton ? graph.skeleton.ids.join('\n') : '')
      setSkelConfirmed(graph.skeleton ? graph.skeleton.confirmed : false)
    }
  }, [graph, skelOpen])

  const readOnly = graph?.status === 'ISSUED'

  const draftAction = (id: string, action: 'approve' | 'reject'): void => {
    if (!selected || readOnly || !kApi) return
    void (async () => {
      setBusy(action)
      setError('')
      setInfo('')
      try {
        // 已 approved 未物化（画布仍虚线）→ 跳过 review 直接物化，防 CANDIDATE_FINALIZED 打断
        const cur = candidates.find((c) => String(c['id']) === id)
        if (!(action === 'approve' && cur?.['status'] === 'approved')) {
          unwrap(await kApi.reviewCandidate({ id, action }))
        }
        if (action === 'approve') {
          const res = unwrap<{ applied: string[]; skipped: Array<{ id: string; reason: string }> }>(
            await kApi.materialize({ name: selected.name, version: selected.version, ids: [id] }),
          )
          const reasons = res.skipped.map((s) => s.reason).join('; ')
          if (res.applied.length > 0) {
            // 物化了但有跳过 → 告警色列出原因，不吞（I6 拦截要让人看见）。
            setInfo(
              res.skipped.length > 0
                ? `✓ ${t('approveMat')}（${t('partialSkip')}: ${reasons}）`
                : `✓ ${t('approveMat')}`,
            )
          } else {
            // 一条没落地 → 不打 ✓，走错误条（实测 P1：绿勾盖住 I6 跳过原因）。
            setError(`${t('approveSkip')}: ${reasons || t('empty')}`)
          }
        } else {
          setInfo(`✓ ${t('reject')}`)
        }
        await loadGraph()
        onChanged?.()
      } catch (e) {
        setError(errText(e))
        void loadGraph()
      } finally {
        setBusy('')
      }
    })()
  }

  /**
   * E3-1 批量人审：画布全部虚线节点一次批准 + 单次 materialize 同批物化（权重归一批语义）。
   * P2-1：① 批量前 window.confirm（防误触整包写入）；② 逐条 review 失败不中断
   * （CONCLUSION_BLOCKED 等单条拒绝不拖死整批），失败项汇总进回执。
   */
  const batchApprove = (): void => {
    if (!selected || readOnly || !kApi || !graph) return
    const ids = graph.nodes.filter((nd) => nd.draft).map((nd) => nd.id)
    if (ids.length === 0) {
      setInfo(t('empty'))
      return
    }
    if (!window.confirm(`${t('approveAllConfirm')}\n${ids.length}`)) return
    void (async () => {
      setBusy('batch')
      setError('')
      setInfo('')
      try {
        const byId = new Map(candidates.map((c) => [String(c['id']), c]))
        const reviewFailed: string[] = []
        for (const id of ids) {
          if (byId.get(id)?.['status'] === 'pending') {
            try {
              unwrap(await kApi.reviewCandidate({ id, action: 'approve' }))
            } catch (e) {
              reviewFailed.push(`${id}: ${errText(e)}`)
            }
          }
        }
        const res = unwrap<{ applied: string[]; skipped: Array<{ id: string; reason: string }> }>(
          await kApi.materialize({ name: selected.name, version: selected.version, ids }),
        )
        const parts = [`✓ ${t('approveAll')}：${res.applied.length}/${ids.length}`]
        if (res.skipped.length > 0) parts.push(res.skipped.map((s) => s.reason).join('; '))
        if (reviewFailed.length > 0) {
          parts.push(`${t('approveReviewFail')} ${reviewFailed.length}: ${reviewFailed.join('; ')}`)
        }
        setInfo(parts.join(' · '))
        await loadGraph()
        onChanged?.()
      } catch (e) {
        setError(errText(e))
        void loadGraph()
      } finally {
        setBusy('')
      }
    })()
  }

  const saveSkeleton = (): void => {
    if (!selected || !kApi) return
    const domainCode = skelCode.trim() || skelDomainFallback(graph)
    const ids = skelIds
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    void (async () => {
      setBusy('skel')
      setError('')
      setInfo('')
      try {
        unwrap(
          await kApi.saveSkeleton({
            name: selected.name,
            version: selected.version,
            domainCode,
            confirmed: skelConfirmed,
            ids,
          }),
        )
        await loadGraph()
        setInfo(`✓ ${t('skelSave')}`)
      } catch (e) {
        setError(errText(e))
      } finally {
        setBusy('')
        setSkelOpen(false)
      }
    })()
  }

  if (!selected) return h('p', { className: 'ow-note' }, t('none'))

  const EMPTY_GRAPH: OgGraph = { package: '', version: '', status: '', nodes: [], edges: [], issues: [], revision: 0 }
  const g = graph ?? EMPTY_GRAPH
  const nodeObj: OgNode | null = selNode ? g.nodes.find((nd) => nd.id === selNode) ?? null : null
  const edgeKinds = Array.from(new Set(g.edges.map((e) => e.kind))).sort()
  const runSearch = (): void => {
    const q = searchQ.trim().toLowerCase()
    if (!q) return
    const hit = g.nodes.find((n) => n.name.toLowerCase().includes(q) || n.id.toLowerCase().includes(q))
    if (hit) {
      setSelectedEdge(null)
      setSelNode(hit.id)
      setFocusId(`${hit.id}#${Date.now()}`)
    } else {
      setInfo(t('empty'))
    }
  }
  const clearGraphSel = (): void => {
    setSelNode(null)
    setSelectedEdge(null)
    setFocusScenario(null)
    setPlayIndex(-1)
    setPlaying(false)
  }

  type ScStep = { stepId: string; stepType: string; order?: string; skillRefs?: string[]; label?: string }
  const scenarios = ((pkg ?? {}) as { scenarios?: Array<Record<string, unknown>> }).scenarios ?? []
  const activeSc = focusScenario
    ? scenarios.find((s) => String(s['id']) === focusScenario) ?? null
    : null
  const pipeline: ScStep[] = activeSc
    ? ((activeSc['pipeline'] as ScStep[] | undefined) ?? [])
    : []
  /** 聚焦场景 → 步骤链；否则跟用户偏好（力导/分列；步骤链无焦点时回落分列）。 */
  const effectiveLayout: 'force' | 'column' | 'scenario-chain' = focusScenario
    ? 'scenario-chain'
    : layoutPref === 'force'
      ? 'force'
      : 'column'

  /** 场景焦点集：场景 + pipeline 引用 + 行为/规则圈定 + 图上一跳。 */
  const focusSet = useMemo(() => {
    if (!focusScenario) return null
    const sc = scenarios.find((s) => String(s['id']) === focusScenario)
    if (!sc) return null
    const set = new Set<string>([focusScenario])
    const addAll = (arr: unknown): void => {
      if (Array.isArray(arr)) arr.forEach((x) => set.add(String(x)))
    }
    addAll(sc['behaviorRefs'])
    addAll(sc['scoreRefs'])
    addAll(sc['exclusionRefs'])
    const steps = (sc['pipeline'] as ScStep[] | undefined) ?? []
    const hasBeh = Array.isArray(sc['behaviorRefs']) && (sc['behaviorRefs'] as unknown[]).length > 0
    const hasScore = Array.isArray(sc['scoreRefs']) && (sc['scoreRefs'] as unknown[]).length > 0
    const hasExcl = Array.isArray(sc['exclusionRefs']) && (sc['exclusionRefs'] as unknown[]).length > 0
    let needBeh = false
    let needScore = false
    let needExcl = false
    for (const step of steps) {
      addAll(step.skillRefs)
      if (step.stepType === 'BEHAVIOR_CALL' && !hasBeh) needBeh = true
      if (step.stepType === 'RULE_EVALUATE' && step.order === 'before-scoring' && !hasExcl) needExcl = true
      if (step.stepType === 'RULE_EVALUATE' && step.order !== 'before-scoring' && !hasScore) needScore = true
    }
    // 缺省圈定 = 与运行一致：该步作用于全量对应类型
    if (needBeh || hasBeh === false && steps.some((s) => s.stepType === 'BEHAVIOR_CALL')) {
      if (!hasBeh && steps.some((s) => s.stepType === 'BEHAVIOR_CALL')) {
        for (const n of g.nodes) if (n.kind === 'behavior') set.add(n.id)
      }
    }
    if (!hasScore && steps.some((s) => s.stepType === 'RULE_EVALUATE' && s.order !== 'before-scoring')) {
      for (const n of g.nodes) if (n.kind === 'scoreRule') set.add(n.id)
    }
    if (!hasExcl && steps.some((s) => s.stepType === 'RULE_EVALUATE' && s.order === 'before-scoring')) {
      for (const n of g.nodes) if (n.kind === 'exclusionRule') set.add(n.id)
    }
    // 图上与场景相连的节点（scenario-step 等）
    for (const e of g.edges) {
      if (e.from === focusScenario) set.add(e.to)
      if (e.to === focusScenario) set.add(e.from)
    }
    // 两跳：技能→规则、行为→锚点、场景 refs→目标（v0.2.1 全链路）
    const twoHop = new Set(['skill-rule', 'anchor', 'ref', 'behavior-ref', 'score-ref', 'exclusion-ref', 'scenario-step'])
    for (const e of g.edges) {
      if (twoHop.has(e.kind) && set.has(e.from)) set.add(e.to)
      if (twoHop.has(e.kind) && set.has(e.to)) set.add(e.from)
    }
    // 行为锚定的对象
    for (const e of g.edges) {
      if (e.kind === 'anchor' && set.has(e.from)) set.add(e.to)
      if (e.kind === 'anchor' && set.has(e.to)) set.add(e.from)
    }
    return set
  }, [focusScenario, pkg, g.edges])

  /** 当前播放步的高亮 ID 集。 */
  const playSet = useMemo(() => {
    if (!focusScenario || playIndex < 0 || !pipeline[playIndex]) return null
    const step = pipeline[playIndex]
    const sc = activeSc
    const set = new Set<string>([focusScenario])
    const addAll = (arr: unknown): void => {
      if (Array.isArray(arr)) arr.forEach((x) => set.add(String(x)))
    }
    if (step.stepType === 'SKILL_RUN') addAll(step.skillRefs)
    else if (step.stepType === 'BEHAVIOR_CALL') addAll(sc?.['behaviorRefs'])
    else if (step.stepType === 'RULE_EVALUATE') {
      if (step.order === 'before-scoring') addAll(sc?.['exclusionRefs'])
      else addAll(sc?.['scoreRefs'])
    } else if (step.stepType === 'HUMAN_REVIEW' || step.stepType === 'AUDIT_CHECK') {
      // 保持场景 + 已出现技能
      for (let i = 0; i <= playIndex; i++) addAll(pipeline[i].skillRefs)
    } else if (step.stepType === 'DATA_INGEST') {
      // 数据摄入：亮场景
    }
    // 行为步若未圈定，亮全部 O2 行为（与运行缺省一致）
    if (step.stepType === 'BEHAVIOR_CALL' && !(sc?.['behaviorRefs'] as unknown[] | undefined)?.length) {
      for (const n of g.nodes) if (n.kind === 'behavior') set.add(n.id)
    }
    if (step.stepType === 'RULE_EVALUATE' && step.order !== 'before-scoring'
        && !(sc?.['scoreRefs'] as unknown[] | undefined)?.length) {
      for (const n of g.nodes) if (n.kind === 'scoreRule') set.add(n.id)
    }
    if (step.stepType === 'RULE_EVALUATE' && step.order === 'before-scoring'
        && !(sc?.['exclusionRefs'] as unknown[] | undefined)?.length) {
      for (const n of g.nodes) if (n.kind === 'exclusionRule') set.add(n.id)
    }
    return set
  }, [focusScenario, playIndex, pipeline, activeSc, g.nodes])

  const enterScenarioFocus = (id: string): void => {
    setSelNode(null)
    setSelectedEdge(null)
    setFocusScenario(id)
    setPlayIndex(-1)
    setPlaying(false)
    setVpReset((n) => n + 1)
  }

  const exitScenarioFocus = (): void => {
    setFocusScenario(null)
    setPlayIndex(-1)
    setPlaying(false)
  }

  // 播放循环
  useEffect(() => {
    if (!playing || pipeline.length === 0) return
    const ms = Math.round(1400 / playSpeed)
    const timer = setInterval(() => {
      setPlayIndex((i) => {
        if (i >= pipeline.length - 1) {
          setPlaying(false)
          return i
        }
        return i + 1
      })
    }, ms)
    return () => clearInterval(timer)
  }, [playing, playSpeed, pipeline.length])
  const pkgIssues = g.issues.filter((i) => i.where === 'package' && i.level !== 'info')
  const draftCount = g.nodes.filter((nd) => nd.draft).length
  const domain = skelDomainFallback(graph)
  const layerCounts = {
    O1: g.nodes.filter((n) => !n.draft && n.layer === 'O1').length,
    O2: g.nodes.filter((n) => !n.draft && n.layer === 'O2').length,
    O3: g.nodes.filter((n) => !n.draft && n.layer === 'O3').length,
  }
  const errN = (quality?.errors ?? []).length
  const runHitN = g.nodes.filter((n) => n.runHit).length

  const canvasChildren: ReactNode[] = []
  if (graph) {
    canvasChildren.push(
      h(
        'div',
        { key: 'skel', className: 'ogc-skel', style: { margin: 0, padding: 0 } },
        h(Tag, {
          text: t('skeleton'),
          tone: graph.skeleton ? (graph.skeleton.confirmed ? 'ok' : 'warn') : undefined,
        }),
        h(
          'span',
          { className: 'ow-note' },
          graph.skeleton
            ? `${graph.skeleton.confirmed ? t('skelConfirmed') : t('skelUnconfirmed')} · ${graph.skeleton.ids.length} ID`
            : t('skelNone'),
        ),
        readOnly || skelOpen
          ? null
          : h('button', {
              className: 'ow-btn ghost',
              disabled: !!busy,
              onClick: () => setSkelOpen(true),
            }, t('skelEdit')),
        skelOpen
          ? h(
              'div',
              { className: 'ow-form', style: { width: '100%', marginTop: 6 } },
              h(Field, { label: t('skelCode') },
                h('input', {
                  className: 'ow-in',
                  value: skelCode,
                  placeholder: domain,
                  onChange: (e: { target: { value: string } }) => setSkelCode(e.target.value),
                })),
              h(Field, { label: t('skelIds') },
                h('textarea', {
                  className: 'ow-textarea',
                  style: { minHeight: 90 },
                  value: skelIds,
                  onChange: (e: { target: { value: string } }) => setSkelIds(e.target.value),
                })),
              h(
                'div',
                { className: 'ow-row' },
                h('label', { className: 'ow-note', style: { display: 'flex', gap: 6, alignItems: 'center' } },
                  h('input', {
                    type: 'checkbox',
                    checked: skelConfirmed,
                    onChange: (e: { target: { checked: boolean } }) => setSkelConfirmed(e.target.checked),
                  }),
                  t('skelConfirmed')),
                h('button', { className: 'ow-btn', disabled: !!busy, onClick: saveSkeleton }, t('skelSave')),
                h('button', { className: 'ow-btn ghost', onClick: () => setSkelOpen(false) }, t('cancel')),
              ),
            )
          : null,
      ),
    )
  }

  // 层过滤后的图（画布主表面）
  let visNodes = layerFilter === 'all'
    ? g.nodes
    : g.nodes.filter((n) => n.draft || n.layer === layerFilter)
  const layerById = new Map(g.nodes.map((n) => [n.id, n.layer] as const))
  let visEdges =
    edgeKindFilter === 'cross'
      ? g.edges.filter((e) => isCrossLayerEdge(e.kind, layerById.get(e.from), layerById.get(e.to)))
      : edgeKindFilter
        ? g.edges.filter((e) => e.kind === edgeKindFilter)
        : g.edges
  // 场景步骤链：只显示焦点节点（横向编排更清晰）；其余模式保留全图靠 dim
  if (focusSet && focusScenario) {
    visNodes = visNodes.filter((n) => focusSet.has(n.id))
    visEdges = visEdges.filter((e) => focusSet.has(e.from) && focusSet.has(e.to))
  }
  const visibleGraph: OgGraph = { ...g, nodes: visNodes, edges: visEdges }

  const layerBtn = (key: 'all' | 'O1' | 'O2' | 'O3', label: string, tip: string): ReactNode =>
    h(
      'button',
      {
        key,
        type: 'button',
        className: layerFilter === key ? 'lb on' : 'lb',
        onClick: () => setLayerFilter(key),
      },
      label,
      h('span', { className: 'tip' }, tip),
    )

  return h(
    'div',
    { className: 'ogc-studio' },
    // 左层轨
    h(
      'aside',
      { className: 'ogc-lrail', 'aria-label': t('modelLayers') },
      layerBtn('all', '≡', t('modelLayers')),
      layerBtn('O1', 'O1', 'O1'),
      layerBtn('O2', 'O2', 'O2'),
      layerBtn('O3', 'O3', 'O3'),
      h(
        'button',
        {
          type: 'button',
          className: derivedOpen ? 'lb on' : 'lb',
          onClick: () => {
            setDerivedOpen((v) => !v)
            if (!derivedOpen) void loadStatus()
          },
          title: t('derivedView'),
        },
        '◇',
        h('span', { className: 'tip' }, t('derivedView')),
      ),
    ),
    // 中央大画布
    h(
      'div',
      { className: 'ogc-stage' },
      h(
        'div',
        { className: 'ogc-stage-top' },
        h('span', {
          className: 'ogc-chip',
          title: t('primaryModelChip'),
          style: { maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        }, t('primaryModelChip')),
        h('span', { className: 'ow-stat', title: t('draftCount') }, `⚡${draftCount}`),
        !readOnly && draftCount > 0
          ? h('button', {
              className: 'ow-btn',
              disabled: !!busy,
              onClick: batchApprove,
              title: t('approveAll'),
            }, busy === 'batch' ? '…' : '✓')
          : null,
        h('button', {
          className: 'ow-btn ghost',
          disabled: !!busy,
          onClick: () => void loadGraph(),
          title: t('refresh'),
        }, '↻'),
        h(
          'div',
          { className: 'ogc-search' },
          h('input', {
            placeholder: t('searchPh'),
            value: searchQ,
            onChange: (e: { target: { value: string } }) => setSearchQ(e.target.value),
            onKeyDown: (e: { key: string }) => {
              if (e.key === 'Enter') runSearch()
            },
          }),
          h('button', { className: 'ow-btn ghost', onClick: runSearch }, '⌕'),
          h('button', {
            className: 'ow-btn ghost',
            onClick: () => {
              clearGraphSel()
              setSearchQ('')
              setVpReset((n) => n + 1)
              setEdgeKindFilter(null)
            },
          }, t('resetView')),
        ),
        h(
          'div',
          {
            className: 'ogc-search',
            title: focusScenario ? t('scenarioFocusHint') : t('layoutMode'),
          },
          h('span', { className: 'ow-note' }, t('layoutMode')),
          h('select', {
            value: focusScenario ? 'chain' : layoutPref,
            disabled: !!focusScenario,
            onChange: (e: { target: { value: string } }) => {
              const v = e.target.value
              if (v === 'force' || v === 'column' || v === 'chain') setLayoutPref(v)
              setVpReset((n) => n + 1)
            },
            style: {
              padding: '5px 8px',
              borderRadius: 8,
              border: '1px solid #d1d5db',
              fontSize: 12.5,
              background: '#fff',
              color: 'inherit',
            },
          },
            h('option', { value: 'force' }, t('layoutForce')),
            h('option', { value: 'column' }, t('layoutColumn')),
            h('option', { value: 'chain', disabled: !focusScenario }, t('layoutChain')),
          ),
        ),
        h(
          'div',
          { className: 'ogc-search', title: t('labelDensity') },
          h('span', { className: 'ow-note' }, t('labelDensity')),
          h('select', {
            value: labelMode,
            onChange: (e: { target: { value: string } }) => {
              const v = e.target.value
              if (v === 'main' || v === 'all' || v === 'hover') setLabelMode(v)
            },
            style: {
              padding: '5px 8px',
              borderRadius: 8,
              border: '1px solid #d1d5db',
              fontSize: 12.5,
              background: '#fff',
              color: 'inherit',
            },
          },
            h('option', { value: 'main' }, t('labelMain')),
            h('option', { value: 'all' }, t('labelAll')),
            h('option', { value: 'hover' }, t('labelHover')),
          ),
        ),
        readOnly ? h(Tag, { text: 'ISSUED', tone: 'ok' }) : null,
      ),
      h(
        'div',
        { className: 'ogc-stage-banners' },
        h(ErrorBanner, { text: error }),
        h(OkBanner, { text: info }),
        focusScenario
          ? h(
              'div',
              { className: 'ogc-focus-bar', style: { marginBottom: 8 } },
              h('span', null,
                `${t('focusScenario')}：`,
                h('b', null, activeSc ? String(activeSc['name'] ?? focusScenario) : focusScenario),
                ` · ${focusSet ? focusSet.size : 0} ${t('focusNodes')}`),
              h('button', { className: 'ow-btn ghost', onClick: exitScenarioFocus }, '✕'),
            )
          : null,
        focusScenario && pipeline.length > 0
          ? h(
              'div',
              { className: 'ogc-playbar', style: { marginBottom: 8 } },
              h('button', {
                className: 'ow-btn ghost',
                onClick: () => setPlayIndex((i) => Math.max(0, i - 1)),
                disabled: playIndex <= 0,
              }, t('prevStep')),
              h('button', {
                className: 'ow-btn',
                onClick: () => {
                  if (playIndex >= pipeline.length - 1) setPlayIndex(0)
                  setPlaying((p) => !p)
                },
              }, playing ? t('pause') : t('play')),
              h('button', {
                className: 'ow-btn ghost',
                onClick: () => setPlayIndex((i) => Math.min(pipeline.length - 1, i + 1)),
                disabled: playIndex >= pipeline.length - 1,
              }, t('nextStep')),
              h('input', {
                type: 'range',
                min: 0,
                max: Math.max(0, pipeline.length - 1),
                value: Math.max(0, playIndex),
                onChange: (e: { target: { value: string } }) => {
                  setPlaying(false)
                  setPlayIndex(Number(e.target.value))
                },
                style: { flex: 1, minWidth: 120 },
              }),
              h('span', { className: 'ow-stat' },
                `${Math.max(0, playIndex) + (playIndex >= 0 ? 1 : 0)} / ${pipeline.length} ${t('stepOf')}`),
              h('label', { className: 'ow-note' }, t('speed')),
              h('select', {
                value: String(playSpeed),
                onChange: (e: { target: { value: string } }) => setPlaySpeed(Number(e.target.value)),
              },
                h('option', { value: '0.5' }, '0.5×'),
                h('option', { value: '1' }, '1×'),
                h('option', { value: '2' }, '2×'),
              ),
              playIndex >= 0 && pipeline[playIndex]
                ? h('span', { className: 'ow-stat' },
                    h('b', null, pipeline[playIndex].stepId),
                    ' ',
                    pipeline[playIndex].stepType)
                : null,
            )
          : null,
        focusScenario && pipeline.length === 0
          ? h('p', { className: 'ow-note' }, t('noPipeline'))
          : null,
      ),
      ...canvasChildren,
      h(
        'div',
        { className: 'ogc-canvas-area' },
        graph
          ? h(
              'div',
              { className: 'ogc-box', style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, border: 'none' } },
              focusScenario && pipeline.length > 0
                ? h(
                    'div',
                    {
                      className: 'ogc-step-bar',
                      style: {
                        display: 'flex',
                        gap: 4,
                        padding: '8px 8px 4px',
                        overflowX: 'auto',
                        flexShrink: 0,
                      },
                    },
                    ...pipeline.map((step, i) =>
                      h(
                        'div',
                        {
                          key: step.stepId || i,
                          style: {
                            flex: '1 0 auto',
                            minWidth: 72,
                            textAlign: 'center',
                            background: playIndex === i ? '#1d4ed8' : '#ffffff',
                            border: `1.5px solid ${playIndex === i ? '#1d4ed8' : '#3b6fd4'}`,
                            borderRadius: 8,
                            padding: '4px 6px',
                          },
                        },
                        h('div', {
                          style: {
                            fontSize: 12,
                            fontWeight: 750,
                            color: playIndex === i ? '#ffffff' : '#1d4ed8',
                            lineHeight: 1.2,
                          },
                        }, step.stepId),
                        h('div', {
                          style: {
                            fontSize: 10,
                            fontWeight: 650,
                            color: playIndex === i ? '#dbeafe' : '#374151',
                            lineHeight: 1.2,
                          },
                        }, step.stepType.replace(/_/g, ' ')),
                      ),
                    ),
                  )
                : null,
              h(GraphCanvas, {
                t,
                graph: visibleGraph,
                selected: selNode,
                selectedEdge,
                onSelect: (id: string | null) => {
                  if (id) {
                    const nd = g.nodes.find((n) => n.id === id)
                    if (nd && nd.kind === 'scenario') {
                      enterScenarioFocus(id)
                      return
                    }
                  }
                  setSelNode(id)
                  if (id) {
                    setSelectedEdge(null)
                    if (focusScenario) exitScenarioFocus()
                  }
                },
                onSelectEdge: (e: OgEdge | null) => {
                  setSelectedEdge(e)
                  if (e) setSelNode(null)
                },
                onDraftAction: draftAction,
                actionOff: !!busy || readOnly,
                focusId,
                onViewportResetKey: vpReset,
                focusSet,
                playSet,
                layoutMode: effectiveLayout,
                pipeline: focusScenario ? pipeline : undefined,
                scenarioId: focusScenario ?? undefined,
                labelMode,
              }),
              h(
                'div',
                { className: 'ogc-legend' },
                h('span', null, h('i', { className: 'ogc-dot', style: { background: '#fff', border: '1.5px solid #3b6fd4' } }), ' O1'),
                h('span', null, h('i', { className: 'ogc-dot', style: { background: '#fff', border: '1.5px solid #d97706' } }), ' O2'),
                h('span', null, h('i', { className: 'ogc-dot', style: { background: '#fff', border: '1.5px solid #16a34a' } }), ' O3'),
                h('span', null, h('i', { className: 'ogc-dot', style: { background: '#fff', border: '1.5px dashed #999' } }), ` ${t('queue')}`),
                h('span', null, h('i', { className: 'ogc-dot', style: { background: '#fff', border: '1.5px solid #dc2626' } }), ' error / run-hit'),
                h('span', null, h('i', { className: 'ogc-dot', style: { background: '#f5f3ff', border: '1.5px dashed #7c3aed' } }), ` ${t('derivedView')}`),
              ),
              h(
                'div',
                { className: 'ogc-edge-legend', style: { width: '100%', borderTop: '1px solid #f0f1f4', marginTop: 4, paddingTop: 6 } },
                h('span', { style: { fontWeight: 650, marginRight: 4 } }, `${t('edgeLegend')}:`),
                h(
                  'button',
                  {
                    key: 'cross',
                    type: 'button',
                    className: edgeKindFilter === 'cross' ? 'on' : '',
                    onClick: () => setEdgeKindFilter(edgeKindFilter === 'cross' ? null : 'cross'),
                    title: 'cross-layer O1-O2-O3',
                  },
                  h('i', { style: { borderTopColor: '#3b6fd4', borderTopWidth: 3 } }),
                  t('edgeCross'),
                ),
                ...edgeKinds.map((k) =>
                  h(
                    'button',
                    {
                      key: k,
                      type: 'button',
                      className: edgeKindFilter === k ? 'on' : '',
                      onClick: () => setEdgeKindFilter(edgeKindFilter === k ? null : k),
                      title: k,
                    },
                    h('i', { style: { borderTopColor: OG_EDGE[k] ?? '#a8b0c3' } }),
                    k,
                  ),
                ),
                edgeKindFilter
                  ? h('button', { type: 'button', onClick: () => setEdgeKindFilter(null) }, '×')
                  : null,
              ),
            )
          : h('p', { className: 'ow-note', style: { padding: 24 } }, t('loading')),
      ),
      // 悬浮栈：状态板 +（有选中时）检视器/包问题——可拖拽、状态板可折叠
      h(
        'div',
        {
          className: 'ogc-floats',
          'data-panel': 'floats',
          style: panelStyle('floats'),
        },
        h(
          'div',
          { className: `ogc-board${boardCollapsed ? ' collapsed' : ''}` },
          h(
            'div',
            {
              className: 'ogc-float-handle',
              onPointerDown: onPanelHandleDown,
              onPointerMove: onPanelHandleMove,
              onPointerUp: onPanelHandleUp,
              onPointerCancel: onPanelHandleUp,
              title: '拖动',
            },
            h('h4', null, t('statusBoard')),
            h(
              'button',
              {
                type: 'button',
                className: 'ogc-float-toggle',
                onPointerDown: (e: { stopPropagation?: () => void }) => e.stopPropagation?.(),
                onClick: (e: { stopPropagation?: () => void }) => {
                  e.stopPropagation?.()
                  setBoardCollapsed((v) => !v)
                },
                title: boardCollapsed ? '展开' : '收起',
              },
              boardCollapsed ? '+' : '−',
            ),
          ),
          boardCollapsed
            ? null
            : h(
                'div',
                { className: 'ogc-board-body' },
                h('div', { className: 'sb-row' },
                  h('span', null, t('qualityScore')),
                  h('b', { className: errN === 0 && quality ? 'ok' : 'warn' },
                    quality && typeof quality.score === 'number' ? String(quality.score) : '—')),
                h('div', { className: 'sb-row' },
                  h('span', null, t('validateErrors')),
                  h('b', { className: errN === 0 ? 'ok' : 'err' }, String(errN))),
                h('div', { className: 'sb-row' },
                  h('span', null, t('deriveGate')),
                  h('b', { className: gateOk === true ? 'ok' : gateOk === false ? 'err' : '' },
                    gateOk === true ? t('gateOk') : gateOk === false ? t('drift') : t('gateUnknown'))),
                h('div', { className: 'sb-row' },
                  h('span', null, t('draftCount')),
                  h('b', { className: draftCount > 0 ? 'warn' : 'ok' }, String(draftCount))),
                h('div', { className: 'sb-row' },
                  h('span', null, t('needReviewRuns')),
                  h('b', null, needReviewN === null ? '—' : String(needReviewN))),
                h(
                  'div',
                  { className: 'ogc-board-actions' },
                  h('button', { disabled: !!busy, onClick: () => void loadStatus() }, t('validateBtn')),
                  h('button', {
                    disabled: !!busy,
                    onClick: () => {
                      const dApi = apis.remote['ontoDerive']
                      if (!dApi || !selected) return
                      void (async () => {
                        setBusy('derive')
                        try {
                          unwrap(await dApi.derive({ name: selected.name, version: selected.version }))
                          await loadStatus()
                          setInfo(`✓ ${t('deriveBtn')}`)
                        } catch (e) {
                          setError(errText(e))
                        } finally {
                          setBusy('')
                        }
                      })()
                    },
                  }, t('deriveBtn')),
                ),
              ),
        ),
        // 有选中才浮出详情；未选中不占位
        nodeObj || selectedEdge || (focusScenario && playIndex >= 0 && pipeline[playIndex])
          ? h(InspectorView, {
              t,
              graph: g,
              node: nodeObj,
              edge: selectedEdge,
              pkg,
              candidates,
              busy,
              readOnly,
              onDraftAction: draftAction,
              onClear: clearGraphSel,
              stepDetail: focusScenario && playIndex >= 0 && pipeline[playIndex]
                ? {
                    stepId: pipeline[playIndex].stepId,
                    stepType: pipeline[playIndex].stepType,
                    order: pipeline[playIndex].order,
                    label: pipeline[playIndex].label,
                    refs: Array.from(playSet ?? []),
                  }
                : null,
            })
          : null,
        pkgIssues.length > 0
          ? h(
              'div',
              { className: 'ogc-float-issues' },
              h('b', { className: 'ow-note' }, `${t('pkgIssues')}（${pkgIssues.length}）`),
              ...pkgIssues.slice(0, 8).map((i, k) =>
                h(
                  'div',
                  { key: k, className: i.level === 'warn' ? 'ogc-issue warn' : 'ogc-issue' },
                  h('b', null, i.code),
                  ' ',
                  i.message,
                )),
            )
          : null,
      ),
      h(
        'div',
        {
          className: `ogc-derived${derivedOpen ? ' on' : ''}${derivedCollapsed ? ' collapsed' : ''}`,
          'data-panel': 'derived',
          style: panelStyle('derived'),
        },
        h(
          'div',
          {
            className: 'ogc-float-handle',
            onPointerDown: onPanelHandleDown,
            onPointerMove: onPanelHandleMove,
            onPointerUp: onPanelHandleUp,
            onPointerCancel: onPanelHandleUp,
            title: '拖动',
          },
          h('h4', null, t('derivedView')),
          h(
            'span',
            { className: 'ogc-float-btns' },
            h(
              'button',
              {
                type: 'button',
                className: 'ogc-float-toggle',
                onPointerDown: (e: { stopPropagation?: () => void }) => e.stopPropagation?.(),
                onClick: (e: { stopPropagation?: () => void }) => {
                  e.stopPropagation?.()
                  setDerivedCollapsed((v) => !v)
                },
                title: derivedCollapsed ? '展开' : '收起',
              },
              derivedCollapsed ? '+' : '−',
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'ogc-float-toggle',
                onPointerDown: (e: { stopPropagation?: () => void }) => e.stopPropagation?.(),
                onClick: (e: { stopPropagation?: () => void }) => {
                  e.stopPropagation?.()
                  setDerivedOpen(false)
                  setDerivedCollapsed(false)
                },
                title: '关闭',
              },
              '×',
            ),
          ),
        ),
        derivedCollapsed
          ? null
          : h(
              'div',
              { className: 'ogc-derived-body' },
              h('p', { className: 'note' }, t('derivedHint')),
              h(
                'div',
                { className: 'ow-row' },
                h('span', { className: 'ow-stat' }, `${t('modelLayers')} O1 ${layerCounts.O1} · O2 ${layerCounts.O2} · O3 ${layerCounts.O3}`),
                h('span', { className: 'ow-stat' }, `${t('derivedEvents')}: ${derivedRuns.length}`),
                h('span', { className: 'ow-stat' }, `run-hit ${runHitN}`),
              ),
              derivedRuns.length === 0
                ? h('p', { className: 'ow-note' }, t('derivedEmpty'))
                : h(
                    'div',
                    { className: 'ow-row', style: { alignItems: 'flex-start' } },
                    ...derivedRuns.map((r, i) =>
                      h(
                        'div',
                        {
                          key: i,
                          className: 'ow-stat',
                          style: { flexDirection: 'column', alignItems: 'flex-start', gap: 2, maxWidth: 240 },
                        },
                        h('b', { className: 'ow-mono', style: { fontSize: 11 } }, String(r['runId'] ?? '—')),
                        h('span', { className: 'ow-note' },
                          `${String(r['scenarioId'] ?? r['scenario'] ?? '')} · ${String(r['auditPassed'] ?? r['passed'] ?? '')}`),
                      ),
                    ),
                  ),
            ),
      ),
    ),
  )
}

/** 骨架域码回退：无图谱时用包 ID 派生的占位（保存时优先 skelCode 输入）。 */
export function skelDomainFallback(graph: OgGraph | null): string {
  if (graph && graph.package) return (graph.package.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) || 'GEN')
  return 'GEN'
}
