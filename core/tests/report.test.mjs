/** RunReport 投影与稳定字段引用（spec chat-run-report S2.1）：投影形状、引用闭包、指针校验。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CANDIDATE_ROW_FIELDS,
  REPORT_FIELD_REFS,
  buildRunReport,
  isCandidateRowField,
  isReportFieldRef,
  isReportPointer,
  reportPointerToRef,
  resolveReportPointer,
} from '../dist/index.js'

function fullRecord() {
  return {
    runId: 'run-abc12345',
    package: { name: 'wst-ops', version: '1.0.0' },
    scenarioId: 'SCN-WST-HAZARD-MIX',
    startedAt: '2026-11-22T00:00:00.000Z',
    savedAt: '2026-11-22T00:01:00.000Z',
    datasetDigest: 'd'.repeat(64),
    datasetSummary: { objects: 5, relations: 3, behaviors: 4, candidates: 2 },
    redlines: ['认定违规'],
    result: {
      scenarioId: 'SCN-WST-HAZARD-MIX',
      runId: 'run-abc12345',
      startedAt: '2026-11-22T00:00:00.000Z',
      candidates: [
        {
          candidateId: 'ALERT-BIN-03',
          objectRef: 'OBJ-WST-BIN:B3',
          riskScore: 0.94,
          riskLevel: '高',
          hitRuleIds: ['RULE-WST-MIX', 'RULE-WST-OVER'],
          evidenceChains: [
            { ruleId: 'RULE-WST-MIX', score: 0.5, evidence: '混投事件 2 次' },
            { ruleId: 'RULE-WST-OVER', score: 0.44, evidence: '超载 1 次' },
          ],
          narrative: ['候选 0.94'],
          pendingChecks: [{ ruleId: 'RULE-WST-MIX', missing: ['fillLevel'], note: '缺 fillLevel' }],
          pendingVerification: true,
        },
        {
          candidateId: 'ALERT-BIN-01',
          objectRef: 'OBJ-WST-BIN:B1',
          riskScore: 0.368,
          hitRuleIds: ['RULE-WST-OVER'],
          evidenceChains: [{ ruleId: 'RULE-WST-OVER', score: 0.368, evidence: '超载 0 次' }],
          narrative: ['候选 0.368'],
          pendingChecks: [],
          pendingVerification: false,
        },
      ],
      excluded: [{ candidateId: 'ALERT-BIN-02', ruleId: 'RULE-WST-EXCL' }],
      exclusionFeatureGaps: [{ candidateId: 'ALERT-BIN-02', ruleId: 'RULE-WST-EXCL', missing: ['zone'] }],
      humanReviewRequired: true,
      reviewGate: { threshold: 0.75, required: true, requireReviewFor: ['高'] },
      ruleHitLog: [
        { ruleId: 'RULE-WST-MIX', candidateId: 'ALERT-BIN-03', score: 0.5, ts: '2026-11-22T00:00:01Z' },
      ],
      audit: {
        checks: [{ check: 'EVIDENCE', closed: true, detail: '证据齐', ts: '2026-11-22T00:00:02Z', blocking: true }],
        forbiddenPhraseHits: [{ phrase: '认定违规', where: '$.candidates[0].narrative[0]' }],
        passed: true,
      },
      dataStatus: 'verified',
      contractStatus: 'conformant',
      dataTrust: { provenance: 'connector', verified: true, note: 'SRC-WST-CORE' },
    },
  }
}

test('buildRunReport：投影形状与引用内容', () => {
  const report = buildRunReport(fullRecord())
  assert.deepEqual(report.runRef, {
    runId: 'run-abc12345',
    package: { name: 'wst-ops', version: '1.0.0' },
    scenarioId: 'SCN-WST-HAZARD-MIX',
    startedAt: '2026-11-22T00:00:00.000Z',
    savedAt: '2026-11-22T00:01:00.000Z',
  })
  assert.equal(report.summary.candidateCount, 2)
  assert.equal(report.summary.excludedCount, 1)
  assert.equal(report.summary.maxRiskScore, 0.94)
  assert.equal(report.summary.hitRuleCount, 2)
  assert.equal(report.summary.humanReviewRequired, true)
  assert.equal(report.summary.auditPassed, true)
  assert.equal(report.summary.dataStatus, 'verified')
  assert.equal(report.summary.contractStatus, 'conformant')
  assert.equal(report.summary.dataTrust.verified, true)
  assert.deepEqual(report.summary.datasetSummary, { objects: 5, relations: 3, behaviors: 4, candidates: 2 })
  assert.equal(report.candidates.length, 2)
  assert.equal(report.candidates[0].riskLevel, '高')
  assert.equal(report.candidates[0].evidenceChains.length, 2)
  assert.equal(report.candidates[1].riskLevel, undefined)
  assert.deepEqual(report.excluded, [{ candidateId: 'ALERT-BIN-02', ruleId: 'RULE-WST-EXCL' }])
  assert.equal(report.exclusionFeatureGaps[0].missing[0], 'zone')
  assert.equal(report.ruleHitLog[0].ruleId, 'RULE-WST-MIX')
  assert.equal(report.audit.checks[0].blocking, true)
  assert.equal(report.audit.passed, true)
  // 禁语命中清单不进报表（模型面/日志零短语）
  assert.ok(!('forbiddenPhraseHits' in report.audit))
})

test('buildRunReport：深拷贝独立 + 无候选 maxRiskScore 为 null', () => {
  const record = fullRecord()
  const report = buildRunReport(record)
  report.candidates[0].hitRuleIds.push('MUT')
  report.candidates[0].evidenceChains[0].evidence = 'MUT'
  // 改报表不动原记录
  assert.deepEqual(record.result.candidates[0].hitRuleIds, ['RULE-WST-MIX', 'RULE-WST-OVER'])
  assert.equal(record.result.candidates[0].evidenceChains[0].evidence, '混投事件 2 次')
  // 改原记录不动已出的报表
  record.result.candidates[0].evidenceChains[0].evidence = 'LATER'
  assert.equal(report.candidates[0].evidenceChains[0].evidence, 'MUT')

  const empty = fullRecord()
  empty.result.candidates = []
  empty.result.excluded = []
  const emptyReport = buildRunReport(empty)
  assert.equal(emptyReport.summary.maxRiskScore, null)
  assert.equal(emptyReport.summary.candidateCount, 0)
  assert.equal(emptyReport.summary.hitRuleCount, 0)
})

test('buildRunReport：可选字段缺省时不出现在投影', () => {
  const record = fullRecord()
  delete record.result.dataStatus
  delete record.result.contractStatus
  delete record.result.dataTrust
  delete record.result.exclusionFeatureGaps
  delete record.result.candidates[0].riskLevel
  const report = buildRunReport(record)
  assert.ok(!('dataStatus' in report.summary))
  assert.ok(!('contractStatus' in report.summary))
  assert.ok(!('dataTrust' in report.summary))
  assert.ok(!('exclusionFeatureGaps' in report))
  assert.ok(!('riskLevel' in report.candidates[0]))
})

test('稳定字段引用表与行字段表', () => {
  assert.ok(isReportFieldRef('candidates[].riskScore'))
  assert.ok(isReportFieldRef('candidates[0].riskScore'))
  assert.ok(isReportFieldRef('summary.maxRiskScore'))
  assert.ok(!isReportFieldRef('candidates[].password'))
  assert.ok(!isReportFieldRef(''))
  assert.ok(!isReportFieldRef('toString'))
  assert.ok(isCandidateRowField('riskScore'))
  assert.ok(isCandidateRowField('evidenceChains'))
  assert.ok(!isCandidateRowField('runId'))
})

test('指针折叠与 @path 校验', () => {
  assert.equal(reportPointerToRef('/candidates/0/riskScore'), 'candidates[].riskScore')
  assert.equal(reportPointerToRef('/candidates/0/evidenceChains/1/ruleId'), 'candidates[].evidenceChains[].ruleId')
  assert.equal(reportPointerToRef('/summary/maxRiskScore'), 'summary.maxRiskScore')
  assert.equal(reportPointerToRef('/candidates/hitRuleIds'), 'candidates.hitRuleIds')
  assert.equal(reportPointerToRef('/'), null)
  assert.equal(reportPointerToRef('candidates/0'), null)
  assert.equal(reportPointerToRef('/0/riskScore'), null)
  assert.ok(isReportPointer('/candidates/0/riskScore'))
  assert.ok(isReportPointer('/audit/checks/0/detail'))
  assert.ok(!isReportPointer('/candidates/0/secret'))
  assert.ok(!isReportPointer('/audit/checks/0/detail/1'))
})

test('引用闭包：满配报表上每个稳定引用均可解析', () => {
  const report = buildRunReport(fullRecord())
  for (const ref of REPORT_FIELD_REFS) {
    const pointer = '/' + ref.replace(/\[\]/g, '/0').replace(/\./g, '/')
    const value = resolveReportPointer(report, pointer)
    assert.notEqual(value, undefined, `ref ${ref} → ${pointer} 不可解析`)
  }
  assert.equal(resolveReportPointer(report, '/candidates/1/riskScore'), 0.368)
  assert.equal(resolveReportPointer(report, '/candidates/9/riskScore'), undefined)
  assert.equal(resolveReportPointer(report, '/nope'), undefined)
})
