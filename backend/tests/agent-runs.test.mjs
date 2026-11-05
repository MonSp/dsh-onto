/**
 * run-insight 工具面/持久面测试（spec run-insight S2.1–S2.4）：phraseRegistry 持久后端、
 * compare/batch/export 纯函数与出口契约。不起 dsh host。
 */
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  assertBatchContract,
  assertDiffContract,
  configurePhraseStore,
  enforceOutputPolicy,
  recallPhrases,
  rememberPhrases,
  renderBatchText,
  renderRunDiffText,
  renderRunText,
} from '../dist/agent-policy.js'
import {
  BATCH_RUN_LIMIT,
  exportSummaryOf,
  loadDatasetFromArgs,
  resolveBatchIds,
  runScenarioBatch,
  summarizeRunResult,
} from '../dist/agent-tools.js'
import {
  PackageWorkspace,
  buildRunRecord,
  compareRunRecords,
  derivePackage,
  exportRunArchive,
  loadPackage,
  loadRunRecord,
  loadRunRedlines,
  saveRunRecord,
} from '@dsh-onto/core'

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const AML_DIR = fileURLToPath(new URL('../../packages/aml/1.0.0', import.meta.url))
const AML_RUN = fileURLToPath(new URL('../../examples/aml-run.json', import.meta.url))
const MED_DIR = fileURLToPath(new URL('../../packages/med/1.0.0', import.meta.url))
const MED_RUN = fileURLToPath(new URL('../../examples/med-run.json', import.meta.url))

function fakeResult(runId = 'run-abc12345') {
  return {
    scenarioId: 'SCN-TST-1',
    runId,
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

test('phraseStore：remember 内存、跨进程 recall 回读 RunRecord.redlines（backlog #2）', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-onto-runs-'))
  try {
    const rec = buildRunRecord({
      package: { name: 'test-pkg', version: '1.0.0' },
      dataset: fakeDataset(),
      result: fakeResult(),
      redlines: ['认定违规'],
    })
    saveRunRecord(root, rec)
    // 未配置持久后端：内存路径行为不变
    configurePhraseStore(null)
    rememberPhrases('run-abc12345', ['认定违规'])
    assert.deepEqual(recallPhrases('run-abc12345'), ['认定违规'])
    assert.equal(recallPhrases('run-zzzzzzzz'), undefined)
    // 模拟跨进程：configure 清空内存后，recall 经持久后端回读
    configurePhraseStore((runId) => loadRunRedlines(root, runId))
    assert.deepEqual(recallPhrases('run-abc12345'), ['认定违规'])
    assert.equal(recallPhrases('run-zzzzzzzz'), undefined)
    // 清单仅用于遮蔽：render 文本不得回显短语本体
    const text = renderRunText(fakeResult())
    assert.ok(!text.includes('认定违规'))
    assert.ok(text.includes('禁语命中'))
    configurePhraseStore(null)
  } finally {
    rmSync(root, { recursive: true, force: true })
    configurePhraseStore(null)
  }
})

test('phraseStore：后端回读过滤非串/空串条目', () => {
  try {
    configurePhraseStore(() => ['a', '', 42, 'b'])
    assert.deepEqual(recallPhrases('run-any00000'), ['a', 'b'])
    configurePhraseStore(null)
  } finally {
    configurePhraseStore(null)
  }
})

function fakeDiff(overrides = {}) {
  return {
    runIdA: 'run-aaaaaaaa',
    runIdB: 'run-bbbbbbbb',
    scenarioA: 'SCN-TST-1',
    scenarioB: 'SCN-TST-1',
    packageA: { name: 'test-pkg', version: '1.0.0' },
    packageB: { name: 'test-pkg', version: '1.1.0' },
    sameDataset: true,
    candidates: [
      {
        candidateId: 'CAND-001',
        riskScoreA: 0.4,
        riskScoreB: 0.7,
        riskScoreDelta: 0.3,
        hitRuleIdsAdded: ['RULE-TST-S2'],
        hitRuleIdsRemoved: [],
        pendingChecksAdded: ['缺流水'],
        pendingChecksRemoved: [],
      },
    ],
    excludedAdded: [],
    excludedRemoved: [{ candidateId: 'CAND-003', ruleId: 'RULE-TST-E1' }],
    auditPassedA: true,
    auditPassedB: true,
    humanReviewRequired: true,
    ...overrides,
  }
}

test('assertDiffContract：分数 NaN/错型落 INVALID_TOOL_OUTPUT（I5）', () => {
  assertDiffContract(fakeDiff())
  assert.throws(
    () => assertDiffContract(fakeDiff({ candidates: [{ ...fakeDiff().candidates[0], riskScoreA: NaN }] })),
    (e) => e.code === 'INVALID_TOOL_OUTPUT',
  )
  assert.throws(
    () => assertDiffContract(fakeDiff({ candidates: [{ ...fakeDiff().candidates[0], hitRuleIdsAdded: 'x' }] })),
    (e) => e.code === 'INVALID_TOOL_OUTPUT',
  )
  assert.throws(
    () => assertDiffContract(fakeDiff({ humanReviewRequired: false })),
    (e) => e.code === 'INVALID_TOOL_OUTPUT',
  )
})

test('compare 出口：禁语整值重遮、ID 面 fail-loud、render 零短语（I1）', () => {
  const phrases = ['认定违规']
  const diff = fakeDiff({
    candidates: [
      {
        ...fakeDiff().candidates[0],
        pendingChecksAdded: ['疑似认定违规，待核实'],
      },
    ],
  })
  const masked = enforceOutputPolicy(diff, phrases)
  assert.equal(masked.candidates[0].pendingChecksAdded[0], '【禁语已脱敏】')
  // ID 面不改写：短语撞进 runIdA → fail-loud，拒绝产出
  const bad = fakeDiff({ runIdA: 'run-认定违规' })
  assert.throws(() => enforceOutputPolicy(bad, phrases), (e) => e.code === 'INVALID_TOOL_OUTPUT')
  // render：片段重遮 + 页脚合规字段 + 拼接后兜底
  const text = renderRunDiffText(diff, phrases)
  assert.ok(!text.includes('认定违规'))
  assert.ok(text.includes('humanReviewRequired=true'))
  assert.ok(text.includes('三层闭合'))
})

test('compare render：跨进程经持久后端取清单遮蔽（S2.2 + S2.1）', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-onto-runs-'))
  try {
    for (const runId of ['run-aaaaaaaa', 'run-bbbbbbbb']) {
      saveRunRecord(
        root,
        buildRunRecord({
          package: { name: 'test-pkg', version: '1.0.0' },
          dataset: fakeDataset(),
          result: fakeResult(runId),
          redlines: ['认定违规'],
        }),
      )
    }
    // 模拟新进程：内存为空，清单经 RunRecord.redlines 回读
    configurePhraseStore((runId) => loadRunRedlines(root, runId))
    const diff = fakeDiff({
      candidates: [
        {
          ...fakeDiff().candidates[0],
          pendingChecksAdded: ['疑似认定违规，待核实'],
        },
      ],
    })
    const text = renderRunDiffText(diff)
    assert.ok(!text.includes('认定违规'))
    assert.ok(text.includes('【禁语已脱敏】'))
    configurePhraseStore(null)
  } finally {
    rmSync(root, { recursive: true, force: true })
    configurePhraseStore(null)
  }
})

test('summarizeRunResult：计数摘要 + humanReviewRequired 恒真', () => {
  const s = summarizeRunResult(fakeResult())
  assert.equal(s.candidateCount, 1)
  assert.equal(s.hitRuleCount, 1)
  assert.equal(s.excludedCount, 0)
  assert.equal(s.auditPassed, true)
  assert.equal(s.forbiddenPhraseHitCount, 1)
  assert.equal(s.humanReviewRequired, true)
})

test('resolveBatchIds：显式去重保序 / 缺省全场景 / 错型拒（含非数组 fail-fast）', () => {
  const pkg = { scenarios: [{ id: 'SCN-A' }, { id: 'SCN-B' }] }
  assert.deepEqual(resolveBatchIds(undefined, pkg), ['SCN-A', 'SCN-B'])
  assert.deepEqual(resolveBatchIds(null, pkg), ['SCN-A', 'SCN-B'])
  assert.deepEqual(resolveBatchIds([], pkg), ['SCN-A', 'SCN-B'])
  assert.deepEqual(resolveBatchIds(['SCN-B', 'SCN-B', 'SCN-A'], pkg), ['SCN-B', 'SCN-A'])
  assert.throws(() => resolveBatchIds(['SCN-A', ''], pkg), (e) => e.code === 'INVALID_ARGS')
  assert.throws(() => resolveBatchIds([1], pkg), (e) => e.code === 'INVALID_ARGS')
  // 非数组（模型手误传字符串/对象）不得静默回退全场景——fail-fast
  assert.throws(() => resolveBatchIds('SCN-A', pkg), (e) => e.code === 'INVALID_ARGS')
  assert.throws(() => resolveBatchIds({ id: 'SCN-A' }, pkg), (e) => e.code === 'INVALID_ARGS')
})

test('assertBatchContract：ok/error 形态验形，NaN 计数拒（I5）', () => {
  const ok = {
    results: [
      {
        scenarioId: 'SCN-A',
        status: 'ok',
        runId: 'run-abc12345',
        summary: {
          candidateCount: 1,
          hitRuleCount: 1,
          excludedCount: 0,
          auditPassed: true,
          forbiddenPhraseHitCount: 0,
          humanReviewRequired: true,
        },
      },
      { scenarioId: 'SCN-B', status: 'error', error: { code: 'NOT_FOUND', message: '场景 SCN-B 不存在' } },
    ],
    humanReviewRequired: true,
  }
  assertBatchContract(ok)
  assert.throws(
    () =>
      assertBatchContract({
        results: [{ scenarioId: 'SCN-A', status: 'ok', runId: 'run-abc12345', summary: { ...ok.results[0].summary, candidateCount: NaN } }],
        humanReviewRequired: true,
      }),
    (e) => e.code === 'INVALID_TOOL_OUTPUT',
  )
  assert.throws(
    () => assertBatchContract({ results: [{ scenarioId: 'SCN-A', status: 'weird' }], humanReviewRequired: true }),
    (e) => e.code === 'INVALID_TOOL_OUTPUT',
  )
  assert.throws(
    () => assertBatchContract({ results: [], humanReviewRequired: false }),
    (e) => e.code === 'INVALID_TOOL_OUTPUT',
  )
})

function mkAmlBatchFixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-onto-batch-'))
  const ws = new PackageWorkspace(root)
  const dir = ws.versionDir('aml-analysis', '1.0.0')
  cpSync(AML_DIR, dir, { recursive: true })
  derivePackage(dir)
  const pkg = loadPackage(dir)
  const dataset = loadDatasetFromArgs({ dataset: JSON.parse(readFileSync(AML_RUN, 'utf8')) }, { baseDir: REPO })
  return { ws, root, dir, pkg, dataset }
}

test('runScenarioBatch：失败隔离（坏场景不污染好场景）+ RunRecord 落盘（S2.3）', () => {
  const { ws, root, dir, pkg, dataset } = mkAmlBatchFixture()
  try {
    const out = runScenarioBatch({
      ws,
      pkg,
      versionDir: dir,
      dataset,
      ids: ['SCN-AML-FIND-CLUES', 'SCN-NOPE'],
    })
    assertBatchContract(out)
    assert.equal(out.humanReviewRequired, true)
    assert.equal(out.results.length, 2)
    const [good, bad] = out.results
    assert.equal(good.status, 'ok')
    assert.ok(typeof good.runId === 'string' && good.runId.startsWith('run-'))
    assert.equal(good.summary.humanReviewRequired, true)
    assert.ok(good.summary.candidateCount >= 1)
    assert.equal(bad.status, 'error')
    assert.equal(bad.error.code, 'NOT_FOUND')
    assert.ok(bad.error.message.includes('SCN-NOPE'))
    // 好项已落 RunRecord（完整结果人审面）
    const rec = loadRunRecord(root, good.runId)
    assert.equal(rec.scenarioId, 'SCN-AML-FIND-CLUES')
    assert.ok(rec.result.candidates.length >= 1)
    assert.deepEqual(rec.redlines, [...rec.redlines]) // 形状自洽
  } finally {
    rmSync(root, { recursive: true, force: true })
    configurePhraseStore(null)
  }
})

test('runScenarioBatch：上限拒（包级前置 fail-loud，不半跑）', () => {
  const { ws, root, dir, pkg, dataset } = mkAmlBatchFixture()
  try {
    const ids = Array.from({ length: BATCH_RUN_LIMIT + 1 }, (_, i) => `SCN-X${i}`)
    assert.throws(
      () => runScenarioBatch({ ws, pkg, versionDir: dir, dataset, ids }),
      (e) => e.code === 'INVALID_ARGS',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
    configurePhraseStore(null)
  }
})

test('renderBatchText：error.message 禁语重遮 + 合规页脚', () => {
  const out = {
    results: [
      {
        scenarioId: 'SCN-A',
        status: 'error',
        error: { code: 'RUN_FAILED', message: '疑似认定违规，已终止' },
      },
    ],
    humanReviewRequired: true,
  }
  const text = renderBatchText(out, ['认定违规'])
  assert.ok(!text.includes('认定违规'))
  assert.ok(text.includes('【禁语已脱敏】'))
  assert.ok(text.includes('humanReviewRequired=true'))
  assert.ok(text.includes('RUN_FAILED'))
})

test('exportSummaryOf：模型面摘要零短语、locator 相对路径（S2.4）', () => {
  const rec = buildRunRecord({
    package: { name: 'test-pkg', version: '1.0.0' },
    dataset: fakeDataset(),
    result: fakeResult(),
    redlines: ['认定违规'],
  })
  const summary = exportSummaryOf({ locator: 'runs/exports/run-abc12345.json', archive: { ...rec, archivedAt: '2026-11-05T03:00:00.000Z' } })
  assert.equal(summary.exported, true)
  assert.equal(summary.runId, 'run-abc12345')
  assert.equal(summary.locator, 'runs/exports/run-abc12345.json')
  assert.equal(summary.auditPassed, true)
  assert.equal(summary.candidateCount, 1)
  assert.equal(summary.hitRuleCount, 1)
  assert.equal(summary.forbiddenPhraseHitCount, 1)
  assert.equal(summary.humanReviewRequired, true)
  assert.ok(!JSON.stringify(summary).includes('认定违规'))
  assert.ok(!summary.locator.includes(':') && !summary.locator.startsWith('/'))
})

test('export_audit 集成：batch → export，摘要与 RunRecord 一致、归档人审面完整', () => {
  const { ws, root, dir, pkg, dataset } = mkAmlBatchFixture()
  try {
    const out = runScenarioBatch({ ws, pkg, versionDir: dir, dataset, ids: ['SCN-AML-FIND-CLUES'] })
    const runId = out.results[0].runId
    const exported = exportRunArchive(root, runId)
    assert.equal(exported.locator, `runs/exports/${runId}.json`)
    const summary = exportSummaryOf(exported)
    assert.equal(summary.runId, runId)
    assert.equal(summary.candidateCount, out.results[0].summary.candidateCount)
    assert.equal(summary.auditPassed, out.results[0].summary.auditPassed)
    // 人审面归档：完整 result 与 redlines 在盘
    const rec = loadRunRecord(root, runId)
    assert.deepEqual(exported.archive.redlines, rec.redlines)
    assert.equal(exported.archive.result.candidates.length, summary.candidateCount)
    // 重复导出覆盖幂等
    const again = exportRunArchive(root, runId)
    assert.equal(again.locator, exported.locator)
  } finally {
    rmSync(root, { recursive: true, force: true })
    configurePhraseStore(null)
  }
})

test('runScenarioBatch：med 域全场景批量过装配断言（多域同口径，S2.3）', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-onto-batch-med-'))
  try {
    const ws = new PackageWorkspace(root)
    const dir = ws.versionDir('med-safety', '1.0.0')
    cpSync(MED_DIR, dir, { recursive: true })
    derivePackage(dir)
    const pkg = loadPackage(dir)
    const dataset = loadDatasetFromArgs({ dataset: JSON.parse(readFileSync(MED_RUN, 'utf8')) }, { baseDir: REPO })
    const ids = pkg.scenarios.map((s) => s.id)
    assert.ok(ids.length >= 1, 'med 包应有场景')
    const out = runScenarioBatch({ ws, pkg, versionDir: dir, dataset, ids })
    assertBatchContract(out)
    assert.equal(out.results.length, ids.length)
    for (const item of out.results) {
      assert.equal(item.status, 'ok', `${item.scenarioId} 应成功: ${JSON.stringify(item.error ?? null)}`)
      assert.equal(item.summary.humanReviewRequired, true)
      loadRunRecord(root, item.runId)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
    configurePhraseStore(null)
  }
})
