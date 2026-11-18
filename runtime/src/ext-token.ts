/**
 * 外部业务 API 令牌提供者（M3/F2 真实集成）—— OAuth2 client_credentials 自动续签。
 *
 * 静态 access_token 必然过期（真实系统的生命周期语义）：本模块按 expires_in 缓存、
 * 到期前主动刷新，并支持 401 TOKEN_EXPIRED 后强制失效重取（业务请求按幂等键可安全重试）。
 * @module @dsh-onto/runtime/ext-token
 */

export interface TokenProvider {
  /** 取有效 access_token（缓存命中或自动续签）。 */
  getToken(): Promise<string>
  /** 强制失效缓存（401 TOKEN_EXPIRED 后调用，下一次 getToken 重签）。 */
  invalidate(): void
}

export interface ClientCredentialsOptions {
  /** 签发端点（如 http://host:3920/oauth/token）。 */
  tokenUrl: string
  clientId: string
  clientSecret: string
  fetchImpl?: typeof fetch
  /** 到期前多少秒开始刷新（缺省 60s）。 */
  refreshMarginSec?: number
}

export function createTokenProvider(opts: ClientCredentialsOptions): TokenProvider {
  const fetchImpl = opts.fetchImpl ?? fetch
  const margin = (opts.refreshMarginSec ?? 60) * 1000
  let cached: { token: string; expiresAt: number } | null = null
  let inflight: Promise<string> | null = null

  async function issue(): Promise<string> {
    const res = await fetchImpl(opts.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
      }),
    })
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number }
    if (res.status !== 200 || typeof body.access_token !== 'string') {
      throw new Error(`令牌签发失败（${res.status}）——外部 API 不可用，零效应`)
    }
    const ttlMs = (typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3600) * 1000
    cached = { token: body.access_token, expiresAt: Date.now() + ttlMs }
    return cached.token
  }

  return {
    async getToken(): Promise<string> {
      if (cached !== null && Date.now() < cached.expiresAt - margin) return cached.token
      if (inflight === null) {
        inflight = issue().finally(() => {
          inflight = null
        })
      }
      return inflight
    },
    invalidate(): void {
      cached = null
    },
  }
}

/** 静态令牌提供者（兼容旧配置；到期语义由调用方承担）。 */
export function staticTokenProvider(token: string): TokenProvider {
  return {
    getToken: async () => token,
    invalidate: () => {},
  }
}
