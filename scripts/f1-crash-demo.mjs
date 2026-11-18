/**
 * F1 步骤 6 live 演练：外部受理后、写终态前崩溃（SIGKILL）→ 重启对账恢复同一外部单号。
 * 前置：ticket-sim 跑在 3901；活动 profile 工作区已有复核决定 DEC-3fb627bdf172。
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { executeBehaviorAction, registerActionConnector, digestAction, ActionExecuteError, ActionNoEffectError } from '../backend/dist/action-executor.js'
import { actionStoreFor, closeActionStore } from '../backend/dist/action-store.js'
import { createTicketSimConnector } from '../backend/dist/action-connector-ticketsim.js'

// 台账 ROOT：DSH_PROFILE_DIR 指向 dsh profile 目录（缺省 ~/.dsh/profiles/dsh-onto）；工作区 = <profile>/dsh-onto/workspace
const ROOT = join(
  process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'dsh-onto'),
  'dsh-onto', 'workspace',
)
const BASE = 'http://127.0.0.1:3901'
const IDENTITY = { id: 'ticket-sim', env: 'local-sim', kind: 'simulated' }
const PKG = { name: 'aml-analysis', version: '1.0.0' }
const BEHAVIOR = { id: 'BHV-AML-OPEN-REVIEW-TICKET', anchor: 'OBJ-AML-ACCOUNT', name: '创建复核工单' }
const GRANT = { approvalDigest: 'crash-demo-grant', approvedAt: new Date().toISOString() }

const intent = {
  behaviorId: 'BHV-AML-OPEN-REVIEW-TICKET',
  objectRef: 'OBJ-AML-ACCOUNT:ACCT-001',
  payload: { title: '复核工单（崩溃演练）', runId: 'run-a11cb32a', candidateId: 'CAND-001' },
}

const store = actionStoreFor(ROOT)
const proposal = store.createProposal({
  decisionId: 'DEC-3fb627bdf172',
  runId: 'run-a11cb32a',
  candidateId: 'CAND-001',
  behaviorId: intent.behaviorId,
  objectRef: intent.objectRef,
  payload: intent.payload,
  intentDigest: digestAction(intent),
  connectorId: IDENTITY.id,
  connectorEnv: IDENTITY.env,
})
console.log('PROPOSAL', proposal.proposalId, proposal.operationId)

// ── 子进程：派发后、回执写盘前 SIGKILL（模拟「外部已受理、终态未落」） ──
const childSrc = join(mkdtempSync(join(tmpdir(), 'f1-crash-')), 'child.mjs')
const dist = (p) => pathToFileURL(join(process.cwd(), 'backend', 'dist', p)).href
writeFileSync(childSrc, `
import { executeBehaviorAction, registerActionConnector, ActionExecuteError, ActionNoEffectError } from ${JSON.stringify(dist('action-executor.js'))}
import { createTicketSimConnector } from ${JSON.stringify(dist('action-connector-ticketsim.js'))}
const [, , root, proposalId] = process.argv
const intent = ${JSON.stringify(intent)}
const inner = createTicketSimConnector({ baseUrl: ${JSON.stringify(BASE)}, ActionExecuteError, ActionNoEffectError })
registerActionConnector({
  async execute(i, a, key) {
    const out = await inner.execute(i, a, key)
    // 外部已受理（工单已落）——在回执返回前杀掉自己，终态不会写进台账
    console.log('EXTERNAL_ACCEPTED ' + out.externalRef)
    process.kill(process.pid, 'SIGKILL')
  },
  async compensate(i, ref) { return inner.compensate(i, ref) },
  async queryResult(i, key) { return inner.queryResult(i, key) },
}, ${JSON.stringify(IDENTITY)})
try {
  await executeBehaviorAction({
    root, intent, pkg: ${JSON.stringify(PKG)}, behavior: ${JSON.stringify(BEHAVIOR)},
    proposalId,
    requestGrant: async () => (${JSON.stringify(GRANT)}),
    inFlightWaitMs: 0,
  })
} catch (e) {
  console.log('CHILD_ERR ' + (e?.code ?? e?.message))
}
`)

const child = spawn(process.execPath, [childSrc, ROOT, proposal.proposalId], { stdio: ['ignore', 'pipe', 'pipe'] })
let childOut = ''
child.stdout.on('data', (c) => { childOut += c })
child.stderr.on('data', (c) => { childOut += c })
const killed = await new Promise((resolve) => {
  child.on('exit', (code, signal) => resolve({ code, signal }))
  setTimeout(() => resolve({ code: 'timeout' }), 8000)
})
console.log('CHILD_EXIT', JSON.stringify(killed), childOut.trim().slice(0, 200))

// ── 父进程：重启对账（重放同提案）→ 按外部回执恢复同一单号 ──
registerActionConnector(createTicketSimConnector({
  baseUrl: BASE,
  ActionExecuteError,
  ActionNoEffectError,
}), IDENTITY)
const res = await executeBehaviorAction({
  root: ROOT,
  intent,
  pkg: PKG,
  behavior: BEHAVIOR,
  proposalId: proposal.proposalId,
  requestGrant: async () => {
    throw new Error('恢复路径不得重复批准')
  },
  inFlightWaitMs: 0,
})
console.log('RECOVERED', JSON.stringify({
  replayed: res.replayed,
  status: res.record.status,
  externalRef: res.record.externalRef,
  note: res.note,
}))
const tickets = await (await fetch(`${BASE}/admin/tickets`)).json()
console.log('TICKETS', tickets.tickets.map((t) => `${t.ticketNo}:${t.title}`).join(' | '))
registerActionConnector(null)
closeActionStore(ROOT)
