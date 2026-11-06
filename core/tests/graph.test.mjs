/** 对话式建模验收（conversational-modeling P3/P4；不变量 I1/I2/I3/I6）。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  KnowledgeStore,
  buildModelGraph,
  whereToNodeId,
  validateDraftItem,
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

test('skeleton 门：Attribute 不新增 ID，按 owner ID 段校验（I6 口径）', () => {
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    const store = new KnowledgeStore(root)
    const mkAttr = (name) => {
      const c = store.addDraft({
        packageId: 'test-pkg',
        item: {
          layer: 'O1',
          targetKind: 'Attribute',
          name,
          payload: { ownerId: 'OBJ-TST-A', name, type: 'string' },
          confidence: 0.9,
        },
        provenance: { turnId: 't-attr' },
      })
      store.reviewCandidate(c.id, 'approve')
      return c
    }

    // owner 在骨架内 → 物化为 'OBJ.attr' 属性引用（不新增 ID），按 ID 段通过
    store.skeletons.save({ packageId: 'test-pkg', domainCode: 'TST', confirmed: true, ids: fullIds() })
    const c1 = mkAttr('a3')
    const r1 = store.materialize(dir, [c1.id])
    assert.deepEqual(r1.applied, [c1.id])
    const merged = store.listCandidates({ packageId: 'test-pkg' }).find((x) => x.id === c1.id)
    assert.equal(merged.appliedAs, 'OBJ-TST-A.a3')
    assert.ok(
      loadPackage(dir).objects.find((o) => o.id === 'OBJ-TST-A').attributes.some((a) => a.name === 'a3'),
      '属性已进包',
    )

    // owner 不在骨架内 → 拒（ID 段超骨架）
    store.skeletons.save({
      packageId: 'test-pkg',
      domainCode: 'TST',
      confirmed: true,
      ids: fullIds().filter((id) => id !== 'OBJ-TST-A'),
    })
    const c2 = mkAttr('a4')
    const r2 = store.materialize(dir, [c2.id])
    assert.equal(r2.applied.length, 0)
    assert.match(r2.skipped[0].reason, /OBJ-TST-A 不在骨架内/)
  } finally {
    rmWorkspace(root)
  }
})

test('人审留痕：reviewCandidate 落 reviewedBy/reviewedAt 并随队列持久化', () => {
  const { root } = mkWorkspaceWithPkg()
  try {
    const store = new KnowledgeStore(root)
    const c = store.addDraft({
      packageId: 'test-pkg',
      item: { layer: 'O1', targetKind: 'ObjectType', name: '留痕对象', payload: { id: 'OBJ-TST-NEW', attributes: [] }, confidence: 0.9 },
      provenance: { turnId: 't-audit' },
    })
    const done = store.reviewCandidate(c.id, 'reject', { reviewedBy: 'agent-tool' })
    assert.equal(done.reviewedBy, 'agent-tool')
    assert.ok(typeof done.reviewedAt === 'string' && done.reviewedAt !== '', 'reviewedAt 有值')
    const reloaded = store.getCandidate(c.id)
    assert.equal(reloaded.reviewedBy, 'agent-tool')
    assert.equal(reloaded.reviewedAt, done.reviewedAt)
  } finally {
    rmWorkspace(root)
  }
})

test('草案引用边只从语义字段抽取（自由文本不连边，防假阳性）', () => {
  const { root, pkg } = mkWorkspaceWithPkg()
  try {
    const store = new KnowledgeStore(root)
    // name/description 自由文本里出现 ID 字面 → 不连边
    const cFree = store.addDraft({
      packageId: 'test-pkg',
      item: {
        layer: 'O1',
        targetKind: 'ObjectType',
        name: '提及 OBJ-TST-A 的文本',
        payload: { name: '提及 OBJ-TST-A 的文本', description: '参考 OBJ-TST-B', attributes: [] },
        confidence: 0.9,
      },
      provenance: { turnId: 't-free' },
    })
    // anchor 引用位 → 连边
    const cAnchor = store.addDraft({
      packageId: 'test-pkg',
      item: {
        layer: 'O1',
        targetKind: 'BehaviorType',
        name: '新行为',
        payload: { name: '新行为', anchor: 'OBJ-TST-A' },
        confidence: 0.9,
      },
      provenance: { turnId: 't-anchor' },
    })
    const g = buildModelGraph({ pkg, candidates: store.listCandidates({ packageId: 'test-pkg' }) })
    assert.ok(!g.edges.some((e) => e.from === cFree.id), '自由文本里的 ID 字面不连边')
    assert.ok(
      g.edges.some((e) => e.from === cAnchor.id && e.to === 'OBJ-TST-A' && e.kind === 'ref'),
      'anchor 引用位连边',
    )
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

    // I3：每条 issue 要么 where=package，要么 where 已归一为节点 ID；无孤立报错
    const nodeIds = new Set(g.nodes.map((n) => n.id))
    for (const i of g.issues) {
      const located = i.where === 'package' || nodeIds.has(i.where)
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

test('图谱结果无显式 undefined 键（工具面 lossless-JSON 契约）', () => {
  const { root, pkg } = mkWorkspaceWithPkg()
  try {
    // 手工候选：无 provenance、forcedReview=false/true 两种，覆盖可选字段缺省路径
    const g = buildModelGraph({
      pkg,
      candidates: [
        {
          id: 'dc-lo-1', packageId: 'test-pkg', sourceId: '', status: 'pending',
          layer: 'O1', targetKind: 'ObjectType', name: '甲草案', payload: {},
          confidence: 0.9, forcedReview: false, conclusionLike: false, createdAt: '',
        },
        {
          id: 'dc-lo-2', packageId: 'test-pkg', sourceId: 'src-1', status: 'pending',
          layer: 'O2', targetKind: 'ScoreRule', name: '乙草案', payload: {},
          confidence: 0.5, forcedReview: true, conclusionLike: false, createdAt: '',
        },
      ],
      // 无 skeleton / 无 revision → 覆盖返回对象可选字段路径
    })
    const undefinedKeys = []
    const walk = (v, path) => {
      if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`))
      if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          if (x === undefined) undefinedKeys.push(`${path}.${k}`)
          else walk(x, `${path}.${k}`)
        }
      }
    }
    walk(g, '$')
    assert.deepEqual(undefinedKeys, [], '不得有显式 undefined 键（harness lossless-JSON 拒绝）')
    const n1 = g.nodes.find((n) => n.id === 'dc-lo-1')
    const n2 = g.nodes.find((n) => n.id === 'dc-lo-2')
    assert.ok(!('forcedReview' in n1), 'forcedReview=false 不带键')
    assert.equal(n2.forcedReview, true, 'forcedReview=true 保留')
    assert.ok(!('provenance' in n1), '无溯源不带键')
    assert.deepEqual(n2.provenance, { sourceId: 'src-1' })
    assert.ok(!('skeleton' in g), '无骨架不带键')
  } finally {
    rmWorkspace(root)
  }
})

test('op=update：改权重联动归一 + 技能模板同权（P3）', () => {
  const { dir, root } = mkWorkspaceWithPkg({
    scoreRules: [
      { id: 'RULE-TST-A', name: '规则A', weight: 0.5, expression: '1' },
      { id: 'RULE-TST-B', name: '规则B', weight: 0.5, expression: '1' },
    ],
    skillTemplates: [
      { id: 'SKL-TST-N', name: '叙述', weights: { 'RULE-TST-A': 0.5, 'RULE-TST-B': 0.5 }, steps: [], outputTemplate: '' },
    ],
  })
  try {
    const store = new KnowledgeStore(root)
    const c = store.addDraft({
      packageId: 'test-pkg',
      item: {
        layer: 'O2', targetKind: 'ScoreRule', op: 'update', targetId: 'RULE-TST-A',
        name: '调整A权重', payload: { weight: 0.3 }, confidence: 0.9, rationale: '改权重',
      },
      provenance: { turnId: 't-w' },
    })
    store.reviewCandidate(c.id, 'approve')
    const r = store.materialize(dir, [c.id])
    assert.deepEqual(r.applied, [c.id])
    const merged = store.listCandidates({ packageId: 'test-pkg' }).find((x) => x.id === c.id)
    assert.equal(merged.appliedAs, 'RULE-TST-A', 'update 的 appliedAs = targetId')

    const after = loadPackage(dir)
    const a = after.scoreRules.find((x) => x.id === 'RULE-TST-A')
    const b = after.scoreRules.find((x) => x.id === 'RULE-TST-B')
    assert.equal(a.weight, 0.3, '显式权重为准')
    assert.ok(Math.abs(b.weight - 0.7) < 1e-9, `未动规则吸收残差，得 ${b.weight}`)
    // 技能模板同权（键集+数值）
    const w = after.skillTemplates[0].weights
    assert.deepEqual(Object.keys(w).sort(), ['RULE-TST-A', 'RULE-TST-B'])
    assert.ok(Math.abs(w['RULE-TST-A'] - 0.3) < 1e-9 && Math.abs(w['RULE-TST-B'] - 0.7) < 1e-9)
    // 终检无权重错误
    const v = validatePackage(after)
    assert.ok(!v.errors.some((e) => e.code === 'WEIGHT_SUM' || e.code === 'WEIGHT_SET_MISMATCH'))
  } finally {
    rmWorkspace(root)
  }
})

test('op=update：同批多条权重固定 → 未动规则吸收残差（批语义，供批量物化面）', () => {
  const { dir, root } = mkWorkspaceWithPkg({
    scoreRules: [
      { id: 'RULE-TST-A', name: '规则A', weight: 1 / 3, expression: '1' },
      { id: 'RULE-TST-B', name: '规则B', weight: 1 / 3, expression: '1' },
      { id: 'RULE-TST-C', name: '规则C', weight: 1 / 3, expression: '1' },
    ],
    skillTemplates: [
      {
        id: 'SKL-TST-N', name: '叙述', steps: [], outputTemplate: '',
        weights: { 'RULE-TST-A': 1 / 3, 'RULE-TST-B': 1 / 3, 'RULE-TST-C': 1 / 3 },
      },
    ],
  })
  try {
    const store = new KnowledgeStore(root)
    const mkUpd = (targetId, weight, name) => {
      const c = store.addDraft({
        packageId: 'test-pkg',
        item: { layer: 'O2', targetKind: 'ScoreRule', op: 'update', targetId, name, payload: { weight }, confidence: 0.9 },
        provenance: { turnId: 't-b' },
      })
      store.reviewCandidate(c.id, 'approve')
      return c.id
    }
    // 同批两条显式权重（A=0.5、C=0.1），B 吸收残差 0.4
    const r = store.materialize(dir, [mkUpd('RULE-TST-A', 0.5, 'A调0.5'), mkUpd('RULE-TST-C', 0.1, 'C调0.1')])
    assert.equal(r.applied.length, 2, JSON.stringify(r.skipped))
    const after = loadPackage(dir)
    const w = Object.fromEntries(after.scoreRules.map((x) => [x.id, x.weight]))
    assert.equal(w['RULE-TST-A'], 0.5)
    assert.equal(w['RULE-TST-C'], 0.1)
    assert.ok(Math.abs(w['RULE-TST-B'] - 0.4) < 1e-9, `B 吸收残差，得 ${w['RULE-TST-B']}`)
    const v = validatePackage(after)
    assert.ok(!v.errors.some((e) => e.code === 'WEIGHT_SUM' || e.code === 'WEIGHT_SET_MISMATCH'))
  } finally {
    rmWorkspace(root)
  }
})

test('op=update：标量覆盖、append 接线去重、阈值调整；目标不存在拒', () => {
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    const store = new KnowledgeStore(root)
    const upd = (item) => {
      const c = store.addDraft({ packageId: 'test-pkg', item, provenance: { turnId: 't-u' } })
      store.reviewCandidate(c.id, 'approve')
      return c
    }
    // 标量覆盖 + append 去重（已有的 REL-TST-AB 再追加不重复）
    upd({
      layer: 'O2', targetKind: 'BehaviorType', op: 'update', targetId: 'BHV-TST-X',
      name: '行为接线', payload: { trigger: '新开户', append: { relations: ['REL-TST-AB'] } },
      confidence: 0.9,
    })
    // 字典值追加（接线语义）
    upd({
      layer: 'O1', targetKind: 'Dictionary', op: 'update', targetId: 'dict-tst-k',
      name: '字典扩值', payload: { append: { values: ['z'] } }, confidence: 0.9,
    })
    // 阈值调整
    upd({
      layer: 'O2', targetKind: 'ScoreRule', op: 'update', targetId: 'RULE-TST-S1',
      name: '调阈值', payload: { threshold: 0.8 }, confidence: 0.9,
    })
    const r = store.materialize(dir, [
      ...store.listCandidates({ packageId: 'test-pkg' }).map((x) => x.id),
    ])
    assert.equal(r.applied.length, 3, JSON.stringify(r.skipped))
    const after = loadPackage(dir)
    const bhv = after.behaviors.find((x) => x.id === 'BHV-TST-X')
    assert.equal(bhv.trigger, '新开户')
    assert.deepEqual(bhv.relations, ['REL-TST-AB'], 'append 去重')
    assert.deepEqual(after.dictionaries[0].values, ['x', 'y', 'z'])
    assert.equal(after.scoreRules[0].threshold, 0.8)

    // 目标不存在 → 拒
    const missing = upd({
      layer: 'O2', targetKind: 'ScoreRule', op: 'update', targetId: 'RULE-TST-GONE',
      name: '改不存在', payload: { weight: 0.1 }, confidence: 0.9,
    })
    const r2 = store.materialize(dir, [missing.id])
    assert.equal(r2.applied.length, 0)
    assert.match(r2.skipped[0].reason, /元素不存在/)
  } finally {
    rmWorkspace(root)
  }
})

test('op=update：校验与幂等、图谱 targetId 引用边、骨架门口径、RedLine 拒 update', () => {
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    // 校验闸门
    assert.equal(
      validateDraftItem({ layer: 'O1', targetKind: 'ObjectType', op: 'update', name: 'x', payload: {}, confidence: 0.9 }),
      'update requires targetId',
    )
    assert.equal(
      validateDraftItem({ layer: 'O1', targetKind: 'ObjectType', op: 'nope', targetId: 'OBJ-TST-A', name: 'x', payload: {}, confidence: 0.9 }),
      'bad op',
    )

    const store = new KnowledgeStore(root)
    const mk = (name) => store.addDraft({
      packageId: 'test-pkg',
      item: { layer: 'O1', targetKind: 'ObjectType', op: 'update', targetId: 'OBJ-TST-A', name, payload: { idRule: '<c>:<a2>' }, confidence: 0.9 },
      provenance: { turnId: 't-i' },
    })
    const c1 = mk('改规则')
    const c2 = mk('改规则') // 同 targetId+name 幂等
    assert.equal(c1.id, c2.id)
    const c3 = mk('改规则二') // 不同 name 独立
    assert.notEqual(c1.id, c3.id)

    // 图谱：pending update 草案 → targetId 引用边
    const g = buildModelGraph({ pkg: loadPackage(dir), candidates: store.listCandidates({ packageId: 'test-pkg' }) })
    assert.ok(g.edges.some((e) => e.from === c1.id && e.to === 'OBJ-TST-A' && e.kind === 'ref'), 'targetId 连边')

    // 骨架门口径：targetId 在骨架内通过；元素存在但在骨架外 → I6 拒
    store.skeletons.save({ packageId: 'test-pkg', domainCode: 'TST', confirmed: true, ids: fullIds() })
    store.reviewCandidate(c1.id, 'approve')
    const ok = store.materialize(dir, [c1.id])
    assert.deepEqual(ok.applied, [c1.id])
    store.skeletons.save({
      packageId: 'test-pkg',
      domainCode: 'TST',
      confirmed: true,
      ids: fullIds().filter((id) => id !== 'RULE-TST-S1'),
    })
    const oos = store.addDraft({
      packageId: 'test-pkg',
      item: { layer: 'O2', targetKind: 'ScoreRule', op: 'update', targetId: 'RULE-TST-S1', name: '改骨架外', payload: { weight: 0.1 }, confidence: 0.9 },
      provenance: { turnId: 't-i' },
    })
    store.reviewCandidate(oos.id, 'approve')
    const bad = store.materialize(dir, [oos.id])
    assert.equal(bad.applied.length, 0)
    assert.match(bad.skipped[0].reason, /RULE-TST-S1 不在骨架内/)

    // RedLine 拒 update
    const rl = store.addDraft({
      packageId: 'test-pkg',
      item: { layer: 'O3', targetKind: 'RedLine', op: 'update', targetId: 'SCN-TST-1', name: '红线改', payload: { phrases: ['认定'] }, confidence: 0.9 },
      provenance: { turnId: 't-i' },
    })
    store.reviewCandidate(rl.id, 'approve')
    const r3 = store.materialize(dir, [rl.id])
    assert.equal(r3.applied.length, 0)
    assert.match(r3.skipped[0].reason, /RedLine 只支持追加/)
  } finally {
    rmWorkspace(root)
  }
})

test('v1.1 引用位：场景卡 create/update 携带 behaviorRefs/exclusionRefs', () => {
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    const store = new KnowledgeStore(root)
    // update：给既有场景补引用位
    const u = store.addDraft({
      packageId: 'test-pkg',
      item: {
        layer: 'O3', targetKind: 'ScenarioCard', op: 'update', targetId: 'SCN-TST-1',
        name: '场景接线', payload: { behaviorRefs: ['BHV-TST-X'], exclusionRefs: ['RULE-TST-E1'] },
        confidence: 0.9,
      },
      provenance: { turnId: 't-refs' },
    })
    store.reviewCandidate(u.id, 'approve')
    const r = store.materialize(dir, [u.id])
    assert.deepEqual(r.applied, [u.id], JSON.stringify(r.skipped))

    // create：新场景带引用位
    const c = store.addDraft({
      packageId: 'test-pkg',
      item: {
        layer: 'O3', targetKind: 'ScenarioCard', name: '新场景',
        payload: {
          id: 'SCN-TST-2', name: '新场景', goal: 'g', boundary: 'b',
          behaviorRefs: ['BHV-TST-X'], exclusionRefs: ['RULE-TST-E1'],
        },
        confidence: 0.9,
      },
      provenance: { turnId: 't-refs' },
    })
    store.reviewCandidate(c.id, 'approve')
    const r2 = store.materialize(dir, [c.id])
    assert.deepEqual(r2.applied, [c.id], JSON.stringify(r2.skipped))

    const after = loadPackage(dir)
    const s1 = after.scenarios.find((x) => x.id === 'SCN-TST-1')
    assert.deepEqual(s1.behaviorRefs, ['BHV-TST-X'], 'update 携带引用位')
    const s2 = after.scenarios.find((x) => x.id === 'SCN-TST-2')
    assert.deepEqual(s2.behaviorRefs, ['BHV-TST-X'])
    assert.deepEqual(s2.exclusionRefs, ['RULE-TST-E1'], 'create 携带引用位')
  } finally {
    rmWorkspace(root)
  }
})

test('D9：update 白名单外字段 fail-loud；顶层 mustInclude 归一进 outputContract（create/update 同源）', () => {
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    const store = new KnowledgeStore(root)
    // 1) 白名单外字段：起草即拒（不再静默入队、物化假 merged）
    assert.throws(
      () => store.addDraft({
        packageId: 'test-pkg',
        item: { layer: 'O3', targetKind: 'ScenarioCard', op: 'update', targetId: 'SCN-TST-1',
          name: '坏字段', payload: { mustInclude: ['x'], bogusField: 1 }, confidence: 0.9 },
        provenance: { turnId: 't-d9' },
      }),
      (e) => /not updatable/.test(e.message) && e.code === 'BAD_DRAFT',
      '顶层 mustInclude 合法归一、bogusField 必须报 not updatable',
    )
    // 纯白名单外字段同样拒
    assert.throws(
      () => store.addDraft({
        packageId: 'test-pkg',
        item: { layer: 'O3', targetKind: 'ScenarioCard', op: 'update', targetId: 'SCN-TST-1',
          name: '坏字段2', payload: { totallyWrong: true }, confidence: 0.9 },
        provenance: { turnId: 't-d9' },
      }),
      /not updatable/,
    )
    // append 白名单外字段同样拒
    assert.throws(
      () => store.addDraft({
        packageId: 'test-pkg',
        item: { layer: 'O2', targetKind: 'BehaviorType', op: 'update', targetId: 'BHV-TST-X',
          name: '坏接线', payload: { append: { notAField: ['x'] } }, confidence: 0.9 },
        provenance: { turnId: 't-d9' },
      }),
      /not updatable/,
    )

    // 2) 顶层 mustInclude 与 create 同源：归一进 outputContract.mustInclude
    const ok = store.addDraft({
      packageId: 'test-pkg',
      item: { layer: 'O3', targetKind: 'ScenarioCard', op: 'update', targetId: 'SCN-TST-1',
        name: '契约收敛', payload: { mustInclude: ['candidateList', 'riskScore'] }, confidence: 0.9 },
      provenance: { turnId: 't-d9' },
    })
    store.reviewCandidate(ok.id, 'approve')
    const r = store.materialize(dir, [ok.id])
    assert.deepEqual(r.applied, [ok.id], JSON.stringify(r.skipped))
    const after = loadPackage(dir)
    const s = after.scenarios.find((x) => x.id === 'SCN-TST-1')
    assert.deepEqual(s.outputContract.mustInclude, ['candidateList', 'riskScore'], '顶层 mustInclude 生效')
  } finally {
    rmWorkspace(root)
  }
})

test('D6：驳回后同名可重新起草（恢复路径）；pending/merged 仍幂等', () => {
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    const store = new KnowledgeStore(root)
    const item = {
      layer: 'O1', targetKind: 'ObjectType', name: '重试对象',
      payload: { id: 'OBJ-TST-RETRY', attributes: [] }, confidence: 0.9,
    }
    const c1 = store.addDraft({ packageId: 'test-pkg', item, provenance: { turnId: 't-1' } })
    // pending 幂等：同名返回同一条
    const again = store.addDraft({ packageId: 'test-pkg', item, provenance: { turnId: 't-2' } })
    assert.equal(again.id, c1.id, 'pending 仍幂等')

    // 驳回
    store.reviewCandidate(c1.id, 'reject')
    assert.equal(store.getCandidate(c1.id).status, 'rejected')

    // 驳回后同名重起草 → 新草案（不再被 rejected 记录吞掉）
    const c2 = store.addDraft({ packageId: 'test-pkg', item, provenance: { turnId: 't-3' } })
    assert.notEqual(c2.id, c1.id, '驳回后同名必须产生新候选 ID')
    assert.equal(c2.status, 'pending')

    // 重试草案自身幂等
    const again2 = store.addDraft({ packageId: 'test-pkg', item, provenance: { turnId: 't-4' } })
    assert.equal(again2.id, c2.id)

    // 重试草案可正常物化
    store.reviewCandidate(c2.id, 'approve')
    const r = store.materialize(dir, [c2.id])
    assert.deepEqual(r.applied, [c2.id], JSON.stringify(r.skipped))
    const after = loadPackage(dir)
    assert.ok(after.objects.some((o) => o.id === 'OBJ-TST-RETRY'))
  } finally {
    rmWorkspace(root)
  }
})

test('scoreRefs：场景卡 create/update 携带并持久化（UPDATABLE 白名单含 scoreRefs）', () => {
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    const store = new KnowledgeStore(root)
    // update：给既有场景补 scoreRefs（走白名单，不得被 D9 拦）
    const u = store.addDraft({
      packageId: 'test-pkg',
      item: {
        layer: 'O3', targetKind: 'ScenarioCard', op: 'update', targetId: 'SCN-TST-1',
        name: '场景打分圈定', payload: { scoreRefs: ['RULE-TST-S1'] }, confidence: 0.9,
      },
      provenance: { turnId: 't-sr' },
    })
    store.reviewCandidate(u.id, 'approve')
    const r = store.materialize(dir, [u.id])
    assert.deepEqual(r.applied, [u.id], JSON.stringify(r.skipped))
    let after = loadPackage(dir)
    assert.deepEqual(after.scenarios[0].scoreRefs, ['RULE-TST-S1'])

    // create：新场景携带 scoreRefs
    const c = store.addDraft({
      packageId: 'test-pkg',
      item: {
        layer: 'O3', targetKind: 'ScenarioCard', name: '新场景带圈',
        payload: { id: 'SCN-TST-2', name: '新场景带圈', goal: 'g', boundary: 'b', scoreRefs: ['RULE-TST-S1'] },
        confidence: 0.9,
      },
      provenance: { turnId: 't-sr' },
    })
    store.reviewCandidate(c.id, 'approve')
    const r2 = store.materialize(dir, [c.id])
    assert.deepEqual(r2.applied, [c.id], JSON.stringify(r2.skipped))
    after = loadPackage(dir)
    assert.deepEqual(after.scenarios.find((s) => s.id === 'SCN-TST-2').scoreRefs, ['RULE-TST-S1'])
  } finally {
    rmWorkspace(root)
  }
})
