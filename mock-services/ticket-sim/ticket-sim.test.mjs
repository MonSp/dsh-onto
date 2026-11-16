/**
 * ticket-sim 验收测试 —— 真实子进程 + 真 HTTP（F1 口径：服务自身持久化与幂等、
 * 受理后超时可对账、外部单号来自服务端、重启后记录仍在）。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTicketSimConnector, SimActionExecuteError, SimActionNoEffectError } from './connector.mjs'

const SERVER = fileURLToPath(new URL('./server.mjs', import.meta.url))

async function spawnServer(dbPath, env = {}) {
  const child = spawn(process.execPath, [SERVER, '--port', '0', '--db', dbPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TICKET_SIM_FAULT_HOLD_MS: '1500', ...env },
  })
  let stderr = ''
  child.stderr.on('data', (c) => {
    stderr += c
  })
  const port = await new Promise((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => reject(new Error(`启动超时：${buf}${stderr}`)), 8000)
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
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`服务提前退出 code=${code}：${buf}${stderr}`))
    })
  })
  return {
    child,
    port,
    base: `http://127.0.0.1:${port}`,
    kill: () =>
      new Promise((done) => {
        if (child.exitCode !== null) {
          done()
          return
        }
        child.on('exit', () => done())
        child.kill()
      }),
  }
}

const post = (base, path, body, headers = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(1200),
  }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) }))

const get = (base, path) =>
  fetch(`${base}${path}`, { signal: AbortSignal.timeout(1200) }).then(async (res) => ({
    status: res.status,
    body: await res.json().catch(() => ({})),
  }))

let shared
let sharedDb

before(async () => {
  sharedDb = join(mkdtempSync(join(tmpdir(), 'ticket-sim-')), 'tickets.db')
  shared = await spawnServer(sharedDb)
})

after(async () => {
  await shared?.kill()
})

test('健康面：服务自称 simulated，工单数可查', async () => {
  const { status, body } = await get(shared.base, '/admin/health')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.simulated, true)
  assert.equal(typeof body.tickets, 'number')
})

test('创建 + 幂等重放：同键同单号，first 标记翻转，不新建工单', async () => {
  const key = 'itest-create-1'
  const r1 = await post(shared.base, '/tickets', { title: '复核工单 A', runId: 'run-abc12345' }, { 'idempotency-key': key })
  assert.equal(r1.status, 201)
  assert.match(r1.body.ticketNo, /^SIM-TKT-\d{6}$/)
  assert.equal(r1.body.first, true)
  assert.equal(r1.body.simulated, true)

  const r2 = await post(shared.base, '/tickets', { title: '复核工单 A（重放）' }, { 'idempotency-key': key })
  assert.equal(r2.status, 200)
  assert.equal(r2.body.ticketNo, r1.body.ticketNo)
  assert.equal(r2.body.first, false)

  const all = await get(shared.base, '/admin/tickets')
  const mine = all.body.tickets.filter((t) => t.idempotencyKey === key)
  assert.equal(mine.length, 1)
  assert.equal(mine[0].status, 'open')
  assert.equal(mine[0].simulated, true)
})

test('并发同键（单服务多请求）：外部只产生一次效应', async () => {
  const key = 'itest-concurrent-1'
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      post(shared.base, '/tickets', { title: '并发同操作' }, { 'idempotency-key': key }),
    ),
  )
  const nos = new Set(results.map((r) => r.body.ticketNo))
  assert.equal(nos.size, 1, `同键并发应得同一单号，实际：${[...nos].join(',')}`)
  const all = await get(shared.base, '/admin/tickets')
  assert.equal(all.body.tickets.filter((t) => t.idempotencyKey === key).length, 1)
})

test('对账回读：queryResult 形态（命中 succeeded / 未命中 not-executed）', async () => {
  const key = 'itest-query-1'
  const created = await post(shared.base, '/tickets', { title: '对账回读' }, { 'idempotency-key': key })
  const hit = await get(shared.base, `/tickets?key=${encodeURIComponent(key)}`)
  assert.equal(hit.status, 200)
  assert.equal(hit.body.state, 'succeeded')
  assert.equal(hit.body.externalRef, created.body.ticketNo)

  const miss = await get(shared.base, '/tickets?key=never-used-key')
  assert.equal(miss.body.state, 'not-executed')
})

test('故障 reject：受理前拒绝、零效应（回读 not-executed）', async () => {
  const key = 'itest-reject-1'
  await post(shared.base, '/admin/fault', { mode: 'reject', remaining: 1 })
  const r = await post(shared.base, '/tickets', { title: '应被拒绝' }, { 'idempotency-key': key })
  assert.equal(r.status, 422)
  assert.equal(r.body.error, 'rejected-before-effect')
  const q = await get(shared.base, `/tickets?key=${encodeURIComponent(key)}`)
  assert.equal(q.body.state, 'not-executed')
})

test('故障 accept-timeout：受理后调用方超时，对账可恢复同一单号', async () => {
  const key = 'itest-accept-timeout-1'
  await post(shared.base, '/admin/fault', { mode: 'accept-timeout', remaining: 1, holdMs: 1500 })
  let timedOut = false
  try {
    await fetch(`${shared.base}/tickets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ title: '受理后超时' }),
      signal: AbortSignal.timeout(300),
    })
  } catch {
    timedOut = true
  }
  assert.equal(timedOut, true, '调用方应观察到超时')
  const q = await get(shared.base, `/tickets?key=${encodeURIComponent(key)}`)
  assert.equal(q.body.state, 'succeeded', '外部已受理——对账必须能恢复单号')
  assert.match(q.body.externalRef, /^SIM-TKT-\d{6}$/)
})

test('故障 partial-fail：受理后失败带单号，补偿撤销落 canceled', async () => {
  const key = 'itest-partial-1'
  await post(shared.base, '/admin/fault', { mode: 'partial-fail', remaining: 1 })
  const r = await post(shared.base, '/tickets', { title: '部分效应' }, { 'idempotency-key': key })
  assert.equal(r.status, 502)
  assert.equal(r.body.error, 'accepted-but-failed')
  assert.match(r.body.ticketNo, /^SIM-TKT-\d{6}$/)

  const c1 = await post(shared.base, `/tickets/${r.body.ticketNo}/cancel`, { reason: 'compensate' })
  assert.equal(c1.status, 200)
  assert.equal(c1.body.ticket.status, 'canceled')
  const c2 = await post(shared.base, `/tickets/${r.body.ticketNo}/cancel`, {})
  assert.equal(c2.body.already, true, '补偿应幂等')
})

test('审计面：服务端留有创建/重放/查询记录（连接器目标系统侧证据）', async () => {
  const { body } = await get(shared.base, '/admin/audit?limit=100')
  const outcomes = body.entries.map((e) => e.outcome)
  assert.ok(outcomes.includes('created'), `期望 created，实际 ${outcomes.join(',')}`)
  assert.ok(outcomes.includes('replayed'))
  assert.ok(outcomes.includes('query-hit'))
})

test('跨进程并发同键（两个服务进程共享台账）：外部只产生一次效应', async () => {
  const db = join(mkdtempSync(join(tmpdir(), 'ticket-sim-')), 'mp.db')
  const s1 = await spawnServer(db)
  const s2 = await spawnServer(db)
  try {
    const key = 'itest-mp-1'
    const results = await Promise.all([
      post(s1.base, '/tickets', { title: '跨进程并发' }, { 'idempotency-key': key }),
      post(s2.base, '/tickets', { title: '跨进程并发' }, { 'idempotency-key': key }),
    ])
    const nos = new Set(results.map((r) => r.body.ticketNo))
    assert.equal(nos.size, 1, `两个进程应得同一单号，实际：${[...nos].join(',')}`)
    const all = await get(s1.base, '/admin/tickets')
    assert.equal(all.body.tickets.filter((t) => t.idempotencyKey === key).length, 1)
  } finally {
    await s1.kill()
    await s2.kill()
  }
})

test('重启持久化：进程杀死再起，工单与幂等记录仍在', async () => {
  const db = join(mkdtempSync(join(tmpdir(), 'ticket-sim-')), 'restart.db')
  const s1 = await spawnServer(db)
  const key = 'itest-restart-1'
  const created = await post(s1.base, '/tickets', { title: '重启前创建' }, { 'idempotency-key': key })
  assert.equal(created.status, 201)
  await s1.kill()

  const s2 = await spawnServer(db)
  try {
    const q = await get(s2.base, `/tickets?key=${encodeURIComponent(key)}`)
    assert.equal(q.body.state, 'succeeded')
    assert.equal(q.body.externalRef, created.body.ticketNo)
    const byNo = await get(s2.base, `/tickets/${created.body.ticketNo}`)
    assert.equal(byNo.body.ticket.title, '重启前创建')
  } finally {
    await s2.kill()
  }
})

test('连接器适配：externalRef 来自网络回执；错误映射可被 instanceof 分类', async () => {
  const conn = createTicketSimConnector({
    baseUrl: shared.base,
    ActionExecuteError: SimActionExecuteError,
    ActionNoEffectError: SimActionNoEffectError,
    requestTimeoutMs: 800,
  })
  const intent = { behaviorId: 'BEH-OPEN-TICKET', objectRef: 'ACCT:001', payload: { title: '经连接器开工单', runId: 'run-abc12345' } }

  const r1 = await conn.execute(intent, 'act00001', 'itest-conn-1')
  assert.match(r1.externalRef, /^SIM-TKT-\d{6}$/)
  const r2 = await conn.execute(intent, 'act00001', 'itest-conn-1')
  assert.equal(r2.externalRef, r1.externalRef, '重放须回读同一外部单号')

  const q = await conn.queryResult(intent, 'itest-conn-1')
  assert.equal(q.state, 'succeeded')
  assert.equal(q.externalRef, r1.externalRef)
  const qMiss = await conn.queryResult(intent, 'itest-conn-miss')
  assert.equal(qMiss.state, 'not-executed')

  await post(shared.base, '/admin/fault', { mode: 'reject', remaining: 1 })
  await assert.rejects(
    () => conn.execute(intent, 'act00002', 'itest-conn-reject'),
    (e) => e instanceof SimActionNoEffectError,
    '受理前拒绝须映射为无效应错误',
  )

  await post(shared.base, '/admin/fault', { mode: 'partial-fail', remaining: 1 })
  await assert.rejects(
    () => conn.execute(intent, 'act00003', 'itest-conn-partial'),
    (e) => e instanceof SimActionExecuteError && /^SIM-TKT-\d{6}$/.test(e.externalRef),
    '受理后失败须带 externalRef 的部分效应错误',
  )

  await conn.compensate(intent, r1.externalRef)
  const canceled = await get(shared.base, `/tickets/${r1.externalRef}`)
  assert.equal(canceled.body.ticket.status, 'canceled')
})
