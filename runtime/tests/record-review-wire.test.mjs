/**
 * aml-review-workbench S2.3 — recordReviewDecision wire：
 * 五类校验错误码零写入；成功落 ReviewDecision；UI 候选越界拒绝；无身份 fail-closed。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  OntoRuntime,
  actionStoreFor,
  closeActionStore,
  businessPolicy,
  runtimeContextForHost,
} from '../dist/index.js'
import { buildRunRecord, saveRunRecord } from '@dsh-onto/core'

function seedRun(wsRoot, runId = 'run-wire00001') {
  const dataset = {
    objects: [{ id: 'ACC-1', type: 'OBJ-AML-ACCOUNT' }],
    relations: [],
    behaviors: [],
    candidates: [{ candidateId: 'CAND-001', objectRef: 'OBJ-AML-ACCOUNT:ACC-1' }],
  }
  const result = {
    scenarioId: 'SCN-AML-FIND-CLUES',
    runId,
    startedAt: '2026-11-19T00:00:00.000Z',
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
    ruleHitLog: [{ ruleId: 'RULE-X', candidateId: 'CAND-001', score: 0.9, ts: '2026-11-19T00:00:00.000Z' }],
    audit: { checks: [], forbiddenPhraseHits: [], passed: true },
  }
  const rec = buildRunRecord({
    package: { name: 'aml-analysis', version: '1.0.0' },
    dataset,
    result,
    redlines: [],
    savedAt: '2026-11-19T00:00:00.000Z',
  })
  saveRunRecord(wsRoot, rec)
  return rec
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'onto-rrd-'))
  const wsRoot = join(dir, 'dsh-onto', 'workspace')
  mkdirSync(wsRoot, { recursive: true })
  const ctx = new Context()
  ctx.reflect.provide('profileContext', { dir })
  const service = new OntoRuntime(ctx)
  // 身份须在 OntoRuntime 绑定的 runtime 上下文内设置（wire 方法经 runtime.bind 执行）
  const runtime = runtimeContextForHost(ctx.root)
  runtime.run(() => {
    businessPolicy.setIdentityProvider(() => ({
      userId: 'u-wire',
      tenant: 't1',
      roles: ['analyst'],
      dataScope: { objectTypes: [] },
    }))
  })
  return {
    wsRoot,
    service,
    setIdentity(provider) {
      runtime.run(() => businessPolicy.setIdentityProvider(provider))
    },
    dispose() {
      runtime.run(() => businessPolicy.setIdentityProvider(null))
      closeActionStore(wsRoot)
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function baseArgs(rec) {
  return {
    runId: rec.runId,
    candidateIds: ['CAND-001'],
    snapshotDigest: rec.datasetDigest,
    ruleFingerprint: 'aml-analysis@1.0.0',
    decision: 'approved',
    reason: 'ui-ok',
  }
}

async function expectOrigCode(fn, origCode) {
  await assert.rejects(fn, (e) => {
    const got = e.details?.origCode ?? e.code
    assert.equal(got, origCode, `expected origCode ${origCode}, got ${got} (code=${e.code})`)
    return true
  })
}

test('recordReviewDecision：成功落库 + reviewer=host:身份 + humanReviewRequired', async () => {
  const f = fixture()
  try {
    const rec = seedRun(f.wsRoot)
    const out = await f.service.remoteExportRecordReviewDecision(baseArgs(rec))
    assert.equal(out.decision, 'approved')
    assert.equal(out.reviewer, 'host:u-wire')
    assert.equal(out.humanReviewRequired, true)
    assert.deepEqual(out.candidateIds, ['CAND-001'])
    const dec = actionStoreFor(f.wsRoot).getDecision(out.decisionId)
    assert.ok(dec)
    assert.equal(dec.runId, rec.runId)
    assert.equal(dec.reviewer, 'host:u-wire')
    assert.equal(dec.reason, 'ui-ok')
  } finally {
    f.dispose()
  }
})

test('recordReviewDecision：五类校验失败零写入', async () => {
  const f = fixture()
  try {
    const rec = seedRun(f.wsRoot)
    const store = actionStoreFor(f.wsRoot)
    const before = store.listDecisions().length

    await expectOrigCode(
      () => f.service.remoteExportRecordReviewDecision({ ...baseArgs(rec), runId: 'run-nope' }),
      'REVIEW_RUN_NOT_FOUND',
    )
    await expectOrigCode(
      () => f.service.remoteExportRecordReviewDecision({ ...baseArgs(rec), snapshotDigest: 'deadbeef1234' }),
      'REVIEW_SNAPSHOT_MISMATCH',
    )
    await expectOrigCode(
      () => f.service.remoteExportRecordReviewDecision({ ...baseArgs(rec), ruleFingerprint: 'other@9.9.9' }),
      'REVIEW_RULE_MISMATCH',
    )
    await expectOrigCode(
      () => f.service.remoteExportRecordReviewDecision({ ...baseArgs(rec), candidateIds: ['CAND-NOPE'] }),
      'REVIEW_CANDIDATE_UNKNOWN',
    )
    await expectOrigCode(
      () => f.service.remoteExportRecordReviewDecision({ ...baseArgs(rec), decision: 'maybe' }),
      'INVALID_ARGS',
    )
    assert.equal(store.listDecisions().length, before, '校验失败不得落决定')
  } finally {
    f.dispose()
  }
})

test('recordReviewDecision：无身份 fail-closed REVIEWER_UNCONFIRMED 零写入', async () => {
  const f = fixture()
  try {
    const rec = seedRun(f.wsRoot)
    f.setIdentity(null)
    const before = actionStoreFor(f.wsRoot).listDecisions().length
    await expectOrigCode(
      () => f.service.remoteExportRecordReviewDecision(baseArgs(rec)),
      'REVIEWER_UNCONFIRMED',
    )
    assert.equal(actionStoreFor(f.wsRoot).listDecisions().length, before)
  } finally {
    f.dispose()
  }
})

test('recordReviewDecision：追加决定后 listRuns 状态翻转为最新', async () => {
  const f = fixture()
  try {
    const rec = seedRun(f.wsRoot, 'run-flip00001')
    await f.service.remoteExportRecordReviewDecision({ ...baseArgs(rec), decision: 'rejected', reason: 'no' })
    let { runs } = await f.service.remoteExportListRuns()
    assert.equal(runs.find((r) => r.runId === rec.runId).reviewStatus, 'rejected')

    await new Promise((r) => setTimeout(r, 5))
    await f.service.remoteExportRecordReviewDecision({ ...baseArgs(rec), decision: 'approved', reason: 'yes' })
    runs = (await f.service.remoteExportListRuns()).runs
    const row = runs.find((r) => r.runId === rec.runId)
    assert.equal(row.reviewStatus, 'approved')
    assert.equal(row.latestDecision.reason, 'yes')
  } finally {
    f.dispose()
  }
})
