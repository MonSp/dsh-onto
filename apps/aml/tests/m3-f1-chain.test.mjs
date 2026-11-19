/**
 * M3/F1 — AML 工具面全链演练（进程内）：
 * run 留痕 → record_review_decision → create_action_proposal → execute_behavior_action
 * → ticket-sim 网络回执（simulated）→ 幂等重放 → accept-timeout 后人工对账。
 *
 * 不起浏览器；ticket-sim 为独立子进程 HTTP（F1：外部单号由服务分配，执行器不伪造）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyRun } from '@dsh-onto/runtime/agent-tools'
import {
  businessPolicy,
  currentRuntimeContext,
  provideRuntimeContext,
  registerActionConnector,
  currentConnectorIdentity,
} from '@dsh-onto/runtime'
import { createTicketSimConnector } from '@dsh-onto/runtime'
import { buildRunRecord, derivePackage, saveRunRecord } from '@dsh-onto/core'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const AML_SRC = join(REPO, 'packages', 'aml', '1.0.0')
const TICKET_SIM = join(REPO, 'mock-services', 'ticket-sim', 'server.mjs')

const IDENTITY = {
  userId: 'u-m3',
  tenant: 'tenant-m3',
  roles: ['analyst'],
  dataScope: { objectTypes: ['OBJ-AML-ACCOUNT', 'OBJ-AML-CUSTOMER', 'OBJ-AML-TXN'] },
}

function setupAmlTools() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-aml-m3-'))
  const versionDir = join(root, 'dsh-onto', 'workspace', 'packages', 'aml-analysis', '1.0.0')
  mkdirSync(join(versionDir, '..'), { recursive: true })
  cpSync(AML_SRC, versionDir, { recursive: true })
  derivePackage(versionDir)

  const services = new Map()
  services.set('profileContext', { dir: root })
  let approvalCount = 0
  services.set('approval', {
    request: async () => {
      approvalCount++
      return 'allowed-once'
    },
  })
  const tools = new Map()
  const ctx = {
    on: () => undefined,
    root: { get: (k) => services.get(k) },
    tools: {
      guard: () => () => undefined,
      register: (d) => {
        tools.set(d.name, d)
      },
    },
    skills: { registerProvider: () => undefined },
  }
  provideRuntimeContext(ctx.root, currentRuntimeContext())
  applyRun(ctx)
  businessPolicy.setIdentityProvider(() => IDENTITY)
  const execCtx = { agent: { session: { id: 'm3-session' } }, callId: 'm3' }
  return {
    root,
    tools,
    execCtx,
    approvalCount: () => approvalCount,
    wsRoot: join(root, 'dsh-onto', 'workspace'),
    dispose() {
      businessPolicy.setIdentityProvider(null)
      registerActionConnector(null)
      rmSync(root, { recursive: true, force: true })
    },
  }
}

function seedRun(wsRoot, runId, objectRef = 'OBJ-AML-ACCOUNT:ACCT-001') {
  const result = {
    scenarioId: 'SCN-AML-FIND-CLUES',
    runId,
    startedAt: '2026-01-01T00:00:00.000Z',
    candidates: [
      {
        candidateId: 'CAND-001',
        objectRef,
        riskScore: 0.9,
        hitRuleIds: ['RULE-AML-SCORE-FANOUT'],
        evidenceChains: [],
        narrative: [],
        pendingChecks: [],
        pendingVerification: false,
      },
    ],
    excluded: [],
    humanReviewRequired: true,
    reviewGate: { threshold: 0.75, required: true, requireReviewFor: ['CAND-001'] },
    ruleHitLog: [],
    audit: { checks: [], forbiddenPhraseHits: [], passed: true },
  }
  const rec = buildRunRecord({
    package: { name: 'aml-analysis', version: '1.0.0' },
    dataset: { objects: [], relations: [], candidates: [] },
    result,
    redlines: [],
  })
  saveRunRecord(wsRoot, rec)
  return rec
}

async function startTicketSim() {
  const dbDir = mkdtempSync(join(tmpdir(), 'm3-tsim-'))
  const child = spawn(process.execPath, [TICKET_SIM, '--port', '0', '--db', join(dbDir, 'tickets.db')], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TICKET_SIM_FAULT_HOLD_MS: '800' },
  })
  const port = await new Promise((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => reject(new Error(`ticket-sim 启动超时：${buf}`)), 8000)
    child.stdout.on('data', (c) => {
      buf += c
      for (const line of buf.split('\n')) {
        if (!line.startsWith('{')) continue
        try {
          const j = JSON.parse(line)
          if (j.event === 'listening') {
            clearTimeout(timer)
            resolve(j.port)
            return
          }
        } catch {
          /* continue */
        }
      }
    })
    child.on('exit', (code) => reject(new Error(`ticket-sim 退出：${code} ${buf}`)))
  })
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    async setFault(mode, remaining = 1, holdMs = 2500) {
      const res = await fetch(`http://127.0.0.1:${port}/admin/fault`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode, remaining, holdMs }),
      })
      assert.equal(res.ok, true, `fault 设置失败：${res.status}`)
    },
    async tickets() {
      const res = await fetch(`http://127.0.0.1:${port}/admin/tickets`)
      return res.json()
    },
    dispose() {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      // Windows：SQLite 子进程可能仍握句柄，清理失败不掩盖测试断言
      try {
        rmSync(dbDir, { recursive: true, force: true })
      } catch {
        /* ignore EPERM */
      }
    },
  }
}

test('M3-F1 全链：复核→提案→批准→ticket-sim→幂等→超时对账（回执 simulated）', async () => {
  const sim = await startTicketSim()
  const chain = setupAmlTools()
  try {
    registerActionConnector(
      createTicketSimConnector({ baseUrl: sim.baseUrl, requestTimeoutMs: 600 }),
      { id: 'ticket-sim', env: 'local-sim', kind: 'simulated' },
    )
    assert.equal(currentConnectorIdentity().kind, 'simulated')

    const run = seedRun(chain.wsRoot, 'run-m3-0001')
    const argsBase = {
      name: 'aml-analysis',
      version: '1.0.0',
      objectRef: 'OBJ-AML-ACCOUNT:ACCT-001',
      humanApproved: true,
    }

    // ── 事件 1：业务复核 ──
    const reviewTool = chain.tools.get('record_review_decision')
    assert.ok(reviewTool, 'record_review_decision 在场')
    const review = await reviewTool.execute(
      {
        runId: run.runId,
        candidateIds: JSON.stringify(['CAND-001']),
        snapshotDigest: run.datasetDigest,
        ruleFingerprint: 'aml-analysis@1.0.0',
        decision: 'approved',
        reason: 'M3 演练：允许对 CAND-001 提复核工单',
        humanApproved: true,
      },
      chain.execCtx,
    )
    assert.equal(review.decision, 'approved')
    assert.equal(review.humanReviewRequired, true)
    assert.ok(review.decisionId?.startsWith('DEC-') || review.decisionId, '有 decisionId')
    // 事件 1：业务复核弹 1 次批准卡
    assert.equal(chain.approvalCount(), 1, '复核：1 次批准卡')

    // ── 提案 ──
    const propTool = chain.tools.get('create_action_proposal')
    assert.ok(propTool, 'create_action_proposal 在场')
    const prop = await propTool.execute(
      {
        ...argsBase,
        decisionId: review.decisionId,
        runId: run.runId,
        candidateId: 'CAND-001',
        behaviorId: 'BHV-AML-TRANSFER',
        payload: {
          title: 'M3 复核工单 CAND-001',
          severity: 'high',
          runId: run.runId,
          candidateId: 'CAND-001',
        },
      },
      chain.execCtx,
    )
    assert.ok(prop.proposalId?.startsWith('PROP-') || prop.proposalId, '有 proposalId')
    assert.equal(prop.humanReviewRequired, true)

    // ── 事件 2：系统批准卡 + 执行（ticket-sim 网络回执）──
    const execTool = chain.tools.get('execute_behavior_action')
    assert.ok(execTool, 'execute_behavior_action 在场')
    const execPayload = {
      title: 'M3 复核工单 CAND-001',
      severity: 'high',
      runId: run.runId,
      candidateId: 'CAND-001',
    }
    const execArgs = {
      ...argsBase,
      behaviorId: 'BHV-AML-TRANSFER',
      payload: execPayload,
      proposalId: prop.proposalId,
    }
    const first = await execTool.execute(execArgs, chain.execCtx)
    assert.equal(first.status, 'succeeded')
    assert.equal(first.replayed, false)
    assert.equal(first.simulated, true, '回执必须标注 simulated')
    assert.equal(first.connectorKind, 'simulated')
    assert.match(String(first.externalRef), /^SIM-TKT-\d{6}$/, '外部单号来自 ticket-sim 网络')
    // 事件 2：执行再弹 1 次（累计 2 = 复核 + 执行）
    assert.equal(chain.approvalCount(), 2, '执行：第 2 次系统批准卡')

    const remote = await sim.tickets()
    assert.equal(remote.tickets?.length ?? remote.length, 1, 'ticket-sim 侧仅一张工单')

    // ── 幂等重放：同提案回读同单号，不新建、不再批准 ──
    const replay = await execTool.execute(execArgs, chain.execCtx)
    assert.equal(replay.replayed, true)
    assert.equal(replay.externalRef, first.externalRef)
    assert.equal(chain.approvalCount(), 2, '重放不得二次批准')
    const afterReplay = await sim.tickets()
    assert.equal(afterReplay.tickets?.length ?? afterReplay.length, 1, '重放不新建工单')

    // ── accept-timeout：受理后调用方超时 → 效应不明 → 人工对账恢复同单号 ──
    await sim.setFault('accept-timeout', 1)
    const prop2 = await propTool.execute(
      {
        ...argsBase,
        decisionId: review.decisionId,
        runId: run.runId,
        candidateId: 'CAND-001',
        behaviorId: 'BHV-AML-TRANSFER',
        payload: {
          title: 'M3 超时对账工单',
          severity: 'medium',
          runId: run.runId,
          candidateId: 'CAND-001',
          seq: 2,
        },
      },
      chain.execCtx,
    )
    await assert.rejects(
      () =>
        execTool.execute(
          {
            ...argsBase,
            behaviorId: 'BHV-AML-TRANSFER',
            payload: {
              title: 'M3 超时对账工单',
              severity: 'medium',
              runId: run.runId,
              candidateId: 'CAND-001',
              seq: 2,
            },
            proposalId: prop2.proposalId,
            operationId: prop2.operationId,
          },
          chain.execCtx,
        ),
      (e) => /效应不明|须对账|超时|timeout/i.test(String(e.message ?? e)),
      'accept-timeout → 效应不明（不静默当失败）',
    )

    // 对账：外部已受理 → 恢复 succeeded + 同一外部单号
    const listAfterTimeout = await sim.tickets()
    const tickets = listAfterTimeout.tickets ?? listAfterTimeout
    assert.ok(tickets.length >= 2, `超时后外部已有工单：${tickets.length}`)
    const reconTool = chain.tools.get('reconcile_action')
    assert.ok(reconTool, 'reconcile_action 在场')
    // 找 unknown/disconnecting 动作
    const actionsRes = await (async () => {
      // 通过 store 读：工具面无 list_actions，用 actionStore 路径——
      // reconcile 需要 actionId；从 workspace 侧用工具不可列时，经 execute 失败后的台账。
      // 这里直接用 runtime actionStoreFor。
      const { actionStoreFor } = await import('@dsh-onto/runtime')
      const store = actionStoreFor(chain.wsRoot)
      const unknown = store.listActions().filter((a) => a.status === 'unknown' || a.status === 'executing')
      assert.ok(unknown.length >= 1, `应有 unknown/在途记录，实际：${store.listActions().map((a) => a.status).join(',')}`)
      return unknown[0]
    })()
    const recon = await reconTool.execute(
      { actionId: actionsRes.actionId, humanApproved: true },
      chain.execCtx,
    )
    assert.equal(recon.status, 'succeeded', '对账按外部回执恢复成功')
    assert.match(String(recon.externalRef), /^SIM-TKT-\d{6}$/, '对账带回外部单号')
    assert.equal(recon.humanReviewRequired, true)
  } finally {
    chain.dispose()
    sim.dispose()
  }
})

test('M3-F1 错链拒绝：错 run 复核 / 错提案执行 / 未复核提案 —— 外部零效应', async () => {
  const sim = await startTicketSim()
  const chain = setupAmlTools()
  try {
    registerActionConnector(
      createTicketSimConnector({ baseUrl: sim.baseUrl, requestTimeoutMs: 1000 }),
      { id: 'ticket-sim', env: 'local-sim', kind: 'simulated' },
    )
    const run = seedRun(chain.wsRoot, 'run-m3-err')
    const reviewTool = chain.tools.get('record_review_decision')
    const propTool = chain.tools.get('create_action_proposal')
    const execTool = chain.tools.get('execute_behavior_action')

    // 错 snapshotDigest → 复核拒绝
    await assert.rejects(
      () =>
        reviewTool.execute(
          {
            runId: run.runId,
            candidateIds: JSON.stringify(['CAND-001']),
            snapshotDigest: 'deadbeefdeadbeef',
            ruleFingerprint: 'aml-analysis@1.0.0',
            decision: 'approved',
            humanApproved: true,
          },
          chain.execCtx,
        ),
      (e) => /snapshot|快照|摘要|不匹配/i.test(String(e.message ?? e)),
    )

    const review = await reviewTool.execute(
      {
        runId: run.runId,
        candidateIds: JSON.stringify(['CAND-001']),
        snapshotDigest: run.datasetDigest,
        ruleFingerprint: 'aml-analysis@1.0.0',
        decision: 'approved',
        humanApproved: true,
      },
      chain.execCtx,
    )

    // 错 candidate（不在获准集合）→ 提案拒绝
    await assert.rejects(
      () =>
        propTool.execute(
          {
            name: 'aml-analysis',
            version: '1.0.0',
            decisionId: review.decisionId,
            runId: run.runId,
            candidateId: 'CAND-999',
            behaviorId: 'BHV-AML-TRANSFER',
            objectRef: 'OBJ-AML-ACCOUNT:ACCT-001',
            payload: { title: 'x' },
            humanApproved: true,
          },
          chain.execCtx,
        ),
      (e) => /候选|candidate|复核/i.test(String(e.message ?? e)),
    )

    // 无提案直接执行（受治理路径）→ 拒绝或走 dryrun；用假 proposalId → PROPOSAL_NOT_FOUND
    await assert.rejects(
      () =>
        execTool.execute(
          {
            name: 'aml-analysis',
            version: '1.0.0',
            behaviorId: 'BHV-AML-TRANSFER',
            objectRef: 'OBJ-AML-ACCOUNT:ACCT-001',
            payload: { title: 'no-prop' },
            proposalId: 'PROP-DOES-NOT-EXIST',
            humanApproved: true,
          },
          chain.execCtx,
        ),
      (e) => /PROPOSAL_NOT_FOUND|提案/.test(String(e.code ?? '') + String(e.message ?? e)),
    )

    const after = await sim.tickets()
    assert.equal(after.tickets?.length ?? after.length, 0, '错链路径外部零效应')
    // 合法复核弹 1 次批准卡；错链执行/提案失败不得再弹
    assert.equal(chain.approvalCount(), 1, '仅合法复核 1 次批准；错链执行 0 次')
  } finally {
    chain.dispose()
    sim.dispose()
  }
})
