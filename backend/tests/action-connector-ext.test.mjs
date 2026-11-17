/**
 * M3/F2 适配器单测 —— 外部业务 API 连接器错误映射、query-miss 审计收窄、
 * 取数分页与 complete 完整性（fetch 注入，不起真服务）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createExtApiConnector } from '../dist/action-connector-ext.js'
import { createExtDataConnector } from '../dist/data-source-ext.js'
import { ActionExecuteError, ActionNoEffectError } from '../dist/action-executor.js'

function stubFetch(handler) {
  return async (url, init) => handler(String(url), init)
}

function jsonRes(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const INTENT = {
  behaviorId: 'BHV-OPEN-TICKET',
  objectRef: 'OBJ-AML-ACCOUNT:ACC-1',
  payload: { title: '工单', severity: 'high', candidateId: 'CAND-001', runId: 'run-x' },
}

test('F2-1 execute 成功/重放映射 externalRef；鉴权/受理前拒/业务冲突 → 无效应类错误', async () => {
  const ok = createExtApiConnector({
    baseUrl: 'http://x',
    token: 't',
    fetchImpl: stubFetch(async () => jsonRes(201, { ticketNo: 'EXT-TKT-000001', replayed: false })),
  })
  const out = await ok.execute(INTENT, 'act-1', 'key-1')
  assert.equal(out.externalRef, 'EXT-TKT-000001')

  const denied = createExtApiConnector({
    baseUrl: 'http://x',
    token: 't',
    fetchImpl: stubFetch(async () => jsonRes(403, { error: { code: 'TENANT_MISMATCH' } })),
  })
  await assert.rejects(() => denied.execute(INTENT, 'act-1', 'key-2'), (e) => e.name === 'ActionNoEffectError')

  const rejected = createExtApiConnector({
    baseUrl: 'http://x',
    token: 't',
    fetchImpl: stubFetch(async () => jsonRes(422, { error: { code: 'REJECTED' } })),
  })
  await assert.rejects(() => rejected.execute(INTENT, 'act-1', 'key-3'), (e) => e.name === 'ActionNoEffectError')

  const conflict = createExtApiConnector({
    baseUrl: 'http://x',
    token: 't',
    fetchImpl: stubFetch(async () => jsonRes(409, { error: { code: 'OPERATION_CONFLICT' }, ticketNo: 'EXT-TKT-9' })),
  })
  await assert.rejects(
    () => conflict.execute(INTENT, 'act-1', 'key-4'),
    (e) => e.name === 'ActionNoEffectError' && /OPERATION_CONFLICT|冲突/.test(e.message),
  )
})

test('F2-2 受理后失败带单号 → 部分效应错误（可补偿）；网络失败 → 效应不明类', async () => {
  const partial = createExtApiConnector({
    baseUrl: 'http://x',
    token: 't',
    fetchImpl: stubFetch(async () => jsonRes(502, { error: { code: 'ACCEPTED_BUT_FAILED' }, ticketNo: 'EXT-TKT-7' })),
  })
  await assert.rejects(
    () => partial.execute(INTENT, 'act-1', 'key-5'),
    (e) => e instanceof ActionExecuteError && e.externalRef === 'EXT-TKT-7',
  )
  const down = createExtApiConnector({
    baseUrl: 'http://x',
    token: 't',
    fetchImpl: stubFetch(async () => {
      throw new Error('ECONNREFUSED')
    }),
  })
  await assert.rejects(
    () => down.execute(INTENT, 'act-1', 'key-6'),
    (e) => e.name === 'Error' && /效应不明/.test(e.message),
  )
})

test('F2-3 queryResult：命中带回执；未见键用审计收窄（零记录=not-executed）', async () => {
  const hit = createExtApiConnector({
    baseUrl: 'http://x',
    token: 't',
    fetchImpl: stubFetch(async (url) => {
      if (url.includes('audit')) return jsonRes(200, { items: [] })
      return jsonRes(200, { state: 'succeeded', externalRef: 'EXT-TKT-1' })
    }),
  })
  const r1 = await hit.queryResult(INTENT, 'key-1')
  assert.deepEqual(r1, { state: 'succeeded', externalRef: 'EXT-TKT-1' })

  const miss = createExtApiConnector({
    baseUrl: 'http://x',
    token: 't',
    fetchImpl: stubFetch(async (url) => {
      if (url.includes('audit')) return jsonRes(200, { items: [] })
      return jsonRes(200, { state: 'unknown' })
    }),
  })
  const r2 = await miss.queryResult(INTENT, 'key-gone')
  assert.equal(r2.state, 'not-executed', '审计零记录 = 确认从未受理')

  const seen = createExtApiConnector({
    baseUrl: 'http://x',
    token: 't',
    fetchImpl: stubFetch(async (url) => {
      if (url.includes('audit')) return jsonRes(200, { items: [{ idempotencyKey: 'key-mid', result: 'accepted' }] })
      return jsonRes(200, { state: 'unknown' })
    }),
  })
  const r3 = await seen.queryResult(INTENT, 'key-mid')
  assert.equal(r3.state, 'unknown', '审计有记录但无回执 → 保持效应不明')
})

test('F2-4 取数映射与完整性：对象/关系映射、分页循环、complete=false 如实上报', async () => {
  const pages = {
    customers: { items: [{ custNo: 'C1', custType: 'personal' }], nextCursor: null, complete: true, fetchedAt: 'T0' },
    accounts: {
      page1: { items: [{ acctNo: 'A1', custNo: 'C1', balance: 1 }], nextCursor: 'c2', complete: true, fetchedAt: 'T0' },
      page2: { items: [{ acctNo: 'A2', custNo: 'C1', balance: 2 }], nextCursor: null, complete: true, fetchedAt: 'T0' },
    },
  }
  const conn = createExtDataConnector({
    baseUrl: 'http://x',
    token: 't',
    fetchImpl: stubFetch(async (url) => {
      if (url.includes('customers')) return jsonRes(200, pages.customers)
      if (url.includes('cursor=c2')) return jsonRes(200, pages.accounts.page2)
      return jsonRes(200, pages.accounts.page1)
    }),
  })
  const out = await conn.fetch({ objectTypes: ['OBJ-AML-CUSTOMER', 'OBJ-AML-ACCOUNT'] }, {
    tenant: 'tenant-A',
    objectTypes: ['OBJ-AML-CUSTOMER', 'OBJ-AML-ACCOUNT'],
  })
  assert.equal(out.complete, true)
  assert.equal(out.dataset.provenance, 'connector')
  assert.equal(out.dataset.objects.length, 3)
  assert.ok(out.dataset.objects.some((o) => o.id === 'A2' && o.type === 'OBJ-AML-ACCOUNT'))
  assert.ok(out.dataset.relations.some((r) => r.type === 'REL-AML-HOLDS' && r.from === 'C1' && r.to === 'A1'))

  const truncated = createExtDataConnector({
    baseUrl: 'http://x',
    token: 't',
    fetchImpl: stubFetch(async () => jsonRes(200, { items: [], nextCursor: 'more', complete: true, fetchedAt: 'T0' })),
    maxPages: 2,
  })
  const out2 = await truncated.fetch({}, { tenant: 't', objectTypes: [] })
  assert.equal(out2.complete, false, '触顶截断须如实上报 complete=false')
  assert.match(out2.truncatedReason ?? '', /分页不全|截断/)
})

test('F2-5 client_credentials 续签：401 TOKEN_EXPIRED 失效重签后安全重试', async () => {
  const issued = []
  const stub = async (url, init) => {
    if (String(url).includes('/oauth/token')) {
      issued.push(issued.length + 1)
      return jsonRes(200, { access_token: `tok-${issued.length}`, expires_in: 3600 })
    }
    const auth = init.headers.authorization
    if (auth === 'Bearer tok-1') return jsonRes(401, { error: { code: 'TOKEN_EXPIRED' } })
    return jsonRes(201, { ticketNo: 'EXT-TKT-9', replayed: false })
  }
  const conn = createExtApiConnector({
    baseUrl: 'http://x', clientId: 'c', clientSecret: 's', fetchImpl: stub,
  })
  const out = await conn.execute(INTENT, 'act-1', 'key-9')
  assert.equal(out.externalRef, 'EXT-TKT-9')
  assert.deepEqual(issued, [1, 2], '401 后重签一次并重试（幂等键使重试安全）')

  // 缓存命中：第二次调用不再签发
  await conn.execute(INTENT, 'act-2', 'key-10')
  assert.deepEqual(issued, [1, 2], '有效期内缓存命中，不重复签发')
})
