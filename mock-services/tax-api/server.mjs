/**
 * tax-api — TAX 第二插件的只读业务查询 mock（冷启动接数路径）。
 *
 * 只读 HTTP（JSON）；无数据库、无写端点；进程独立、仅绑回环。
 * 数据内嵌自 examples/tax-run.json 同构切片（simulated，不作业务验收）。
 *
 * API：
 *   GET /admin/health                 { ok, counts, nature }
 *   GET /api/v1/data/:collection      { items, nextCursor, complete, fetchedAt }
 *     collection ∈ taxpayers | invoices | bankFlows | taxReturns | benchmarks | riskCandidates
 *   其它方法 / 未知路径 → 405 / 404（零写入）
 *
 * 运行：node server.mjs [--port 3911]
 * 环境：TAX_API_PORT
 */
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

const DEFAULT_PORT = 3911
const COLLECTIONS = new Set([
  'taxpayers',
  'invoices',
  'bankFlows',
  'taxReturns',
  'benchmarks',
  'riskCandidates',
])

/** 同构 examples/tax-run.json 的对象切片 + 候选（burden 场景所需）。 */
function buildFixture() {
  const taxpayers = [
    {
      tin: '91110000T001',
      name: '华信贸易',
      taxpayerType: '企业',
      industryCode: '批发和零售业',
      regionCode: '110000',
      status: '非正常',
      creditLevel: 'D',
      registrationDate: '2026-09-01',
    },
    {
      tin: '91110000T002',
      name: '联达物资',
      taxpayerType: '企业',
      industryCode: '批发和零售业',
      regionCode: '110000',
      status: '存续',
      creditLevel: 'B',
      registrationDate: '2024-03-15',
    },
  ]
  const invoices = [
    {
      invoiceCode: '0110021001',
      invoiceNo: '00012345',
      invoiceType: '增值税专用发票',
      issueDate: '2026-09-15',
      sellerTin: '91110000T001',
      buyerTin: '91110000T002',
      amountExTax: 980000,
      taxAmount: 127400,
      totalAmount: 1107400,
      status: '正常',
    },
  ]
  const bankFlows = [
    {
      bankCode: 'ICBC',
      flowNo: 'F001',
      acctNo: '62220001',
      counterpartyAcctNo: '62220002',
      counterpartyName: '联达物资',
      direction: 'in',
      amount: 1107400,
      currency: 'CNY',
      occurredAt: '2026-09-16',
      summary: '货款',
      purpose: '贸易',
    },
    {
      bankCode: 'ICBC',
      flowNo: 'F002',
      acctNo: '62220001',
      counterpartyAcctNo: '62220099',
      counterpartyName: '个人账户',
      direction: 'out',
      amount: 900000,
      currency: 'CNY',
      occurredAt: '2026-09-17',
      summary: '备用金',
      purpose: '周转',
    },
  ]
  const taxReturns = [
    {
      returnType: '增值税申报',
      period: '2026-09',
      taxpayerTin: '91110000T001',
      salesAmount: 200000,
      outputTax: 26000,
      inputTax: 150000,
      taxPayable: 0,
      taxPaid: 0,
      status: '已申报',
      filingDate: '2026-10-10',
    },
  ]
  const benchmarks = [
    {
      industryCode: '批发和零售业',
      period: '2026',
      regionCode: '110000',
      taxType: '增值税',
      avgBurdenRate: 0.8,
      p25: 0.4,
      p50: 0.7,
      p75: 1.1,
      sampleSize: 120,
    },
  ]
  // 候选特征与 tax-run.json TAX-CAND-001/002 对齐（上游风险信号切片）
  const riskCandidates = [
    {
      candidateId: 'TAX-CAND-001',
      objectRef: '91110000T001',
      features: {
        statusAbnormalFlag: 1,
        shortLifeFlag: 0.8,
        identityClusterRatio: 0.9,
        relatedTradeRatio: 0.85,
        counterpartyConcentration: 0.9,
        sameControllerFlag: 1,
        fastInOutRatio: 0.92,
        personalAccountRatio: 0.7,
        flowScaleMismatch: 0.95,
        invoiceReturnGap: 0.88,
        inputOutputGap: 0.75,
        taxPaidGap: 0.9,
        burdenDeviation: 0.95,
        belowP25Flag: 1,
        lowBurdenMonthsScore: 0.85,
        inputSpikeRatio: 0.8,
        invoiceSalesGap: 0.92,
        bankInflowGap: 0.88,
      },
      tags: [],
    },
    {
      candidateId: 'TAX-CAND-002',
      objectRef: '91110000T002',
      features: {
        statusAbnormalFlag: 0,
        shortLifeFlag: 0,
        identityClusterRatio: 0.1,
        relatedTradeRatio: 0.1,
        counterpartyConcentration: 0.2,
        sameControllerFlag: 0,
        fastInOutRatio: 0.1,
        personalAccountRatio: 0,
        flowScaleMismatch: 0.1,
        invoiceReturnGap: 0.05,
        inputOutputGap: 0.1,
        taxPaidGap: 0.05,
        burdenDeviation: 0.2,
        belowP25Flag: 0,
        lowBurdenMonthsScore: 0.1,
        inputSpikeRatio: 0.1,
        invoiceSalesGap: 0.1,
        bankInflowGap: 0.1,
      },
      tags: ['whitelist'],
    },
  ]
  return { taxpayers, invoices, bankFlows, taxReturns, benchmarks, riskCandidates }
}

const FIXTURE = buildFixture()

function counts() {
  return Object.fromEntries(Object.entries(FIXTURE).map(([k, v]) => [k, v.length]))
}

function parsePort(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' && argv[i + 1] !== undefined) return Number(argv[++i])
  }
  return Number(process.env.TAX_API_PORT ?? DEFAULT_PORT)
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

function paginate(items, url) {
  const limitRaw = url.searchParams.get('limit')
  const cursorRaw = url.searchParams.get('cursor')
  const limit = limitRaw !== null && Number.isFinite(Number(limitRaw)) && Number(limitRaw) > 0
    ? Math.min(Number(limitRaw), 1000)
    : items.length
  const start = cursorRaw !== null && Number.isFinite(Number(cursorRaw)) && Number(cursorRaw) >= 0
    ? Number(cursorRaw)
    : 0
  const page = items.slice(start, start + limit)
  const next = start + limit
  const hasMore = next < items.length
  return {
    items: page,
    nextCursor: hasMore ? String(next) : null,
    complete: !hasMore,
    fetchedAt: new Date().toISOString(),
  }
}

export function createTaxApiServer() {
  return createServer((req, res) => {
    if (req.method !== 'GET') {
      // 只读：一切非 GET 显式拒绝
      sendJson(res, 405, { ok: false, error: 'method_not_allowed', note: 'tax-api is read-only' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname.replace(/\/+$/, '') || '/'

    if (path === '/admin/health') {
      sendJson(res, 200, { ok: true, nature: 'simulated', counts: counts() })
      return
    }

    const m = path.match(/^\/api\/v1\/data\/([A-Za-z][A-Za-z0-9_]*)$/)
    if (m !== null) {
      const name = m[1]
      if (!COLLECTIONS.has(name)) {
        sendJson(res, 404, { ok: false, error: 'unknown_collection', collection: name })
        return
      }
      sendJson(res, 200, paginate(FIXTURE[name], url))
      return
    }

    sendJson(res, 404, { ok: false, error: 'not_found', path })
  })
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const port = parsePort(process.argv.slice(2))
  const server = createTaxApiServer()
  server.listen(port, '127.0.0.1', () => {
    const actual = server.address()
    const bound = typeof actual === 'object' && actual !== null ? actual.port : port
    console.log(JSON.stringify({ event: 'listening', port: bound, nature: 'simulated', pid: process.pid }))
    console.log(`[tax-api] collections: ${[...COLLECTIONS].join(', ')}`)
  })
}
