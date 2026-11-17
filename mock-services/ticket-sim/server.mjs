/**
 * ticket-sim — F1 本地工程验收的工单模拟服务（独立进程 HTTP）。
 *
 * 方案 §9 F1 约束：工单与幂等记录由本服务**自身**持久化（SQLite 文件）；受理后超时等
 * 故障注入在服务端发生；外部单号由本服务分配，执行器不伪造。一切回执显式标注 simulated。
 *
 * API（JSON over HTTP）：
 *   GET  /admin/health                 健康与工单计数
 *   GET  /admin/audit?limit=50         请求审计（连接器目标系统侧证据）
 *   GET  /admin/tickets                全量工单（验证用）
 *   POST /admin/fault                  { mode, remaining?, holdMs? } 设故障注入
 *   POST /tickets                      创建工单（幂等：Idempotency-Key 头或 body.idempotencyKey）
 *   GET  /tickets?key=<idem>           按幂等键回读（ActionConnector.queryResult 形态）
 *   GET  /tickets/<ticketNo>           按单号回读
 *   POST /tickets/<ticketNo>/cancel    补偿撤销（幂等）
 *
 * 故障模式（仅对「将产生新效应」的创建生效，remaining 每次递减；幂等重放不触发）：
 *   none           正常
 *   reject         受理前拒绝（422，零效应）
 *   accept-timeout 受理后挂起响应（调用方超时；工单已落，可对账回读）
 *   partial-fail   受理后回执失败（502 带单号；可补偿撤销）
 *   hang           受理前挂起（调用方超时；零效应）
 * 单次请求可用请求头 x-sim-fault 覆盖模式（不消耗 remaining，仅作用于该请求）。
 *
 * 运行：node server.mjs [--port 3901] [--db <path>]
 * 环境：TICKET_SIM_PORT / TICKET_SIM_DB / TICKET_SIM_FAULT_HOLD_MS（缺省 30000）
 */
import { createServer } from 'node:http'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const DEFAULT_PORT = 3901
const DEFAULT_HOLD_MS = Number(process.env.TICKET_SIM_FAULT_HOLD_MS ?? 30_000)
const MAX_BODY = 1024 * 1024
const FAULT_MODES = new Set(['none', 'reject', 'accept-timeout', 'partial-fail', 'hang'])

function parseArgs(argv) {
  const out = { port: Number(process.env.TICKET_SIM_PORT ?? DEFAULT_PORT), db: process.env.TICKET_SIM_DB ?? null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') out.port = Number(argv[++i])
    else if (argv[i] === '--db') out.db = argv[++i]
  }
  return out
}

function openDb(dbPath) {
  if (dbPath !== null && dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
  // timeout：跨进程写锁 busy 等待（并发同键时第二进程靠它排到唯一约束/重放路径）
  const db = new DatabaseSync(dbPath, dbPath === ':memory:' ? {} : { timeout: 5_000 })
  db.exec(`
    create table if not exists counters (name text primary key, value integer not null);
    create table if not exists tickets (
      id integer primary key autoincrement,
      ticket_no text not null unique,
      idempotency_key text not null unique,
      status text not null,
      title text not null,
      severity text,
      candidate_id text,
      run_id text,
      object_ref text,
      behavior_id text,
      payload_json text not null default '{}',
      simulated integer not null default 1,
      created_at text not null,
      updated_at text not null,
      canceled_at text
    );
    create table if not exists fault (
      id integer primary key check (id = 1),
      mode text not null default 'none',
      remaining integer not null default 0,
      hold_ms integer not null default 30000
    );
    create table if not exists audit (
      id integer primary key autoincrement,
      at text not null,
      method text not null,
      path text not null,
      idempotency_key text,
      outcome text not null,
      detail text
    );
  `)
  return db
}

function now() {
  return new Date().toISOString()
}

function audit(db, req, key, outcome, detail) {
  db.prepare('insert into audit (at, method, path, idempotency_key, outcome, detail) values (?,?,?,?,?,?)')
    .run(now(), req.method, req.url ?? '', key ?? null, outcome, detail ?? null)
}

function currentFault(db, override) {
  if (override !== undefined) {
    return FAULT_MODES.has(override) && override !== 'none'
      ? { mode: override, remaining: 1, holdMs: DEFAULT_HOLD_MS }
      : { mode: 'none', remaining: 0, holdMs: DEFAULT_HOLD_MS }
  }
  const row = db.prepare('select mode, remaining, hold_ms from fault where id = 1').get()
  if (row === undefined || row.mode === 'none' || row.remaining <= 0) {
    return { mode: 'none', remaining: 0, holdMs: DEFAULT_HOLD_MS }
  }
  return { mode: row.mode, remaining: row.remaining, holdMs: row.hold_ms }
}

function consumeFault(db, hasOverride) {
  // 请求头 x-sim-fault 显式 override 不消耗 DB 计数器（见文件头文档）
  if (hasOverride) return
  db.prepare('update fault set remaining = remaining - 1 where id = 1 and remaining > 0').run()
}

function ticketToJson(row) {
  return {
    ticketNo: row.ticket_no,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    title: row.title,
    severity: row.severity,
    candidateId: row.candidate_id,
    runId: row.run_id,
    objectRef: row.object_ref,
    behaviorId: row.behavior_id,
    payload: JSON.parse(row.payload_json),
    simulated: row.simulated === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    canceledAt: row.canceled_at,
  }
}

function send(res, status, body) {
  const raw = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(raw) })
  res.end(raw)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('body-too-large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('invalid-json'))
      }
    })
    req.on('error', reject)
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 创建工单（幂等）。故障仅作用于将产生新效应的请求；重放直接回读既有工单。 */
async function handleCreate(db, req, res, body, faultOverride) {
  const key = req.headers['idempotency-key'] ?? body.idempotencyKey
  if (typeof key !== 'string' || key.length === 0) {
    audit(db, req, null, 'rejected', 'idempotency-key-required')
    send(res, 400, { ok: false, simulated: true, error: 'idempotency-key-required' })
    return
  }
  const existing = db.prepare('select * from tickets where idempotency_key = ?').get(key)
  if (existing !== undefined) {
    audit(db, req, key, 'replayed', existing.ticket_no)
    send(res, 200, {
      ok: true,
      simulated: true,
      first: false,
      ticketNo: existing.ticket_no,
      idempotencyKey: key,
      status: existing.status,
      createdAt: existing.created_at,
    })
    return
  }

  const fault = currentFault(db, faultOverride)
  const hasOverride = faultOverride !== undefined
  if (fault.mode === 'reject') {
    consumeFault(db, hasOverride)
    audit(db, req, key, 'rejected', 'fault=reject')
    send(res, 422, { ok: false, simulated: true, error: 'rejected-before-effect' })
    return
  }
  if (fault.mode === 'hang') {
    consumeFault(db, hasOverride)
    audit(db, req, key, 'hang', 'fault=hang（受理前挂起，零效应）')
    await sleep(fault.holdMs)
    send(res, 504, { ok: false, simulated: true, error: 'hang-timeout-no-effect' })
    return
  }

  const at = now()
  const status = fault.mode === 'partial-fail' ? 'failed' : 'open'
  const title = typeof body.title === 'string' && body.title.length > 0 ? body.title : '（无标题）'
  let row
  try {
    db.exec('begin immediate')
    db.prepare('insert into counters (name, value) values (\'ticket\', 0) on conflict(name) do nothing').run()
    db.prepare('update counters set value = value + 1 where name = \'ticket\'').run()
    const seq = db.prepare('select value from counters where name = \'ticket\'').get().value
    const ticketNo = `SIM-TKT-${String(seq).padStart(6, '0')}`
    db.prepare(
      `insert into tickets (ticket_no, idempotency_key, status, title, severity, candidate_id, run_id, object_ref, behavior_id, payload_json, created_at, updated_at)
       values (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      ticketNo,
      key,
      status,
      title,
      body.severity ?? null,
      body.candidateId ?? null,
      body.runId ?? null,
      body.objectRef ?? null,
      body.behaviorId ?? null,
      JSON.stringify(body.payload ?? {}),
      at,
      at,
    )
    db.exec('commit')
    row = db.prepare('select * from tickets where idempotency_key = ?').get(key)
  } catch (e) {
    try {
      db.exec('rollback')
    } catch {
      /* 事务未开启（如 begin 即 busy）时不掩盖主错误 */
    }
    // 跨进程并发同键：唯一约束拦下后当重放回读（外部只产生一次效应）
    const again = db.prepare('select * from tickets where idempotency_key = ?').get(key)
    if (again !== undefined) {
      audit(db, req, key, 'replayed-concurrent', again.ticket_no)
      send(res, 200, {
        ok: true,
        simulated: true,
        first: false,
        ticketNo: again.ticket_no,
        idempotencyKey: key,
        status: again.status,
        createdAt: again.created_at,
      })
      return
    }
    audit(db, req, key, 'error', String(e?.message ?? e))
    send(res, 500, { ok: false, simulated: true, error: 'persist-failed' })
    return
  }

  if (fault.mode === 'accept-timeout') {
    consumeFault(db, hasOverride)
    audit(db, req, key, 'accepted-held', `${row.ticket_no}（受理后挂起，调用方超时）`)
    await sleep(fault.holdMs)
    send(res, 201, {
      ok: true,
      simulated: true,
      first: true,
      ticketNo: row.ticket_no,
      idempotencyKey: key,
      status: row.status,
      createdAt: row.created_at,
    })
    return
  }
  if (fault.mode === 'partial-fail') {
    consumeFault(db, hasOverride)
    audit(db, req, key, 'partial-fail', row.ticket_no)
    send(res, 502, { ok: false, simulated: true, error: 'accepted-but-failed', ticketNo: row.ticket_no })
    return
  }
  audit(db, req, key, 'created', row.ticket_no)
  send(res, 201, {
    ok: true,
    simulated: true,
    first: true,
    ticketNo: row.ticket_no,
    idempotencyKey: key,
    status: row.status,
    createdAt: row.created_at,
  })
}

function handleCancel(db, req, res, ticketNo) {
  const row = db.prepare('select * from tickets where ticket_no = ?').get(ticketNo)
  if (row === undefined) {
    audit(db, req, null, 'cancel-miss', ticketNo)
    send(res, 404, { ok: false, simulated: true, error: 'ticket-not-found' })
    return
  }
  if (row.status === 'canceled') {
    audit(db, req, row.idempotency_key, 'cancel-already', ticketNo)
    send(res, 200, { ok: true, simulated: true, already: true, ticket: ticketToJson(row) })
    return
  }
  const at = now()
  db.prepare('update tickets set status = \'canceled\', canceled_at = ?, updated_at = ? where ticket_no = ?')
    .run(at, at, ticketNo)
  const after = db.prepare('select * from tickets where ticket_no = ?').get(ticketNo)
  audit(db, req, after.idempotency_key, 'canceled', ticketNo)
  send(res, 200, { ok: true, simulated: true, already: false, ticket: ticketToJson(after) })
}

function routes(db, holdDefault) {
  return async function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    const method = req.method ?? 'GET'
    try {
      // /admin/* 无鉴权：仅限本地测试面（127.0.0.1 回环监听），勿在共享机/对外可达环境运行本服务
      if (method === 'GET' && path === '/admin/health') {
        const count = db.prepare('select count(*) as n from tickets').get().n
        send(res, 200, { ok: true, simulated: true, tickets: count, uptimeSec: Math.round(process.uptime()) })
        return
      }
      if (method === 'GET' && path === '/admin/audit') {
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 500)
        const rows = db.prepare('select * from audit order by id desc limit ?').all(limit)
        send(res, 200, {
          ok: true,
          simulated: true,
          entries: rows.map((r) => ({
            id: r.id,
            at: r.at,
            method: r.method,
            path: r.path,
            idempotencyKey: r.idempotency_key,
            outcome: r.outcome,
            detail: r.detail,
          })),
        })
        return
      }
      if (method === 'GET' && path === '/admin/tickets') {
        const rows = db.prepare('select * from tickets order by id asc').all()
        send(res, 200, { ok: true, simulated: true, tickets: rows.map(ticketToJson) })
        return
      }
      if (method === 'POST' && path === '/admin/fault') {
        const body = await readBody(req)
        const mode = typeof body.mode === 'string' ? body.mode : 'none'
        if (!FAULT_MODES.has(mode)) {
          send(res, 400, { ok: false, simulated: true, error: `unknown-fault-mode: ${mode}` })
          return
        }
        const remaining = Number.isFinite(body.remaining) ? Math.max(0, Math.trunc(body.remaining)) : 1
        const holdMs = Number.isFinite(body.holdMs) ? Math.max(0, Math.trunc(body.holdMs)) : holdDefault
        db.prepare('insert into fault (id, mode, remaining, hold_ms) values (1, ?, ?, ?) on conflict(id) do update set mode = excluded.mode, remaining = excluded.remaining, hold_ms = excluded.hold_ms')
          .run(mode, remaining, holdMs)
        audit(db, req, null, 'fault-set', `${mode} remaining=${remaining} holdMs=${holdMs}`)
        send(res, 200, { ok: true, simulated: true, mode, remaining, holdMs })
        return
      }
      if (method === 'POST' && path === '/tickets') {
        const body = await readBody(req)
        await handleCreate(db, req, res, body, req.headers['x-sim-fault'])
        return
      }
      if (method === 'GET' && path === '/tickets') {
        const key = url.searchParams.get('key')
        if (key === null) {
          send(res, 400, { ok: false, simulated: true, error: 'key-required' })
          return
        }
        const row = db.prepare('select * from tickets where idempotency_key = ?').get(key)
        if (row === undefined) {
          audit(db, req, key, 'query-miss', null)
          send(res, 200, { state: 'not-executed', simulated: true })
          return
        }
        audit(db, req, key, 'query-hit', row.ticket_no)
        send(res, 200, { state: 'succeeded', externalRef: row.ticket_no, simulated: true, ticket: ticketToJson(row) })
        return
      }
      let m = path.match(/^\/tickets\/([^/]+)$/)
      if (method === 'GET' && m !== null) {
        const row = db.prepare('select * from tickets where ticket_no = ?').get(decodeURIComponent(m[1]))
        if (row === undefined) {
          send(res, 404, { ok: false, simulated: true, error: 'ticket-not-found' })
          return
        }
        send(res, 200, { ok: true, simulated: true, ticket: ticketToJson(row) })
        return
      }
      m = path.match(/^\/tickets\/([^/]+)\/cancel$/)
      if (method === 'POST' && m !== null) {
        handleCancel(db, req, res, decodeURIComponent(m[1]))
        return
      }
      audit(db, req, null, 'no-route', `${method} ${path}`)
      send(res, 404, { ok: false, simulated: true, error: 'no-route' })
    } catch (e) {
      if (e?.message === 'invalid-json') {
        send(res, 400, { ok: false, simulated: true, error: 'invalid-json' })
        return
      }
      if (e?.message === 'body-too-large') {
        send(res, 413, { ok: false, simulated: true, error: 'body-too-large' })
        return
      }
      try {
        audit(db, req, null, 'error', String(e?.message ?? e))
      } catch {
        /* 审计失败不掩盖主错误 */
      }
      send(res, 500, { ok: false, simulated: true, error: 'internal' })
    }
  }
}

export function startTicketSim({ port = 0, dbPath = ':memory:', holdMs = DEFAULT_HOLD_MS } = {}) {
  const db = openDb(dbPath)
  const server = createServer(routes(db, holdMs))
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port
      resolve({
        server,
        db,
        port: actual,
        close: () =>
          new Promise((done) => {
            server.close(() => {
              try {
                db.close()
              } catch {
                /* 已关 */
              }
              done()
            })
          }),
      })
    })
  })
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const args = parseArgs(process.argv.slice(2))
  const dbPath = args.db ?? join(dirname(fileURLToPath(import.meta.url)), 'data', 'tickets.db')
  const inst = await startTicketSim({ port: args.port, dbPath })
  // stdout 单行 JSON：测试与脚本解析监听端口
  console.log(JSON.stringify({ event: 'listening', port: inst.port, db: dbPath, pid: process.pid, simulated: true }))
  const shutdown = () => {
    inst.close().then(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
