/**
 * wst-api —— 校园废弃物（WST）只读快照 mock（api-to-plugin 验收夹具）。
 *
 * 只读 HTTP（JSON）；无数据库、无写端点；进程独立、仅绑回环。
 * 结构刻意不同于 tax-api：单端点多集合（无 items/cursor 信封），
 * bins 内嵌 mixEvents 子记录、routes 以 covers 数组外键挂桶。
 *
 * API：
 *   GET /admin/health            { ok, nature, counts }
 *   GET /api/v1/bin-snapshot     快照 JSON（bins/routes/dumps/alerts 顶层多数组）
 *   其它方法 / 未知路径 → 405 / 404（零写入）
 *
 * 运行：node server.mjs [--port 3912]
 * 环境：WST_API_PORT
 */
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DEFAULT_PORT = 3912

const SNAPSHOT = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'data', 'snapshot.json'), 'utf8'),
)

function counts() {
  return {
    bins: SNAPSHOT.bins.length,
    routes: SNAPSHOT.routes.length,
    dumps: SNAPSHOT.dumps.length,
    alerts: SNAPSHOT.alerts.length,
  }
}

function parsePort(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' && argv[i + 1] !== undefined) return Number(argv[++i])
  }
  return Number(process.env.WST_API_PORT ?? DEFAULT_PORT)
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

export function createWstApiServer() {
  return createServer((req, res) => {
    if (req.method !== 'GET') {
      // 只读：一切非 GET 显式拒绝
      sendJson(res, 405, { ok: false, error: 'method_not_allowed', note: 'wst-api is read-only' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname.replace(/\/+$/, '') || '/'

    if (path === '/admin/health') {
      sendJson(res, 200, { ok: true, nature: 'simulated', counts: counts() })
      return
    }

    if (path === '/api/v1/bin-snapshot') {
      // 完整快照直出：顶层多数组，无集合信封
      sendJson(res, 200, SNAPSHOT)
      return
    }

    sendJson(res, 404, { ok: false, error: 'not_found', path })
  })
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const port = parsePort(process.argv.slice(2))
  const server = createWstApiServer()
  server.listen(port, '127.0.0.1', () => {
    const actual = server.address()
    const bound = typeof actual === 'object' && actual !== null ? actual.port : port
    console.log(JSON.stringify({ event: 'listening', port: bound }))
  })
}
