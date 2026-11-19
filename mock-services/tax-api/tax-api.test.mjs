/**
 * tax-api 自测：health、五类+候选 collection、分页 complete 语义、只读（非 GET 拒绝）。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTaxApiServer } from './server.mjs'

let server
let base

before(async () => {
  server = createTaxApiServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  base = `http://127.0.0.1:${addr.port}`
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
})

test('health：ok + simulated + 各 collection 计数', async () => {
  const res = await fetch(`${base}/admin/health`)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.nature, 'simulated')
  assert.ok(body.counts.taxpayers >= 2)
  assert.ok(body.counts.invoices >= 1)
  assert.ok(body.counts.bankFlows >= 2)
  assert.ok(body.counts.taxReturns >= 1)
  assert.ok(body.counts.benchmarks >= 1)
  assert.ok(body.counts.riskCandidates >= 2)
})

test('五类业务 collection + riskCandidates：200 且 items 数组', async () => {
  for (const name of [
    'taxpayers',
    'invoices',
    'bankFlows',
    'taxReturns',
    'benchmarks',
    'riskCandidates',
  ]) {
    const res = await fetch(`${base}/api/v1/data/${name}`)
    assert.equal(res.status, 200, name)
    const body = await res.json()
    assert.ok(Array.isArray(body.items), name)
    assert.ok(body.items.length > 0, name)
    assert.equal(body.complete, true, name)
    assert.equal(body.nextCursor, null, name)
    assert.ok(typeof body.fetchedAt === 'string', name)
  }
})

test('分页：limit=1 时 first 页 complete=false + nextCursor；末页 complete=true', async () => {
  const first = await (await fetch(`${base}/api/v1/data/taxpayers?limit=1`)).json()
  assert.equal(first.items.length, 1)
  assert.equal(first.complete, false)
  assert.equal(first.nextCursor, '1')
  const second = await (await fetch(`${base}/api/v1/data/taxpayers?limit=1&cursor=1`)).json()
  assert.ok(second.items.length >= 1)
  assert.equal(second.complete, true)
  assert.equal(second.nextCursor, null)
})

test('未知 collection → 404', async () => {
  const res = await fetch(`${base}/api/v1/data/nope`)
  assert.equal(res.status, 404)
})

test('只读：POST/PUT/DELETE → 405，零写入', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const res = await fetch(`${base}/api/v1/data/taxpayers`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(res.status, 405, method)
    const body = await res.json()
    assert.equal(body.error, 'method_not_allowed', method)
  }
})

test('未知路径 → 404', async () => {
  const res = await fetch(`${base}/admin/secret`)
  assert.equal(res.status, 404)
})
