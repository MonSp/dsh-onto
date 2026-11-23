/** RunReport 投影与稳定字段引用（spec chat-run-report S2.1）：投影形状、引用闭包、指针校验。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CANDIDATE_ROW_FIELDS,
  REPORT_FIELD_REFS,
  buildRunReport,
  evalWhen,
  isCandidateRowField,
  isReportFieldRef,
  isReportPointer,
  projectChartGroups,
  projectChartPoints,
  projectChartSeries,
  projectChartStacks,
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

test('projectChartPoints：null-safe 取点、断线分段、绝不补 0', () => {
  const record = fullRecord()
  // 中间插入不可数值化行 → 跳过并断线（两侧各成一段）
  record.result.candidates.splice(1, 0, {
    ...record.result.candidates[1],
    candidateId: 'ALERT-BIN-99',
    riskScore: Number.NaN,
  })
  const report = buildRunReport(record)
  const { points, segments } = projectChartPoints(report, '/candidates', 'candidateId', 'riskScore')
  assert.equal(points.length, 2)
  assert.deepEqual(points.map((p) => p.label), ['ALERT-BIN-03', 'ALERT-BIN-01'])
  assert.deepEqual(points.map((p) => p.value), [0.94, 0.368])
  assert.equal(segments.length, 2, '缺断点断线分段')
  assert.equal(segments[0].length, 1)
  assert.equal(segments[1].length, 1)

  // 空候选 → 空点空段（渲染显 '—'，不得画 0）
  const empty = fullRecord()
  empty.result.candidates = []
  const emptyReport = buildRunReport(empty)
  const none = projectChartPoints(emptyReport, '/candidates', 'candidateId', 'riskScore')
  assert.equal(none.points.length, 0)
  assert.equal(none.segments.length, 0)

  // 全有效 → 单段
  const ok = projectChartPoints(buildRunReport(fullRecord()), '/candidates', 'candidateId', 'riskScore')
  assert.equal(ok.segments.length, 1)
  assert.equal(ok.points.length, 2)
})

test('evalWhen：数据驱动谓词（各 op / 不可求值不满足）', () => {
  const report = buildRunReport(fullRecord())
  const at = (op, value) => ({ bind: '/summary/dataStatus', op, ...(value === undefined ? {} : { value }) })

  // fullRecord 带 dataStatus: 'verified'
  assert.equal(evalWhen(report, at('eq', 'verified')), true)
  assert.equal(evalWhen(report, at('eq', 'insufficient')), false)
  assert.equal(evalWhen(report, at('neq', 'insufficient')), true)
  assert.equal(evalWhen(report, at('in', ['verified', 'conditional'])), true)
  assert.equal(evalWhen(report, at('not-in', ['insufficient'])), true)
  assert.equal(evalWhen(report, at('empty')), false)
  assert.equal(evalWhen(report, at('not-empty')), true)

  // 数值比较
  const score = (op, value) => ({ bind: '/summary/maxRiskScore', op, value })
  assert.equal(evalWhen(report, score('gt', 0.5)), true)
  assert.equal(evalWhen(report, score('gt', 0.94)), false)
  assert.equal(evalWhen(report, score('gte', 0.94)), true)
  assert.equal(evalWhen(report, score('lt', 1)), true)
  assert.equal(evalWhen(report, score('lte', 0.94)), true)

  // 不可求值（null 比较 / 缺字段）→ 不满足（含 neq/not-in 取反侧）
  const emptyRec = fullRecord()
  emptyRec.result.candidates = []
  const emptyReport = buildRunReport(emptyRec)
  assert.equal(evalWhen(emptyReport, { bind: '/summary/maxRiskScore', op: 'gt', value: 0 }), false)
  assert.equal(evalWhen(emptyReport, { bind: '/summary/maxRiskScore', op: 'empty' }), true)
  assert.equal(evalWhen(report, { bind: '/nope', op: 'eq', value: 1 }), false)
  assert.equal(evalWhen(report, { bind: '/nope', op: 'neq', value: 1 }), false)
  assert.equal(evalWhen(report, { bind: '/nope', op: 'not-in', value: [1] }), false)
  assert.equal(evalWhen(report, { bind: '/nope', op: 'gte', value: 0 }), false)
  // null 分数不得当 0 分（Number(null)=0 陷阱）
  assert.equal(evalWhen(emptyReport, { bind: '/summary/maxRiskScore', op: 'eq', value: 0 }), false)
  assert.equal(evalWhen(emptyReport, { bind: '/summary/maxRiskScore', op: 'gte', value: 0 }), false)
  assert.equal(evalWhen(emptyReport, { bind: '/summary/maxRiskScore', op: 'lte', value: 0 }), false)
  // 布尔严格等（false 不得等于 0）
  assert.equal(evalWhen(report, { bind: '/summary/auditPassed', op: 'eq', value: true }), true)
  assert.equal(evalWhen(report, { bind: '/summary/auditPassed', op: 'eq', value: 1 }), false)
  // 布尔不入大小比较（Number(true)=1 曲解语义）
  assert.equal(evalWhen(report, { bind: '/summary/auditPassed', op: 'gt', value: 0 }), false)
  assert.equal(evalWhen(report, { bind: '/summary/auditPassed', op: 'lte', value: 1 }), false)
  assert.equal(evalWhen(report, { bind: '/summary/maxRiskScore', op: 'lt', value: true }), false)

  // 列表指针 empty/not-empty（数组空/非空语义，如「有缺失项才展示」）
  assert.equal(evalWhen(report, { bind: '/candidates/0/pendingChecks/0/missing', op: 'not-empty' }), true)
  assert.equal(evalWhen(report, { bind: '/candidates/0/hitRuleIds', op: 'not-empty' }), true)
  assert.equal(evalWhen(report, { bind: '/candidates/1/pendingChecks', op: 'empty' }), true)

  // UI 状态源：未注册一律不渲染；注册后走同一谓词集
  assert.equal(evalWhen(report, { field: 'q', op: 'empty' }, {}), false)
  assert.equal(evalWhen(report, { field: 'q', op: 'empty' }, { q: '' }), true)
  assert.equal(evalWhen(report, { field: 'q', op: 'not-empty' }, { q: 'abc' }), true)
  assert.equal(evalWhen(report, { field: 'q', op: 'eq', value: 'abc' }, { q: 'abc' }), true)
})

test('多系列/堆叠/分组投影（null-safe 同取点语义）', () => {
  const record = fullRecord()
  record.result.ruleHitLog.push(
    { ruleId: 'RULE-WST-OVER', candidateId: 'ALERT-BIN-03', score: 0.2, ts: '2026-11-22T00:00:02Z' },
    { ruleId: 'RULE-WST-MIX', candidateId: 'ALERT-BIN-01', score: 0.1, ts: '2026-11-22T00:00:03Z' },
  )
  const report = buildRunReport(record)

  // 分组柱：同行多列
  const groups = projectChartGroups(report, '/candidates', 'candidateId', ['riskScore', 'hitRuleCount'])
  assert.equal(groups.length, 2)
  assert.deepEqual(groups[0], { label: 'ALERT-BIN-03', values: [0.94, 2] })
  assert.deepEqual(groups[1], { label: 'ALERT-BIN-01', values: [0.368, 1] })

  // 堆叠：行内 evidenceChains 段
  const stacks = projectChartStacks(report, '/candidates', 'candidateId', 'evidenceChains', 'ruleId', 'score')
  assert.equal(stacks.length, 2)
  assert.deepEqual(stacks[0].segments.map((s) => s.label), ['RULE-WST-MIX', 'RULE-WST-OVER'])
  assert.deepEqual(stacks[0].segments.map((s) => s.value), [0.5, 0.44])
  assert.equal(stacks[1].segments.length, 1)

  // 多系列折线：按 candidateId 分组（首次出现序；x=全局行序）
  const series = projectChartSeries(report, '/ruleHitLog', 'candidateId', 'ruleId', 'score')
  assert.deepEqual(series.map((s) => s.label), ['ALERT-BIN-03', 'ALERT-BIN-01'])
  assert.equal(series[0].points.length, 2)
  assert.equal(series[1].points.length, 1)
  assert.deepEqual(series[0].points.map((p) => p.label), ['RULE-WST-MIX', 'RULE-WST-OVER'])
  assert.deepEqual(series[0].points.map((p) => p.index), [0, 1])
  assert.deepEqual(series[1].points.map((p) => p.index), [2])

  // null-safe：非有限值剔除；全空行跳过
  record.result.candidates[1].riskScore = Number.NaN
  record.result.candidates[1].hitRuleIds = []
  const g2 = projectChartGroups(buildRunReport(record), '/candidates', 'candidateId', ['riskScore', 'hitRuleCount'])
  assert.deepEqual(g2[1], { label: 'ALERT-BIN-01', values: [null, 0] })
})

test('多系列折线：组内缺断断线（与取点语义同构）', () => {
  const record = fullRecord()
  record.result.ruleHitLog = [
    { ruleId: 'R1', candidateId: 'A', score: 0.5, ts: '1' },
    { ruleId: 'R2', candidateId: 'A', score: Number.NaN, ts: '2' },
    { ruleId: 'R3', candidateId: 'A', score: 0.7, ts: '3' },
  ]
  const series = projectChartSeries(buildRunReport(record), '/ruleHitLog', 'candidateId', 'ruleId', 'score')
  assert.equal(series.length, 1)
  assert.equal(series[0].points.length, 2)
  assert.equal(series[0].segments.length, 2, '缺断两侧断线')
  assert.deepEqual(series[0].points.map((p) => p.index), [0, 2])
})
