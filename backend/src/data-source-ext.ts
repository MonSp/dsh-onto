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
  /**
   * 连接器性质（M0-A 口径，data-sources.ts `nature` 语义）：`simulated` 本地/测试闭环、
   * `formal` 真实业务来源。缺省 simulated——测试 API 不得自称 business-source
   * （模拟来源即使 formal 计算通过也不能调用真实业务动作）。
   */
  kind?: 'dryrun' | 'simulated' | 'formal'
}

const DEFAULT_TYPE_MAP = { customers: 'OBJ-AML-CUSTOMER', accounts: 'OBJ-AML-ACCOUNT', txns: 'OBJ-AML-TXN' }
const DEFAULT_REL_TYPES = { holds: 'REL-AML-HOLDS', inbound: 'REL-AML-INBOUND' }

/** 记录时间字段识别（键名启发：At/Time/Date/ts 结尾，或常见时间键）。 */
const TIME_KEY_RE = /(?:^|_)(?:at|ts|time|date|timestamp|datetime|occurredat|createdat|updatedat|lastupdated|occurred)$|(?:At|Time|Date|Ts|Timestamp|Datetime|On)$/

/**
 * 记录时间（毫秒时间戳）：扫描 attrs 里的时间字段——ISO 串或数字 epoch。
 * 取不到 → undefined（业务窗口不以取数时刻冒充记录时间）。
 */
function recordTimeMs(attrs: Record<string, unknown>): number | undefined {
  let best: number | undefined
  for (const [k, v] of Object.entries(attrs)) {
    if (!TIME_KEY_RE.test(k)) continue
    let ms: number | undefined
    if (typeof v === 'string' && v !== '') {
      const p = Date.parse(v)
      if (Number.isFinite(p)) ms = p
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      // 数字 epoch：秒/毫秒启发（>1e12 视为毫秒）
      ms = v > 1e12 ? v : v * 1000
    }
    if (ms !== undefined && (best === undefined || ms > best)) best = ms
  }
  return best
}

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
    // 来源性质按适配器 kind 标注（与 data-sources.ts 口径一致）：simulated 测试 API
    // 不得标 business-source（模拟来源即使 formal 计算通过也不能调用真实业务动作）。
    nature: opts.kind === 'formal' ? 'business-source' : 'simulated',
    async fetch(query: DataQuery, scope): Promise<ConnectorFetchOutput> {
      const wanted = query.objectTypes && query.objectTypes.length > 0
        ? query.objectTypes
        : scope.objectTypes
      const need = (t: string) => wanted.length === 0 || wanted.includes(t)

      const objects: RuntimeObjectInstance[] = []
      const relations: RuntimeRelationInstance[] = []
      let complete = true

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

      // businessWindow 按记录时间计算真实窗口（不是查询回显）：窗外记录剔除，
      // 窗口 = 存活记录的记录时间 [min, max]。无记录时间无法证明时效 → to 留空
      //（data-sources 侧 Date.parse 失败 → fresh=false），不再缺省 to=取数时刻使 fresh 恒真。
      const winFrom = query.timeWindow !== undefined ? Date.parse(query.timeWindow.from) : NaN
      const winTo = query.timeWindow !== undefined ? Date.parse(query.timeWindow.to) : NaN
      const hasWin = query.timeWindow !== undefined && Number.isFinite(winFrom) && Number.isFinite(winTo)
      const kept: RuntimeObjectInstance[] = []
      const recordTimes: number[] = []
      for (const o of objects) {
        const ms = recordTimeMs(o.attrs)
        if (hasWin && ms !== undefined && (ms < winFrom || ms > winTo)) continue // 按记录时间过滤
        if (ms !== undefined) recordTimes.push(ms)
        kept.push(o)
      }
      const keptIds = new Set(kept.map((o) => o.id))
      const keptRelations = relations.filter((r) => keptIds.has(r.from) && keptIds.has(r.to))
      const businessWindow = recordTimes.length > 0
        ? {
            from: new Date(Math.min(...recordTimes)).toISOString(),
            to: new Date(Math.max(...recordTimes)).toISOString(),
          }
        : {
            from: query.timeWindow?.from ?? '1970-01-01T00:00:00.000Z',
            to: '', // 无记录时间不声称时效（fresh 门生效，fail-closed）
          }

      return {
        dataset: { objects: kept, relations: keptRelations, candidates: [], provenance: 'connector' },
        complete,
        paged: true,
        ...(complete ? {} : { truncatedReason: '外部取数分页不全或触顶截断（complete=false）' }),
        businessWindow,
      }
    },
  }
}
