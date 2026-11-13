/** 子图扩展验收（subgraph-expansion S3.1 / S5 A-3）：BFS、环、方向、类型过滤、诱导子图、truncated、种子缺失。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { expandEntity, runScenario } from '../dist/index.js'
import { copyExamplePackage, exampleData, rmWorkspace } from './helpers.mjs'

const aml = () => exampleData('aml-run.json')

test('1 跳扩展：AML 从 CUST-001 出发，邻域闭包恰为对象/边/行为/候选', () => {
  const r = expandEntity(aml(), ['CUST-001'], { hops: 1 })
  assert.deepEqual(r.seedIds, ['CUST-001'])
  assert.deepEqual(r.missingSeedIds, [])
  assert.deepEqual(r.dataset.objects.map((o) => o.id).sort(), ['ACCT-001', 'CUST-001'])
  assert.deepEqual(r.dataset.relations.map((x) => x.id), ['R-001'])
  // R-002 端点 TXN-001 不在邻域 → 不入（诱导子图杜绝悬空）
  assert.ok(!r.dataset.relations.some((x) => x.id === 'R-002'))
  assert.deepEqual(r.dataset.behaviors.map((b) => b.id), ['B-001'])
  assert.deepEqual(r.dataset.candidates.map((c) => c.candidateId).sort(), ['CAND-001', 'CAND-003'])
  assert.equal(r.stats.seeds, 1)
  assert.equal(r.stats.objects, 2)
  assert.equal(r.stats.relations, 1)
  assert.equal(r.stats.candidates, 2)
  // ACCT-001 经 R-002 还有外沿（TXN-001）→ 触及 1 跳上限必须置位
  assert.equal(r.truncated, true)
})

test('1 跳 from ACCT-001：1 跳内全覆盖，truncated=false', () => {
  const r = expandEntity(aml(), ['ACCT-001'], { hops: 1 })
  assert.deepEqual(r.dataset.objects.map((o) => o.id).sort(), ['ACCT-001', 'CUST-001', 'TXN-001'])
  assert.deepEqual(r.dataset.relations.map((x) => x.id).sort(), ['R-001', 'R-002'])
  assert.equal(r.truncated, false, '邻域已在 1 跳内闭合，ACCT-002 孤立不构成外沿')
  // ACCT-002 不可达（无关系边）→ 不入
  assert.ok(!r.dataset.objects.some((o) => o.id === 'ACCT-002'))
})

test('2 跳扩展：TXN-001 纳入、候选/行为随邻域过滤', () => {
  const r = expandEntity(aml(), ['CUST-001'], { hops: 2 })
  assert.deepEqual(r.dataset.objects.map((o) => o.id).sort(), ['ACCT-001', 'CUST-001', 'TXN-001'])
  assert.deepEqual(r.dataset.relations.map((x) => x.id).sort(), ['R-001', 'R-002'])
  assert.deepEqual(r.dataset.behaviors.map((b) => b.id), ['B-001'])
  assert.deepEqual(r.dataset.candidates.map((c) => c.candidateId).sort(), ['CAND-001', 'CAND-003'])
  assert.equal(r.truncated, false)
  assert.equal(r.stats.objects, 3)
})

test('环数据：visited 防环不无限循环；truncated 语义按 hops 上限置位', () => {
  const cyclic = {
    objects: ['A', 'B', 'C'].map((id) => ({ id, type: 'OBJ-TST-A', attrs: {} })),
    relations: [
      { id: 'R1', type: 'REL-TST-AB', from: 'A', to: 'B' },
      { id: 'R2', type: 'REL-TST-AB', from: 'B', to: 'C' },
      { id: 'R3', type: 'REL-TST-AB', from: 'C', to: 'A' },
    ],
    candidates: [],
  }
  // out 方向链式推进：A→B 一跳，B→C 构成外沿
  const one = expandEntity(cyclic, ['A'], { hops: 1, direction: 'out' })
  assert.deepEqual(one.dataset.objects.map((o) => o.id), ['A', 'B'])
  assert.deepEqual(one.dataset.relations.map((x) => x.id), ['R1'])
  assert.equal(one.truncated, true, 'B 仍有未访问外沿 C')
  const two = expandEntity(cyclic, ['A'], { hops: 2, direction: 'out' })
  assert.deepEqual(two.dataset.objects.map((o) => o.id).sort(), ['A', 'B', 'C'])
  assert.equal(two.truncated, false, 'C 的外沿仅指向已访问 A')
  // 诱导子图：三端都在邻域 → 三条边全收（含回边 R3）
  assert.deepEqual(two.dataset.relations.map((x) => x.id).sort(), ['R1', 'R2', 'R3'])
  const three = expandEntity(cyclic, ['A'], { hops: 3, direction: 'out' })
  assert.deepEqual(three.dataset.objects.map((o) => o.id).sort(), ['A', 'B', 'C'])
  assert.equal(three.truncated, false)
  // both 方向：三角互达，1 跳即全覆盖且不因环死循环
  const both = expandEntity(cyclic, ['A'], { hops: 1 })
  assert.deepEqual(both.dataset.objects.map((o) => o.id).sort(), ['A', 'B', 'C'])
  assert.equal(both.truncated, false)
})

test('direction：out 只走 from→to，in 只走 to→from，both 双向', () => {
  // out from ACCT-001：R-001/R-002 的 from 都不是它 → 无邻居
  const out = expandEntity(aml(), ['ACCT-001'], { hops: 1, direction: 'out' })
  assert.deepEqual(out.dataset.objects.map((o) => o.id), ['ACCT-001'])
  assert.equal(out.truncated, false)
  // in to ACCT-001：CUST-001（R-001）与 TXN-001（R-002）都是入边来源
  const inn = expandEntity(aml(), ['ACCT-001'], { hops: 1, direction: 'in' })
  assert.deepEqual(inn.dataset.objects.map((o) => o.id).sort(), ['ACCT-001', 'CUST-001', 'TXN-001'])
  // out from CUST-001：R-001 出边 → ACCT-001；ACCT-001 无出边（R-002 是 TXN→ACCT）
  const out2 = expandEntity(aml(), ['CUST-001'], { hops: 1, direction: 'out' })
  assert.deepEqual(out2.dataset.objects.map((o) => o.id).sort(), ['ACCT-001', 'CUST-001'])
  assert.equal(out2.truncated, false, 'ACCT-001 无出边，out 方向无外沿')
  // out 方向 truncated：链 A→B→C，1 跳从 A 触及上限仍有外沿
  const chain = {
    objects: ['A', 'B', 'C'].map((id) => ({ id, type: 'OBJ-TST-A', attrs: {} })),
    relations: [
      { id: 'R1', type: 'REL-TST-AB', from: 'A', to: 'B' },
      { id: 'R2', type: 'REL-TST-AB', from: 'B', to: 'C' },
    ],
    candidates: [],
  }
  const outChain = expandEntity(chain, ['A'], { hops: 1, direction: 'out' })
  assert.deepEqual(outChain.dataset.objects.map((o) => o.id), ['A', 'B'])
  assert.equal(outChain.truncated, true)
})

test('relationTypes：只沿匹配类型行走；输出仍为邻域诱导子图（不裁剪既有边）', () => {
  // 只走 HOLDS：ACCT-001 ↔ CUST-001，TXN-001 不可达
  const r = expandEntity(aml(), ['ACCT-001'], { hops: 1, relationTypes: ['REL-AML-HOLDS'] })
  assert.deepEqual(r.dataset.objects.map((o) => o.id).sort(), ['ACCT-001', 'CUST-001'])
  assert.deepEqual(r.dataset.relations.map((x) => x.id), ['R-001'])
  // 双类型端点闭包：过滤只约束行走，邻域内既有边全收
  const dual = {
    objects: [
      { id: 'A', type: 'OBJ-TST-A', attrs: {} },
      { id: 'B', type: 'OBJ-TST-B', attrs: {} },
    ],
    relations: [
      { id: 'RX', type: 'REL-TST-AB', from: 'A', to: 'B' },
      { id: 'RY', type: 'REL-OTHER', from: 'A', to: 'B' },
    ],
    candidates: [],
  }
  const f = expandEntity(dual, ['A'], { hops: 1, relationTypes: ['REL-TST-AB'] })
  assert.deepEqual(f.dataset.objects.map((o) => o.id).sort(), ['A', 'B'])
  assert.deepEqual(f.dataset.relations.map((x) => x.id).sort(), ['RX', 'RY'])
  assert.equal(f.truncated, false)
})

test('种子缺失：部分命中单列 missingSeedIds；全部缺失空邻域不抛错', () => {
  const part = expandEntity(aml(), ['CUST-001', 'NOPE-1'], { hops: 1 })
  assert.deepEqual(part.seedIds, ['CUST-001'])
  assert.deepEqual(part.missingSeedIds, ['NOPE-1'])
  assert.equal(part.stats.seeds, 1)
  const none = expandEntity(aml(), ['NOPE-1', 'NOPE-2'], { hops: 1 })
  assert.deepEqual(none.seedIds, [])
  assert.deepEqual(none.missingSeedIds, ['NOPE-1', 'NOPE-2'])
  assert.equal(none.stats.seeds, 0)
  assert.equal(none.stats.objects, 0)
  assert.deepEqual(none.dataset.objects, [])
  assert.deepEqual(none.dataset.relations, [])
  assert.deepEqual(none.dataset.candidates, [])
  assert.equal(none.truncated, false)
  // 重复种子去重且保序
  const dup = expandEntity(aml(), ['CUST-001', 'CUST-001', 'ACCT-001'], { hops: 0 })
  assert.deepEqual(dup.seedIds, ['CUST-001', 'ACCT-001'])
})

test('hops=0：仅种子入邻域；种子有外沿则 truncated 置位', () => {
  const r = expandEntity(aml(), ['CUST-001'], { hops: 0 })
  assert.deepEqual(r.dataset.objects.map((o) => o.id), ['CUST-001'])
  assert.deepEqual(r.dataset.relations, [])
  assert.deepEqual(r.dataset.candidates, [])
  assert.equal(r.truncated, true, '种子经 R-001 仍有外沿 ACCT-001')
})

test('includeBehaviors=false：行为不入；候选仍按 objectRef 命中邻域', () => {
  const r = expandEntity(aml(), ['ACCT-001'], { hops: 1, includeBehaviors: false })
  assert.deepEqual(r.dataset.behaviors, [])
  assert.deepEqual(r.dataset.candidates.map((c) => c.candidateId).sort(), ['CAND-001', 'CAND-003'])
  const withB = expandEntity(aml(), ['ACCT-001'], { hops: 1 })
  assert.deepEqual(withB.dataset.behaviors.map((b) => b.id), ['B-001'])
})

test('确定性：同输入两次 expand 结果逐字节一致', () => {
  const input = aml()
  const a = JSON.stringify(expandEntity(input, ['CUST-001'], { hops: 2 }))
  const b = JSON.stringify(expandEntity(input, ['CUST-001'], { hops: 2 }))
  assert.equal(a, b)
  // 入参不被改写（纯函数）
  const before = JSON.stringify(input)
  expandEntity(input, ['CUST-001'], { hops: 2 })
  assert.equal(JSON.stringify(input), before)
})

test('验收 S2.1：AML 1 跳扩展子 dataset 直接 run_scenario——ingest 零 problem、人审字段齐全', () => {
  const { dir, root } = copyExamplePackage('aml')
  try {
    const expanded = expandEntity(exampleData('aml-run.json'), ['ACCT-001'], { hops: 1 })
    const result = runScenario(dir, 'SCN-AML-FIND-CLUES', expanded.dataset)
    assert.equal(result.humanReviewRequired, true)
    assert.ok(result.candidates.length >= 1, '子 dataset 候选应存活')
    for (const c of result.candidates) {
      assert.ok(
        !c.pendingChecks.some((p) => p.note.includes('数据归一问题')),
        `ingest 应零 problem: ${JSON.stringify(c.pendingChecks)}`,
      )
    }
    assert.equal(result.audit.forbiddenPhraseHits.length, 0)
    // 命中规则可回指 + 证据链非空（打分在子 dataset 上正常工作）
    const hot = result.candidates.find((c) => c.candidateId === 'CAND-001')
    assert.ok(hot, 'CAND-001（ACCT-001）应在邻域内')
    assert.ok(hot.riskScore > 0)
    assert.ok(hot.evidenceChains.length >= 1)
  } finally {
    rmWorkspace(root)
  }
})
