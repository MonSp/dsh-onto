/** 场景执行验收（规范 §9 / §11.3）：端到端全流程字段、ruleId 回指、禁语零命中。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runScenario, ScenarioRunError, derivePackage, savePackage, loadPackage, KnowledgeStore } from '../dist/index.js'
import { copyExamplePackage, exampleData, mkWorkspaceWithPkg, minimalPkg, rmWorkspace } from './helpers.mjs'


function confirmSkeleton(store, extraIds = []) {
  store.skeletons.save({
    packageId: 'test-pkg',
    domainCode: 'TST',
    confirmed: true,
    ids: [...new Set(['OBJ-TST-A', 'OBJ-TST-B', 'REL-TST-AB', 'dict-tst-k', 'BHV-TST-X', 'RULE-TST-S1', 'RULE-TST-E1', 'SKL-TST-N', 'SCN-TST-1', 'FM-TST-1', 'SRC-TST-1', ...extraIds])],
  })
}

test('端到端 AML：候选 + 风险分 + 命中规则 + 证据链 + 待核实点齐全', () => {
  const { dir, root } = copyExamplePackage('aml')
  try {
    const result = runScenario(dir, 'SCN-AML-FIND-CLUES', exampleData('aml-run.json'))
    assert.equal(result.humanReviewRequired, true)
    assert.ok(result.candidates.length >= 2)
    for (const c of result.candidates) {
      assert.equal(typeof c.riskScore, 'number')
      assert.ok(c.riskScore >= 0 && c.riskScore <= 1)
      assert.ok(Array.isArray(c.hitRuleIds))
      assert.ok(Array.isArray(c.evidenceChains))
      assert.ok(Array.isArray(c.pendingChecks))
    }
    // 高风险候选命中规则且证据链带回指 ruleId
    const hot = result.candidates.find((c) => c.candidateId === 'CAND-001')
    assert.ok(hot.riskScore >= 0.75)
    assert.equal(hot.hitRuleIds.length, 4)
    for (const e of hot.evidenceChains) {
      assert.ok(e.ruleId.startsWith('RULE-'))
      assert.ok(e.evidence.length > 0)
    }
    // 证据链的 ruleId 全部可回指 O2 规则
    const ruleIds = new Set(hot.hitRuleIds)
    for (const e of hot.evidenceChains) assert.ok(ruleIds.has(e.ruleId) || e.ruleId.startsWith('RULE-'))
  } finally {
    rmWorkspace(root)
  }
})

test('排除段：白名单 drop 剔除、代发工资 downweight 降权', () => {
  const { dir, root } = copyExamplePackage('aml')
  try {
    const result = runScenario(dir, 'SCN-AML-FIND-CLUES', exampleData('aml-run.json'))
    // CAND-003 tagged cleared-whitelist → dropped
    assert.deepEqual(result.excluded.map((x) => x.candidateId), ['CAND-003'])
    assert.equal(result.excluded[0].ruleId, 'RULE-AML-EXCL-WHITELIST')
    // CAND-002 tagged salary → downweight 0.3：分值应显著低于同比例原始分
    const salary = result.candidates.find((c) => c.candidateId === 'CAND-002')
    assert.ok(salary.riskScore < 0.1)
  } finally {
    rmWorkspace(root)
  }
})

test('缺失特征 → pendingVerification=true（待核实，不硬判）', () => {
  const { dir, root } = copyExamplePackage('aml')
  try {
    const result = runScenario(dir, 'SCN-AML-FIND-CLUES', exampleData('aml-run.json'))
    const c4 = result.candidates.find((c) => c.candidateId === 'CAND-004')
    assert.equal(c4.pendingVerification, true)
    assert.ok(c4.pendingChecks.some((p) => Array.isArray(p.missing) && p.missing.includes('fastInOutRatio')))
    // 缺失特征的规则不得硬判入 hitRuleIds
    assert.ok(!c4.hitRuleIds.includes('RULE-AML-SCORE-FASTFLOW'))
  } finally {
    rmWorkspace(root)
  }
})

test('输出契约：禁用表述零命中 + 三层闭合 + 人审门禁', () => {
  const { dir, root } = copyExamplePackage('aml')
  try {
    const result = runScenario(dir, 'SCN-AML-FIND-CLUES', exampleData('aml-run.json'))
    assert.equal(result.audit.forbiddenPhraseHits.length, 0)
    assert.equal(result.audit.passed, true)
    const checks = Object.fromEntries(result.audit.checks.map((c) => [c.check, c.closed]))
    assert.equal(checks['O1_CLOSED'], true)
    assert.equal(checks['O2_CLOSED'], true)
    assert.equal(checks['O3_CLOSED'], true)
    assert.equal(result.humanReviewRequired, true)
    assert.equal(result.reviewGate.required, true)
    assert.ok(result.reviewGate.requireReviewFor.includes('CAND-001'))
    // 审计链带时间戳可回放
    for (const c of result.audit.checks) assert.ok(c.ts)
    for (const h of result.ruleHitLog) assert.ok(h.ts)
  } finally {
    rmWorkspace(root)
  }
})

test('叙述不含认定；含模板证据', () => {
  const { dir, root } = copyExamplePackage('aml')
  try {
    const result = runScenario(dir, 'SCN-AML-FIND-CLUES', exampleData('aml-run.json'))
    const blob = JSON.stringify(result)
    for (const phrase of ['认定洗钱', '确定为地下钱庄', '已构成犯罪', '该客户系诈骗分子']) {
      assert.ok(!blob.includes(phrase), `forbidden phrase leaked: ${phrase}`)
    }
    const hot = result.candidates.find((c) => c.candidateId === 'CAND-001')
    assert.ok(hot.narrative.some((l) => l.includes('非认定')))
  } finally {
    rmWorkspace(root)
  }
})

test('未派生 / 派生物被改 → 运行拒绝加载（DERIVED_DRIFT）', () => {
  const { ws, dir, root } = mkWorkspaceWithPkg()
  try {
    assert.throws(
      () => runScenario(dir, 'SCN-TST-1', { objects: [], relations: [], candidates: [] }),
      (e) => e instanceof ScenarioRunError && e.code === 'DERIVED_DRIFT',
    )
  } finally {
    rmWorkspace(root)
  }
})

test('最小包场景：人工复核字段与 reviewGate 阈值生效', () => {
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    const pkg = minimalPkg()
    savePackage(dir, pkg)
    derivePackage(dir)
    const dataset = {
      objects: [
        { id: 'A1', type: 'OBJ-TST-A', attrs: { a1: 'x' } },
        { id: 'B1', type: 'OBJ-TST-B', attrs: { b1: 1 } },
      ],
      relations: [{ id: 'R1', type: 'REL-TST-AB', from: 'A1', to: 'B1' }],
      behaviors: [{ id: 'BV1', type: 'BHV-TST-X', anchorRef: 'A1', objectRef: 'A1', occurredAt: '2026-01-01T00:00:00Z' }],
      candidates: [{ candidateId: 'C1', objectRef: 'A1', features: { f1: 0.9 }, tags: [] }],
    }
    const result = runScenario(dir, 'SCN-TST-1', dataset)
    assert.equal(result.candidates.length, 1)
    assert.ok(result.candidates[0].hitRuleIds.includes('RULE-TST-S1'))
    assert.ok(result.reviewGate.requireReviewFor.includes('C1'))
    assert.equal(result.humanReviewRequired, true)
  } finally {
    rmWorkspace(root)
  }
})

test('D7：场景引用位参与运行收窄——exclusionRefs/behaviorRefs 生效，缺省=全部', () => {
  const base = minimalPkg()
  const { dir, root } = mkWorkspaceWithPkg({
    behaviors: [
      { id: 'BHV-TST-X', name: '行为X', anchor: 'OBJ-TST-A', relations: ['REL-TST-AB'] },
      { id: 'BHV-TST-Y', name: '行为Y', anchor: 'OBJ-TST-B', relations: [] },
    ],
    exclusionRules: [
      { id: 'RULE-TST-E1', name: '排除一', action: 'downweight', factor: 0.5, condition: "tag == 't'" },
      { id: 'RULE-TST-E2', name: '排除二', action: 'drop', condition: "tag == 'x'" },
    ],
    // 场景只圈定 E1 与行为 X——E2 与行为 Y 不在运行范围
    scenarios: [{ ...base.scenarios[0], behaviorRefs: ['BHV-TST-X'], exclusionRefs: ['RULE-TST-E1'] }],
  })
  try {
    savePackage(dir, minimalPkg({
      behaviors: [
        { id: 'BHV-TST-X', name: '行为X', anchor: 'OBJ-TST-A', relations: ['REL-TST-AB'] },
        { id: 'BHV-TST-Y', name: '行为Y', anchor: 'OBJ-TST-B', relations: [] },
      ],
      exclusionRules: [
        { id: 'RULE-TST-E1', name: '排除一', action: 'downweight', factor: 0.5, condition: "tag == 't'" },
        { id: 'RULE-TST-E2', name: '排除二', action: 'drop', condition: "tag == 'x'" },
      ],
      scenarios: [{ ...base.scenarios[0], behaviorRefs: ['BHV-TST-X'], exclusionRefs: ['RULE-TST-E1'] }],
    }))
    derivePackage(dir)
    const dataset = {
      objects: [
        { id: 'A1', type: 'OBJ-TST-A', attrs: { a1: 'x' } },
        { id: 'B1', type: 'OBJ-TST-B', attrs: { b1: 1 } },
      ],
      relations: [{ id: 'R1', type: 'REL-TST-AB', from: 'A1', to: 'B1' }],
      behaviors: [
        { id: 'BV1', type: 'BHV-TST-X', anchorRef: 'A1', objectRef: 'A1', occurredAt: '2026-01-01T00:00:00Z' },
        { id: 'BV2', type: 'BHV-TST-Y', anchorRef: 'B1', objectRef: 'B1', occurredAt: '2026-01-02T00:00:00Z' },
      ],
      candidates: [
        { candidateId: 'C1', objectRef: 'A1', features: { f1: 0.9 }, tags: ['x'] },
        { candidateId: 'C2', objectRef: 'B1', features: { f1: 0.6 }, tags: ['t'] },
      ],
    }
    const result = runScenario(dir, 'SCN-TST-1', dataset)
    // E2（tag=='x' drop）不在 exclusionRefs → 不得剔除 C1
    const ids = result.candidates.map((c) => c.candidateId)
    assert.ok(ids.includes('C1'), 'exclusionRefs 之外的排除规则不参与运行: ' + JSON.stringify(result.excluded))
    assert.ok(!result.excluded.some((x) => x.ruleId === 'RULE-TST-E2'))
    // E1（在圈内）照常生效：C2 tag=t → downweight
    const c2 = result.candidates.find((c) => c.candidateId === 'C2')
    assert.ok(c2.riskScore < 0.6 * 0.5 + 0.0001, '圈内排除仍生效, got ' + c2.riskScore)
    // behaviorRefs 只跑 X：BV2（类型 Y）不进行为实例——经 O2_CLOSED 审计明细观察
    const o2 = result.audit.checks.find((c) => c.check === 'O2_CLOSED')
    assert.match(o2.detail, /行为实例 1 条/, 'behaviorRefs 收窄行为实例: ' + o2.detail)
  } finally {
    rmWorkspace(root)
  }
})

test('D7：缺省引用位 = 全部（不落键时行为与排除不受限）', () => {
  const { dir, root } = mkWorkspaceWithPkg({
    behaviors: [
      { id: 'BHV-TST-X', name: '行为X', anchor: 'OBJ-TST-A', relations: ['REL-TST-AB'] },
      { id: 'BHV-TST-Y', name: '行为Y', anchor: 'OBJ-TST-B', relations: [] },
    ],
    exclusionRules: [
      { id: 'RULE-TST-E1', name: '排除一', action: 'downweight', factor: 0.5, condition: "tag == 't'" },
      { id: 'RULE-TST-E2', name: '排除二', action: 'drop', condition: "tag == 'x'" },
    ],
  })
  try {
    savePackage(dir, minimalPkg({
      behaviors: [
        { id: 'BHV-TST-X', name: '行为X', anchor: 'OBJ-TST-A', relations: ['REL-TST-AB'] },
        { id: 'BHV-TST-Y', name: '行为Y', anchor: 'OBJ-TST-B', relations: [] },
      ],
      exclusionRules: [
        { id: 'RULE-TST-E1', name: '排除一', action: 'downweight', factor: 0.5, condition: "tag == 't'" },
        { id: 'RULE-TST-E2', name: '排除二', action: 'drop', condition: "tag == 'x'" },
      ],
    }))
    derivePackage(dir)
    const dataset = {
      objects: [
        { id: 'A1', type: 'OBJ-TST-A', attrs: { a1: 'x' } },
        { id: 'B1', type: 'OBJ-TST-B', attrs: { b1: 1 } },
      ],
      relations: [{ id: 'R1', type: 'REL-TST-AB', from: 'A1', to: 'B1' }],
      behaviors: [
        { id: 'BV1', type: 'BHV-TST-X', anchorRef: 'A1', objectRef: 'A1', occurredAt: '2026-01-01T00:00:00Z' },
        { id: 'BV2', type: 'BHV-TST-Y', anchorRef: 'B1', objectRef: 'B1', occurredAt: '2026-01-02T00:00:00Z' },
      ],
      candidates: [
        { candidateId: 'C1', objectRef: 'A1', features: { f1: 0.9 }, tags: ['x'] },
      ],
    }
    const result = runScenario(dir, 'SCN-TST-1', dataset)
    assert.ok(!result.candidates.some((c) => c.candidateId === 'C1'), '缺省=全部：E2 照常剔除')
    const o2 = result.audit.checks.find((c) => c.check === 'O2_CLOSED')
    assert.match(o2.detail, /行为实例 2 条/, '缺省=全部：行为不限: ' + o2.detail)
  } finally {
    rmWorkspace(root)
  }
})

test('scoreRefs：执行器按场景收窄打分——范围外规则不求值、不刷待核实（D13）', () => {
  const base = minimalPkg()
  const pkg2 = minimalPkg({
    scoreRules: [
      { id: 'RULE-TST-S1', name: '规则一', weight: 0.6, expression: 'min(1, f1)', threshold: 0.5, evidenceTemplate: 'f1 = {f1}' },
      { id: 'RULE-TST-S2', name: '规则二', weight: 0.4, expression: 'min(1, f2)', threshold: 0.5, evidenceTemplate: 'f2 = {f2}' },
    ],
    skillTemplates: [
      { id: 'SKL-TST-N', name: '叙述', weights: { 'RULE-TST-S1': 0.6, 'RULE-TST-S2': 0.4 }, steps: ['候选 {candidateId}'], outputTemplate: '摘要：{riskScore}' },
    ],
    scenarios: [{ ...base.scenarios[0], scoreRefs: ['RULE-TST-S1'] }],
  })
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    savePackage(dir, pkg2)
    derivePackage(dir)
    const dataset = {
      objects: [
        { id: 'A1', type: 'OBJ-TST-A', attrs: { a1: 'x' } },
        { id: 'B1', type: 'OBJ-TST-B', attrs: { b1: 1 } },
      ],
      relations: [{ id: 'R1', type: 'REL-TST-AB', from: 'A1', to: 'B1' }],
      behaviors: [{ id: 'BV1', type: 'BHV-TST-X', anchorRef: 'A1', objectRef: 'A1', occurredAt: '2026-01-01T00:00:00Z' }],
      candidates: [{ candidateId: 'C1', objectRef: 'A1', features: { f1: 0.9 }, tags: [] }],
    }
    const scoped = runScenario(dir, 'SCN-TST-1', dataset)
    const c1 = scoped.candidates.find((c) => c.candidateId === 'C1')
    // S2 不在圈内：不求值 → 不因缺 f2 落待核实；S1 正常命中
    assert.ok(c1.hitRuleIds.includes('RULE-TST-S1'))
    assert.ok(!c1.hitRuleIds.includes('RULE-TST-S2'))
    assert.equal(c1.pendingVerification !== true && c1.pendingChecks.length === 0, true,
      '范围外规则不得刷待核实: ' + JSON.stringify(c1.pendingChecks))
    assert.ok(Math.abs(c1.riskScore - 0.6 * 0.9) < 1e-9, '只有圈内规则参与加权, got ' + c1.riskScore)

    // 缺省（不落 scoreRefs）= 全部：S2 参与并因缺 f2 落待核实
    const all = minimalPkg({
      scoreRules: pkg2.scoreRules,
      skillTemplates: pkg2.skillTemplates,
    })
    savePackage(dir, all)
    derivePackage(dir)
    const full = runScenario(dir, 'SCN-TST-1', dataset)
    const c2 = full.candidates.find((c) => c.candidateId === 'C1')
    assert.ok(c2.pendingChecks.length > 0, '缺省=全部：缺 f2 应落待核实')
    assert.ok(c2.pendingVerification === true)
  } finally {
    rmWorkspace(root)
  }
})

test('P-1 reviewGate.includeExcluded：排除件进人工队列；缺省保持现状', () => {
  const base = minimalPkg()
  const pkgWithDrop = minimalPkg({
    exclusionRules: [
      { id: 'RULE-TST-E1', name: '排除一', action: 'drop', condition: "tag == 'x'" },
    ],
    scenarios: [{
      ...base.scenarios[0],
      reviewGate: { required: true, threshold: 0.5, includeExcluded: true },
    }],
  })
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    savePackage(dir, pkgWithDrop)
    derivePackage(dir)
    const dataset = {
      objects: [
        { id: 'A1', type: 'OBJ-TST-A', attrs: { a1: 'x' } },
        { id: 'B1', type: 'OBJ-TST-B', attrs: { b1: 1 } },
      ],
      relations: [{ id: 'R1', type: 'REL-TST-AB', from: 'A1', to: 'B1' }],
      behaviors: [{ id: 'BV1', type: 'BHV-TST-X', anchorRef: 'A1', objectRef: 'A1', occurredAt: '2026-01-01T00:00:00Z' }],
      candidates: [
        { candidateId: 'C-hot', objectRef: 'A1', features: { f1: 0.9 }, tags: ['x'] },
        { candidateId: 'C-low', objectRef: 'B1', features: { f1: 0.1 }, tags: [] },
      ],
    }
    const withFlag = runScenario(dir, 'SCN-TST-1', dataset)
    assert.equal(withFlag.excluded.length, 1)
    assert.ok(withFlag.reviewGate.requireReviewFor.includes('C-hot'), '排除件须进人审队列')
    assert.ok(withFlag.reviewGate.requireReviewFor.includes('C-low') === false || withFlag.reviewGate.requireReviewFor.includes('C-low'),
      '低分件不进队列（阈值 0.5，0.1 不达）')
    assert.ok(!withFlag.reviewGate.requireReviewFor.includes('C-low'), '低分且未排除的不进队列')

    // 缺省（不落 includeExcluded）= 现状：排除件不进队列
    const pkgDefault = minimalPkg({
      exclusionRules: pkgWithDrop.exclusionRules,
      scenarios: [{ ...base.scenarios[0] }],
    })
    savePackage(dir, pkgDefault)
    derivePackage(dir)
    const noFlag = runScenario(dir, 'SCN-TST-1', dataset)
    assert.equal(noFlag.excluded.length, 1)
    assert.ok(!noFlag.reviewGate.requireReviewFor.includes('C-hot'), '缺省不改现状：排除件不进队列')
  } finally {
    rmWorkspace(root)
  }
})

test('P-1 includeExcluded 持久化：create 携带、update 可开、坏类型拒', () => {
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    const store = new KnowledgeStore(root)
    confirmSkeleton(store, ['SCN-TST-1', 'SCN-TST-2'])
    // create 携带
    const c = store.addDraft({
      packageId: 'test-pkg',
      item: {
        layer: 'O3', targetKind: 'ScenarioCard', name: '新场景含排除复核',
        payload: {
          id: 'SCN-TST-2', name: '新场景含排除复核', goal: 'g', boundary: 'b',
          reviewGate: { threshold: 0.5, includeExcluded: true },
        },
        confidence: 0.9,
      },
      provenance: { turnId: 't-p1' },
    })
    store.reviewCandidate(c.id, 'approve')
    const r = store.materialize(dir, [c.id])
    assert.deepEqual(r.applied, [c.id], JSON.stringify(r.skipped))
    let after = loadPackage(dir)
    assert.equal(after.scenarios.find((s) => s.id === 'SCN-TST-2').reviewGate.includeExcluded, true)
    assert.equal(after.scenarios.find((s) => s.id === 'SCN-TST-2').reviewGate.threshold, 0.5)

    // update 开启既有场景
    const u = store.addDraft({
      packageId: 'test-pkg',
      item: {
        layer: 'O3', targetKind: 'ScenarioCard', op: 'update', targetId: 'SCN-TST-1',
        name: '排除件进队列', payload: { reviewGate: { includeExcluded: true } }, confidence: 0.9,
      },
      provenance: { turnId: 't-p1' },
    })
    store.reviewCandidate(u.id, 'approve')
    const r2 = store.materialize(dir, [u.id])
    assert.deepEqual(r2.applied, [u.id], JSON.stringify(r2.skipped))
    after = loadPackage(dir)
    const s1 = after.scenarios.find((s) => s.id === 'SCN-TST-1')
    assert.equal(s1.reviewGate.includeExcluded, true)
    assert.equal(s1.reviewGate.threshold, 0.75, '浅并保留既有 threshold')

    // 坏类型拒绝（起草即拒）
    assert.throws(
      () => store.addDraft({
        packageId: 'test-pkg',
        item: {
          layer: 'O3', targetKind: 'ScenarioCard', op: 'update', targetId: 'SCN-TST-1',
          name: '坏类型', payload: { reviewGate: { includeExcluded: 'yes' } }, confidence: 0.9,
        },
        provenance: { turnId: 't-p1' },
      }),
      /includeExcluded/,
    )
  } finally {
    rmWorkspace(root)
  }
})

/* ── 可信取数（T1.1/T1.2/T1.3）：事实优先覆盖 / 数据信任面 / 审计补强 ── */

test('T1.1 prep.featureOverrides：预置特征被对象事实覆盖 → 留痕 + 候选降级，分数按事实算', () => {
  const base = minimalPkg()
  const pkg2 = minimalPkg({
    scoreRules: [{ ...base.scoreRules[0], featureSources: { f1: 'OBJ-TST-A' } }],
  })
  pkg2.scenarios[0].prep = { features: true }
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    savePackage(dir, pkg2)
    derivePackage(dir)
    const dataset = {
      objects: [{ id: 'A1', type: 'OBJ-TST-A', attrs: { a1: 'x', f1: 1 } }],
      relations: [],
      behaviors: [],
      candidates: [{ candidateId: 'C1', objectRef: 'A1', features: { f1: 0.9 }, tags: [] }],
    }
    const result = runScenario(dir, 'SCN-TST-1', dataset)
    assert.deepEqual(
      result.prep?.featureOverrides,
      [{ candidateId: 'C1', key: 'f1', caller: 0.9, fact: 1 }],
      '调用方预置 0.9 与对象事实 1 冲突 → 事实覆盖留痕',
    )
    const c1 = result.candidates.find((c) => c.candidateId === 'C1')
    assert.equal(c1.pendingVerification, true)
    assert.ok(c1.pendingChecks.some((p) => /事实覆盖/.test(p.note)), JSON.stringify(c1.pendingChecks))
    // 分数按事实 f1=1 算（预置 0.9 不参与）
    assert.equal(c1.riskScore, 1)
  } finally {
    rmWorkspace(root)
  }
})

test('T1.2 数据信任面：provenance=inline → dataTrust + DATA_TRUST 提示项 + 候选降级，不否闭合', () => {
  const { dir, root } = copyExamplePackage('aml')
  try {
    const ds = { ...exampleData('aml-run.json'), provenance: 'inline' }
    const result = runScenario(dir, 'SCN-AML-FIND-CLUES', ds)
    assert.deepEqual(result.dataTrust, {
      provenance: 'inline',
      verified: false,
      note: '内联数据未经可信取数核验——结论仅在该数据集内自洽',
    })
    const trust = result.audit.checks.find((c) => c.check === 'DATA_TRUST')
    assert.ok(trust, 'DATA_TRUST 检查项应在场')
    assert.equal(trust.closed, false)
    assert.equal(trust.blocking, false, '信任面是提示项，不否掉本数据集内三层闭合')
    assert.equal(result.audit.passed, true)
    for (const c of result.candidates) {
      assert.equal(c.pendingVerification, true, `${c.candidateId} 内联数据应降级待核实`)
      assert.ok(c.pendingChecks.some((p) => /未经可信取数核验/.test(p.note)))
    }
    // provenance 缺省 = 来源未声明：无 DATA_TRUST、无降级（零回归）
    const plain = runScenario(dir, 'SCN-AML-FIND-CLUES', exampleData('aml-run.json'))
    assert.equal(plain.dataTrust, undefined)
    assert.ok(!plain.audit.checks.some((c) => c.check === 'DATA_TRUST'))
  } finally {
    rmWorkspace(root)
  }
})

test('T1.3 INSTANCE_SCHEMA：枚举值越出字典 / 关系端点类型不匹配 → 审计不闭合并降级', () => {
  const { dir, root } = copyExamplePackage('aml')
  try {
    const ds = exampleData('aml-run.json')
    ds.objects[0].attrs.acctType = 'no-such-type' // enum 不在 dict-acct-type
    ds.relations[0] = { ...ds.relations[0], from: 'TXN-001' } // REL-AML-HOLDS 期望 from=OBJ-AML-CUSTOMER
    const result = runScenario(dir, 'SCN-AML-FIND-CLUES', ds)
    assert.equal(result.audit.passed, false)
    const schema = result.audit.checks.find((c) => c.check === 'INSTANCE_SCHEMA')
    assert.equal(schema.closed, false)
    assert.match(schema.detail, /acctType/)
    assert.match(schema.detail, /from 端类型/)
    assert.ok(
      result.candidates.some((c) => c.pendingChecks.some((p) => /INSTANCE_SCHEMA/.test(p.note))),
      '不闭合须降级为待核实点',
    )
  } finally {
    rmWorkspace(root)
  }
})

test('T1.3 FEATURE_RECOMPUTED：声明特征与对象事实不符 → 审计不闭合（无 prep 也可抓篡改）', () => {
  const base = minimalPkg()
  const pkg2 = minimalPkg({
    scoreRules: [{ ...base.scoreRules[0], featureSources: { f1: 'OBJ-TST-A' } }],
  })
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    savePackage(dir, pkg2)
    derivePackage(dir)
    const dataset = {
      objects: [{ id: 'A1', type: 'OBJ-TST-A', attrs: { a1: 'x', f1: 1 } }],
      relations: [],
      behaviors: [],
      candidates: [{ candidateId: 'C1', objectRef: 'A1', features: { f1: 0.9 }, tags: [] }],
    }
    // 场景无 prep.features：投影不跑，审计仍须抓「特征 ≠ 事实」
    const result = runScenario(dir, 'SCN-TST-1', dataset)
    assert.equal(result.audit.passed, false)
    const feat = result.audit.checks.find((c) => c.check === 'FEATURE_RECOMPUTED')
    assert.equal(feat.closed, false)
    assert.match(feat.detail, /C1 特征 f1 与对象事实不符/)
  } finally {
    rmWorkspace(root)
  }
})
/* ── T2.2 人审屏障：HUMAN_REVIEW 是硬停点，自动执行不过人审点 ── */

test('T2.2-1 人审屏障拦住打分段 → HUMAN_REVIEW_PENDING（停点待放行，不是缺步）', () => {
  const base = minimalPkg()
  const sc = base.scenarios[0]
  // 打分段挪到 HUMAN_REVIEW 之后——自动执行不得越过人审点
  const pkg2 = minimalPkg({
    scenarios: [{
      ...sc,
      pipeline: [
        { stepId: 's1', stepType: 'DATA_INGEST' },
        { stepId: 's7', stepType: 'HUMAN_REVIEW' },
        { stepId: 's3', stepType: 'RULE_EVALUATE', order: 'before-scoring' },
        { stepId: 's4', stepType: 'RULE_EVALUATE' },
      ],
    }],
  })
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    savePackage(dir, pkg2)
    derivePackage(dir)
    const dataset = {
      objects: [{ id: 'A1', type: 'OBJ-TST-A', attrs: { a1: 'x' } }],
      relations: [],
      behaviors: [],
      candidates: [{ candidateId: 'C1', objectRef: 'A1', features: { f1: 0.5 }, tags: [] }],
    }
    assert.throws(
      () => runScenario(dir, 'SCN-TST-1', dataset),
      (e) => e instanceof ScenarioRunError && e.code === 'HUMAN_REVIEW_PENDING' && /人审屏障/.test(e.message),
    )
  } finally {
    rmWorkspace(root)
  }
})

test('T2.2-2 人审屏障：其后步骤不自动执行，reviewBarrier 留痕（末步 HUMAN_REVIEW 零回归）', () => {
  const base = minimalPkg()
  const sc = base.scenarios[0]
  const pkg2 = minimalPkg({
    scenarios: [{
      ...sc,
      // HUMAN_REVIEW 后挂 BEHAVIOR_CALL / SKILL_RUN——都不得自动执行
      pipeline: [
        { stepId: 's1', stepType: 'DATA_INGEST' },
        { stepId: 's3', stepType: 'RULE_EVALUATE', order: 'before-scoring' },
        { stepId: 's4', stepType: 'RULE_EVALUATE' },
        { stepId: 's5', stepType: 'SKILL_RUN', skillRefs: ['SKL-TST-N'] },
        { stepId: 's7', stepType: 'HUMAN_REVIEW' },
        { stepId: 's8', stepType: 'BEHAVIOR_CALL' },
        { stepId: 's9', stepType: 'SKILL_RUN', skillRefs: ['SKL-TST-N'] },
      ],
    }],
  })
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    savePackage(dir, pkg2)
    derivePackage(dir)
    const dataset = {
      objects: [{ id: 'A1', type: 'OBJ-TST-A', attrs: { a1: 'x' } }],
      relations: [],
      behaviors: [{ id: 'BV1', type: 'BHV-TST-X', anchorRef: 'A1', objectRef: 'A1', occurredAt: '2026-01-01T00:00:00Z' }],
      candidates: [{ candidateId: 'C1', objectRef: 'A1', features: { f1: 0.5 }, tags: [] }],
    }
    const result = runScenario(dir, 'SCN-TST-1', dataset)
    assert.deepEqual(result.reviewBarrier, { stepId: 's7', skipped: ['s8', 's9'] })
    // 屏障后 BEHAVIOR_CALL 未跑：行为实例不进审计口径（O2 明细 0 条）
    const o2 = result.audit.checks.find((c) => c.check === 'O2_CLOSED')
    assert.match(o2.detail, /行为实例 0 条/)
    // 叙述仍来自屏障前的 s5（装配过滤 skipped SKILL_RUN——s9 同技能不重复计入）
    assert.ok(result.candidates[0].narrative.length > 0)
  } finally {
    rmWorkspace(root)
  }
})

test('T2.2-3 屏障后 AUDIT_CHECK 不计 skipped（审计是恒执行的核验，非未执行动作）', () => {
  const base = minimalPkg()
  const sc = base.scenarios[0]
  const pkg2 = minimalPkg({
    scenarios: [{
      ...sc,
      pipeline: [
        { stepId: 's1', stepType: 'DATA_INGEST' },
        { stepId: 's3', stepType: 'RULE_EVALUATE', order: 'before-scoring' },
        { stepId: 's4', stepType: 'RULE_EVALUATE' },
        { stepId: 's7', stepType: 'HUMAN_REVIEW' },
        { stepId: 's8', stepType: 'AUDIT_CHECK' },
        { stepId: 's9', stepType: 'SKILL_RUN', skillRefs: ['SKL-TST-N'] },
      ],
    }],
  })
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    savePackage(dir, pkg2)
    derivePackage(dir)
    const result = runScenario(dir, 'SCN-TST-1', {
      objects: [{ id: 'A1', type: 'OBJ-TST-A', attrs: { a1: 'x' } }],
      relations: [],
      behaviors: [],
      candidates: [{ candidateId: 'C1', objectRef: 'A1', features: { f1: 0.5 }, tags: [] }],
    })
    // AUDIT_CHECK（s8）恒执行，不计 skipped；只有 SKILL_RUN（s9）真正未执行
    assert.deepEqual(result.reviewBarrier, { stepId: 's7', skipped: ['s9'] })
    assert.ok(result.audit.checks.length > 0, '审计仍随输出装配执行')
  } finally {
    rmWorkspace(root)
  }
})

test('T1.4 禁语扫描面含 prep.featureOverrides（调用方字符串不得绕过红线）', () => {
  const base = minimalPkg()
  const pkg = minimalPkg({
    scoreRules: [{ ...base.scoreRules[0], featureSources: { f1: 'OBJ-TST-A' } }],
    scenarios: [{
      ...base.scenarios[0],
      prep: { features: true },
    }],
  })
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    savePackage(dir, pkg)
    derivePackage(dir)
    // 调用方预置值带禁语、被对象事实覆盖 → featureOverrides.caller 进扫描面
    const result = runScenario(dir, 'SCN-TST-1', {
      objects: [{ id: 'A1', type: 'OBJ-TST-A', attrs: { a1: 'x', f1: 1 } }],
      relations: [],
      behaviors: [],
      candidates: [{ candidateId: 'C1', objectRef: 'A1', features: { f1: '认定违规' }, tags: [] }],
    })
    assert.equal(result.prep?.featureOverrides?.length, 1, JSON.stringify(result.prep))
    assert.ok(
      result.audit.forbiddenPhraseHits.some((h) => h.phrase === '认定违规' && h.where.includes('prep')),
      JSON.stringify(result.audit.forbiddenPhraseHits),
    )
  } finally {
    rmWorkspace(root)
  }
})

test('T1.5 待补数备注进禁语扫描面（备注先上墙再扫描，不留绕过口）', () => {
  const base = minimalPkg()
  const pkg = minimalPkg({
    scoreRules: [{ ...base.scoreRules[0], featureSources: { f1: 'OBJ-TST-A' } }],
    scenarios: [{
      ...base.scenarios[0],
      outputContract: { ...base.scenarios[0].outputContract, forbiddenPhrases: ['依据不足'] },
    }],
  })
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    savePackage(dir, pkg)
    derivePackage(dir)
    // formal 缺依据 → 触发「正式分析依据不足…」备注；包把「依据不足」列为禁语 → 须命中
    const result = runScenario(dir, 'SCN-TST-1', {
      objects: [{ id: 'A1', type: 'OBJ-TST-A', attrs: { a1: 'x' } }],
      relations: [],
      behaviors: [],
      candidates: [{ candidateId: 'C1', objectRef: 'A1', features: { f1: 1 }, tags: [] }],
    }, {
      analysisMode: 'formal',
      dataBasis: { nature: 'simulated', complete: true, fresh: true, snapshotId: 'snap-1', sourceId: 'SRC-TST-1' },
    })
    assert.equal(result.dataStatus, 'insufficient')
    assert.ok(
      result.audit.forbiddenPhraseHits.some((h) => h.phrase === '依据不足'),
      JSON.stringify(result.audit.forbiddenPhraseHits),
    )
  } finally {
    rmWorkspace(root)
  }
})
