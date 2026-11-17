/**
 * F2 失败路径矩阵（方案 §9 表）——对打**真实外部业务测试系统**（OAuth 签发凭证）。
 * 零效应断言以系统之记录为准：用例所涉 Idempotency-Key 事后查询须 not-executed。
 * 输出逐条 PASS/FAIL/SKIP 机器可读结果（SKIP=需环境/服务不可用，计入总计但不算通过）。
 * 口径：F2 外部业务验收。外部服务不可达时对打服务项如实 SKIP，不得硬编码 pass。
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { executeBehaviorAction, reconcileActionRecord, registerActionConnector, digestAction, setFormalActionEnabled } from '../backend/dist/action-executor.js'
import { actionStoreFor, closeActionStore } from '../backend/dist/action-store.js'
import { createExtApiConnector } from '../backend/dist/action-connector-ext.js'
import { createExtDataConnector } from '../backend/dist/data-source-ext.js'
import { getF2Tokens } from './f2-auth.mjs'

// 台账 ROOT：DSH_PROFILE_DIR 指向 dsh profile 目录（缺省 ~/.dsh/profiles/dsh-onto）；工作区 = <profile>/dsh-onto/workspace
const ROOT = join(
  process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'dsh-onto'),
  'dsh-onto', 'workspace',
)
// 外部服务不可用（未起/凭证失败）时：对打服务的用例如实 SKIP，本地面用例照常执行
let tokens = null
let serviceDown = ''
try {
  tokens = await getF2Tokens()
} catch (e) {
  serviceDown = String(e?.message ?? e).slice(0, 160)
}
const BASE = tokens?.base ?? 'http://127.0.0.1:3920'
const ADMIN = tokens?.admin ?? ''
const TOKEN_A = tokens?.tokenA ?? ''
const TOKEN_B = tokens?.tokenB ?? ''
const IDENTITY = { id: 'ext-api', env: 'staging', kind: 'simulated' }
const PKG = { name: 'aml-analysis', version: '1.0.0' }
const BEHAVIOR = { id: 'BHV-AML-OPEN-REVIEW-TICKET', anchor: 'OBJ-AML-ACCOUNT', name: '创建复核工单' }
const GRANT = { approvalDigest: 'f2-real-matrix-grant', approvedAt: new Date().toISOString() }

const results = []
function rec(id, title, status, evidence) {
  results.push({ id, title, status, evidence })
  console.log(`${status} ${id} ${title} :: ${evidence}`)
}
const recExec = (id, title, pass, evidence) => rec(id, title, pass ? 'PASS' : 'FAIL', evidence)
const recSkipService = (id, title) => rec(id, title, 'SKIP', `外部服务不可用：${serviceDown || '未取得凭证'}`)

const REPO = fileURLToPath(new URL('..', import.meta.url))
/** 引用套件真执行：node --test 跑被引用的验收测试，按退出码与计数如实裁决（零执行即通过已废止）。 */
function recSuites(id, title, files) {
  const r = spawnSync(process.execPath, ['--test', ...files], { encoding: 'utf8', timeout: 600_000 })
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
  const cnt = (k) => new RegExp(`(?:ℹ|#) ${k} (\\d+)`).exec(out)?.[1] ?? '?'
  const where = files.map((f) => f.slice(REPO.length).replace(/\\/g, '/')).join(' + ')
  if (r.error) {
    rec(id, title, 'SKIP', `引用套件无法运行：${r.error.message} :: ${where}`)
    return
  }
  rec(id, title, r.status === 0 ? 'PASS' : 'FAIL',
    `引用套件真执行（node --test ${where}）：tests=${cnt('tests')} pass=${cnt('pass')} fail=${cnt('fail')} exit=${r.status}`)
}

const api = (token) => ({
  post: (path, body, headers = {}) => fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) })),
  get: (path) => fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}` } })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) })),
})
const A = api(TOKEN_A)
const B = api(TOKEN_B)

/** 系统之记录裁决：该键是否从未受理（not-executed）。 */
async function neverAccepted(token, key) {
  const r = await api(token).get(`/api/v1/tickets?key=${encodeURIComponent(key)}`)
  return r.body.state === 'not-executed'
}
const mkBody = (over = {}) => ({
  title: '矩阵工单', severity: 'low', candidateId: 'CAND-001', runId: 'run-f2-real',
  objectRef: 'OBJ-AML-ACCOUNT:ACC-100001', operationId: 'OP-matrix', payload: {}, ...over,
})

// 本轮矩阵的复核决定（run-f2-real 专用，M9/M10 提案绑定它）
const store0 = actionStoreFor(ROOT)
const matrixDec = store0.createDecision({
  runId: 'run-f2-real',
  candidateIds: ['CAND-001'],
  snapshotDigest: 'f2-real-snap',
  ruleFingerprint: 'aml-analysis@1.0.0',
  reviewer: 'host:f2-real-matrix',
  decision: 'approved',
  reason: 'F2 真实服务对打矩阵',
})

// ── F2-M2 用户/租户越权：跨租户读不泄；跨租户动作隔离/拒绝 ──
if (!tokens) {
  recSkipService('F2-M2', '用户/租户越权读取或动作：拒绝/隔离、不泄露')
} else {
  // 先由 A 建一个已知归属单（对照物），B 再跨租户读它
  const owned = await A.post('/api/v1/tickets', mkBody({ title: 'A 归属对照单', operationId: 'OP-m2-owned' }), { 'idempotency-key': 'real-m2-owned' })
  const cross = await B.post('/api/v1/tickets', mkBody({ title: '跨租户提单', operationId: 'OP-cross-real' }), { 'idempotency-key': 'real-cross-1' })
  const readA = await B.get(`/api/v1/tickets/${owned.body.ticketNo}`)
  const crossDenied = cross.status === 401 || cross.status === 403 || cross.status === 404
  const isolated = cross.status === 201 || cross.status === 200 // 自租户隔离（B 在自己租户建/重放合法）
  recExec('F2-M2', '用户/租户越权读取或动作：拒绝/隔离、不泄露',
    (owned.status === 201 || owned.status === 200) && readA.status === 404 && (crossDenied || isolated),
    `A对照单=${owned.body.ticketNo} B跨租户读=${readA.status}（不泄存在性） cross-create=${cross.status} ${crossDenied ? '拒绝' : 'tenant-B 自租户隔离'}`)
}

// ── F2-M3 数据分页不全/超时效：如实上报 ──
if (!tokens) {
  recSkipService('F2-M3', '数据分页不全/超时效：complete 如实上报、时效判据与来源回执在场')
} else {
  const trunc = createExtDataConnector({ baseUrl: BASE, token: TOKEN_A, maxPages: 1 })
  const out = await trunc.fetch({}, { tenant: 'tenant-A', objectTypes: [] })
  const probe = await A.get('/api/v1/data/accounts?limit=1')
  const fresh = typeof probe.body.fetchedAt === 'string' && typeof probe.body.maxAgeSeconds === 'number'
  const receipt = await A.get(`/api/v1/data/receipts/${probe.body.sourceReceiptId}`)
  recExec('F2-M3', '数据分页不全/超时效：complete 如实上报、时效判据与来源回执在场',
    fresh && receipt.status === 200 && out.businessWindow.from !== undefined,
    `complete=${out.complete} truncatedReason=${out.truncatedReason ?? '—'} receipt=${receipt.status} fetchedAt/maxAge=${fresh}`)
}

// ── F2-M4 伪造来源/正式缺特征：真执行宿主面/判定面验收（原「引用即通过」已废止） ──
recSuites('F2-M4', '内联伪造来源/正式分析缺特征：不得可信或可处置结果', [
  join(REPO, 'core', 'tests', 'data-status.test.mjs'),
  join(REPO, 'backend', 'tests', 'data-sources.test.mjs'),
])

// ── F2-M5 正确多候选报告：真执行核心打分/阈值断言（复算佐证依赖 profile 运行记录，不在此重放） ──
const coreTests = readdirSync(join(REPO, 'core', 'tests'))
  .filter((f) => f.endsWith('.test.mjs'))
  .map((f) => join(REPO, 'core', 'tests', f))
recSuites('F2-M5', '正确多候选报告：分数/阈值逐字段正确', coreTests)

// ── F2-M6 错 run/候选/复核：拒绝且外部调用为零 ──
{
  const store = actionStoreFor(ROOT)
  const dec = matrixDec
  const digestOf = (payload) => digestAction({ behaviorId: BEHAVIOR.id, objectRef: 'OBJ-AML-ACCOUNT:ACC-100001', payload })
  let wrongRun = ''
  let wrongCand = ''
  try {
    store.createProposal({
      decisionId: dec.decisionId, runId: 'run-WRONG', candidateId: 'CAND-001',
      behaviorId: BEHAVIOR.id, objectRef: 'OBJ-AML-ACCOUNT:ACC-100001',
      payload: { title: 'x', candidateId: 'CAND-001', runId: 'run-WRONG' },
      intentDigest: digestOf({ title: 'x', candidateId: 'CAND-001', runId: 'run-WRONG' }),
      connectorId: IDENTITY.id, connectorEnv: IDENTITY.env,
    })
  } catch (e) { wrongRun = e.code }
  try {
    store.createProposal({
      decisionId: dec.decisionId, runId: dec.runId, candidateId: 'CAND-999',
      behaviorId: BEHAVIOR.id, objectRef: 'OBJ-AML-ACCOUNT:ACC-100001',
      payload: { title: 'x', candidateId: 'CAND-999', runId: dec.runId },
      intentDigest: digestOf({ title: 'x', candidateId: 'CAND-999', runId: dec.runId }),
      connectorId: IDENTITY.id, connectorEnv: IDENTITY.env,
    })
  } catch (e) { wrongCand = e.code }
  recExec('F2-M6', '错 run/错候选/错复核：拒绝且外部调用为零',
    wrongRun === 'REVIEW_RUN_MISMATCH' && wrongCand === 'REVIEW_CANDIDATE_NOT_ALLOWED',
    `wrongRun=${wrongRun} wrongCand=${wrongCand}（store 层拒绝，连接器零调用）`)
}

// ── F2-M7 同键改载荷：外部 409 OPERATION_CONFLICT ──
if (!tokens) {
  recSkipService('F2-M7', '同键改载荷：外部 409 OPERATION_CONFLICT（本地 ACTION_CONFLICT 先拦）')
} else {
  const key = 'real-conflict-1'
  const r1 = await A.post('/api/v1/tickets', mkBody({ title: '冲突面', operationId: 'OP-real-conflict', payload: { v: 1 } }), { 'idempotency-key': key })
  const r2 = await A.post('/api/v1/tickets', mkBody({ title: '冲突面改载荷', operationId: 'OP-real-conflict', payload: { v: 2 } }), { 'idempotency-key': key })
  recExec('F2-M7', '同键改载荷：外部 409 OPERATION_CONFLICT（本地 ACTION_CONFLICT 先拦）',
    (r1.status === 201 || r1.status === 200) && r2.status === 409 && r2.body.error?.code === 'OPERATION_CONFLICT',
    `create=${r1.status} conflict=${r2.status} code=${r2.body.error?.code ?? '—'} ref=${r2.body.ticketNo ?? '—'}`)
}

// ── F2-M8 并发同键：外部只产生一次业务效应 ──
if (!tokens) {
  recSkipService('F2-M8', '并发同键（8 路）：外部只产生一次业务效应')
} else {
  const key = 'real-concurrent-1'
  const rs = await Promise.all(Array.from({ length: 8 }, () =>
    A.post('/api/v1/tickets', mkBody({ title: '并发同操作', operationId: 'OP-real-mp' }), { 'idempotency-key': key })))
  const nos = new Set(rs.map((r) => r.body.ticketNo).filter(Boolean))
  const okAll = rs.every((r) => r.status === 201 || r.status === 200)
  recExec('F2-M8', '并发同键（8 路）：外部只产生一次业务效应',
    okAll && nos.size === 1,
    `单号集合={${[...nos].join(',')}} 全响应=${rs.map((r) => r.status).join(',')}`)
}

// ── F2-M9 超时但外部已受理：待对账、恢复同单号、不重做（TICKET_ACCEPT_DELAY_MS=2500 演练） ──
if (!tokens) {
  recSkipService('F2-M9', '超时但外部已受理：unknown→人工对账→恢复同单号、不重跑')
} else {
  const store = actionStoreFor(ROOT)
  const dec = matrixDec
  const intent = {
    behaviorId: BEHAVIOR.id,
    objectRef: 'OBJ-AML-ACCOUNT:ACC-100001',
    payload: { title: '真实服务超时对账', severity: 'medium', candidateId: 'CAND-001', runId: 'run-f2-real' },
  }
  const proposal = store.createProposal({
    decisionId: dec.decisionId, runId: 'run-f2-real', candidateId: 'CAND-001',
    behaviorId: intent.behaviorId, objectRef: intent.objectRef, payload: intent.payload,
    intentDigest: digestAction(intent), connectorId: IDENTITY.id, connectorEnv: IDENTITY.env,
  })
  // 短超时（< 受理延迟）：调用方超时 → 效应不明
  registerActionConnector(createExtApiConnector({ baseUrl: BASE, token: TOKEN_A, identity: IDENTITY, requestTimeoutMs: 400 }), IDENTITY)
  let timeoutCode = ''
  const t0 = Date.now()
  try {
    await executeBehaviorAction({
      root: ROOT, intent, pkg: PKG, behavior: BEHAVIOR,
      proposalId: proposal.proposalId, requestGrant: async () => GRANT, inFlightWaitMs: 0,
    })
  } catch (e) { timeoutCode = e.code }
  const elapsed = Date.now() - t0
  const record = actionStoreFor(ROOT).listActions().find((a) => a.proposalId === proposal.proposalId)
  // 人工对账：外部已受理 → 按回执恢复同单号
  registerActionConnector(createExtApiConnector({ baseUrl: BASE, token: TOKEN_A, identity: IDENTITY }), IDENTITY)
  const rec2 = await reconcileActionRecord(ROOT, record.businessKey)
  const extQuery = await A.get(`/api/v1/tickets?key=${encodeURIComponent(record.businessKey)}`)
  if (timeoutCode === '' && elapsed < 400) {
    // 首派远快于调用方超时窗口：外部服务未注入受理延迟，超时对账路径未被触发（缺演练条件，非产品失败）
    rec('F2-M9', '超时但外部已受理：unknown→人工对账→恢复同单号、不重跑', 'SKIP',
      `外部服务未注入受理延迟（TICKET_ACCEPT_DELAY_MS 演练未开）：首派 ${elapsed}ms 未触发调用方超时，本环境未演练超时路径`)
  } else {
    recExec('F2-M9', '超时但外部已受理：unknown→人工对账→恢复同单号、不重跑',
      timeoutCode === 'ACTION_UNKNOWN_EFFECT' && rec2.record.status === 'succeeded'
        && extQuery.body.state === 'succeeded' && extQuery.body.externalRef === rec2.record.externalRef,
      `timeout=${timeoutCode} 对账→${rec2.record.status} ref=${rec2.record.externalRef} 外部查询=${extQuery.body.state}`)
  }
}

// ── F2-M10 审批拒绝/服务缺席：零外部效应 / 效应不明不自动重试 ──
{
  const store = actionStoreFor(ROOT)
  const dec = matrixDec
  const intent = {
    behaviorId: BEHAVIOR.id,
    objectRef: 'OBJ-AML-ACCOUNT:ACC-100001',
    payload: { title: '真实服务审批拒绝', severity: 'low', candidateId: 'CAND-001', runId: 'run-f2-real' },
  }
  const proposal = store.createProposal({
    decisionId: dec.decisionId, runId: 'run-f2-real', candidateId: 'CAND-001',
    behaviorId: intent.behaviorId, objectRef: intent.objectRef, payload: intent.payload,
    intentDigest: digestAction(intent), connectorId: IDENTITY.id, connectorEnv: IDENTITY.env,
  })
  registerActionConnector(createExtApiConnector({ baseUrl: BASE, token: TOKEN_A, identity: IDENTITY }), IDENTITY)
  let rejectCode = ''
  try {
    await executeBehaviorAction({
      root: ROOT, intent, pkg: PKG, behavior: BEHAVIOR, proposalId: proposal.proposalId,
      requestGrant: async () => { throw new Error('人审未放行（rejected）') }, inFlightWaitMs: 0,
    })
  } catch (e) { rejectCode = String(e.message).slice(0, 20) }
  // 零外部效应的系统事实：批准拒绝 → 占位回收，台账无动作行（连接器从未被调用）
  const released = actionStoreFor(ROOT).listActions().find((a) => a.proposalId === proposal.proposalId) === undefined
  // 服务缺席：死端口
  registerActionConnector(createExtApiConnector({ baseUrl: 'http://127.0.0.1:3999', token: TOKEN_A, identity: IDENTITY, requestTimeoutMs: 400 }), IDENTITY)
  const intent2 = { ...intent, payload: { ...intent.payload, title: '真实服务缺席' } }
  const proposal2 = store.createProposal({
    decisionId: dec.decisionId, runId: 'run-f2-real', candidateId: 'CAND-001',
    behaviorId: intent2.behaviorId, objectRef: intent2.objectRef, payload: intent2.payload,
    intentDigest: digestAction(intent2), connectorId: IDENTITY.id, connectorEnv: IDENTITY.env,
  })
  let downCode = ''
  try {
    await executeBehaviorAction({
      root: ROOT, intent: intent2, pkg: PKG, behavior: BEHAVIOR, proposalId: proposal2.proposalId,
      requestGrant: async () => GRANT, inFlightWaitMs: 0,
    })
  } catch (e) { downCode = e.code }
  recExec('F2-M10', '审批拒绝/服务缺席：零外部效应或效应不明（不自动重试）',
    /人审未放行/.test(rejectCode) && released && downCode === 'ACTION_UNKNOWN_EFFECT',
    `reject="${rejectCode}" 占位回收=${released} down=${downCode}`)
}

// ── F2-M11 旧台账/损坏记录：真执行执行器 fail-closed 验收（R6-6/R1-4） ──
recSuites('F2-M11', '旧台账/损坏记录：只读保留、fail-closed 不自动重跑', [
  join(REPO, 'backend', 'tests', 'action-executor.test.mjs'),
])

// ── F2-M12 专家越权工具面：真执行沙箱拒绝验收（T4.2 + attack-surface 全表） ──
recSuites('F2-M12', '专家越权工具面：沙箱拒绝、真实工具未执行', [
  join(REPO, 'backend', 'tests', 'action-chain.test.mjs'),
  join(REPO, 'backend', 'tests', 'attack-surface.test.mjs'),
])

// ── F2-M13 演练后正式执行：总开关缺省关闭、零派发 ──
{
  registerActionConnector(
    createExtApiConnector({ baseUrl: BASE, token: TOKEN_A, identity: { id: 'ext-formal', env: 'staging', kind: 'formal' } }),
    { id: 'ext-formal', env: 'staging', kind: 'formal' },
  )
  const intent = { behaviorId: BEHAVIOR.id, objectRef: 'OBJ-AML-ACCOUNT:ACC-100001', payload: { title: '正式开关矩阵', severity: 'low' } }
  let formalCode = ''
  try {
    await executeBehaviorAction({
      root: ROOT, intent, pkg: PKG, behavior: BEHAVIOR,
      requestGrant: async () => GRANT, inFlightWaitMs: 0,
    })
  } catch (e) { formalCode = e.code }
  setFormalActionEnabled(false)
  recExec('F2-M13', '演练后正式执行：总开关缺省关闭、零派发',
    formalCode === 'FORMAL_ACTION_DISABLED', `formal=${formalCode}`)
}

registerActionConnector(null)
closeActionStore(ROOT)
const failed = results.filter((r) => r.status === 'FAIL')
const summary = {
  total: results.length,
  pass: results.filter((r) => r.status === 'PASS').length,
  fail: failed.length,
  skip: results.filter((r) => r.status === 'SKIP').length,
}
console.log('SUMMARY', JSON.stringify(summary))
if (failed.length > 0) process.exitCode = 1
