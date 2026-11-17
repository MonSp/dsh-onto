/** F1 步骤 6 恢复段：对崩溃遗留的 dispatched 记录重放同提案 → 按外部回执恢复同一单号。 */
import { executeBehaviorAction, registerActionConnector, ActionExecuteError, ActionNoEffectError } from '../backend/dist/action-executor.js'
import { actionStoreFor, closeActionStore } from '../backend/dist/action-store.js'
import { createTicketSimConnector } from '../backend/dist/action-connector-ticketsim.js'

const ROOT = 'C:/Users/qgh13/.dsh/profiles/dsh-onto/dsh-onto/workspace'
const BASE = 'http://127.0.0.1:3901'
const IDENTITY = { id: 'ticket-sim', env: 'local-sim', kind: 'simulated' }
const intent = {
  behaviorId: 'BHV-AML-OPEN-REVIEW-TICKET',
  objectRef: 'OBJ-AML-ACCOUNT:ACCT-001',
  payload: { title: '复核工单（崩溃演练）', runId: 'run-a11cb32a', candidateId: 'CAND-001' },
}
registerActionConnector(createTicketSimConnector({ baseUrl: BASE, ActionExecuteError, ActionNoEffectError }), IDENTITY)
const res = await executeBehaviorAction({
  root: ROOT,
  intent,
  pkg: { name: 'aml-analysis', version: '1.0.0' },
  behavior: { id: 'BHV-AML-OPEN-REVIEW-TICKET', anchor: 'OBJ-AML-ACCOUNT', name: '创建复核工单' },
  proposalId: process.argv[2],
  requestGrant: async () => {
    throw new Error('恢复路径不得重复批准')
  },
  inFlightWaitMs: 0,
})
console.log('RECOVERED', JSON.stringify({ replayed: res.replayed, status: res.record.status, externalRef: res.record.externalRef, note: res.note }))
const tickets = await (await fetch(`${BASE}/admin/tickets`)).json()
console.log('TICKETS', tickets.tickets.map((t) => `${t.ticketNo}:${t.title}`).join(' | '))
registerActionConnector(null)
closeActionStore(ROOT)
