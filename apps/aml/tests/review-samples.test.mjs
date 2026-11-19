/**
 * aml-review-workbench S2.6 — 四类可回放验收样例：
 * S-a 正常命中 / S-b 证据不足 / S-c 审批拒绝 / S-d 受理后超时（待对账）。
 *
 * 进程内 wire + action-store；不搭评测平台、不接 LLM。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import {
  OntoRuntime,
  actionStoreFor,
  closeActionStore,
  businessPolicy,
  runtimeContextForHost,
} from '@dsh-onto/runtime'
import { buildRunRecord, saveRunRecord } from '@dsh-onto/core'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

function makeResult(runId, overrides = {}) {
  const base = {
    scenarioId: 'SCN-AML-FIND-CLUES',
    runId,
    startedAt: '2026-11-19T00:00:00.000Z',
    candidates: [
      {
        candidateId: 'CAND-001',
        objectRef: 'OBJ-AML-ACCOUNT:ACC-1',
        riskScore: 0.9,
        hitRuleIds: ['RULE-AML-SCORE-FANOUT'],
        evidenceChains: [
          { ruleId: 'RULE-AML-SCORE-FANOUT', score: 0.9, evidence: '多层转出且对手方集中' },
        ],
        narrative: ['候选 CAND-001 命中评分规则'],
        pendingChecks: [],
        pendingVerification: false,
      },
    ],
    excluded: [],
    humanReviewRequired: true,
    reviewGate: { threshold: 0.75, required: true, requireReviewFor: ['CAND-001'] },
    ruleHitLog: [
      { ruleId: 'RULE-AML-SCORE-FANOUT', candidateId: 'CAND-001', score: 0.9, ts: '2026-11-19T00:00:00.000Z' },
    ],
    audit: { checks: [], forbiddenPhraseHits: [], passed: true },
    ...overrides,
  }
  return base
}

function seed(wsRoot, runId, resultOverrides = {}) {
  const dataset = {
    objects: [{ id: 'ACC-1', type: 'OBJ-AML-ACCOUNT' }],
    relations: [],
    behaviors: [],
    candidates: [{ candidateId: 'CAND-001', objectRef: 'OBJ-AML-ACCOUNT:ACC-1' }],
  }
  const rec = buildRunRecord({
    package: { name: 'aml-analysis', version: '1.0.0' },
    dataset,
    result: makeResult(runId, resultOverrides),
    redlines: [],
    savedAt: '2026-11-19T00:00:00.000Z',
  })
  saveRunRecord(wsRoot, rec)
  return rec
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'onto-samples-'))
  const wsRoot = join(dir, 'dsh-onto', 'workspace')
  mkdirSync(wsRoot, { recursive: true })
  const ctx = new Context()
  ctx.reflect.provide('profileContext', { dir })
  const service = new OntoRuntime(ctx)
  const runtime = runtimeContextForHost(ctx.root)
  runtime.run(() => {
    businessPolicy.setIdentityProvider(() => ({
      userId: 'u-sample',
      tenant: 't1',
      roles: ['analyst'],
      dataScope: { objectTypes: [] },
    }))
  })
  return {
    wsRoot,
    service,
    dispose() {
      runtime.run(() => businessPolicy.setIdentityProvider(null))
      closeActionStore(wsRoot)
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function approveArgs(rec, extra = {}) {
  return {
    runId: rec.runId,
    candidateIds: ['CAND-001'],
    snapshotDigest: rec.datasetDigest,
    ruleFingerprint: 'aml-analysis@1.0.0',
    decision: 'approved',
    ...extra,
  }
}

/* ── S-a 正常命中 ─────────────────────────────────────────── */

test('S-a 正常命中：pending 列表 → 证据齐全 → approved 落库', async () => {
  const f = fixture()
  try {
    const rec = seed(f.wsRoot, 'run-sa-normal')
    let { runs } = await f.service.remoteExportListRuns()
    const row = runs.find((r) => r.runId === rec.runId)
    assert.equal(row.reviewStatus, 'pending')
    assert.equal(row.latestDecision, undefined)

    const detail = await f.service.remoteExportShowRun({ runId: rec.runId })
    const cand = detail.record.result.candidates[0]
    assert.equal(cand.pendingVerification, false)
    assert.equal(cand.pendingChecks.length, 0)
    assert.ok(cand.evidenceChains.length > 0, '证据链非空')
    assert.ok(cand.hitRuleIds.includes('RULE-AML-SCORE-FANOUT'))
    assert.equal(detail.record.result.audit.passed, true)

    const out = await f.service.remoteExportRecordReviewDecision(approveArgs(rec, { reason: '证据充分' }))
    assert.equal(out.decision, 'approved')
    assert.equal(out.reviewer, 'host:u-sample')

    runs = (await f.service.remoteExportListRuns()).runs
    const after = runs.find((r) => r.runId === rec.runId)
    assert.equal(after.reviewStatus, 'approved')
    assert.equal(after.latestDecision.reason, '证据充分')
    // 判分与证据一致：分数与命中规则仍来自 RunRecord，复核不改分
    assert.equal(detail.record.result.candidates[0].riskScore, 0.9)
  } finally {
    f.dispose()
  }
})

/* ── S-b 证据不足 ─────────────────────────────────────────── */

test('S-b 证据不足：缺数可见 → 可拒绝；不得假装 audit 闭合', async () => {
  const f = fixture()
  try {
    const rec = seed(f.wsRoot, 'run-sb-thin', {
      candidates: [
        {
          candidateId: 'CAND-001',
          objectRef: 'OBJ-AML-ACCOUNT:ACC-1',
          riskScore: 0.8,
          hitRuleIds: ['RULE-AML-SCORE-FANOUT'],
          evidenceChains: [{ ruleId: 'RULE-AML-SCORE-FANOUT', score: 0.8, evidence: '仅部分特征' }],
          narrative: [],
          pendingChecks: [
            { ruleId: 'RULE-AML-SCORE-FANOUT', missing: ['txnCount'], note: '交易笔数特征缺失' },
          ],
          pendingVerification: true,
        },
      ],
      audit: {
        checks: [
          { check: 'DATA_TRUST', closed: false, detail: 'inline 数据未核验', ts: '2026-11-19T00:00:00.000Z', blocking: false },
        ],
        forbiddenPhraseHits: [],
        passed: false,
      },
    })

    const detail = await f.service.remoteExportShowRun({ runId: rec.runId })
    const cand = detail.record.result.candidates[0]
    assert.equal(cand.pendingVerification, true)
    assert.ok(cand.pendingChecks.length > 0, '缺数必须暴露')
    assert.ok(cand.pendingChecks[0].missing.includes('txnCount'))
    assert.equal(detail.record.result.audit.passed, false, '证据不足时 audit 不得假装通过')

    const out = await f.service.remoteExportRecordReviewDecision(
      approveArgs(rec, { decision: 'rejected', reason: '证据不足，缺 txnCount' }),
    )
    assert.equal(out.decision, 'rejected')

    const { runs } = await f.service.remoteExportListRuns()
    const row = runs.find((r) => r.runId === rec.runId)
    assert.equal(row.reviewStatus, 'rejected')
    assert.match(row.latestDecision.reason, /证据不足/)
  } finally {
    f.dispose()
  }
})

/* ── S-c 审批拒绝 ─────────────────────────────────────────── */

test('S-c 审批拒绝：rejected 上墙 → 追加 approved 翻转为最新', async () => {
  const f = fixture()
  try {
    const rec = seed(f.wsRoot, 'run-sc-reject')
    await f.service.remoteExportRecordReviewDecision(
      approveArgs(rec, { decision: 'rejected', reason: '业务口径不符' }),
    )
    let { runs } = await f.service.remoteExportListRuns()
    let row = runs.find((r) => r.runId === rec.runId)
    assert.equal(row.reviewStatus, 'rejected')
    assert.equal(row.latestDecision.decision, 'rejected')
    assert.equal(row.latestDecision.reason, '业务口径不符')

    await new Promise((r) => setTimeout(r, 5))
    await f.service.remoteExportRecordReviewDecision(
      approveArgs(rec, { decision: 'approved', reason: '补充材料后通过' }),
    )
    runs = (await f.service.remoteExportListRuns()).runs
    row = runs.find((r) => r.runId === rec.runId)
    assert.equal(row.reviewStatus, 'approved')
    assert.equal(row.latestDecision.reason, '补充材料后通过')

    // 治理链保留两条决定历史
    const chain = await f.service.remoteExportReviewChain({ runId: rec.runId })
    assert.equal(chain.decisions.length, 2)
    const decisions = chain.decisions.map((d) => d.decision).sort()
    assert.deepEqual(decisions, ['approved', 'rejected'])
  } finally {
    f.dispose()
  }
})

/* ── S-d 受理后超时 → 待对账 ──────────────────────────────── */

function seedUnknownAction(store, dec, proposal, runId) {
  const claimed = store.claim({
    actionId: 'act-sd-timeout',
    businessKey: `bk-sd-${runId}`,
    approvalContext: 's-d-ctx',
    connector: { id: 'ticket-sim', env: 'test', kind: 'simulated' },
    behaviorId: 'BHV-AML-OPEN-REVIEW-TICKET',
    objectRef: 'OBJ-AML-ACCOUNT:ACC-1',
    payload: { title: 'S-d 超时工单' },
    status: 'executing',
    phase: 'dispatched',
    approvalDigest: 's-d-approval',
    approvedAt: '2026-11-19T00:00:00.000Z',
    executedAt: '2026-11-19T00:00:01.000Z',
    intentDigest: 's-d-intent',
    decisionId: dec.decisionId,
    proposalId: proposal.proposalId,
    operationId: proposal.operationId,
  })
  assert.equal(claimed.created, true)
  // 受理后超时：效应不明 → unknown（禁止写成无效应失败）
  const settled = store.settle(`bk-sd-${runId}`, claimed.record.version, {
    status: 'unknown',
    error: 'accept-timeout——效应不明，待人工对账',
  })
  assert.equal(settled.status, 'unknown')
  return settled
}

test('S-d 受理后超时：unknown 台账 → 治理链待对账；UI 无重新执行引导', async () => {
  const f = fixture()
  try {
    const rec = seed(f.wsRoot, 'run-sd-timeout')
    const store = actionStoreFor(f.wsRoot)
    const dec = await f.service.remoteExportRecordReviewDecision(approveArgs(rec))
    const proposal = store.createProposal({
      decisionId: dec.decisionId,
      runId: rec.runId,
      candidateId: 'CAND-001',
      behaviorId: 'BHV-AML-OPEN-REVIEW-TICKET',
      objectRef: 'OBJ-AML-ACCOUNT:ACC-1',
      payload: { title: 'S-d 超时工单' },
      intentDigest: 's-d-intent',
      connectorId: 'ticket-sim',
      connectorEnv: 'test',
      connectorKind: 'simulated',
    })
    const action = seedUnknownAction(store, dec, proposal, rec.runId)

    const chain = await f.service.remoteExportReviewChain({ runId: rec.runId })
    assert.equal(chain.decisions.length, 1)
    assert.equal(chain.proposals.length, 1)
    assert.equal(chain.actions.length, 1)
    assert.equal(chain.actions[0].status, 'unknown')
    assert.equal(chain.actions[0].actionId, action.actionId)

    // 列表仍显示复核状态（unknown 动作不改变 reviewStatus 口径）
    const { runs } = await f.service.remoteExportListRuns()
    const row = runs.find((r) => r.runId === rec.runId)
    assert.equal(row.reviewStatus, 'approved')

    // UI 源码契约：unknown/dispatched → 待对账，无重新执行
    const appSrc = readFileSync(join(REPO, 'apps', 'aml', 'src', 'client', 'app.ts'), 'utf8')
    assert.ok(appSrc.includes("status === 'unknown'"))
    assert.ok(appSrc.includes("status === 'dispatched'") || appSrc.includes("phase === 'dispatched'"))
    assert.ok(appSrc.includes('pendingReconcile') || appSrc.includes('待对账'))
    assert.ok(!/重新执行|re-?execute/i.test(appSrc), '不得引导重新执行')
    const clientSrc = readFileSync(join(REPO, 'apps', 'aml', 'src', 'client.ts'), 'utf8')
    assert.ok(!clientSrc.includes('reconcile_action'), '对账工具不进 UI 描述符')
    assert.ok(!clientSrc.includes('execute_behavior_action'), '执行工具不进 UI 描述符')
  } finally {
    f.dispose()
  }
})
