/**
 * wst-api 自测：health、快照结构（顶层多数组 + 嵌套 mixEvents + covers 数组外键）、
 * 只读（非 GET 拒绝）、未知路径。结构断言刻意区别于 tax-api 的集合信封。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createWstApiServer } from './server.mjs'

let server
let base

before(async () => {
  server = createWstApiServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  base = `http://127.0.0.1:${addr.port}`
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
})

test('health：ok + simulated + 四集合计数', async () => {
  const res = await fetch(`${base}/admin/health`)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.nature, 'simulated')
  assert.ok(body.counts.bins >= 3)
  assert.ok(body.counts.routes >= 1)
  assert.ok(body.counts.dumps >= 1)
  assert.ok(body.counts.alerts >= 1)
})

test('快照：顶层 bins/routes/dumps/alerts 数组齐全，无 TAX 式集合信封', async () => {
  const res = await fetch(`${base}/api/v1/bin-snapshot`)
  assert.equal(res.status, 200)
  const body = await res.json()
  for (const key of ['bins', 'routes', 'dumps', 'alerts']) {
    assert.ok(Array.isArray(body[key]), key)
    assert.ok(body[key].length > 0, key)
  }
  // 不复制 tax-api 的 { items, nextCursor, complete } 集合信封
  assert.equal(body.items, undefined)
  assert.equal(body.nextCursor, undefined)
  assert.equal(body.complete, undefined)
})

test('bins：嵌套 mixEvents 子记录存在，至少一桶 hazardous 混投且满溢', async () => {
  const body = await (await fetch(`${base}/api/v1/bin-snapshot`)).json()
  for (const bin of body.bins) {
    assert.ok(Array.isArray(bin.mixEvents), bin.binId)
    assert.equal(typeof bin.binId, 'string')
    assert.equal(typeof bin.binNo, 'string')
    assert.equal(typeof bin.zone, 'string')
    assert.equal(typeof bin.wasteType, 'string')
    assert.equal(typeof bin.fillLevel, 'number')
    assert.equal(typeof bin.lastEmptiedAt, 'string')
  }
  const hazardous = body.bins.filter(
    (b) => b.mixEvents.some((e) => e.kind === 'hazardous-mix') && b.fillLevel >= 0.8,
  )
  assert.ok(hazardous.length >= 1, '至少一桶有 hazardous mixEvents 且高 fillLevel')
  const clean = body.bins.filter((b) => b.mixEvents.length === 0 && b.fillLevel < 0.5)
  assert.ok(clean.length >= 1, '至少一桶干净（无混投、低满溢）')
})

test('routes：covers 数组外键指向本批 binId', async () => {
  const body = await (await fetch(`${base}/api/v1/bin-snapshot`)).json()
  const binIds = new Set(body.bins.map((b) => b.binId))
  for (const route of body.routes) {
    assert.equal(typeof route.routeId, 'string')
    assert.equal(typeof route.routeNo, 'string')
    assert.equal(typeof route.stopCount, 'number')
    assert.equal(typeof route.plannedMinutes, 'number')
    assert.ok(Array.isArray(route.covers), route.routeId)
    assert.ok(route.covers.length > 0, route.routeId)
    for (const binId of route.covers) assert.ok(binIds.has(binId), `${route.routeId} covers ${binId}`)
  }
})

test('alerts：features 三特征为 number、tags 为数组（上游候选信号）', async () => {
  const body = await (await fetch(`${base}/api/v1/bin-snapshot`)).json()
  const binIds = new Set(body.bins.map((b) => b.binId))
  for (const alert of body.alerts) {
    assert.equal(typeof alert.alertId, 'string')
    assert.ok(binIds.has(alert.binId), alert.alertId)
    assert.equal(typeof alert.features.fillRatio, 'number', alert.alertId)
    assert.equal(typeof alert.features.mixCount, 'number', alert.alertId)
    assert.equal(typeof alert.features.hazardFlag, 'number', alert.alertId)
    assert.ok(Array.isArray(alert.tags), alert.alertId)
  }
  // 高/低风险可分：至少一条高危（混投+危废标记）与一条干净信号
  assert.ok(body.alerts.some((a) => a.features.mixCount > 0 && a.features.hazardFlag === 1))
  assert.ok(body.alerts.some((a) => a.features.mixCount === 0 && a.features.hazardFlag === 0))
})

test('只读：POST/PUT/DELETE/PATCH → 405，零写入', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    for (const path of ['/api/v1/bin-snapshot', '/admin/health']) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      assert.equal(res.status, 405, `${method} ${path}`)
      const body = await res.json()
      assert.equal(body.error, 'method_not_allowed', `${method} ${path}`)
    }
  }
})

test('未知路径 → 404', async () => {
  const res = await fetch(`${base}/api/v1/nope`)
  assert.equal(res.status, 404)
})
