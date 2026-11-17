/**
 * F2 演练：外部业务 API（http://127.0.0.1:3910）上的治理链验收。
 * 覆盖：提案执行拿外部单号 → 幂等重放零新建 → accept-timeout 故障下对账恢复同单号
 *      → 取数连接器快照（分页/来源回执）。全程 kind=simulated（真实验收才 formal）。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { executeBehaviorAction, registerActionConnector, digestAction, ActionExecuteError, ActionNoEffectError } from '../backend/dist/action-executor.js'
import { actionStoreFor, closeActionStore } from '../backend/dist/action-store.js'
import { createExtApiConnector } from '../backend/dist/action-connector-ext.js'
import { createExtDataConnector } from '../backend/dist/data-source-ext.js'

// 台账 ROOT：DSH_PROFILE_DIR 指向 dsh profile 目录（缺省 ~/.dsh/profiles/dsh-onto）；工作区 = <profile>/dsh-onto/workspace
const ROOT = join(
  process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'dsh-onto'),
  'dsh-onto', 'workspace',
)
import { getF2Tokens } from './f2-auth.mjs'
const { base: BASE, tokenA: TOKEN, admin: ADMIN } = await getF2Tokens()

const IDENTITY = { id: 'ext-api', env: 'staging', kind: 'simulated' }
const PKG = { name: 'aml-analysis', version: '1.0.0' }
const BEHAVIOR = { id: 'BHV-AML-OPEN-REVIEW-TICKET', anchor: 'OBJ-AML-ACCOUNT', name: '创建复核工单' }
const GRANT = { approvalDigest: 'f2-rehearsal-grant', approvedAt: new Date().toISOString() }

const adminPost = (path, body) => fetch(`${BASE}${path}`, {
  method: 'POST',
  headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
  body: JSON.stringify(body),
}).then((r) => r.json())

const intent = {
  behaviorId: BEHAVIOR.id,
  objectRef: 'OBJ-AML-ACCOUNT:ACC-100001',
  payload: { title: 'F2 演练工单', severity: 'high', candidateId: 'CAND-001', runId: 'run-f2-rehearsal' },
}

const store = actionStoreFor(ROOT)
const conn = createExtApiConnector({ baseUrl: BASE, token: TOKEN, identity: IDENTITY })
registerActionConnector(conn, IDENTITY)

try {
  // ① 提案 → 执行 → 外部单号
  const dec = store.createDecision({
    runId: 'run-f2-rehearsal',
    candidateIds: ['CAND-001'],
    snapshotDigest: 'f2-snap',
    ruleFingerprint: 'aml-analysis@1.0.0',
    reviewer: 'host:f2-rehearsal',
    decision: 'approved',
    reason: 'F2 演练复核',
  })
  const mkProposal = (title) => {
    const p = { ...intent, payload: { ...intent.payload, title } }
    return store.createProposal({
      decisionId: dec.decisionId,
      runId: dec.runId,
      candidateId: 'CAND-001',
      behaviorId: intent.behaviorId,
      objectRef: intent.objectRef,
      payload: p.payload,
      intentDigest: digestAction(p),
      connectorId: IDENTITY.id,
      connectorEnv: IDENTITY.env,
    })
  }
  const prop1 = mkProposal('F2 演练工单')
  const first = await executeBehaviorAction({
    root: ROOT, intent, pkg: PKG, behavior: BEHAVIOR,
    proposalId: prop1.proposalId, requestGrant: async () => GRANT,
  })
  console.log('STEP1', JSON.stringify({ replayed: first.replayed, status: first.record.status, externalRef: first.record.externalRef }))

  // ② 幂等重放：同提案同单号，外部零新建
  const replay = await executeBehaviorAction({
    root: ROOT, intent, pkg: PKG, behavior: BEHAVIOR,
    proposalId: prop1.proposalId,
    requestGrant: async () => { throw new Error('重放不得重复批准') },
  })
  const audit1 = await (await fetch(`${BASE}/api/v1/audit/operations?limit=50`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()
  const posts = (audit1.items ?? []).filter((o) => String(o.method ?? '') === 'POST' || String(o.operation ?? '').includes('create'))
  console.log('STEP2', JSON.stringify({ replayed: replay.replayed, externalRef: replay.record.externalRef, note: replay.note?.slice(0, 60) }))

  // ③ accept-timeout：外部受理后挂起 → 调用方效应不明 → 对账恢复同单号
  await adminPost('/admin/fault', { mode: 'accept-timeout', remaining: 1, holdMs: 2500 })
  const prop2 = mkProposal('F2 演练工单（超时对账）')
  let timeoutSeen = false
  try {
    await executeBehaviorAction({
      root: ROOT, intent: { ...intent, payload: { ...intent.payload, title: 'F2 演练工单（超时对账）' } },
      pkg: PKG, behavior: BEHAVIOR,
      proposalId: prop2.proposalId, requestGrant: async () => GRANT,
    })
  } catch (e) {
    timeoutSeen = e.code === 'ACTION_UNKNOWN_EFFECT'
    console.log('STEP3a', JSON.stringify({ code: e.code, timeoutSeen }))
  }
  // 人工对账：外部回执已落 → 恢复同单号
  const store2 = actionStoreFor(ROOT)
  const stuck = store2.listActions().find((a) => a.proposalId === prop2.proposalId)
  const rec = await executeBehaviorAction({
    root: ROOT, intent: { ...intent, payload: { ...intent.payload, title: 'F2 演练工单（超时对账）' } },
    pkg: PKG, behavior: BEHAVIOR,
    proposalId: prop2.proposalId,
    requestGrant: async () => { throw new Error('对账恢复不得重复批准') },
    inFlightWaitMs: 0,
  })
  console.log('STEP3b', JSON.stringify({ status: rec.record.status, externalRef: rec.record.externalRef, note: rec.note?.slice(0, 70), stuckStatus: stuck?.status }))

  // ④ 取数连接器：分页 + 来源回执 + complete
  const data = createExtDataConnector({ baseUrl: BASE, token: TOKEN })
  const out = await data.fetch({ objectTypes: ['OBJ-AML-CUSTOMER', 'OBJ-AML-ACCOUNT', 'OBJ-AML-TXN'] }, {
    tenant: 'tenant-A', objectTypes: ['OBJ-AML-CUSTOMER', 'OBJ-AML-ACCOUNT', 'OBJ-AML-TXN'],
  })
  console.log('STEP4', JSON.stringify({
    objects: out.dataset.objects.length,
    relations: out.dataset.relations.length,
    complete: out.complete,
    provenance: out.dataset.provenance,
    sample: out.dataset.objects.slice(0, 2).map((o) => `${o.id}:${o.type}`),
  }))

  // 外部终态快照
  const tickets = await (await fetch(`${BASE}/api/v1/tickets?key=x`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()
  const all = await (await fetch(`${BASE}/admin/state`, { headers: { authorization: `Bearer ${ADMIN}` } })).json()
  console.log('EXT-STATE', JSON.stringify({ queryMiss: tickets.state, tickets: (all.tickets ?? []).map((t) => `${t.ticketNo}:${t.status}`) }))
} finally {
  registerActionConnector(null)
  closeActionStore(ROOT)
}
