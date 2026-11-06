/**
 * 图谱构建（conversational-modeling P1/P3、I2/I3）：
 * 包元素 + 草案队列 + 校验 issues → ModelGraph（画布与 get_model_graph 的共同数据源）。
 * 纯函数：不读盘、不写包；调用方负责取 pkg / candidates / issues / skeleton。
 */
import { extractIdRefs } from './ids.js'
import type {
  DraftCandidate,
  GraphNode,
  GraphNodeKind,
  IssueLevel,
  ModelEdge,
  ModelGraph,
  OntologyPackage,
  SkeletonRecord,
  ValidationIssue,
} from './types.js'

const LEVEL_RANK: Record<IssueLevel, number> = { error: 3, warn: 2, info: 1 }

/** where → 节点 ID。支持 '元素ID' / 'PREFIX 元素ID(.attr)' 两种形态；定位不到（含文件路径、'package'）返回 undefined。 */
export function whereToNodeId(where: string, nodeIds: ReadonlySet<string>): string | undefined {
  if (!where || where === 'package') return undefined
  if (nodeIds.has(where)) return where
  const m = where.match(/^[A-Z]{2,4} ([A-Z]+-[A-Z0-9-]+)(?:\.[A-Za-z0-9_-]+)?$/)
  if (m && nodeIds.has(m[1])) return m[1]
  return undefined
}

function pushEdge(edges: ModelEdge[], seen: Set<string>, nodeIds: ReadonlySet<string>, edge: ModelEdge): void {
  if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to) || edge.from === edge.to) return
  const key = `${edge.from}|${edge.to}|${edge.kind}`
  if (seen.has(key)) return
  seen.add(key)
  edges.push(edge)
}

/** 从任意文本抽取指向已有节点的 ID 引用边。 */
function pushIdRefs(
  edges: ModelEdge[],
  seen: Set<string>,
  nodeIds: ReadonlySet<string>,
  from: string,
  text: string,
  kind: string,
): void {
  for (const ref of extractIdRefs(text)) {
    pushEdge(edges, seen, nodeIds, { from, to: ref, kind })
  }
}

/**
 * 草案 payload 里的语义引用字段（只取引用位，不扫 name/description 自由文本——
 * 避免文本里出现 ID 字面即连边的假阳性）。
 */
function payloadRefTexts(payload: Record<string, unknown>): string[] {
  const out: string[] = []
  const take = (v: unknown): void => {
    if (typeof v === 'string') out.push(v)
  }
  for (const key of [
    'anchor',
    'from',
    'to',
    'refObject',
    'enumValuesRef',
    'scenarioId',
    'target',
    'expression',
    'condition',
    'evidenceTemplate',
  ]) {
    take(payload[key])
  }
  for (const key of ['skillRefs', 'relations']) {
    const v = payload[key]
    if (Array.isArray(v)) v.forEach(take)
  }
  const weights = payload['weights']
  if (weights && typeof weights === 'object' && !Array.isArray(weights)) {
    out.push(...Object.keys(weights))
  }
  return out
}

/**
 * 构建画布图谱。
 * - 物化元素全部成节点；status=pending 的草案成虚线 draft 节点（I1：草案不落包）。
 * - 草案经 appliedAs 回连物化元素，provenance 上节点（I2）。
 * - issues 按 where 定位到节点，定位不到的显式按包级处理（I3）。
 * - skeleton 可选：confirmed 与骨架覆盖随图下发，供画布展示门禁状态。
 */
export function buildModelGraph(input: {
  pkg: OntologyPackage
  candidates?: DraftCandidate[]
  issues?: ValidationIssue[]
  skeleton?: SkeletonRecord | null
  /** S4：运行命中规则 ID（画布高亮）。 */
  runHitRuleIds?: readonly string[]
  revision?: number
}): ModelGraph {
  const pkg = input.pkg
  const candidates = input.candidates ?? []
  const issues = input.issues ?? []
  const nodes: GraphNode[] = []
  const edges: ModelEdge[] = []
  const edgeSeen = new Set<string>()

  const add = (id: string, kind: GraphNodeKind, layer: GraphNode['layer'], name: string): void => {
    // ID 全包唯一是校验不变量，但重复 ID（DUP_ID 未修）可能造成双节点：画布去重。
    if (nodes.some((n) => n.id === id)) return
    nodes.push({ id, kind, layer, name, draft: false })
  }
  for (const o of pkg.objects) add(o.id, 'object', 'O1', o.name)
  for (const r of pkg.relations) add(r.id, 'relation', 'O1', r.name)
  for (const d of pkg.dictionaries) add(d.id, 'dictionary', 'O1', d.name)
  for (const f of pkg.fieldMaps) add(f.id, 'fieldMap', 'O1', f.id)
  for (const s of pkg.apiSources) add(s.id, 'apiSource', 'O1', s.name)
  for (const b of pkg.behaviors) add(b.id, 'behavior', 'O2', b.name)
  for (const r of pkg.scoreRules) add(r.id, 'scoreRule', 'O2', r.name)
  for (const r of pkg.exclusionRules) add(r.id, 'exclusionRule', 'O2', r.name)
  for (const s of pkg.skillTemplates) add(s.id, 'skillTemplate', 'O2', s.name)
  for (const s of pkg.scenarios) add(s.id, 'scenario', 'O3', s.name)

  // 草案节点（pending 与 approved-未物化均画虚线；merged 经 provenance 回连，rejected 出画布）
  // 注意：工具面结果须过 harness lossless-JSON 校验——可选字段用条件展开，禁止显式 undefined 键。
  for (const c of candidates) {
    if (c.status === 'merged' || c.status === 'rejected') continue
    const provenance = c.provenance ?? (c.sourceId ? { sourceId: c.sourceId } : undefined)
    nodes.push({
      id: c.id,
      kind: 'draft',
      layer: c.layer,
      name: c.name,
      draft: true,
      ...(provenance ? { provenance } : {}),
      ...(c.forcedReview ? { forcedReview: true } : {}),
    })
  }

  const nodeIds = new Set(nodes.map((n) => n.id))

  /* 引用边 */
  for (const r of pkg.relations) {
    pushEdge(edges, edgeSeen, nodeIds, { from: r.id, to: r.from, kind: 'relation', label: r.name })
    pushEdge(edges, edgeSeen, nodeIds, { from: r.id, to: r.to, kind: 'relation', label: r.name })
    for (const a of r.attributes ?? []) {
      if (a.type === 'ref' && a.refObject) {
        pushEdge(edges, edgeSeen, nodeIds, { from: r.id, to: a.refObject, kind: 'ref' })
      }
      if (a.type === 'enum' && a.enumValuesRef) {
        pushEdge(edges, edgeSeen, nodeIds, { from: r.id, to: a.enumValuesRef, kind: 'dict' })
      }
    }
  }
  for (const o of pkg.objects) {
    for (const a of o.attributes) {
      if (a.type === 'ref' && a.refObject) {
        pushEdge(edges, edgeSeen, nodeIds, { from: o.id, to: a.refObject, kind: 'ref' })
      }
      if (a.type === 'enum' && a.enumValuesRef) {
        pushEdge(edges, edgeSeen, nodeIds, { from: o.id, to: a.enumValuesRef, kind: 'dict' })
      }
    }
  }
  for (const b of pkg.behaviors) {
    pushEdge(edges, edgeSeen, nodeIds, { from: b.id, to: b.anchor, kind: 'anchor', label: b.name })
    for (const rel of b.relations ?? []) {
      pushEdge(edges, edgeSeen, nodeIds, { from: b.id, to: rel, kind: 'relation' })
    }
  }
  for (const s of pkg.skillTemplates) {
    for (const ruleId of Object.keys(s.weights)) {
      pushEdge(edges, edgeSeen, nodeIds, { from: s.id, to: ruleId, kind: 'skill-rule' })
    }
  }
  for (const sc of pkg.scenarios) {
    for (const step of sc.pipeline) {
      for (const skillId of step.skillRefs ?? []) {
        pushEdge(edges, edgeSeen, nodeIds, { from: sc.id, to: skillId, kind: 'scenario-step', label: step.stepId })
      }
    }
  }
  for (const f of pkg.fieldMaps) {
    const m = f.target.match(/^([A-Z]+-[A-Z0-9-]+)(?:\.[A-Za-z0-9_-]+)?$/)
    if (m) pushEdge(edges, edgeSeen, nodeIds, { from: f.id, to: m[1], kind: 'applies' })
  }
  for (const r of pkg.scoreRules) {
    pushIdRefs(edges, edgeSeen, nodeIds, r.id, r.expression ?? '', 'ref')
    if (r.evidenceTemplate) pushIdRefs(edges, edgeSeen, nodeIds, r.id, r.evidenceTemplate, 'ref')
  }
  for (const r of pkg.exclusionRules) {
    pushIdRefs(edges, edgeSeen, nodeIds, r.id, r.condition ?? '', 'ref')
  }
  // 草案 payload 里的语义引用位（anchor/from/to/refObject/scenarioId/weights 等）
  // 与 update 草案的 targetId（指向被修改的既有元素）
  for (const c of candidates) {
    if (c.status !== 'pending') continue
    for (const text of payloadRefTexts(c.payload ?? {})) {
      pushIdRefs(edges, edgeSeen, nodeIds, c.id, text, 'ref')
    }
    if (c.targetId) {
      pushIdRefs(edges, edgeSeen, nodeIds, c.id, c.targetId, 'ref')
    }
  }

  /* 溯源回连（I2）：appliedAs → 草案 provenance 上节点 */
  const applied = new Map<string, DraftCandidate>()
  for (const c of candidates) {
    if (c.appliedAs) applied.set(c.appliedAs, c)
  }
  for (const n of nodes) {
    const c = applied.get(n.id)
    if (!c) continue
    const provenance = c.provenance ?? (c.sourceId ? { sourceId: c.sourceId } : undefined)
    if (provenance) n.provenance = provenance
  }

  /* issues 定位（I3）：where 归一为「节点 ID | 'package'」——定位不到即显式包级，无孤立报错 */
  const graphIssues: ValidationIssue[] = issues.map((i) => {
    const nodeId = whereToNodeId(i.where, nodeIds)
    if (nodeId) {
      const node = nodes.find((n) => n.id === nodeId)
      if (node && (!node.issueLevel || LEVEL_RANK[i.level] > LEVEL_RANK[node.issueLevel])) {
        node.issueLevel = i.level
      }
      return nodeId === i.where ? i : { ...i, where: nodeId }
    }
    return i.where === 'package' ? i : { ...i, where: 'package' }
  })

  /* S4 运行命中高亮 */
  if (input.runHitRuleIds) {
    const hits = new Set(input.runHitRuleIds)
    for (const n of nodes) {
      if ((n.kind === 'scoreRule' || n.kind === 'exclusionRule') && hits.has(n.id)) n.runHit = true
    }
  }

  return {
    package: pkg.meta.name,
    version: pkg.meta.version,
    status: pkg.meta.status,
    nodes,
    edges,
    issues: graphIssues,
    revision: input.revision ?? 0,
    ...(input.skeleton
      ? { skeleton: { confirmed: input.skeleton.confirmed, ids: input.skeleton.ids } }
      : {}),
  }
}
