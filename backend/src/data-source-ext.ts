/**
 * 外部业务 API 取数连接器适配（M3/F2 演练）—— `DataConnector` 的 HTTP 适配，
 * 对接带 Bearer 认证的外部测试数据 API（cursor 分页 + 来源回执 + complete 完整性）。
 *
 * - complete=false（分页不全/截断）如实上报——formal 模式下不得可处置结果；
 * - provenance=connector 由服务端 loadDatasetFromArgs/DataSources 侧打标，连接器不自称；
 * - 扁平记录 → RuntimeDataset 对象映射可配置（缺省 AML 口径）。
 * @module @dsh-onto/backend/data-source-ext
 */
import type { DataConnector, DataQuery, ConnectorFetchOutput } from './data-sources.js'
import type { RuntimeDataset, RuntimeObjectInstance, RuntimeRelationInstance } from '@dsh-onto/core'
import { createTokenProvider, staticTokenProvider, type TokenProvider } from './ext-token.js'

export interface ExtDataConnectorOptions {
  baseUrl: string
  /** 静态 Bearer token（与 client_credentials 二选一，后者优先）。 */
  token?: string
  /** OAuth2 client_credentials 自动续签（真实集成首选）。 */
  clientId?: string
  clientSecret?: string
  tokenUrl?: string
  requestTimeoutMs?: number
  fetchImpl?: typeof fetch
  /** 外部集合 → O1 类型映射（缺省 AML 口径）。 */
  typeMap?: { customers: string; accounts: string; txns: string }
  /** 派生关系类型（缺省 AML 口径：持卡/转入）。 */
  relationTypes?: { holds: string; inbound: string }
  /** 单次 fetch 最大页数（防失控；触顶即 complete=false）。 */
  maxPages?: number
}

const DEFAULT_TYPE_MAP = { customers: 'OBJ-AML-CUSTOMER', accounts: 'OBJ-AML-ACCOUNT', txns: 'OBJ-AML-TXN' }
const DEFAULT_REL_TYPES = { holds: 'REL-AML-HOLDS', inbound: 'REL-AML-INBOUND' }

export function createExtDataConnector(opts: ExtDataConnectorOptions): DataConnector {
  const baseUrl = opts.baseUrl.trim().replace(/\/$/, '')
  const fetchImpl = opts.fetchImpl ?? fetch
  const requestTimeoutMs = opts.requestTimeoutMs ?? 8_000
  const typeMap = opts.typeMap ?? DEFAULT_TYPE_MAP
  const relTypes = opts.relationTypes ?? DEFAULT_REL_TYPES
  const maxPages = opts.maxPages ?? 20
  const tokens: TokenProvider = opts.clientId !== undefined && opts.clientSecret !== undefined
    ? createTokenProvider({
        tokenUrl: opts.tokenUrl ?? `${baseUrl}/oauth/token`,
        clientId: opts.clientId,
        clientSecret: opts.clientSecret,
        fetchImpl,
      })
    : staticTokenProvider((opts.token ?? '').trim())

  async function fetchPage(collection: string, cursor: string | null): Promise<{
    items: Array<Record<string, unknown>>
    nextCursor: string | null
    complete: boolean
    fetchedAt: string
  }> {
    const params = new URLSearchParams({ limit: '100' })
    if (cursor !== null) params.set('cursor', cursor)
    const send = async (): Promise<Response> => {
      const token = await tokens.getToken()
      return fetchImpl(`${baseUrl}/api/v1/data/${collection}?${params.toString()}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(requestTimeoutMs),
      })
    }
    let res: Response
    try {
      res = await send()
      if (res.status === 401) {
        // 令牌生命周期事件：失效重签后安全重试一次（GET 幂等）
        tokens.invalidate()
        res = await send()
      }
    } catch (e) {
      throw new Error(`外部取数失败（${collection}）：${e instanceof Error ? e.message : String(e)}`)
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (res.status !== 200) {
      throw new Error(`外部取数拒绝（${collection} ${res.status}）`)
    }
    return {
      items: Array.isArray(body.items) ? (body.items as Array<Record<string, unknown>>) : [],
      nextCursor: typeof body.nextCursor === 'string' && body.nextCursor !== '' ? body.nextCursor : null,
      complete: body.complete !== false,
      fetchedAt: typeof body.fetchedAt === 'string' ? body.fetchedAt : new Date().toISOString(),
    }
  }

  async function fetchAll(collection: string): Promise<{ items: Array<Record<string, unknown>>; complete: boolean }> {
    const items: Array<Record<string, unknown>> = []
    let cursor: string | null = null
    let complete = true
    for (let page = 0; page < maxPages; page++) {
      const out = await fetchPage(collection, cursor)
      items.push(...out.items)
      if (out.nextCursor === null) {
        complete = out.complete
        break
      }
      cursor = out.nextCursor
      if (page === maxPages - 1) complete = false // 触顶截断：如实上报
    }
    return { items, complete }
  }

  return {
    version: 'ext-data-1.0.0',
    nature: 'business-source',
    async fetch(query: DataQuery, scope): Promise<ConnectorFetchOutput> {
      const wanted = query.objectTypes && query.objectTypes.length > 0
        ? query.objectTypes
        : scope.objectTypes
      const need = (t: string) => wanted.length === 0 || wanted.includes(t)

      const objects: RuntimeObjectInstance[] = []
      const relations: RuntimeRelationInstance[] = []
      let complete = true
      let fetchedAt = new Date().toISOString()

      if (need(typeMap.customers)) {
        const r = await fetchAll('customers')
        complete = complete && r.complete
        for (const c of r.items) {
          objects.push({
            id: String(c.custNo),
            type: typeMap.customers,
            attrs: { ...c },
          })
        }
      }
      const accountRows: Array<Record<string, unknown>> = []
      if (need(typeMap.accounts)) {
        const r = await fetchAll('accounts')
        complete = complete && r.complete
        accountRows.push(...r.items)
        for (const a of r.items) {
          objects.push({
            id: String(a.acctNo),
            type: typeMap.accounts,
            attrs: { ...a },
          })
        }
      }
      if (need(typeMap.txns)) {
        const r = await fetchAll('txns')
        complete = complete && r.complete
        for (const t of r.items) {
          objects.push({
            id: String(t.txnId),
            type: typeMap.txns,
            attrs: { ...t },
          })
          if (typeof t.acctNo === 'string') {
            relations.push({
              id: `R-IN-${String(t.txnId)}`,
              type: relTypes.inbound,
              from: String(t.txnId),
              to: t.acctNo,
            })
          }
        }
      }
      for (const a of accountRows) {
        if (typeof a.custNo === 'string') {
          relations.push({
            id: `R-HOLD-${String(a.acctNo)}`,
            type: relTypes.holds,
            from: a.custNo,
            to: String(a.acctNo),
          })
        }
      }

      return {
        dataset: { objects, relations, candidates: [], provenance: 'connector' },
        complete,
        paged: true,
        ...(complete ? {} : { truncatedReason: '外部取数分页不全或触顶截断（complete=false）' }),
        businessWindow: {
          from: query.timeWindow?.from ?? '1970-01-01T00:00:00.000Z',
          to: query.timeWindow?.to ?? fetchedAt,
        },
      }
    },
  }
}
