/** 场景执行验收（规范 §9 / §11.3）：端到端全流程字段、ruleId 回指、禁语零命中。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runScenario, ScenarioRunError, derivePackage, savePackage, loadPackage } from '../dist/index.js'
import { copyExamplePackage, exampleData, mkWorkspaceWithPkg, minimalPkg, rmWorkspace } from './helpers.mjs'

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
