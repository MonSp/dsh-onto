/** F2 演练补演：accept-timeout 打穿调用方超时 → unknown → 人工对账恢复同单号。 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { executeBehaviorAction, reconcileActionRecord, registerActionConnector, digestAction, ActionExecuteError, ActionNoEffectError } from '../backend/dist/action-executor.js'
import { actionStoreFor, closeActionStore } from '../backend/dist/action-store.js'
import { createExtApiConnector } from '../backend/dist/action-connector-ext.js'

// 台账 ROOT：DSH_PROFILE_DIR 指向 dsh profile 目录（缺省 ~/.dsh/profiles/dsh-onto）；工作区 = <profile>/dsh-onto/workspace
const ROOT = join(
  process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'dsh-onto'),
  'dsh-onto', 'workspace',
)
const BASE = 'http://127.0.0.1:3910'
// 开发缺省静态 token（仅限本地演练面）；一律可经 env 覆盖
const TOKEN = process.env.F2_TIMEOUT_TOKEN ?? 'token-analyst-a'
const ADMIN = process.env.F2_TIMEOUT_ADMIN ?? 'token-admin'
const IDENTITY = { id: 'ext-api', env: 'test', kind: 'simulated' }
const PKG = { name: 'aml-analysis', version: '1.0.0' }
const BEHAVIOR = { id: 'BHV-AML-OPEN-REVIEW-TICKET', anchor: 'OBJ-AML-ACCOUNT', name: '创建复核工单' }
const GRANT = { approvalDigest: 'f2-timeout-grant', approvedAt: new Date().toISOString() }
const TITLE = 'F2 演练工单（超时对账2）'

const intent = {
  behaviorId: BEHAVIOR.id,
  objectRef: 'OBJ-AML-ACCOUNT:ACC-100001',
  payload: { title: TITLE, severity: 'medium', candidateId: 'CAND-001', runId: 'run-f2-rehearsal' },
}

await fetch(`${BASE}/admin/fault`, {
  method: 'POST',
  headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
  body: JSON.stringify({ mode: 'accept-timeout', remaining: 1, holdMs: 2500 }),
})

const store = actionStoreFor(ROOT)
const dec = store.listDecisions('run-f2-rehearsal')[0]
const proposal = store.createProposal({
  decisionId: dec.decisionId,
  runId: dec.runId,
  candidateId: 'CAND-001',
  behaviorId: intent.behaviorId,
  objectRef: intent.objectRef,
  payload: intent.payload,
  intentDigest: digestAction(intent),
  connectorId: IDENTITY.id,
  connectorEnv: IDENTITY.env,
})

// 短超时连接器：故障挂起 2.5s > 调用方 400ms → 效应不明
registerActionConnector(createExtApiConnector({ baseUrl: BASE, token: TOKEN, identity: IDENTITY, requestTimeoutMs: 400 }), IDENTITY)
try {
  await executeBehaviorAction({
    root: ROOT, intent, pkg: PKG, behavior: BEHAVIOR,
    proposalId: proposal.proposalId, requestGrant: async () => GRANT,
    inFlightWaitMs: 0,
  })
  console.log('UNEXPECTED-SUCCESS')
} catch (e) {
  console.log('TIMEOUT-SEEN', JSON.stringify({ code: e.code, msg: e.message.slice(0, 60) }))
}

// 人工对账（正常超时连接器）：外部已受理 → 按回执恢复同单号
registerActionConnector(createExtApiConnector({ baseUrl: BASE, token: TOKEN, identity: IDENTITY }), IDENTITY)
const record = actionStoreFor(ROOT).listActions().find((a) => a.proposalId === proposal.proposalId)
console.log('LEDGER', JSON.stringify({ status: record.status, externalRef: record.externalRef ?? null }))
const rec = await reconcileActionRecord(ROOT, record.businessKey)
console.log('RECONCILED', JSON.stringify({
  status: rec.record.status,
  externalRef: rec.record.externalRef,
  note: rec.note?.slice(0, 80),
}))
const t = await (await fetch(`${BASE}/api/v1/tickets?key=${encodeURIComponent(record.businessKey)}`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()
console.log('EXT-QUERY', JSON.stringify(t))
registerActionConnector(null)
closeActionStore(ROOT)
