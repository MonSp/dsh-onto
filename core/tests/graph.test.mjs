/** 对话式建模验收（conversational-modeling P3/P4；不变量 I1/I2/I3/I6）。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  KnowledgeStore,
  buildModelGraph,
  whereToNodeId,
  validatePackage,
  derivePackage,
  loadPackage,
  heuristicParse,
} from '../dist/index.js'
import { minimalPkg, mkWorkspaceWithPkg, rmWorkspace, copyExamplePackage } from './helpers.mjs'

function fullIds() {
  return [
    'OBJ-TST-A', 'OBJ-TST-B', 'REL-TST-AB', 'dict-tst-k', 'BHV-TST-X',
    'RULE-TST-S1', 'RULE-TST-E1', 'SKL-TST-N', 'SCN-TST-1', 'FM-TST-1', 'SRC-TST-1',
  ]
}

test('addDraft：草案只入队列不写包，带 provenance，幂等（I1）', () => {
  const { dir, root, pkg } = mkWorkspaceWithPkg()
  try {
    const store = new KnowledgeStore(root)
    const item = {
      layer: 'O1',
      targetKind: 'ObjectType',
      name: '新对象',
      payload: { id: 'OBJ-TST-NEW', attributes: [] },
      confidence: 0.9,
    }
    const c = store.addDraft({ packageId: 'test-pkg', item, provenance: { turnId: 'turn-1' } })
    assert.equal(c.status, 'pending')
    assert.equal(c.provenance.turnId, 'turn-1')
    assert.equal(c.forcedReview, false)

    // I1：包未被触碰
    const after = loadPackage(dir)
    assert.equal(after.objects.length, pkg.objects.length)

    // 幂等：同 packageId|layer|targetKind|name 返回同一草案
    const again = store.addDraft({ packageId: 'test-pkg', item, provenance: { turnId: 'turn-2' } })
    assert.equal(again.id, c.id)

    // 置信度 < 0.75 → 强制人审
    const low = store.addDraft({
      packageId: 'test-pkg',
      item: { ...item, name: '低置信', confidence: 0.5 },
      provenance: { turnId: 'turn-3' },
    })
    assert.equal(low.forcedReview, true)

    // 非法草案拒绝
    assert.throws(
      () => store.addDraft({ packageId: 'test-pkg', item: { layer: 'O9', targetKind: 'ObjectType', name: 'x', payload: {}, confidence: 0.9 } }),
      /draft invalid/,
    )
  } finally {
    rmWorkspace(root)
  }
})

test('批准物化：appliedAs 落盘 + 画布溯源回连（I2）', () => {
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    const store = new KnowledgeStore(root)
    const c = store.addDraft({
      packageId: 'test-pkg',
      item: {
        layer: 'O1',
        targetKind: 'ObjectType',
        name: '新对象',
        payload: { id: 'OBJ-TST-NEW', attributes: [] },
        confidence: 0.9,
      },
      provenance: { turnId: 'turn-7' },
    })
    store.reviewCandidate(c.id, 'approve')
    const res = store.materialize(dir, [c.id])
    assert.deepEqual(res.applied, [c.id])

    const after = loadPackage(dir)
    assert.ok(after.objects.some((o) => o.id === 'OBJ-TST-NEW'), '物化后包内出现元素')

    const merged = store.listCandidates({ packageId: 'test-pkg' }).find((x) => x.id === c.id)
    assert.equal(merged.status, 'merged')
    assert.equal(merged.appliedAs, 'OBJ-TST-NEW')

    // 画布：物化节点携带 provenance（经 appliedAs 回连）
    const g = buildModelGraph({ pkg: after, candidates: store.listCandidates({ packageId: 'test-pkg' }) })
    const node = g.nodes.find((n) => n.id === 'OBJ-TST-NEW')
    assert.ok(node, '图上出现物化节点')
    assert.equal(node.draft, false)
    assert.equal(node.provenance.turnId, 'turn-7')
  } finally {
    rmWorkspace(root)
  }
})

test('skeleton 门：未确认全拒；骨架外 ID 拒且回滚；骨架内通过（I6）', () => {
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    const store = new KnowledgeStore(root)
    const mkDraft = (payload, name) =>
      store.addDraft({
        packageId: 'test-pkg',
        item: { layer: 'O1', targetKind: 'ObjectType', name, payload, confidence: 0.9 },
        provenance: { turnId: 't' },
      })

    // 未确认 → 全部拒物化
    store.skeletons.save({ packageId: 'test-pkg', domainCode: 'TST', confirmed: false, ids: fullIds() })
    const c1 = mkDraft({ id: 'OBJ-TST-NEW' }, '对象一')
    store.reviewCandidate(c1.id, 'approve')
    const r1 = store.materialize(dir, [c1.id])
    assert.equal(r1.applied.length, 0)
    assert.match(r1.skipped[0].reason, /skeleton 未确认/)

    // 确认后：显式 payload.id 超骨架 → 拒
    store.skeletons.save({ packageId: 'test-pkg', domainCode: 'TST', confirmed: true, ids: [...fullIds(), 'OBJ-TST-C'] })
    const r2 = store.materialize(dir, [c1.id])
    assert.equal(r2.applied.length, 0)
    assert.match(r2.skipped[0].reason, /OBJ-TST-NEW 不在骨架内/)

    // 自动分配 ID 超骨架 → 拒且不落盘（回滚）
    const c3 = mkDraft({ attributes: [] }, '自动ID对象')
    store.reviewCandidate(c3.id, 'approve')
    const r3 = store.materialize(dir, [c3.id])
    assert.equal(r3.applied.length, 0)
    assert.match(r3.skipped[0].reason, /不在骨架内/)
    const mid = loadPackage(dir)
    assert.ok(!mid.objects.some((o) => o.id === 'OBJ-TST-1'), '超界自动 ID 已回滚')

    // 骨架内显式 ID → 通过
    const c4 = mkDraft({ id: 'OBJ-TST-C' }, '骨架内对象')
    store.reviewCandidate(c4.id, 'approve')
    const r4 = store.materialize(dir, [c4.id])
    assert.deepEqual(r4.applied, [c4.id])
    assert.ok(loadPackage(dir).objects.some((o) => o.id === 'OBJ-TST-C'))
  } finally {
    rmWorkspace(root)
  }
})

test('skeleton 校验门：骨架外 ID → SKELETON_OUT_OF_SCOPE 且 where=元素 ID；无骨架不启用', () => {
  const { root, pkg } = mkWorkspaceWithPkg()
  try {
    const skeleton = {
      packageId: 'test-pkg',
      domainCode: 'TST',
      confirmed: true,
      ids: ['OBJ-TST-A', 'dict-tst-k'],
      updatedAt: new Date().toISOString(),
    }
    const { errors } = validatePackage(pkg, undefined, { skeleton })
    const oos = errors.filter((e) => e.code === 'SKELETON_OUT_OF_SCOPE')
    assert.ok(oos.length > 0, '骨架外 ID 报错')
    assert.ok(oos.some((e) => e.where === 'OBJ-TST-B'), 'where 直接是元素 ID')
    for (const e of oos) assert.ok(!skeleton.ids.includes(e.where))

    // 未提供骨架 → 不启用（既有管线兼容）
    const plain = validatePackage(pkg)
    assert.ok(!plain.errors.some((e) => e.code === 'SKELETON_OUT_OF_SCOPE'))
  } finally {
    rmWorkspace(root)
  }
})

test('图谱构建：节点/边齐备，issue 定位到节点或包级（I3）', () => {
  const { root, pkg } = mkWorkspaceWithPkg()
  try {
    // 引一个悬空关系，制造 REF_UNCLOSED
    const bad = {
      ...pkg,
      relations: [...pkg.relations, { id: 'REL-TST-X', name: '悬空', from: 'OBJ-TST-A', to: 'OBJ-TST-NOPE' }],
    }
    const { errors, warnings } = validatePackage(bad)
    const g = buildModelGraph({ pkg: bad, issues: [...errors, ...warnings] })

    // 节点
    for (const id of ['OBJ-TST-A', 'REL-TST-AB', 'dict-tst-k', 'BHV-TST-X', 'RULE-TST-S1', 'SKL-TST-N', 'SCN-TST-1']) {
      assert.ok(g.nodes.some((n) => n.id === id), `节点 ${id}`)
    }
    // 引用边
    assert.ok(g.edges.some((e) => e.from === 'REL-TST-AB' && e.to === 'OBJ-TST-A' && e.kind === 'relation'))
    assert.ok(g.edges.some((e) => e.from === 'BHV-TST-X' && e.to === 'OBJ-TST-A' && e.kind === 'anchor'))
    assert.ok(g.edges.some((e) => e.from === 'OBJ-TST-A' && e.to === 'dict-tst-k' && e.kind === 'dict'))
    assert.ok(g.edges.some((e) => e.from === 'SKL-TST-N' && e.to === 'RULE-TST-S1' && e.kind === 'skill-rule'))
    assert.ok(g.edges.some((e) => e.from === 'SCN-TST-1' && e.to === 'SKL-TST-N' && e.kind === 'scenario-step'))
    assert.ok(g.edges.some((e) => e.from === 'FM-TST-1' && e.to === 'OBJ-TST-A' && e.kind === 'applies'))

    // I3：每条 issue 要么 where=package，要么能定位到节点；无孤立报错
    const nodeIds = new Set(g.nodes.map((n) => n.id))
    for (const i of g.issues) {
      const located = i.where === 'package' || whereToNodeId(i.where, nodeIds) !== undefined
      assert.ok(located, `${i.code} where=${i.where} 未定位`)
    }
    // 悬空关系 issue → 节点标红
    const xNode = g.nodes.find((n) => n.id === 'REL-TST-X')
    assert.equal(xNode.issueLevel, 'error')
    assert.ok(
      g.issues.some((i) => i.code === 'REF_UNCLOSED' && whereToNodeId(i.where, nodeIds) === 'REL-TST-X'),
    )
  } finally {
    rmWorkspace(root)
  }
})

test('whereToNodeId：元素形态解析，文件路径与 package 归包级', () => {
  const ids = new Set(['OBJ-TST-A', 'RULE-TST-S1'])
  assert.equal(whereToNodeId('OBJ-TST-A', ids), 'OBJ-TST-A')
  assert.equal(whereToNodeId('OBJ OBJ-TST-A.a1', ids), 'OBJ-TST-A')
  assert.equal(whereToNodeId('RULE RULE-TST-S1', ids), 'RULE-TST-S1')
  assert.equal(whereToNodeId('o1-objects/object-types.yaml', ids), undefined)
  assert.equal(whereToNodeId('package', ids), undefined)
  assert.equal(whereToNodeId('OBJ OBJ-TST-GONE', ids), undefined)
})

test('草案虚线节点上图，pending/approved 画、merged 退出（I1）', () => {
  const { root, dir, pkg } = mkWorkspaceWithPkg()
  try {
    const store = new KnowledgeStore(root)
    const c = store.addDraft({
      packageId: 'test-pkg',
      item: { layer: 'O2', targetKind: 'ScoreRule', name: '新规则', payload: { weight: 0.3, expression: '1' }, confidence: 0.6 },
      provenance: { turnId: 'turn-9' },
    })
    const g = buildModelGraph({ pkg, candidates: store.listCandidates({ packageId: 'test-pkg' }) })
    const draftNode = g.nodes.find((n) => n.id === c.id)
    assert.ok(draftNode, 'pending 草案成虚线节点')
    assert.equal(draftNode.draft, true)
    assert.equal(draftNode.layer, 'O2')
    assert.equal(draftNode.forcedReview, true)
    assert.equal(draftNode.provenance.turnId, 'turn-9')

    // 批准但未物化：仍以虚线节点显示（还没进包，可继续物化）
    store.reviewCandidate(c.id, 'approve')
    const gApproved = buildModelGraph({ pkg, candidates: store.listCandidates({ packageId: 'test-pkg' }) })
    const approvedNode = gApproved.nodes.find((n) => n.id === c.id)
    assert.ok(approvedNode && approvedNode.draft === true, 'approved-未物化仍上图（虚线）')

    // 物化后：虚线退出，元素实线 + 溯源回连
    store.materialize(dir, [c.id])
    const gMerged = buildModelGraph({ pkg, candidates: store.listCandidates({ packageId: 'test-pkg' }) })
    assert.ok(!gMerged.nodes.some((n) => n.id === c.id), 'merged 草案不再以虚线节点出现')
  } finally {
    rmWorkspace(root)
  }
})

test('heuristicParse CONVERSATION：前缀/关键词路由成草案，置信度全部 ≤0.74（强制人审）', () => {
  const items = heuristicParse({
    sourceType: 'CONVERSATION',
    packageName: 'test-pkg',
    content: '对象：风控标签\n关系：账户-持有-客户\n打分规则：分散转入 权重0.3\n排除：白名单豁免 tag == salary\n场景：识别可疑交易\n认定洗钱',
  })
  const kinds = items.map((i) => i.targetKind)
  assert.ok(kinds.includes('ObjectType'), '对象前缀 → ObjectType')
  assert.ok(kinds.includes('RelationType'), '关系前缀 → RelationType')
  assert.ok(kinds.includes('ScoreRule'), '规则关键词 → ScoreRule')
  assert.ok(kinds.includes('ExclusionRule'), '排除关键词 → ExclusionRule')
  assert.ok(kinds.includes('ScenarioCard'), '场景前缀 → ScenarioCard')
  assert.ok(kinds.includes('RedLine'), '结论性表述 → RedLine')
  for (const i of items) {
    if (i.targetKind === 'RedLine') continue // 结论检测 0.85（近确定）；批准仍走人审
    assert.ok(i.confidence <= 0.74, `${i.name} 置信度须 ≤0.74（forcedReview）`)
  }
})

test('manifest 层标注：tool-contracts→L2 / agent-duties→L4 / skill-templates→L3 / bindings→L2（P4）', () => {
  const { dir, root } = copyExamplePackage('aml')
  try {
    const m = derivePackage(dir)
    const d = (p) => m.derived.find((e) => e.path.startsWith(p))
    assert.equal(d('derived/tool-contracts')?.layer, 'L2')
    assert.equal(d('derived/agent-duties')?.layer, 'L4')
    assert.equal(d('derived/audit-checks')?.layer, 'L4')
    assert.equal(d('derived/scenario-orchestration')?.layer, 'L4')
    assert.equal(d('derived/rule-engine-config')?.layer, undefined, '引擎配置不标 L 层')
    const s = (p) => m.sources.find((e) => e.path.startsWith(p))
    assert.equal(s('bindings/')?.layer, 'L2')
    assert.equal(s('o2-behavior-rules/skill-templates/')?.layer, 'L3')
    assert.equal(s('o1-objects/')?.layer, undefined, 'O 层源文件不标 L 层')
    // 指纹字段不受 layer 影响：重派生 sourceDigest 稳定
    const again = derivePackage(dir)
    assert.equal(again.sourceDigest, m.sourceDigest)
  } finally {
    rmWorkspace(root)
  }
})
