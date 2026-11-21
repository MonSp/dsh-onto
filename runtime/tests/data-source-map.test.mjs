/**
 * 配置驱动连接器验收（api-to-plugin T3 / S2.3）：
 * collections/snapshot 两模式、cursor/offset/none 分页、按需集合取舍、
 * timeField 业务窗、complete=false 如实上报、非 200 抛错。
 * e2e：mock-services/wst-api（snapshot 形态）与 mock-services/tax-api（collections+cursor 形态）。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMappedDataConnector } from '../dist/index.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/* ───────────────────────── 假响应（collections 形态） ───────────────────────── */

/** pages: collection → 按序返回的响应体队列；记录每次请求的 url/headers。 */
function fakeFetch(pages) {
  const calls = []
  // 浅拷贝队列（shift 消费），同一 rows 夹具可复用多次
  const queues = Object.fromEntries(Object.entries(pages).map(([k, v]) => [k, [...v]]))
  const fetchImpl = async (url, init) => {
    const u = new URL(String(url))
    const collection = u.pathname.split('/').filter((s) => s !== '').pop()
    calls.push({ url: String(url), collection, init })
    const queue = queues[collection]
    const body = Array.isArray(queue) && queue.length > 0 ? queue.shift() : { items: [] }
    return new Response(JSON.stringify(body), { status: 200 })
  }
  return { fetchImpl, calls }
}

const collectionsShape = (pagination = { mode: 'cursor' }) => ({
  mode: 'collections',
  collectionPath: '/api/v1/data/{collection}',
  itemsPath: 'items',
  pagination,
})

const binMap = {
  id: 'SM-WST-BIN',
  collection: 'bins',
  objectType: 'OBJ-WST-BIN',
  idTemplate: '<binId>',
  timeField: 'lastEmptiedAt',
}

/** wst 形态映射（packages/wst/1.0.0 口径 id）：对象 + 数组 FK 关系 + behavior-list + 候选。 */
function wstMaps() {
  return [
    binMap,
    { id: 'SM-WST-ROUTE', collection: 'routes', objectType: 'OBJ-WST-ROUTE', idTemplate: '<routeId>' },
    {
      id: 'SM-WST-COVERS',
      kind: 'relation',
      collection: 'routes',
      relationType: 'REL-WST-COVERS',
      from: 'self',
      to: { field: 'covers' },
      targetCollection: 'bins',
    },
    {
      id: 'SM-WST-ALERT',
      kind: 'candidate',
      collection: 'alerts',
      idField: 'alertId',
      objectRefField: 'binId',
      objectType: 'OBJ-WST-BIN',
      features: { fillRatio: 'features.fillRatio', mixCount: 'features.mixCount', hazardFlag: 'features.hazardFlag' },
      tagsField: 'tags',
    },
    {
      id: 'SM-WST-MIX',
      kind: 'behavior-list',
      collection: 'bins',
      behaviorType: 'BHV-WST-MIX',
      objectRefTemplate: '<binId>',
      eventsPath: 'mixEvents',
      timeField: 'at',
    },
    {
      id: 'SM-WST-DUMP',
      kind: 'behavior',
      collection: 'dumps',
      behaviorType: 'BHV-WST-DUMP',
      objectRefTemplate: '<binId>',
      timeField: 'at',
    },
  ]
}

const bin = (id, lastEmptiedAt, extra = {}) => ({ binId: id, lastEmptiedAt, ...extra })
const scopeAll = { tenant: 'test', objectTypes: [] }

/* ───────────────────────────── collections：分页 ───────────────────────────── */

test('collections/cursor：分页拼页（tax-api 形态信封），cursorParam 缺省 cursor', async () => {
  const { fetchImpl, calls } = fakeFetch({
    bins: [
      { items: [bin('BIN-01', '2026-11-11T10:00:00+08:00')], nextCursor: 'c2' },
      { items: [bin('BIN-02', '2026-11-12T14:00:00+08:00')] },
    ],
  })
  const connector = createMappedDataConnector({
    baseUrl: 'http://api.test',
    shape: collectionsShape(),
    maps: [binMap],
    fetchImpl,
  })
  const out = await connector.fetch({}, scopeAll)
  assert.equal(out.dataset.objects.length, 2)
  assert.deepEqual(out.dataset.objects.map((o) => o.id).sort(), ['BIN-01', 'BIN-02'])
  assert.equal(out.complete, true)
  assert.equal(out.paged, true)
  assert.equal(out.truncatedReason, undefined)
  assert.equal(calls.length, 2)
  assert.ok(!calls[0].url.includes('cursor'), calls[0].url)
  assert.ok(calls[1].url.includes('cursor=c2'), calls[1].url)
})

test('collections/cursor：cursorParam/nextField 可配（nextField 支持点路径）', async () => {
  const { fetchImpl, calls } = fakeFetch({
    bins: [
      { items: [bin('BIN-01', '2026-11-11T10:00:00+08:00')], meta: { next: 't2' } },
      { items: [bin('BIN-02', '2026-11-12T14:00:00+08:00')], meta: {} },
    ],
  })
  const connector = createMappedDataConnector({
    baseUrl: 'http://api.test',
    shape: collectionsShape({ mode: 'cursor', cursorParam: 'pageToken', nextField: 'meta.next' }),
    maps: [binMap],
    fetchImpl,
  })
  const out = await connector.fetch({}, scopeAll)
  assert.equal(out.dataset.objects.length, 2)
  assert.ok(calls[1].url.includes('pageToken=t2'), calls[1].url)
})

test('collections/offset：limit/offset/pageSize 可配，不足一页即结束', async () => {
  const { fetchImpl, calls } = fakeFetch({
    bins: [
      { items: [bin('BIN-01', '2026-11-11T10:00:00+08:00'), bin('BIN-02', '2026-11-12T14:00:00+08:00')] },
      { items: [bin('BIN-03', '2026-11-12T10:00:00+08:00')] },
    ],
  })
  const connector = createMappedDataConnector({
    baseUrl: 'http://api.test',
    shape: collectionsShape({ mode: 'offset', limitParam: 'limit', offsetParam: 'offset', pageSize: 2 }),
    maps: [binMap],
    fetchImpl,
  })
  const out = await connector.fetch({}, scopeAll)
  assert.equal(out.dataset.objects.length, 3)
  assert.equal(out.complete, true)
  assert.equal(calls.length, 2)
  assert.ok(calls[0].url.includes('limit=2') && calls[0].url.includes('offset=0'), calls[0].url)
  assert.ok(calls[1].url.includes('limit=2') && calls[1].url.includes('offset=2'), calls[1].url)
})

test('collections/none：一次取完，paged=false', async () => {
  const { fetchImpl, calls } = fakeFetch({
    bins: [{ items: [bin('BIN-01', '2026-11-11T10:00:00+08:00'), bin('BIN-02', '2026-11-12T14:00:00+08:00')] }],
  })
  const connector = createMappedDataConnector({
    baseUrl: 'http://api.test',
    shape: collectionsShape({ mode: 'none' }),
    maps: [binMap],
    fetchImpl,
  })
  const out = await connector.fetch({}, scopeAll)
  assert.equal(out.dataset.objects.length, 2)
  assert.equal(out.paged, false)
  assert.equal(calls.length, 1)
})

/* ─────────────────────────── complete=false 如实上报 ─────────────────────────── */

test('complete=false：上游 completeField 显式 false → 如实上报 + truncatedReason', async () => {
  const { fetchImpl } = fakeFetch({
    bins: [{ items: [bin('BIN-01', '2026-11-11T10:00:00+08:00')], complete: false }],
  })
  const connector = createMappedDataConnector({
    baseUrl: 'http://api.test',
    shape: collectionsShape(),
    maps: [binMap],
    fetchImpl,
  })
  const out = await connector.fetch({}, scopeAll)
  assert.equal(out.complete, false)
  assert.ok(out.truncatedReason.includes('completeField'), out.truncatedReason)
})

test('complete=false：maxPages 触顶截断 → complete=false + truncatedReason', async () => {
  const { fetchImpl, calls } = fakeFetch({
    bins: [
      { items: [bin('BIN-01', '2026-11-11T10:00:00+08:00')], nextCursor: 'c2' },
      { items: [bin('BIN-02', '2026-11-12T14:00:00+08:00')], nextCursor: 'c3' },
    ],
  })
  const connector = createMappedDataConnector({
    baseUrl: 'http://api.test',
    shape: collectionsShape(),
    maps: [binMap],
    fetchImpl,
    maxPages: 2,
  })
  const out = await connector.fetch({}, scopeAll)
  assert.equal(out.complete, false)
  assert.ok(out.truncatedReason.includes('maxPages=2'), out.truncatedReason)
  assert.equal(calls.length, 2) // 触顶即停，不发第三页
})

/* ─────────────────── timeWindow / businessWindow / 不冒充时效 ─────────────────── */

test('timeWindow 传递给纯转换：窗外对象剔除，businessWindow 按 timeField', async () => {
  const { fetchImpl } = fakeFetch({
    bins: [
      { items: [bin('BIN-01', '2026-11-11T10:00:00+08:00'), bin('BIN-02', '2026-11-12T14:00:00+08:00')] },
    ],
  })
  const connector = createMappedDataConnector({
    baseUrl: 'http://api.test',
    shape: collectionsShape({ mode: 'none' }),
    maps: [binMap],
    fetchImpl,
  })
  const out = await connector.fetch(
    { timeWindow: { from: '2026-11-12T00:00:00Z', to: '2026-11-13T00:00:00Z' } },
    scopeAll,
  )
  // BIN-01 lastEmptiedAt=11-11 窗外剔除；BIN-02=11-12 保留
  assert.deepEqual(out.dataset.objects.map((o) => o.id), ['BIN-02'])
  assert.equal(out.businessWindow.from, '2026-11-12T06:00:00.000Z')
  assert.equal(out.businessWindow.to, '2026-11-12T06:00:00.000Z')
})

test('无 timeField 不冒充时效：businessWindow.to 留空（fresh 门语义）', async () => {
  const { fetchImpl } = fakeFetch({ bins: [{ items: [{ binId: 'BIN-01' }] }] })
  const connector = createMappedDataConnector({
    baseUrl: 'http://api.test',
    shape: collectionsShape({ mode: 'none' }),
    maps: [{ id: 'SM-WST-BIN', collection: 'bins', objectType: 'OBJ-WST-BIN', idTemplate: '<binId>' }],
    fetchImpl,
  })
  const out = await connector.fetch({}, scopeAll)
  assert.equal(out.dataset.objects.length, 1)
  assert.equal(out.businessWindow.to, '')
  assert.equal(out.businessWindow.from, '1970-01-01T00:00:00.000Z')
})

/* ──────────────────────────── 按需集合（wanted）取舍 ──────────────────────────── */

test('只拉 wanted 集合：query.objectTypes 经 maps 映射；候选跟随其 objectType，行为/关系跟随 collection', async () => {
  const rows = {
    bins: [{ items: [bin('BIN-01', '2026-11-11T10:00:00+08:00', { mixEvents: [] })] }],
    routes: [{ items: [{ routeId: 'ROUTE-1', covers: ['BIN-01'] }] }],
    alerts: [{ items: [{ alertId: 'ALERT-1', binId: 'BIN-01', features: { fillRatio: 0.9 }, tags: [] }] }],
    dumps: [{ items: [{ binId: 'BIN-01', at: '2026-11-11T10:00:00+08:00' }] }],
  }
  const { fetchImpl, calls } = fakeFetch(rows)
  const connector = createMappedDataConnector({
    baseUrl: 'http://api.test',
    shape: collectionsShape({ mode: 'none' }),
    maps: wstMaps(),
    fetchImpl,
  })
  // OBJ-WST-BIN wanted → 只拉 bins（对象映射）与 alerts（候选 objectType=OBJ-WST-BIN）；
  // routes（OBJ-WST-ROUTE 不在 wanted）与 dumps（行为映射跟随 collection）不拉
  const out = await connector.fetch({ objectTypes: ['OBJ-WST-BIN'] }, scopeAll)
  assert.deepEqual(calls.map((c) => c.collection).sort(), ['alerts', 'bins'])
  assert.deepEqual(out.dataset.objects.map((o) => o.id), ['BIN-01'])
  assert.equal(out.dataset.relations.length, 0) // routes 未取 → 无关系（对端待补而非断引用）
  assert.equal(out.dataset.candidates.length, 1)
  assert.equal((out.dataset.behaviors ?? []).length, 0) // dumps 未取

  // wanted 为空 = 全取（缺省 scope.objectTypes）
  const all = fakeFetch(rows)
  const connectorAll = createMappedDataConnector({
    baseUrl: 'http://api.test',
    shape: collectionsShape({ mode: 'none' }),
    maps: wstMaps(),
    fetchImpl: all.fetchImpl,
  })
  const outAll = await connectorAll.fetch({}, scopeAll)
  assert.deepEqual(all.calls.map((c) => c.collection).sort(), ['alerts', 'bins', 'dumps', 'routes'])
  assert.equal(outAll.dataset.objects.length, 2)
  assert.equal(outAll.dataset.relations.length, 1)
})

test('wanted 缺省回退 scope.objectTypes（对齐 tax-connector 按需取候选）', async () => {
  const rows = {
    bins: [{ items: [] }],
    routes: [{ items: [{ routeId: 'ROUTE-1', covers: [] }] }],
  }
  const { fetchImpl, calls } = fakeFetch(rows)
  const connector = createMappedDataConnector({
    baseUrl: 'http://api.test',
    shape: collectionsShape({ mode: 'none' }),
    maps: wstMaps(),
    fetchImpl,
  })
  await connector.fetch({}, { tenant: 'test', objectTypes: ['OBJ-WST-ROUTE'] })
  assert.deepEqual(calls.map((c) => c.collection), ['routes'])
})

/* ─────────────────────────────── 鉴权与失败路径 ─────────────────────────────── */

test('鉴权 v1：auth.token → 静态 Bearer；缺省无 authorization 头', async () => {
  const rows = { bins: [{ items: [] }] }
  const a = fakeFetch(rows)
  await createMappedDataConnector({
    baseUrl: 'http://api.test',
    shape: collectionsShape({ mode: 'none' }),
    maps: [binMap],
    auth: { token: 'tok-abc' },
    fetchImpl: a.fetchImpl,
  }).fetch({}, scopeAll)
  assert.equal(a.calls[0].init.headers.authorization, 'Bearer tok-abc')

  const b = fakeFetch(rows)
  await createMappedDataConnector({
    baseUrl: 'http://api.test',
    shape: collectionsShape({ mode: 'none' }),
    maps: [binMap],
    fetchImpl: b.fetchImpl,
  }).fetch({}, scopeAll)
  assert.equal(b.calls[0].init.headers, undefined)
})

test('失败路径：非 200 抛错（消息带集合名与状态码）；网络失败同风格', async () => {
  const connector503 = createMappedDataConnector({
    baseUrl: 'http://api.test',
    shape: collectionsShape({ mode: 'none' }),
    maps: [binMap],
    fetchImpl: async () => new Response('{}', { status: 503 }),
  })
  await assert.rejects(() => connector503.fetch({}, scopeAll), (e) => {
    assert.match(e.message, /外部取数拒绝（bins 503）/)
    return true
  })

  const connectorDown = createMappedDataConnector({
    baseUrl: 'http://api.test',
    shape: collectionsShape({ mode: 'none' }),
    maps: [binMap],
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED')
    },
  })
  await assert.rejects(() => connectorDown.fetch({}, scopeAll), (e) => {
    assert.match(e.message, /外部取数失败（bins）：ECONNREFUSED/)
    return true
  })
})

test('version/nature：mapped-data-1.0.0；kind=formal 才是 business-source', () => {
  const mk = (kind) =>
    createMappedDataConnector({
      baseUrl: 'http://api.test',
      shape: collectionsShape({ mode: 'none' }),
      maps: [binMap],
      kind,
    })
  assert.equal(mk('formal').version, 'mapped-data-1.0.0')
  assert.equal(mk('formal').nature, 'business-source')
  assert.equal(mk('simulated').nature, 'simulated')
  assert.equal(mk(undefined).nature, 'simulated')
  assert.equal(mk('dryrun').nature, 'simulated')
})

test('配置门：snapshot 只支持 pagination=none；collections 须含 {collection} 模板', () => {
  assert.throws(
    () =>
      createMappedDataConnector({
        baseUrl: 'http://api.test',
        shape: { mode: 'snapshot', path: '/x', collectionPaths: { bins: 'bins' }, pagination: { mode: 'cursor' } },
        maps: [binMap],
      }),
    /只支持 none/,
  )
  assert.throws(
    () =>
      createMappedDataConnector({
        baseUrl: 'http://api.test',
        shape: { mode: 'collections', collectionPath: '/api/v1/data/all', pagination: { mode: 'none' } },
        maps: [binMap],
      }),
    /\{collection\}/,
  )
})

/* ───────────────────────── e2e：mock-services/wst-api（snapshot） ───────────────────────── */

const spawned = []
after(async () => {
  for (const child of spawned) {
    if (child.exitCode === null) child.kill()
  }
})

/** 起只读 mock（spawn 进程）；等 stdout 的 listening 事件。测试后 kill。 */
function startMock(serverRelPath, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, serverRelPath), '--port', String(port)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    spawned.push(child)
    let buf = ''
    const timer = setTimeout(() => reject(new Error(`mock 启动超时: ${serverRelPath}（${buf}）`)), 10_000)
    child.stdout.on('data', (d) => {
      buf += String(d)
      if (buf.includes('"event":"listening"')) {
        clearTimeout(timer)
        resolve(child)
      }
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`mock 提前退出（${code}）: ${serverRelPath}（${buf}）`))
    })
    child.stderr.on('data', (d) => {
      buf += String(d)
    })
  })
}

test('e2e/wst-api：snapshot 模式一次取数，对象/关系/候选/行为计数与关键 id', async () => {
  await startMock('mock-services/wst-api/server.mjs', 3912)
  const connector = createMappedDataConnector({
    baseUrl: 'http://127.0.0.1:3912',
    shape: {
      mode: 'snapshot',
      path: '/api/v1/bin-snapshot',
      collectionPaths: { bins: 'bins', routes: 'routes', dumps: 'dumps', alerts: 'alerts' },
      pagination: { mode: 'none' },
    },
    maps: wstMaps(),
    kind: 'simulated',
    fetchImpl: fetch,
  })
  const out = await connector.fetch({}, scopeAll)

  assert.equal(out.complete, true)
  assert.equal(out.paged, false)
  // 对象：3 bin + 2 route
  assert.equal(out.dataset.objects.length, 5)
  assert.deepEqual(
    out.dataset.objects.map((o) => o.id).sort(),
    ['BIN-01', 'BIN-02', 'BIN-03', 'ROUTE-1', 'ROUTE-2'],
  )
  // 关系：covers 数组 FK 逐条展开（全部闭合）
  const rels = out.dataset.relations.filter((r) => r.type === 'REL-WST-COVERS')
  assert.equal(rels.length, 3)
  const pairs = rels.map((r) => `${r.from}→${r.to}`).sort()
  assert.deepEqual(pairs, ['ROUTE-1→BIN-01', 'ROUTE-1→BIN-02', 'ROUTE-2→BIN-03'])
  // 候选：4 条 alerts 全部命中本批桶
  assert.equal(out.dataset.candidates.length, 4)
  const cand3 = out.dataset.candidates.find((c) => c.candidateId === 'ALERT-BIN-03')
  assert.equal(cand3.objectRef, 'BIN-03')
  assert.equal(cand3.features.mixCount, 2)
  assert.equal(cand3.features.hazardFlag, 1)
  // 行为：BIN-03 mixEvents 嵌套 2 条 + dumps 3 条
  const behs = out.dataset.behaviors ?? []
  assert.equal(behs.length, 5)
  assert.equal(behs.filter((b) => b.type === 'BHV-WST-MIX').length, 2)
  assert.equal(behs.filter((b) => b.type === 'BHV-WST-DUMP').length, 3)
  assert.ok(behs.every((b) => b.objectRef.startsWith('BIN-')))
  // businessWindow 按 timeField=lastEmptiedAt（min=BIN-01 11-11T10:00+08，max=BIN-02 11-12T14:00+08）
  assert.equal(out.businessWindow.from, '2026-11-11T02:00:00.000Z')
  assert.equal(out.businessWindow.to, '2026-11-12T06:00:00.000Z')
  assert.equal(connector.nature, 'simulated')
})

test('e2e/wst-api：snapshot 模式同样按 wanted 取舍（OBJ-WST-ROUTE → 仅 routes）', async () => {
  const connector = createMappedDataConnector({
    baseUrl: 'http://127.0.0.1:3912',
    shape: {
      mode: 'snapshot',
      path: '/api/v1/bin-snapshot',
      collectionPaths: { bins: 'bins', routes: 'routes', dumps: 'dumps', alerts: 'alerts' },
      pagination: { mode: 'none' },
    },
    maps: wstMaps(),
    fetchImpl: fetch,
  })
  const out = await connector.fetch({ objectTypes: ['OBJ-WST-ROUTE'] }, scopeAll)
  assert.deepEqual(out.dataset.objects.map((o) => o.id).sort(), ['ROUTE-1', 'ROUTE-2'])
  assert.equal(out.dataset.relations.length, 0) // bins 未取 → covers 待补，不产关系
  assert.equal(out.dataset.candidates.length, 0)
})

/* ─────────────────── e2e：mock-services/tax-api（collections+cursor） ─────────────────── */

/** tax 形态映射（timeField 对 tax-api 行字段 occurredAt/filingDate/…）。 */
function taxMaps() {
  return [
    { id: 'SM-TAX-TAXPAYER', collection: 'taxpayers', objectType: 'OBJ-TAX-TAXPAYER', idTemplate: '<tin>', timeField: 'registrationDate' },
    { id: 'SM-TAX-INVOICE', collection: 'invoices', objectType: 'OBJ-TAX-INVOICE', idTemplate: '<invoiceCode>:<invoiceNo>', timeField: 'issueDate' },
    { id: 'SM-TAX-FLOW', collection: 'bankFlows', objectType: 'OBJ-TAX-BANK-FLOW', idTemplate: '<bankCode>:<flowNo>', timeField: 'occurredAt' },
    { id: 'SM-TAX-RETURN', collection: 'taxReturns', objectType: 'OBJ-TAX-TAX-RETURN', idTemplate: '<taxpayerTin>:<returnType>:<period>', timeField: 'filingDate' },
    {
      id: 'SM-TAX-ISSUES',
      kind: 'relation',
      collection: 'invoices',
      relationType: 'REL-TAX-ISSUES-INVOICE',
      from: { field: 'sellerTin' },
      to: 'self',
      targetCollection: 'taxpayers',
    },
    {
      id: 'SM-TAX-RECEIVES',
      kind: 'relation',
      collection: 'invoices',
      relationType: 'REL-TAX-RECEIVES-INVOICE',
      from: { field: 'buyerTin' },
      to: 'self',
      targetCollection: 'taxpayers',
    },
    {
      id: 'SM-TAX-FILES',
      kind: 'relation',
      collection: 'taxReturns',
      relationType: 'REL-TAX-FILES-RETURN',
      from: { field: 'taxpayerTin' },
      to: 'self',
      targetCollection: 'taxpayers',
    },
    {
      id: 'SM-TAX-CAND',
      kind: 'candidate',
      collection: 'riskCandidates',
      idField: 'candidateId',
      objectRefField: 'objectRef',
      objectType: 'OBJ-TAX-TAXPAYER',
      features: { burden: 'features.burdenDeviation' },
      tagsField: 'tags',
    },
  ]
}

test('e2e/tax-api：collections+cursor 形态取数，对象/关系/候选与业务窗', async () => {
  await startMock('mock-services/tax-api/server.mjs', 3911)
  const connector = createMappedDataConnector({
    baseUrl: 'http://127.0.0.1:3911',
    shape: {
      mode: 'collections',
      collectionPath: '/api/v1/data/{collection}',
      itemsPath: 'items',
      pagination: { mode: 'cursor', cursorParam: 'cursor', nextField: 'nextCursor', completeField: 'complete' },
    },
    maps: taxMaps(),
    fetchImpl: fetch,
  })
  const out = await connector.fetch({}, scopeAll)
  assert.equal(out.complete, true)
  assert.equal(out.paged, true)
  // 对象：2 纳税人 + 1 发票 + 2 流水 + 1 申报
  assert.equal(out.dataset.objects.length, 6)
  assert.ok(out.dataset.objects.some((o) => o.id === '0110021001:00012345'))
  assert.ok(out.dataset.objects.some((o) => o.id === 'ICBC:F002'))
  assert.ok(out.dataset.objects.some((o) => o.id === '91110000T001:增值税申报:2026-09'))
  // 关系：开票/受票/申报 3 条（FK 全闭合）
  assert.equal(out.dataset.relations.length, 3)
  assert.ok(out.dataset.relations.some((r) => r.type === 'REL-TAX-ISSUES-INVOICE' && r.from === '91110000T001'))
  assert.ok(out.dataset.relations.some((r) => r.type === 'REL-TAX-FILES-RETURN' && r.to === '91110000T001:增值税申报:2026-09'))
  // 候选：2 条命中纳税人
  assert.equal(out.dataset.candidates.length, 2)
  const c1 = out.dataset.candidates.find((c) => c.candidateId === 'TAX-CAND-001')
  assert.equal(c1.features.burden, 0.95)
  const c2 = out.dataset.candidates.find((c) => c.candidateId === 'TAX-CAND-002')
  assert.deepEqual(c2.tags, ['whitelist'])
  // businessWindow：min=registrationDate 2024-03-15，max=filingDate 2026-10-10
  assert.equal(out.businessWindow.from, '2024-03-15T00:00:00.000Z')
  assert.equal(out.businessWindow.to, '2026-10-10T00:00:00.000Z')
})

test('e2e/tax-api：只拉 wanted（OBJ-TAX-TAXPAYER → taxpayers+按需取候选）', async () => {
  const connector = createMappedDataConnector({
    baseUrl: 'http://127.0.0.1:3911',
    shape: {
      mode: 'collections',
      collectionPath: '/api/v1/data/{collection}',
      itemsPath: 'items',
      pagination: { mode: 'cursor', cursorParam: 'cursor', nextField: 'nextCursor', completeField: 'complete' },
    },
    maps: taxMaps(),
    fetchImpl: fetch,
  })
  const out = await connector.fetch({ objectTypes: ['OBJ-TAX-TAXPAYER'] }, scopeAll)
  assert.deepEqual(out.dataset.objects.map((o) => o.type), ['OBJ-TAX-TAXPAYER', 'OBJ-TAX-TAXPAYER'])
  assert.equal(out.dataset.relations.length, 0)
  assert.equal(out.dataset.candidates.length, 2) // 对齐 tax-connector：含纳税人批才取候选
})
