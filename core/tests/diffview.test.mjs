/** RunDiffView 投影（report-export-compare S2.2）：缺席侧 null 不补 0、delta 语义、引用表。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DIFF_FIELD_REFS,
  buildRunDiffView,
  buildRunRecord,
  diffViewOf,
  isDiffFieldRef,
} from '../dist/index.js'

function resultOf(runId, candidates, extra = {}) {
  return {
    scenarioId: 'SCN-TST-1',
    runId,
    startedAt: '2026-11-22T00:00:00.000Z',
    candidates,
    excluded: extra.excluded ?? [],
    humanReviewRequired: true,
    reviewGate: { threshold: 0.75, required: true, requireReviewFor: [] },
    ruleHitLog: [],
    audit: { checks: [], forbiddenPhraseHits: [], passed: extra.auditPassed ?? true },
  }
}

function cand(id, score, rules = []) {
  return {
    candidateId: id,
    objectRef: `OBJ:${id}`,
    riskScore: score,
    hitRuleIds: rules,
    evidenceChains: rules.map((r) => ({ ruleId: r, score: score / rules.length, evidence: `${r} 证据` })),
    narrative: [],
    pendingChecks: [],
    pendingVerification: false,
  }
}

function recordOf(runId, candidates, extra) {
  return buildRunRecord({
    package: { name: 'test-pkg', version: '1.0.0' },
    dataset: { objects: [], relations: [], behaviors: [], candidates: [] },
    result: resultOf(runId, candidates, extra),
    redlines: [],
  })
}

test('buildRunDiffView：并集 delta、缺席侧 null 不补 0、增删与摘要', () => {
  const a = recordOf('run-aaa', [cand('C1', 0.5, ['R1']), cand('C2', 0.3, ['R2'])], {
    excluded: [{ candidateId: 'X1', ruleId: 'RX' }],
    auditPassed: true,
  })
  const b = recordOf('run-bbb', [cand('C1', 0.7, ['R1', 'R3']), cand('C3', 0.2, [])], {
    excluded: [],
    auditPassed: false,
  })
  const view = buildRunDiffView(a, b)

  assert.equal(view.head.runIdA, 'run-aaa')
  assert.equal(view.head.runIdB, 'run-bbb')
  assert.equal(view.head.auditPassedA, true)
  assert.equal(view.head.auditPassedB, false)

  const byId = Object.fromEntries(view.deltas.map((d) => [d.candidateId, d]))
  // 双侧齐：delta = B − A
  assert.equal(byId.C1.riskScoreA, 0.5)
  assert.equal(byId.C1.riskScoreB, 0.7)
  assert.ok(Math.abs((byId.C1.riskScoreDelta ?? 0) - 0.2) < 1e-9)
  assert.deepEqual(byId.C1.hitRuleIdsAdded, ['R3'])
  // 单侧缺席：score/delta 全 null（不补 0）
  assert.equal(byId.C2.riskScoreA, 0.3)
  assert.equal(byId.C2.riskScoreB, null)
  assert.equal(byId.C2.riskScoreDelta, null)
  assert.deepEqual(byId.C2.hitRuleIdsRemoved, ['R2'])
  assert.equal(byId.C3.riskScoreA, null)
  assert.equal(byId.C3.riskScoreDelta, null)

  assert.deepEqual(view.excludedRemoved, [{ candidateId: 'X1', ruleId: 'RX' }])
  assert.equal(view.summary.deltaCount, 1)
  assert.equal(view.summary.addedCount, 1)
  assert.equal(view.summary.removedCount, 1)
  assert.ok(Math.abs((view.summary.maxAbsDelta ?? 0) - 0.2) < 1e-9)
  assert.equal(view.summary.humanReviewRequired, true)
})

test('diffViewOf：全单侧时 maxAbsDelta 为 null（不展示为 0）', () => {
  const view = diffViewOf({
    runIdA: 'run-a',
    runIdB: 'run-b',
    scenarioA: 'SCN-TST-1',
    scenarioB: 'SCN-TST-1',
    packageA: { name: 'test-pkg', version: '1.0.0' },
    packageB: { name: 'test-pkg', version: '1.0.0' },
    sameDataset: true,
    candidates: [
      {
        candidateId: 'C1',
        riskScoreA: 0.5,
        riskScoreB: null,
        riskScoreDelta: null,
        hitRuleIdsAdded: [],
        hitRuleIdsRemoved: [],
        pendingChecksAdded: [],
        pendingChecksRemoved: [],
      },
    ],
    excludedAdded: [],
    excludedRemoved: [],
    auditPassedA: true,
    auditPassedB: true,
    humanReviewRequired: true,
  })
  assert.equal(view.summary.maxAbsDelta, null)
  assert.equal(view.summary.deltaCount, 0)
})

test('DIFF_FIELD_REFS 引用表：折叠与校验', () => {
  assert.ok(isDiffFieldRef('deltas[].riskScoreDelta'))
  assert.ok(isDiffFieldRef('deltas[2].riskScoreDelta'))
  assert.ok(isDiffFieldRef('head.runIdA'))
  assert.ok(!isDiffFieldRef('deltas[].secret'))
  assert.ok(!isDiffFieldRef(''))
  // 闭包：每条引用折叠后都在表内
  for (const ref of DIFF_FIELD_REFS) {
    assert.ok(isDiffFieldRef(ref), ref)
  }
})
