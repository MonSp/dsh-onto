/** RunRecord 注册表验收（spec run-insight S2.1/S2.4）：形状、围栏、损坏信封、归档人审面。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildRunRecord,
  compareRunRecords,
  datasetDigest,
  exportRunArchive,
  isSafeRunId,
  listRunRecords,
  loadRunRecord,
  loadRunRedlines,
  saveRunRecord,
} from '../dist/index.js'
import { mkWorkspace, rmWorkspace } from './helpers.mjs'

function fakeResult(overrides = {}) {
  return {
    scenarioId: 'SCN-TST-1',
    runId: 'run-abc12345',
    startedAt: '2026-11-05T00:00:00.000Z',
    candidates: [
      {
        candidateId: 'CAND-001',
        objectRef: 'OBJ-TST-A:1',
        riskScore: 0.5,
        hitRuleIds: ['RULE-TST-S1'],
        evidenceChains: [{ ruleId: 'RULE-TST-S1', score: 0.5, evidence: '特征 f1 = 1' }],
        narrative: ['摘要：0.5'],
        pendingChecks: [],
        pendingVerification: false,
      },
    ],
    excluded: [],
    humanReviewRequired: true,
    reviewGate: { threshold: 0.75, required: true, requireReviewFor: [] },
    ruleHitLog: [],
    audit: {
      checks: [],
      forbiddenPhraseHits: [{ phrase: '认定违规', where: '$.candidates[0].narrative[0]' }],
      passed: true,
    },
    ...overrides,
  }
}

function fakeDataset() {
  return {
    objects: [{ id: 'OBJ-TST-A:1', type: 'OBJ-TST-A', attrs: {} }],
    relations: [],
    behaviors: [],
    candidates: [
      { candidateId: 'CAND-001', objectRef: 'OBJ-TST-A:1', features: { f1: 1 }, tags: [] },
    ],
  }
}

test('buildRunRecord：摘要/去重红线/掩蔽前完整结果', () => {
  const rec = buildRunRecord({
    package: { name: 'test-pkg', version: '1.0.0' },
    dataset: fakeDataset(),
    result: fakeResult(),
    redlines: ['认定违规', '认定违规', ''],
    savedAt: '2026-11-05T01:00:00.000Z',
  })
  assert.equal(rec.runId, 'run-abc12345')
  assert.deepEqual(rec.package, { name: 'test-pkg', version: '1.0.0' })
  assert.deepEqual(rec.redlines, ['认定违规'])
  assert.deepEqual(rec.datasetSummary, { objects: 1, relations: 0, behaviors: 0, candidates: 1 })
  assert.equal(typeof rec.datasetDigest, 'string')
  assert.equal(rec.result.audit.forbiddenPhraseHits[0].phrase, '认定违规')
})

test('datasetDigest：键序无关，同数据同指纹；不同数据不同指纹', () => {
  const a = { objects: [{ id: 'o1', type: 'T', attrs: { x: 1, y: 2 } }], relations: [], candidates: [] }
  const b = { relations: [], candidates: [], objects: [{ attrs: { y: 2, x: 1 }, type: 'T', id: 'o1' }] }
  assert.equal(datasetDigest(a), datasetDigest(b))
  assert.notEqual(datasetDigest(a), datasetDigest(fakeDataset()))
})

test('save/load 往返 + loadRunRedlines 回读', () => {
  const ws = mkWorkspace()
  try {
    const rec = buildRunRecord({
      package: { name: 'test-pkg', version: '1.0.0' },
      dataset: fakeDataset(),
      result: fakeResult(),
      redlines: ['认定违规'],
    })
    saveRunRecord(ws.root, rec)
    const back = loadRunRecord(ws.root, 'run-abc12345')
    assert.deepEqual(back, rec)
    assert.deepEqual(loadRunRedlines(ws.root, 'run-abc12345'), ['认定违规'])
    assert.equal(loadRunRedlines(ws.root, 'run-zzzzzzzz'), undefined)
    assert.equal(loadRunRedlines(ws.root, '../evil'), undefined)
  } finally {
    rmWorkspace(ws.root)
  }
})

test('isSafeRunId：穿越/ADS/多级/空段全拒（I3 同族）', () => {
  for (const bad of ['../x', 'a/b', 'a\\b', 'a:b', '.', '..', '', 'run-1/../../etc', '/abs', 'C:run-1']) {
    assert.equal(isSafeRunId(bad), false, `应拒绝 ${bad}`)
  }
  assert.equal(isSafeRunId('run-abc12345'), true)
  assert.equal(isSafeRunId(123), false)
  assert.equal(isSafeRunId(null), false)
})

test('loadRunRecord 错误信封：非法 INVALID_ARGS / 缺失 NOT_FOUND / 损坏 PACKAGE_MALFORMED', () => {
  const ws = mkWorkspace()
  try {
    assert.throws(() => loadRunRecord(ws.root, '../evil'), (e) => e.code === 'INVALID_ARGS')
    assert.throws(() => loadRunRecord(ws.root, 'run-none000'), (e) => e.code === 'NOT_FOUND')
    const dir = join(ws.root, 'runs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'run-bad00000.json'), '{not json', 'utf8')
    assert.throws(() => loadRunRecord(ws.root, 'run-bad00000'), (e) => e.code === 'PACKAGE_MALFORMED')
    writeFileSync(join(dir, 'run-bad11111.json'), '{"hello":"world"}', 'utf8')
    assert.throws(() => loadRunRecord(ws.root, 'run-bad11111'), (e) => e.code === 'PACKAGE_MALFORMED')
    // 头字段合法但 result 形状残缺 → 同样 PACKAGE_MALFORMED（深验，不放行到调用方 TypeError）
    const shallow = buildRunRecord({
      package: { name: 'test-pkg', version: '1.0.0' },
      dataset: fakeDataset(),
      result: fakeResult({ runId: 'run-bad22222' }),
      redlines: [],
    })
    shallow.result = { ...shallow.result, candidates: undefined, audit: undefined }
    writeFileSync(join(dir, 'run-bad22222.json'), JSON.stringify(shallow), 'utf8')
    assert.throws(() => loadRunRecord(ws.root, 'run-bad22222'), (e) => e.code === 'PACKAGE_MALFORMED')
  } finally {
    rmWorkspace(ws.root)
  }
})

test('loadRunRecord 元素级错型 → PACKAGE_MALFORMED（compare 消费面不裸抛 TypeError）', () => {
  const ws = mkWorkspace()
  try {
    const dir = join(ws.root, 'runs')
    mkdirSync(dir, { recursive: true })
    const base = buildRunRecord({
      package: { name: 'test-pkg', version: '1.0.0' },
      dataset: fakeDataset(),
      result: fakeResult({ runId: 'run-el000000' }),
      redlines: [],
    })
    // compareRunRecords 消费的元素形错型（hitRuleIds 非数组 / excluded null / pendingChecks null）
    const badShapes = [
      {
        ...base,
        runId: 'run-el000001',
        result: {
          ...base.result,
          candidates: [{ candidateId: 'C', riskScore: 0.5, hitRuleIds: 'not-array', pendingChecks: [] }],
        },
      },
      { ...base, runId: 'run-el000002', result: { ...base.result, excluded: [null] } },
      {
        ...base,
        runId: 'run-el000003',
        result: {
          ...base.result,
          candidates: [{ candidateId: 'C', riskScore: 0.5, hitRuleIds: [], pendingChecks: [null] }],
        },
      },
      {
        ...base,
        runId: 'run-el000004',
        result: {
          ...base.result,
          candidates: [{ candidateId: 'C', riskScore: 'x', hitRuleIds: [], pendingChecks: [] }],
        },
      },
    ]
    for (const rec of badShapes) {
      writeFileSync(join(dir, `${rec.runId}.json`), JSON.stringify(rec), 'utf8')
      assert.throws(
        () => loadRunRecord(ws.root, rec.runId),
        (e) => e.code === 'PACKAGE_MALFORMED',
        `${rec.runId} 应在加载期拒`,
      )
    }
    // 合法记录仍可加载（深验不误伤）
    const good = buildRunRecord({
      package: { name: 'test-pkg', version: '1.0.0' },
      dataset: fakeDataset(),
      result: fakeResult({ runId: 'run-el000005' }),
      redlines: [],
    })
    saveRunRecord(ws.root, good)
    assert.equal(loadRunRecord(ws.root, 'run-el000005').runId, 'run-el000005')
  } finally {
    rmWorkspace(ws.root)
  }
})

test('saveRunRecord 拒非法 runId，不落盘', () => {
  const ws = mkWorkspace()
  try {
    const rec = buildRunRecord({
      package: { name: 'test-pkg', version: '1.0.0' },
      dataset: fakeDataset(),
      result: fakeResult({ runId: '../evil' }),
      redlines: [],
    })
    assert.throws(() => saveRunRecord(ws.root, rec), (e) => e.code === 'INVALID_ARGS')
    assert.equal(existsSync(join(ws.root, 'runs', 'evil.json')), false)
  } finally {
    rmWorkspace(ws.root)
  }
})

test('listRunRecords：savedAt 降序、跳过损坏条目', () => {
  const ws = mkWorkspace()
  try {
    const base = buildRunRecord({
      package: { name: 'test-pkg', version: '1.0.0' },
      dataset: fakeDataset(),
      result: fakeResult({ runId: 'run-aaaaaaaa' }),
      redlines: [],
      savedAt: '2026-11-05T01:00:00.000Z',
    })
    saveRunRecord(ws.root, base)
    saveRunRecord(ws.root, {
      ...base,
      runId: 'run-bbbbbbbb',
      savedAt: '2026-11-05T02:00:00.000Z',
    })
    mkdirSync(join(ws.root, 'runs'), { recursive: true })
    writeFileSync(join(ws.root, 'runs', 'run-cccccccc.json'), '{bad', 'utf8')
    const list = listRunRecords(ws.root)
    assert.deepEqual(list.map((r) => r.runId), ['run-bbbbbbbb', 'run-aaaaaaaa'])
    assert.deepEqual(listRunRecords(join(ws.root, 'nowhere')), [])
  } finally {
    rmWorkspace(ws.root)
  }
})

test('exportRunArchive：归档人审面完整（含短语本体）+ 相对 locator + 覆盖幂等', () => {
  const ws = mkWorkspace()
  try {
    const rec = buildRunRecord({
      package: { name: 'test-pkg', version: '1.0.0' },
      dataset: fakeDataset(),
      result: fakeResult(),
      redlines: ['认定违规'],
    })
    saveRunRecord(ws.root, rec)
    const first = exportRunArchive(ws.root, 'run-abc12345')
    assert.equal(first.locator, 'runs/exports/run-abc12345.json')
    assert.equal(first.archive.runId, 'run-abc12345')
    assert.equal(typeof first.archive.archivedAt, 'string')
    // 人审面：完整短语保留（供复核定位），不经过工具面脱敏
    assert.equal(first.archive.result.audit.forbiddenPhraseHits[0].phrase, '认定违规')
    assert.ok(existsSync(join(ws.root, 'runs', 'exports', 'run-abc12345.json')))
    const second = exportRunArchive(ws.root, 'run-abc12345')
    const onDisk = JSON.parse(readFileSync(join(ws.root, 'runs', 'exports', 'run-abc12345.json'), 'utf8'))
    assert.equal(onDisk.runId, 'run-abc12345')
    assert.equal(typeof second.archive.archivedAt, 'string')
    // locator 恒为 workspace 相对路径，零绝对路径
    assert.ok(!first.locator.includes(':') && !first.locator.startsWith('/'))
    assert.throws(() => exportRunArchive(ws.root, '../evil'), (e) => e.code === 'INVALID_ARGS')
    assert.throws(() => exportRunArchive(ws.root, 'run-none000'), (e) => e.code === 'NOT_FOUND')
  } finally {
    rmWorkspace(ws.root)
  }
})

test('compareRunRecords：增删/delta/单侧候选/同数据标记（S2.2）', () => {
  const resultA = fakeResult({
    runId: 'run-aaaaaaaa',
    candidates: [
      {
        candidateId: 'CAND-001',
        objectRef: 'OBJ-TST-A:1',
        riskScore: 0.4,
        hitRuleIds: ['RULE-TST-S1'],
        evidenceChains: [],
        narrative: [],
        pendingChecks: [{ ruleId: 'RULE-TST-S1', note: '缺日志' }],
        pendingVerification: true,
      },
      {
        candidateId: 'CAND-002',
        objectRef: 'OBJ-TST-A:2',
        riskScore: 0.9,
        hitRuleIds: ['RULE-TST-S1', 'RULE-TST-S2'],
        evidenceChains: [],
        narrative: [],
        pendingChecks: [],
        pendingVerification: false,
      },
    ],
    excluded: [{ candidateId: 'CAND-003', ruleId: 'RULE-TST-E1' }],
  })
  const resultB = fakeResult({
    runId: 'run-bbbbbbbb',
    candidates: [
      {
        candidateId: 'CAND-001',
        objectRef: 'OBJ-TST-A:1',
        riskScore: 0.7,
        hitRuleIds: ['RULE-TST-S1', 'RULE-TST-S2'],
        evidenceChains: [],
        narrative: [],
        pendingChecks: [{ ruleId: 'RULE-TST-S1', note: '缺日志' }, { note: '缺流水' }],
        pendingVerification: true,
      },
      {
        candidateId: 'CAND-009',
        objectRef: 'OBJ-TST-A:9',
        riskScore: 0.2,
        hitRuleIds: [],
        evidenceChains: [],
        narrative: [],
        pendingChecks: [],
        pendingVerification: false,
      },
    ],
    excluded: [],
  })
  const ds = fakeDataset()
  const recA = buildRunRecord({
    package: { name: 'test-pkg', version: '1.0.0' },
    dataset: ds,
    result: resultA,
    redlines: [],
    savedAt: '2026-11-05T01:00:00.000Z',
  })
  const recB = buildRunRecord({
    package: { name: 'test-pkg', version: '1.1.0' },
    dataset: ds,
    result: resultB,
    redlines: [],
    savedAt: '2026-11-05T02:00:00.000Z',
  })
  const diff = compareRunRecords(recA, recB)
  assert.equal(diff.sameDataset, true)
  assert.equal(diff.humanReviewRequired, true)
  assert.equal(diff.auditPassedA, true)
  assert.equal(diff.auditPassedB, true)
  assert.deepEqual(diff.packageB, { name: 'test-pkg', version: '1.1.0' })
  assert.deepEqual(diff.candidates.map((c) => c.candidateId), ['CAND-001', 'CAND-002', 'CAND-009'])

  const c1 = diff.candidates.find((c) => c.candidateId === 'CAND-001')
  assert.equal(c1.riskScoreA, 0.4)
  assert.equal(c1.riskScoreB, 0.7)
  assert.ok(Math.abs((c1.riskScoreDelta ?? 0) - 0.3) < 1e-9)
  assert.deepEqual(c1.hitRuleIdsAdded, ['RULE-TST-S2'])
  assert.deepEqual(c1.hitRuleIdsRemoved, [])
  assert.deepEqual(c1.pendingChecksAdded, ['缺流水'])
  assert.deepEqual(c1.pendingChecksRemoved, [])

  const c2 = diff.candidates.find((c) => c.candidateId === 'CAND-002')
  assert.equal(c2.riskScoreB, null)
  assert.equal(c2.riskScoreDelta, null)
  assert.deepEqual(c2.hitRuleIdsRemoved, ['RULE-TST-S1', 'RULE-TST-S2'])

  const c9 = diff.candidates.find((c) => c.candidateId === 'CAND-009')
  assert.equal(c9.riskScoreA, null)
  assert.equal(c9.riskScoreDelta, null)

  assert.deepEqual(diff.excludedRemoved, [{ candidateId: 'CAND-003', ruleId: 'RULE-TST-E1' }])
  assert.deepEqual(diff.excludedAdded, [])

  // 不同数据集 → sameDataset=false
  const recB2 = { ...recB, datasetDigest: 'other-digest' }
  assert.equal(compareRunRecords(recA, recB2).sameDataset, false)
})
