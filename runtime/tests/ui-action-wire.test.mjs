/**
 * issue #30 WP-C — 页面动作面 wire：提案 / 两段式批准卡 / 执行 / 对账。
 * 口径：批准挑战单次 + TTL + 摘要绑定（fail-closed）；批准人宿主身份落台账；
 * 提案 ≠ 批准（仅获准候选）；对账禁自动重跑；无身份不得探测。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import {
  OntoRuntime,
  actionStoreFor,
  closeActionStore,
  businessPolicy,
  runtimeContextForHost,
  issueUiApprovalChallenge,
  registerActionConnector,
} from '../dist/index.js'
import { buildRunRecord, derivePackage, saveRunRecord } from '@dsh-onto/core'

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const AML_SRC = join(REPO, 'packages', 'aml', '1.0.0')

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'onto-ui-action-'))
  const wsRoot = join(dir, 'dsh-onto', 'workspace')
  const versionDir = join(wsRoot, 'packages', 'aml-analysis', '1.0.0')
  mkdirSync(join(versionDir, '..'), { recursive: true })
  cpSync(AML_SRC, versionDir, { recursive: true })
  derivePackage(versionDir)
  const ctx = new Context()
  ctx.reflect.provide('profileContext', { dir })
  const service = new OntoRuntime(ctx)
  const runtime = runtimeContextForHost(ctx.root)
  runtime.run(() => {
    businessPolicy.setIdentityProvider(() => ({
      userId: 'u-wpa',
      tenant: 't1',
      roles: ['analyst'],
      dataScope: { objectTypes: ['OBJ-AML-ACCOUNT', 'OBJ-AML-CUSTOMER', 'OBJ-AML-TXN'] },
    }))
  })
  return {
    dir,
    wsRoot,
    service,
    runtime,
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

/** act 目标存在性证据：运行台账候选对象Ref（数据面实例）。 */
function seedRun(wsRoot, runId = 'run-wpa000001', instance = 'ACCT-001') {
  const dataset = {
    objects: [{ id: instance, type: 'OBJ-AML-ACCOUNT' }],
    relations: [],
    behaviors: [],
    candidates: [{ candidateId: 'CAND-001', objectRef: `OBJ-AML-ACCOUNT:${instance}` }],
  }
  const result = {
    scenarioId: 'SCN-AML-FIND-CLUES',
    runId,
    startedAt: '2026-11-24T00:00:00.000Z',
    candidates: [
      {
        candidateId: 'CAND-001',
        objectRef: `OBJ-AML-ACCOUNT:${instance}`,
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
    ruleHitLog: [{ ruleId: 'RULE-X', candidateId: 'CAND-001', score: 0.9, ts: '2026-11-24T00:00:00.000Z' }],
    audit: { checks: [], forbiddenPhraseHits: [], passed: true },
  }
  const rec = buildRunRecord({
    package: { name: 'aml-analysis', version: '1.0.0' },
    dataset,
    result,
    redlines: [],
    savedAt: '2026-11-24T00:00:00.000Z',
  })
  saveRunRecord(wsRoot, rec)
  return rec
}

function seedDecision(wsRoot, runId, overrides = {}) {
  return actionStoreFor(wsRoot).createDecision({
    runId,
    candidateIds: ['CAND-001'],
    snapshotDigest: 'deadbeefdeadbeef',
    ruleFingerprint: 'aml-analysis@1.0.0',
    reviewer: 'host:u-wpa',
    decision: 'approved',
    reason: 'ok',
    ...overrides,
  })
}

const ACTION_ARGS = {
  name: 'aml-analysis',
  version: '1.0.0',
  behaviorId: 'BHV-AML-TRANSFER',
  objectRef: 'OBJ-AML-ACCOUNT:ACCT-001',
  payload: { amount: 1, note: 'wire-face' },
}

async function expectOrigCode(fn, origCode) {
  await assert.rejects(fn, (e) => {
    const got = e.details?.origCode ?? e.code
    assert.equal(got, origCode, `expected origCode ${origCode}, got ${got} (code=${e.code})`)
    return true
  })
}

test('createActionProposal：approved 决定 + 候选在集内 → 服务端 operationId；提案 ≠ 批准', async () => {
  const f = fixture()
  try {
    const rec = seedRun(f.wsRoot)
    const dec = seedDecision(f.wsRoot, rec.runId)
    const out = await f.service.remoteExportCreateActionProposal({
      decisionId: dec.decisionId,
      runId: rec.runId,
      candidateId: 'CAND-001',
      ...ACTION_ARGS,
    })
    assert.equal(out.decisionId, dec.decisionId)
    assert.equal(out.candidateId, 'CAND-001')
    assert.match(out.proposalId, /^PROP-/)
    assert.match(out.operationId, /^OP-/)
    assert.equal(out.humanReviewRequired, true)
    const saved = actionStoreFor(f.wsRoot).getProposal(out.proposalId)
    assert.equal(saved.status, 'pending', '提案不是执行批准：pending 待批准卡')
  } finally {
    f.dispose()
  }
})

test('createActionProposal：未获准决定 / 候选越界 → 拒（REVIEW_*）', async () => {
  const f = fixture()
  try {
    const rec = seedRun(f.wsRoot, 'run-wpa000002')
    const rejected = seedDecision(f.wsRoot, rec.runId, { decision: 'rejected', reason: 'no' })
    await expectOrigCode(
      () => f.service.remoteExportCreateActionProposal({
        decisionId: rejected.decisionId, runId: rec.runId, candidateId: 'CAND-001', ...ACTION_ARGS,
      }),
      'REVIEW_NOT_APPROVED',
    )
    const approved = seedDecision(f.wsRoot, rec.runId)
    await expectOrigCode(
      () => f.service.remoteExportCreateActionProposal({
        decisionId: approved.decisionId, runId: rec.runId, candidateId: 'CAND-GHOST', ...ACTION_ARGS,
      }),
      'REVIEW_CANDIDATE_NOT_ALLOWED',
    )
  } finally {
    f.dispose()
  }
})

test('prepareAction → executeAction：两段式批准全链（提案消费 + approvedBy 落台账）', async () => {
  const f = fixture()
  try {
    const rec = seedRun(f.wsRoot, 'run-wpa000003')
    const dec = seedDecision(f.wsRoot, rec.runId)
    const proposal = await f.service.remoteExportCreateActionProposal({
      decisionId: dec.decisionId, runId: rec.runId, candidateId: 'CAND-001', ...ACTION_ARGS,
    })
    const prep = await f.service.remoteExportPrepareAction({ ...ACTION_ARGS, proposalId: proposal.proposalId })
    assert.match(prep.challengeId, /^uiac-/)
    assert.equal(prep.contextDigest.length, 64)
    assert.equal(prep.approvalCard.behaviorId, 'BHV-AML-TRANSFER')
    assert.equal(prep.approvalCard.operationId, proposal.operationId)
    assert.equal(prep.humanReviewRequired, true)

    const out = await f.service.remoteExportExecuteAction({
      ...ACTION_ARGS,
      proposalId: proposal.proposalId,
      approval: { challengeId: prep.challengeId, contextDigest: prep.contextDigest },
    })
    assert.equal(out.status, 'succeeded')
    assert.equal(out.replayed, false)
    assert.equal(out.humanReviewRequired, true)
    assert.equal(out.simulated, true, '演练/模拟性质显式上墙')
    assert.equal(out.approvedBy, 'host:u-wpa', '批准人宿主身份落台账')
    assert.match(out.externalRef ?? '', /^dryrun:/)

    const stored = actionStoreFor(f.wsRoot).getProposal(proposal.proposalId)
    assert.equal(stored.status, 'consumed', '提案单次消费')
    const chain = await f.service.remoteExportReviewChain({ runId: rec.runId })
    assert.equal(chain.actions.length, 1)
    assert.equal(chain.actions[0].proposalId, proposal.proposalId)
    assert.equal(chain.actions[0].approvedBy, 'host:u-wpa')
  } finally {
    f.dispose()
  }
})

test('prepareAction：提案↔意图不符 → PROPOSAL_INTENT_MISMATCH（卡面不得混搭错提案）', async () => {
  const f = fixture()
  try {
    const rec = seedRun(f.wsRoot, 'run-wpa000011')
    const dec = seedDecision(f.wsRoot, rec.runId)
    const proposal = await f.service.remoteExportCreateActionProposal({
      decisionId: dec.decisionId, runId: rec.runId, candidateId: 'CAND-001', ...ACTION_ARGS,
    })
    // 载荷被篡改：卡面若签发会显示「提案 operationId + 异意图载荷」误导批准人
    await expectOrigCode(
      () => f.service.remoteExportPrepareAction({
        ...ACTION_ARGS,
        payload: { amount: 999, note: 'tampered' },
        proposalId: proposal.proposalId,
      }),
      'PROPOSAL_INTENT_MISMATCH',
    )
    // 对象引用被替换为另一可见实例（授权过、但意图不符）：同拒
    seedRun(f.wsRoot, 'run-wpa000012', 'ACCT-002')
    await expectOrigCode(
      () => f.service.remoteExportPrepareAction({
        ...ACTION_ARGS,
        objectRef: 'OBJ-AML-ACCOUNT:ACCT-002',
        proposalId: proposal.proposalId,
      }),
      'PROPOSAL_INTENT_MISMATCH',
    )
    // 同意图可正常签发（负例对照）
    const ok = await f.service.remoteExportPrepareAction({ ...ACTION_ARGS, proposalId: proposal.proposalId })
    assert.match(ok.challengeId, /^uiac-/)
  } finally {
    f.dispose()
  }
})

test('批准挑战 fail-closed：未知 / 重放 / 摘要不符 / 过期', async () => {
  const f = fixture()
  try {
    const rec = seedRun(f.wsRoot, 'run-wpa000004')
    const dec = seedDecision(f.wsRoot, rec.runId)
    const proposal = await f.service.remoteExportCreateActionProposal({
      decisionId: dec.decisionId, runId: rec.runId, candidateId: 'CAND-001', ...ACTION_ARGS,
    })
    const prep = await f.service.remoteExportPrepareAction({ ...ACTION_ARGS, proposalId: proposal.proposalId })

    // 未知挑战（不带 proposalId：批准失败不烧正式提案）
    await expectOrigCode(
      () => f.service.remoteExportExecuteAction({
        ...ACTION_ARGS,
        approval: { challengeId: 'uiac-nope', contextDigest: prep.contextDigest },
      }),
      'UI_APPROVAL_UNKNOWN',
    )
    // 摘要不符：拿 A 的挑战去执行 B 的载荷
    await expectOrigCode(
      () => f.service.remoteExportExecuteAction({
        ...ACTION_ARGS, payload: { amount: 99, note: 'swap' },
        approval: { challengeId: prep.challengeId, contextDigest: prep.contextDigest },
      }),
      'UI_APPROVAL_MISMATCH',
    )
    // 正常消费一次
    await f.service.remoteExportExecuteAction({
      ...ACTION_ARGS, proposalId: proposal.proposalId,
      approval: { challengeId: prep.challengeId, contextDigest: prep.contextDigest },
    })
    // 重放：同挑战换载荷（新业务键）→ 会走到批准卡 → 挑战已消费
    await expectOrigCode(
      () => f.service.remoteExportExecuteAction({
        ...ACTION_ARGS, payload: { amount: 2, note: 'replay' },
        approval: { challengeId: prep.challengeId, contextDigest: prep.contextDigest },
      }),
      'UI_APPROVAL_REUSED',
    )
    // 过期：直接签发负 TTL 挑战（不等 5 分钟）
    const expired = f.runtime.run(() =>
      issueUiApprovalChallenge(prep.contextDigest, -1),
    )
    await expectOrigCode(
      () => f.service.remoteExportExecuteAction({
        ...ACTION_ARGS, payload: { amount: 3, note: 'expired' },
        approval: { challengeId: expired.challengeId, contextDigest: prep.contextDigest },
      }),
      'UI_APPROVAL_EXPIRED',
    )
  } finally {
    f.dispose()
  }
})

test('无身份 fail-closed：prepare / execute / reconcile 不得探测', async () => {
  const f = fixture()
  try {
    const rec = seedRun(f.wsRoot, 'run-wpa000005')
    const dec = seedDecision(f.wsRoot, rec.runId)
    const proposal = await f.service.remoteExportCreateActionProposal({
      decisionId: dec.decisionId, runId: rec.runId, candidateId: 'CAND-001', ...ACTION_ARGS,
    })
    f.setIdentity(null)
    await expectOrigCode(
      () => f.service.remoteExportPrepareAction({ ...ACTION_ARGS, proposalId: proposal.proposalId }),
      'OBJECT_NOT_GRANTED',
    )
    await expectOrigCode(
      () => f.service.remoteExportExecuteAction({
        ...ACTION_ARGS, proposalId: proposal.proposalId,
        approval: { challengeId: 'uiac-x', contextDigest: 'x' },
      }),
      'OBJECT_NOT_GRANTED',
    )
    await expectOrigCode(
      () => f.service.remoteExportReconcileAction({ actionId: 'act-nope' }),
      'REVIEWER_UNCONFIRMED',
    )
  } finally {
    f.dispose()
  }
})

test('reconcileAction：效应不明保持 unknown（禁自动重跑）', async () => {
  const f = fixture()
  try {
    const rec = seedRun(f.wsRoot, 'run-wpa000006')
    const dec = seedDecision(f.wsRoot, rec.runId)
    // 泛化失败连接器（无回执）：效应不明 → unknown。须在建提案前注册——提案即绑定连接器
    f.runtime.run(() =>
      registerActionConnector(
        { execute: async () => { throw new Error('boom-effect-unknown') }, compensate: async () => {} },
        { id: 'flaky', env: 'test', kind: 'simulated' },
      ),
    )
    const proposal = await f.service.remoteExportCreateActionProposal({
      decisionId: dec.decisionId, runId: rec.runId, candidateId: 'CAND-001', ...ACTION_ARGS,
    })
    const prep = await f.service.remoteExportPrepareAction({ ...ACTION_ARGS, proposalId: proposal.proposalId })
    await expectOrigCode(
      () => f.service.remoteExportExecuteAction({
        ...ACTION_ARGS, proposalId: proposal.proposalId,
        approval: { challengeId: prep.challengeId, contextDigest: prep.contextDigest },
      }),
      'ACTION_UNKNOWN_EFFECT',
    )
    const chain = await f.service.remoteExportReviewChain({ runId: rec.runId })
    assert.equal(chain.actions[0].status, 'unknown', '效应不明落台账')
    // 对账：无 queryResult → 保持 unknown，不自动重跑
    const again = await f.service.remoteExportReconcileAction({ actionId: chain.actions[0].actionId })
    assert.equal(again.status, 'unknown')
    assert.match(again.note ?? '', /不自动重跑/)
    assert.equal(again.humanReviewRequired, true)
  } finally {
    f.dispose()
  }
})
