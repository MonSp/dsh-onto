/** F2 真实服务 OAuth 签发流：admin 引导 → 注册租户 client（幂等）→ 换业务 token。 */
const DEFAULT_BASE = process.env.F2_BASE ?? 'http://127.0.0.1:3920'
const ADMIN_ID = process.env.F2_ADMIN_ID ?? 'adm-dev'
const ADMIN_SECRET = process.env.F2_ADMIN_SECRET ?? 'adm-dev-secret-0123456789'

export const CLIENTS = {
  a: {
    clientId: 'cli-tenant-a-analyst',
    clientSecret: 'analyst-a-secret-0123456789',
    body: {
      clientId: 'cli-tenant-a-analyst',
      clientSecret: 'analyst-a-secret-0123456789',
      name: 'tenant-A analyst',
      tenant: 'tenant-A',
      userId: 'user-analyst-a',
      roles: ['analyst'],
      dataScope: { objectTypes: ['ACCOUNT', 'CUSTOMER', 'TXN'] },
    },
  },
  b: {
    clientId: 'cli-tenant-b-analyst',
    clientSecret: 'analyst-b-secret-0123456789',
    body: {
      clientId: 'cli-tenant-b-analyst',
      clientSecret: 'analyst-b-secret-0123456789',
      name: 'tenant-B analyst',
      tenant: 'tenant-B',
      userId: 'user-analyst-b',
      roles: ['analyst'],
      dataScope: { objectTypes: ['ACCOUNT', 'CUSTOMER', 'TXN'] },
    },
  },
}

async function token(base, clientId, clientSecret) {
  const r = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
  })
  const body = await r.json()
  if (r.status !== 200 || typeof body.access_token !== 'string') {
    throw new Error(`token 签发失败 ${r.status}: ${JSON.stringify(body).slice(0, 160)}`)
  }
  return body.access_token
}

/** 返回 { base, admin, tokenA, tokenB }（client 注册幂等：已存在即沿用）。 */
export async function getF2Tokens(base = DEFAULT_BASE) {
  const admin = await token(base, ADMIN_ID, ADMIN_SECRET)
  for (const c of [CLIENTS.a, CLIENTS.b]) {
    await fetch(`${base}/admin/clients`, {
      method: 'POST',
      headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' },
      body: JSON.stringify(c.body),
    }).catch(() => {})
  }
  const tokenA = await token(base, CLIENTS.a.clientId, CLIENTS.a.clientSecret)
  const tokenB = await token(base, CLIENTS.b.clientId, CLIENTS.b.clientSecret)
  return { base, admin, tokenA, tokenB }
}

/** 外部效应计数（审计条数）——对账「零外部效应」断言用。 */
export async function effectCount(base, tokenStr) {
  const r = await fetch(`${base}/api/v1/audit/operations?limit=1000`, {
    headers: { authorization: `Bearer ${tokenStr}` },
  })
  const body = await r.json().catch(() => ({}))
  return typeof body.count === 'number' ? body.count : (Array.isArray(body.items) ? body.items.length : -1)
}
