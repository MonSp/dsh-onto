/**
 * M2/D 验收测试 —— SQLite 事务台账（占位/CAS/同键冲突/跨进程互斥/kill-restart）、
 * ReviewDecision → ActionProposal 治理链（不可伪造、错 run/候选不套用、单次消费）、
 * ticket-sim 连接器端到端（提案执行/幂等回读/提案消费）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  approvalContextDigest,
  businessKeyOf,
  digestAction,
  executeBehaviorAction,
  loadActionRecord,
  registerActionConnector,
} from '../dist/action-executor.js'
import {
  ActionStore,
  actionStoreFor,
  closeActionStore,
  migrateLegacyJsonRecords,
  verifyLegacyJsonRecords,
} from '../dist/action-store.js'
import { createTicketSimConnector } from '../dist/action-connector-ticketsim.js'

const DIST = fileURLToPath(new URL('../dist/', import.meta.url))
const INTENT = { behaviorId: 'BHV-TST-X', objectRef: 'OBJ-TST-A:inst1', payload: { amount: 1 } }
const PKG = { name: 'test-pkg', version: '1.0.0' }
const BEHAVIOR = { id: 'BHV-TST-X', anchor: 'OBJ-TST-A', name: '行为X' }
const GRANT = { approvalDigest: 'ap-digest', approvedAt: '2026-11-16T00:00:00.000Z' }

function mkRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-store-'))
}

function runChild(scriptPath, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (c) => {
      out += c
    })
    child.stderr.on('data', (c) => {
      err += c
    })
    child.on('exit', (code) => {
      resolve({ code, out, err })
    })
    child.on('error', reject)
  })
}

test('S1 台账占位/CAS/同键不同载荷显式冲突', () => {
  const root = mkRoot()
  const store = actionStoreFor(root)
  const base = {
    actionId: 'act-s1',
    businessKey: 'bk-s1',
    approvalContext: 'ctx-a',
    connector: { id: 'c', env: 'e', kind: 'simulated' },
    behaviorId: 'BHV-1',
    objectRef: 'OBJ-A:1',
    payload: { amount: 1 },
    status: 'executing',
    phase: 'claimed',
    approvalDigest: '',
    approvedAt: '',
    executedAt: '',
    intentDigest: 'digest-a',
  }
  const r1 = store.claim(base)
  assert.equal(r1.created, true)
  assert.equal(r1.record.version, 1)
  const r2 = store.claim(base)
  assert.equal(r2.created, false, '同键同内容 → 既有记录（单派发者）')
  assert.throws(
    () => store.claim({ ...base, payload: { amount: 2 }, intentDigest: 'digest-b' }),
    (e) => e.code === 'ACTION_CONFLICT',
    '同键不同载荷 → 显式冲突，不悄悄生成新业务操作',
  )
  const s1 = store.settle('bk-s1', 1, { status: 'succeeded', externalRef: 'ext-1' })
  assert.equal(s1.status, 'succeeded')
  assert.equal(s1.version, 2)
  assert.equal(s1.externalRef, 'ext-1')
  assert.throws(
    () => store.settle('bk-s1', 1, { status: 'failed' }),
    (e) => e.code === 'ACTION_LEDGER_CONFLICT',
    'CAS：旧版本不得覆盖并发方推进的终态',
  )
  closeActionStore(root)
  rmSync(root, { recursive: true, force: true })
})

test('S2 复核决定→提案治理链：不可伪造、错 run/候选不套用、单次消费', () => {
  const root = mkRoot()
  const store = actionStoreFor(root)
  const mkProposalArgs = (over = {}) => ({
    decisionId: 'DEC-x',
    runId: 'run-aaa',
    candidateId: 'CAND-001',
    behaviorId: 'BHV-1',
    objectRef: 'OBJ-A:1',
    payload: { title: '复核工单' },
    intentDigest: 'd-1',
    connectorId: 'ticket-sim',
    connectorEnv: 'local-sim',
    ...over,
  })
  assert.throws(
    () => store.createProposal(mkProposalArgs({ decisionId: 'DEC-nope' })),
    (e) => e.code === 'REVIEW_DECISION_NOT_FOUND',
    '提案不得脱离复核决定',
  )
  const dec = store.createDecision({
    runId: 'run-aaa',
    candidateIds: ['CAND-001', 'CAND-002'],
    snapshotDigest: 'snap-1',
    ruleFingerprint: 'rule-fp-1',
    reviewer: 'host:test',
    decision: 'approved',
    reason: '证据链成立',
  })
  const decRej = store.createDecision({
    runId: 'run-aaa',
    candidateIds: ['CAND-003'],
    snapshotDigest: 'snap-1',
    ruleFingerprint: 'rule-fp-1',
    reviewer: 'host:test',
    decision: 'rejected',
  })
  assert.throws(
    () => store.createProposal(mkProposalArgs({ decisionId: decRej.decisionId, candidateId: 'CAND-003' })),
    (e) => e.code === 'REVIEW_NOT_APPROVED',
    'rejected 决定不得提案动作',
  )
  assert.throws(
    () => store.createProposal(mkProposalArgs({ decisionId: dec.decisionId, runId: 'run-bbb' })),
    (e) => e.code === 'REVIEW_RUN_MISMATCH',
    '错 run 不可套用',
  )
  assert.throws(
    () => store.createProposal(mkProposalArgs({ decisionId: dec.decisionId, candidateId: 'CAND-999' })),
    (e) => e.code === 'REVIEW_CANDIDATE_NOT_ALLOWED',
    'Agent 只能对允许的候选提案动作',
  )
  const p = store.createProposal(mkProposalArgs({ decisionId: dec.decisionId }))
  assert.match(p.operationId, /^OP-/, 'operationId 服务端分配并固定')
  assert.equal(p.status, 'pending')
  const c1 = store.consumeProposal(p.proposalId)
  assert.equal(c1.status, 'consumed')
  assert.throws(
    () => store.consumeProposal(p.proposalId),
    (e) => e.code === 'PROPOSAL_ALREADY_CONSUMED',
    '提案单次消费',
  )
  const p2 = store.createProposal(mkProposalArgs({ decisionId: dec.decisionId, intentDigest: 'd-2' }))
  const canceled = store.cancelProposal(p2.proposalId)
  assert.equal(canceled.status, 'canceled')
  assert.throws(() => store.cancelProposal(p2.proposalId), (e) => e.code === 'PROPOSAL_NOT_PENDING')
  closeActionStore(root)
  rmSync(root, { recursive: true, force: true })
})

test('S3 JSON 历史台账：核对 + 显式迁移（缺上下文不迁移、executing 禁自动重跑）', () => {
  const root = mkRoot()
  mkdirSync(join(root, 'actions'), { recursive: true })
  writeFileSync(join(root, 'actions', 'bk-old1.json'), JSON.stringify({
    businessKey: 'bk-old1',
    actionId: 'act-old1',
    approvalContext: 'ctx',
    connector: { id: 'x', env: 'y' },
    behaviorId: 'B',
    objectRef: 'O:1',
    payload: {},
    status: 'succeeded',
    approvalDigest: 'a',
    approvedAt: 't',
    executedAt: 't',
  }))
  writeFileSync(join(root, 'actions', 'bk-old2.json'), JSON.stringify({
    businessKey: 'bk-old2',
    actionId: 'act-old2',
    approvalContext: 'ctx',
    connector: { id: 'x', env: 'y' },
    behaviorId: 'B',
    objectRef: 'O:2',
    payload: {},
    status: 'executing',
    approvalDigest: 'a',
    approvedAt: 't',
    executedAt: 't',
  }))
  writeFileSync(join(root, 'actions', 'legacy-digest.json'), JSON.stringify({ foo: 1, status: 'succeeded' }))
  const reports = verifyLegacyJsonRecords(root)
  assert.equal(reports.length, 3)
  const mig = migrateLegacyJsonRecords(root)
  assert.equal(mig.migrated.length, 2, '有上下文记录迁移')
  assert.equal(mig.skipped.length, 1, '缺上下文（旧格式）不迁移、不自动重跑')
  assert.equal(loadActionRecord(root, 'bk-old1')?.status, 'succeeded')
  assert.equal(loadActionRecord(root, 'bk-old2')?.status, 'unknown', '迁移时 executing 一律按效应待核实（禁止自动重跑）')
  const again = migrateLegacyJsonRecords(root)
  assert.equal(again.migrated.length, 0, '迁移幂等')
  closeActionStore(root)
  rmSync(root, { recursive: true, force: true })
})

test('S4 跨进程并发占位（两进程同键）：只有一个派发者', async () => {
  const root = mkRoot()
  const dbPath = join(root, 'actions', 'ledger.db')
  mkdirSync(join(root, 'actions'), { recursive: true })
  const childSrc = join(root, 'claim-child.mjs')
  const storeUrl = pathToFileURL(join(DIST, 'action-store.js')).href
  writeFileSync(childSrc, `
import { ActionStore } from ${JSON.stringify(storeUrl)}
const [, , dbPath, key, tag] = process.argv
const store = new ActionStore(dbPath)
const res = store.claim({
  businessKey: key, actionId: 'act-' + tag, approvalContext: 'ctx',
  connector: { id: 'c', env: 'e', kind: 'simulated' }, behaviorId: 'B', objectRef: 'O:1',
  payload: { amount: 1 }, status: 'executing', phase: 'claimed',
  approvalDigest: '', approvedAt: '', executedAt: '', intentDigest: 'same',
})
console.log(JSON.stringify({ tag, created: res.created }))
`)
  const results = await Promise.all([
    runChild(childSrc, [dbPath, 'bk-mp', 'A']),
    runChild(childSrc, [dbPath, 'bk-mp', 'B']),
  ])
  const parsed = results.map((r) => JSON.parse(r.out.trim().split('\n').pop()))
  const createdCount = parsed.filter((p) => p.created === true).length
  assert.equal(createdCount, 1, `两进程同键应只有一个占位成功，实际：${JSON.stringify(parsed)}`)
  const store = actionStoreFor(root)
  assert.equal(store.load('bk-mp') !== null, true)
  closeActionStore(root)
  rmSync(root, { recursive: true, force: true })
})

test('S5 kill-restart：进程被杀后按外部回执恢复，不重跑', async () => {
  const root = mkRoot()
  const identity = { id: 'recover', env: 'test', kind: 'simulated' }
  registerActionConnector({
    async execute() {
      throw new Error('恢复路径不得二次执行')
    },
    async compensate() {},
    async queryResult() {
      return { state: 'succeeded', externalRef: 'ext-recovered' }
    },
  }, identity)
  const key = businessKeyOf(INTENT, identity, undefined, '')
  const context = approvalContextDigest(INTENT, identity, PKG, BEHAVIOR)
  const dbPath = join(root, 'actions', 'ledger.db')
  mkdirSync(join(root, 'actions'), { recursive: true })
  const childSrc = join(root, 'crash-child.mjs')
  writeFileSync(childSrc, `
import { ActionStore } from ${JSON.stringify(pathToFileURL(join(DIST, 'action-store.js')).href)}
const [, , dbPath, payload] = process.argv
const rec = JSON.parse(payload)
const store = new ActionStore(dbPath)
const claimed = store.claim(rec)
if (!claimed.created) {
  console.log('CLAIM-CONFLICT')
  process.exit(2)
}
store.settle(rec.businessKey, 1, { phase: 'dispatched', executedAt: new Date().toISOString() })
console.log('DISPATCHED')
// 挂住模拟「派发后、写终态前」被杀
await new Promise(() => {})
`)
  const child = spawn(process.execPath, [
    childSrc,
    dbPath,
    JSON.stringify({
      businessKey: key,
      actionId: `act-${key.slice(0, 12)}`,
      approvalContext: context,
      connector: identity,
      behaviorId: INTENT.behaviorId,
      objectRef: INTENT.objectRef,
      payload: INTENT.payload,
      status: 'executing',
      phase: 'claimed',
      approvalDigest: 'ap',
      approvedAt: 't',
      executedAt: '',
      intentDigest: digestAction(INTENT),
    }),
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  const dispatched = await new Promise((resolve) => {
    let out = ''
    child.stdout.on('data', (c) => {
      out += c
      if (out.includes('DISPATCHED')) resolve(true)
    })
    setTimeout(() => resolve(false), 8000)
  })
  assert.equal(dispatched, true, '子进程应完成占位并进 dispatched')
  child.kill('SIGKILL')
  await new Promise((r) => setTimeout(r, 200))
  try {
    const res = await executeBehaviorAction({
      root,
      intent: INTENT,
      pkg: PKG,
      behavior: BEHAVIOR,
      inFlightWaitMs: 0,
      requestGrant: async () => {
        throw new Error('恢复路径不得重复批准')
      },
    })
    assert.equal(res.replayed, true)
    assert.equal(res.record.status, 'succeeded')
    assert.equal(res.record.externalRef, 'ext-recovered')
    assert.match(res.note ?? '', /崩溃恢复/, '按外部回执恢复，不重跑')
  } finally {
    registerActionConnector(null)
    closeActionStore(root)
    rmSync(root, { recursive: true, force: true })
  }
})

test('S6 ticket-sim 端到端：提案执行/幂等回读/提案消费/意图指纹绑定', async () => {
  const server = fileURLToPath(new URL('../../mock-services/ticket-sim/server.mjs', import.meta.url))
  const child = spawn(process.execPath, [server, '--port', '0', '--db', join(mkdtempSync(join(tmpdir(), 'ticket-e2e-')), 'tickets.db')], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TICKET_SIM_FAULT_HOLD_MS: '1500' },
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
          /* 继续等 */
        }
      }
    })
    child.on('exit', (code) => reject(new Error(`ticket-sim 退出：${code} ${buf}`)))
  })
  const identity = { id: 'ticket-sim', env: 'local-sim', kind: 'simulated' }
  registerActionConnector(createTicketSimConnector({ baseUrl: `http://127.0.0.1:${port}` }), identity)
  const root = mkRoot()
  const store = actionStoreFor(root)
  try {
    const dec = store.createDecision({
      runId: 'run-e2e',
      candidateIds: ['CAND-001'],
      snapshotDigest: 'snap-e2e',
      ruleFingerprint: 'rule-e2e',
      reviewer: 'host:e2e',
      decision: 'approved',
    })
    const intent = {
      behaviorId: 'BHV-OPEN-TICKET',
      objectRef: 'OBJ-AML-ACCOUNT:ACCT-001',
      payload: { title: '复核工单 CAND-001', runId: 'run-e2e', candidateId: 'CAND-001', severity: 'high' },
    }
    const proposal = store.createProposal({
      decisionId: dec.decisionId,
      runId: 'run-e2e',
      candidateId: 'CAND-001',
      behaviorId: intent.behaviorId,
      objectRef: intent.objectRef,
      payload: intent.payload,
      intentDigest: digestAction(intent),
      connectorId: identity.id,
      connectorEnv: identity.env,
    })
    const first = await executeBehaviorAction({
      root,
      intent,
      pkg: PKG,
      behavior: BEHAVIOR,
      proposalId: proposal.proposalId,
      requestGrant: async () => GRANT,
    })
    assert.equal(first.replayed, false)
    assert.equal(first.record.status, 'succeeded')
    assert.match(first.record.externalRef, /^SIM-TKT-\d{6}$/, '外部单号来自 ticket-sim 网络回执')
    assert.equal(first.record.decisionId, dec.decisionId, '台账绑定复核决定（链条可串联）')
    assert.equal(first.record.proposalId, proposal.proposalId)
    assert.equal(first.record.operationId, proposal.operationId, '操作标识以提案服务端分配为准')

    // 幂等重放：同提案回读同一外部单号，不新建工单
    const replay = await executeBehaviorAction({
      root,
      intent,
      pkg: PKG,
      behavior: BEHAVIOR,
      proposalId: proposal.proposalId,
      requestGrant: async () => {
        throw new Error('重放不得重复批准')
      },
    })
    assert.equal(replay.replayed, true)
    assert.equal(replay.record.externalRef, first.record.externalRef)

    // 同提案换载荷 → 意图指纹不符（错提案不可套用）
    await assert.rejects(
      () => executeBehaviorAction({
        root,
        intent: { ...intent, payload: { ...intent.payload, severity: 'low' } },
        pkg: PKG,
        behavior: BEHAVIOR,
        proposalId: proposal.proposalId,
        requestGrant: async () => GRANT,
      }),
      (e) => e.code === 'PROPOSAL_INTENT_MISMATCH',
    )

    // 新业务动作须新提案：新提案可执行，外部产生第二个单号
    const proposal2 = store.createProposal({
      decisionId: dec.decisionId,
      runId: 'run-e2e',
      candidateId: 'CAND-001',
      behaviorId: intent.behaviorId,
      objectRef: intent.objectRef,
      payload: { ...intent.payload, title: '复核工单（第二单）' },
      intentDigest: digestAction({ ...intent, payload: { ...intent.payload, title: '复核工单（第二单）' } }),
      connectorId: identity.id,
      connectorEnv: identity.env,
    })
    const second = await executeBehaviorAction({
      root,
      intent: { ...intent, payload: { ...intent.payload, title: '复核工单（第二单）' } },
      pkg: PKG,
      behavior: BEHAVIOR,
      proposalId: proposal2.proposalId,
      requestGrant: async () => GRANT,
    })
    assert.equal(second.replayed, false)
    assert.notEqual(second.record.externalRef, first.record.externalRef, '新提案新业务操作 → 新外部单号')
  } finally {
    registerActionConnector(null)
    closeActionStore(root)
    rmSync(root, { recursive: true, force: true })
    child.kill()
  }
})
