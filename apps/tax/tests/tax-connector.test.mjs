/**
 * TAX 连接器：对真实 tax-api mock 取数 → RuntimeDataset 闭合
 * （对象 id 符合 idRule、关系两端在图内、候选 objectRef 命中、complete 透传）。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..', '..')
const { createTaxDataConnector } = await import(
  pathToFileURL(join(HERE, '..', 'dist', 'tax-connector.js')).href
)

let apiProc
let baseUrl
let connector

function waitListening(proc, ms = 8000) {
  return new Promise((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => reject(new Error(`tax-api not listening in ${ms}ms: ${buf}`)), ms)
    proc.stdout.on('data', (d) => {
      buf += String(d)
      if (buf.includes('"listening"')) {
        try {
          const line = buf.split('\n').find((l) => l.includes('"listening"'))
          const j = JSON.parse(line)
          clearTimeout(timer)
          resolve(j.port)
        } catch (e) {
          clearTimeout(timer)
          reject(e)
        }
      }
    })
    proc.stderr.on('data', (d) => {
      buf += String(d)
    })
    proc.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`tax-api exited ${code}: ${buf}`))
    })
  })
}

before(async () => {
  apiProc = spawn(process.execPath, [join(REPO, 'mock-services', 'tax-api', 'server.mjs'), '--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: join(REPO, 'mock-services', 'tax-api'),
  })
  const port = await waitListening(apiProc)
  baseUrl = `http://127.0.0.1:${port}`
  connector = createTaxDataConnector({ baseUrl, kind: 'simulated' })
})

after(() => {
  if (apiProc && apiProc.exitCode === null) apiProc.kill()
})

test('connector nature/version', () => {
  assert.equal(connector.nature, 'simulated')
  assert.equal(connector.version, 'tax-api-1.0.0')
})

test('fetch 全量：对象 id 符合 idRule、候选闭合、provenance=connector', async () => {
  const out = await connector.fetch({}, { tenant: 't', objectTypes: [] })
  assert.equal(out.complete, true)
  const ds = out.dataset
  assert.equal(ds.provenance, 'connector')
  const types = new Map(ds.objects.map((o) => [o.id, o.type]))
  // 纳税人 id = tin
  assert.equal(types.get('91110000T001'), 'OBJ-TAX-TAXPAYER')
  assert.equal(types.get('91110000T002'), 'OBJ-TAX-TAXPAYER')
  // 发票 id = code:no
  assert.equal(types.get('0110021001:00012345'), 'OBJ-TAX-INVOICE')
  // 候选 objectRef 必须命中图
  assert.ok(ds.candidates.length >= 2, `candidates=${ds.candidates.length}`)
  for (const c of ds.candidates) {
    assert.ok(types.has(c.objectRef), `candidate ${c.candidateId} objectRef ${c.objectRef} missing`)
    assert.equal(typeof c.riskScore, 'undefined')
    assert.ok(Object.keys(c.features).length > 0, 'features present from upstream signals')
  }
  // 关系两端闭合
  const ids = new Set(ds.objects.map((o) => o.id))
  for (const r of ds.relations) {
    assert.ok(ids.has(r.from), `rel ${r.id} from`)
    assert.ok(ids.has(r.to), `rel ${r.id} to`)
  }
  // 至少申报/开票关系
  assert.ok(
    ds.relations.some((r) => r.type === 'REL-TAX-ISSUES-INVOICE'),
    'issues invoice rel',
  )
  assert.ok(
    ds.relations.some((r) => r.type === 'REL-TAX-FILES-RETURN'),
    'files return rel',
  )
  // businessWindow 非空 to（fixture 有时间字段）
  assert.ok(out.businessWindow.to !== '', 'businessWindow.to from record times')
})

test('fetch objectTypes 过滤', async () => {
  const out = await connector.fetch(
    { objectTypes: ['OBJ-TAX-TAXPAYER'] },
    { tenant: 't', objectTypes: [] },
  )
  assert.ok(out.dataset.objects.every((o) => o.type === 'OBJ-TAX-TAXPAYER'))
  // 过滤后关系/候选随端点剔除——候选不在纳税人集则剔除
  const ids = new Set(out.dataset.objects.map((o) => o.id))
  for (const c of out.dataset.candidates) assert.ok(ids.has(c.objectRef))
})
