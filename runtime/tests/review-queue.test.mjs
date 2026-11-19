/**
 * aml-review-workbench S2.1 — listReviewQueue 复核待办联合口径。
 * pending = 无 ReviewDecision；有决定取最新；store 缺失 fail-loud 不假 pending。
 * listRuns 与台账解耦：workbench 历史页不依赖 action-store。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { OntoRuntime, actionStoreFor, closeActionStore } from '../dist/index.js'
import { buildRunRecord, saveRunRecord } from '@dsh-onto/core'

function seedRun(wsRoot, runId, savedAt) {
  const dataset = {
    objects: [{ id: 'ACC-1', type: 'OBJ-AML-ACCOUNT' }],
    relations: [],
    behaviors: [],
    candidates: [{ candidateId: 'CAND-001', objectRef: 'OBJ-AML-ACCOUNT:ACC-1' }],
  }
  const result = {
    scenarioId: 'SCN-AML-FIND-CLUES',
    runId,
    startedAt: savedAt,
    candidates: [
      {
        candidateId: 'CAND-001',
        objectRef: 'OBJ-AML-ACCOUNT:ACC-1',
        riskScore: 0.9,
        hitRuleIds: ['RULE-X'],
        evidenceChains: [{ ruleId: 'RULE-X', score: 0.9, evidence: 'e' }],
        narrative: [],
        pendingChecks: [],
        pendingVerification: false,
      },
    ],
    excluded: [],
    humanReviewRequired: true,
    reviewGate: { threshold: 0.5, required: true, requireReviewFor: ['high'] },
    ruleHitLog: [{ ruleId: 'RULE-X', candidateId: 'CAND-001', score: 0.9, ts: savedAt }],
    audit: { checks: [], forbiddenPhraseHits: [], passed: true },
  }
  saveRunRecord(
    wsRoot,
    buildRunRecord({
      package: { name: 'aml-analysis', version: '1.0.0' },
      dataset,
      result,
      redlines: [],
      savedAt,
    }),
  )
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'onto-review-queue-'))
  const wsRoot = join(dir, 'dsh-onto', 'workspace')
  mkdirSync(wsRoot, { recursive: true })
  const ctx = new Context()
  ctx.reflect.provide('profileContext', { dir })
  const service = new OntoRuntime(ctx)
  return {
    dir,
    wsRoot,
    service,
    dispose() {
      closeActionStore(wsRoot)
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('listReviewQueue：无决定=pending；最新决定覆盖状态；pending 排前', async () => {
  const f = fixture()
  try {
    seedRun(f.wsRoot, 'run-pending', '2026-11-19T00:00:00.000Z')
    seedRun(f.wsRoot, 'run-approved', '2026-11-19T01:00:00.000Z')
    seedRun(f.wsRoot, 'run-rejected-then-approved', '2026-11-19T02:00:00.000Z')

    const store = actionStoreFor(f.wsRoot)
    store.createDecision({
      runId: 'run-approved',
      candidateIds: ['CAND-001'],
      snapshotDigest: 'deadbeef',
      ruleFingerprint: 'aml-analysis@1.0.0',
      reviewer: 'host:u1',
      decision: 'approved',
      reason: 'ok',
    })
    store.createDecision({
      runId: 'run-rejected-then-approved',
      candidateIds: ['CAND-001'],
      snapshotDigest: 'deadbeef',
      ruleFingerprint: 'aml-analysis@1.0.0',
      reviewer: 'host:u1',
      decision: 'rejected',
      reason: 'first-reject',
    })
    // 同毫秒可能同 createdAt——用稍后调用确保第二条更新
    await new Promise((r) => setTimeout(r, 5))
    store.createDecision({
      runId: 'run-rejected-then-approved',
      candidateIds: ['CAND-001'],
      snapshotDigest: 'deadbeef',
      ruleFingerprint: 'aml-analysis@1.0.0',
      reviewer: 'host:u1',
      decision: 'approved',
      reason: 'second-approve',
    })

    const { runs } = await f.service.remoteExportListReviewQueue()
    const byId = Object.fromEntries(runs.map((r) => [r.runId, r]))

    assert.equal(byId['run-pending'].reviewStatus, 'pending')
    assert.equal(byId['run-pending'].latestDecision, undefined)

    assert.equal(byId['run-approved'].reviewStatus, 'approved')
    assert.equal(byId['run-approved'].latestDecision.decision, 'approved')
    assert.equal(byId['run-approved'].latestDecision.reason, 'ok')
    assert.deepEqual(byId['run-approved'].latestDecision.candidateIds, ['CAND-001'])

    assert.equal(byId['run-rejected-then-approved'].reviewStatus, 'approved')
    assert.equal(byId['run-rejected-then-approved'].latestDecision.reason, 'second-approve')

    // pending 排最前
    assert.equal(runs[0].runId, 'run-pending')
    // 其余 savedAt 倒序
    const rest = runs.slice(1).map((r) => r.runId)
    assert.deepEqual(rest, ['run-rejected-then-approved', 'run-approved'])
  } finally {
    f.dispose()
  }
})

test('listReviewQueue：既有字段形状不回归（runId/scenario/package/digest/audit/savedAt）', async () => {
  const f = fixture()
  try {
    seedRun(f.wsRoot, 'run-shape', '2026-11-19T03:00:00.000Z')
    const { runs } = await f.service.remoteExportListReviewQueue()
    const row = runs.find((r) => r.runId === 'run-shape')
    assert.ok(row)
    assert.equal(row.scenarioId, 'SCN-AML-FIND-CLUES')
    assert.deepEqual(row.package, { name: 'aml-analysis', version: '1.0.0' })
    assert.equal(typeof row.datasetDigest, 'string')
    assert.equal(row.datasetDigest.length, 12)
    assert.equal(row.auditPassed, true)
    assert.equal(typeof row.savedAt, 'string')
    assert.equal(row.reviewStatus, 'pending')
  } finally {
    f.dispose()
  }
})

test('listReviewQueue：action-store 打不开 → fail-loud，不静默全部标 pending', async () => {
  const f = fixture()
  try {
    seedRun(f.wsRoot, 'run-failoud', '2026-11-19T04:00:00.000Z')
    // 先正常读通，确认有 run
    const ok = await f.service.remoteExportListReviewQueue()
    assert.equal(ok.runs.length, 1)

    // 破坏台账：把 ledger.db 换成目录 → DatabaseSync 打开失败
    closeActionStore(f.wsRoot)
    const dbPath = join(f.wsRoot, 'actions', 'ledger.db')
    if (existsSync(dbPath) && statSync(dbPath).isFile()) rmSync(dbPath)
    mkdirSync(dbPath, { recursive: true })

    await assert.rejects(
      () => f.service.remoteExportListReviewQueue(),
      () => true,
      'store 损坏时 listReviewQueue 必须抛错（fail-loud）',
    )
  } finally {
    f.dispose()
  }
})

test('listRuns：与 action-store 解耦——台账损坏仍可读运行历史', async () => {
  const f = fixture()
  try {
    seedRun(f.wsRoot, 'run-history-ok', '2026-11-19T05:00:00.000Z')
    const ok = await f.service.remoteExportListRuns()
    assert.equal(ok.runs.length, 1)
    // 历史面不携带 review 字段（复核状态归 listReviewQueue）
    assert.equal(ok.runs[0].reviewStatus, undefined)

    closeActionStore(f.wsRoot)
    const dbPath = join(f.wsRoot, 'actions', 'ledger.db')
    if (existsSync(dbPath) && statSync(dbPath).isFile()) rmSync(dbPath)
    mkdirSync(dbPath, { recursive: true })

    const after = await f.service.remoteExportListRuns()
    assert.equal(after.runs.length, 1, '台账损坏不得打挂 listRuns')
    assert.equal(after.runs[0].runId, 'run-history-ok')
  } finally {
    f.dispose()
  }
})
