/**
 * 配置驱动源映射连接器（api-to-plugin S2.3）—— `DataConnector` 的 HTTP 适配。
 *
 * 职责边界：HTTP 取数（collections/snapshot 两模式；cursor/offset/none 三分页）
 * + 按需集合取舍（对齐 tax-connector 的按需取候选），行喂给 core/sourcemap 纯转换
 * （`transformSourceRows`——本文件不写任何转换逻辑，映射即转换由单一实现保证）。
 * `complete=false`（分页不全/触顶截断/上游显式 false）如实上报；
 * `businessWindow` 沿用转换返回（timeField 计算，无时间字段不冒充时效，fresh 门语义）。
 *
 * 地址与凭证只来自部署配置（opts 注入，典型为部署 env）——包内 shape/source-maps 只描述
 * 结构；静态 Bearer token 不落日志。鉴权 v1：无鉴权或静态 Bearer（复用 ext-token），不做 OAuth2。
 * @module @dsh-onto/runtime/data-source-map
 */
import type { ApiShape, O1SourceMap, SourceRow, SourceRows } from '@dsh-onto/core'
import { readField, transformSourceRows } from '@dsh-onto/core'
import type { ConnectorFetchOutput, DataConnector, DataQuery } from './data-sources.js'
import { staticTokenProvider, type TokenProvider } from './ext-token.js'

export interface MappedDataConnectorOptions {
  /** 逻辑来源 id（随错误/截断信息可辨识；登记仍走 dataSources.register）。 */
  sourceId?: string
  /** 部署配置的 API 基址（不进本体包）。 */
  baseUrl: string
  /** API 形态（信封/分页），来自 bindings/api-sources.yaml 的 shape 块。 */
  shape: ApiShape
  /** 源映射（bindings/source-maps.yaml），转换契约。 */
  maps: O1SourceMap[]
  /** 鉴权 v1：无鉴权或静态 Bearer。 */
  auth?: { token?: string }
  /**
   * 连接器性质（data-sources.ts `nature` 语义）：`formal` 真实业务来源，
   * 否则 `simulated`（本地/测试闭环不得自标 business-source）。
   */
  kind?: 'dryrun' | 'simulated' | 'formal'
  requestTimeoutMs?: number
  fetchImpl?: typeof fetch
  /** 单集合最大页数（防失控；触顶 → complete=false）。缺省 20。 */
  maxPages?: number
}

export interface MappedDataConnector extends DataConnector {
  /** 登记用逻辑来源 id（契约外信息）。 */
  sourceId?: string
}

const DEFAULT_MAX_PAGES = 20
const DEFAULT_TIMEOUT_MS = 8_000

/** 映射的 objectType 集合：对象映射恒有；候选映射可选（关系/行为映射无，跟随 collection）。 */
function mapObjectType(m: O1SourceMap): string | undefined {
  if (m.kind === undefined || m.kind === 'object') return m.objectType
  if (m.kind === 'candidate') return m.objectType
  return undefined
}

/**
 * 按需集合取舍（对齐 tax-connector）：query.objectTypes（缺省 scope.objectTypes）经
 * maps 的 objectType→collection 决定要哪些集合；候选/行为/关系映射挂在其 collection 上
 * （跟随取舍）——映射的 objectType 不在 wanted 里则不取该集合。wanted 为空 = 全取。
 */
function wantedCollections(maps: O1SourceMap[], wanted: string[]): Set<string> {
  const out = new Set<string>()
  for (const m of maps) {
    if (wanted.length === 0) {
      out.add(m.collection)
      continue
    }
    const t = mapObjectType(m)
    if (t !== undefined && wanted.includes(t)) out.add(m.collection)
  }
  return out
}

/** fetch 单页（GET；非 200/网络失败抛错，风格对齐 data-source-ext）。 */
async function getJson(
  url: string,
  label: string,
  tokens: TokenProvider | null,
  fetchImpl: typeof fetch,
  requestTimeoutMs: number,
): Promise<Record<string, unknown>> {
  let res: Response
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      // 受控数据源不跟随重定向（fail-closed）：防 https 源 30x 跳内网/降级 http 的 SSRF 变道。
      redirect: 'error',
      ...(tokens !== null ? { headers: { authorization: `Bearer ${await tokens.getToken()}` } } : {}),
      signal: AbortSignal.timeout(requestTimeoutMs),
    })
  } catch (e) {
    throw new Error(`外部取数失败（${label}）：${e instanceof Error ? e.message : String(e)}`)
  }
  if (res.status !== 200) {
    throw new Error(`外部取数拒绝（${label} ${res.status}）`)
  }
  const body: unknown = await res.json().catch(() => {
    throw new Error(`外部取数响应不是有效 JSON（${label}）`)
  })
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error(`外部取数响应须为 JSON 对象（${label}）`)
  }
  return body as Record<string, unknown>
}

function pageItems(body: Record<string, unknown>, itemsPath: string, label: string): SourceRow[] {
  const raw = readField(body, itemsPath)
  if (!Array.isArray(raw) || raw.some((r) => r === null || typeof r !== 'object' || Array.isArray(r))) {
    throw new Error(`外部取数响应 ${itemsPath} 须为对象数组（${label}）`)
  }
  return raw as SourceRow[]
}

interface CollectionFetch {
  rows: SourceRow[]
  complete: boolean
  /** 触顶截断（maxPages）——与上游 completeField 显式 false 区分给 truncatedReason。 */
  truncated: boolean
  /** 上游 completeField 显式 false。 */
  upstreamIncomplete: boolean
}

/**
 * collections 模式单集合取数（分页拼页）。
 * cursor：请求 cursorParam（缺省 cursor），响应 nextField（缺省 nextCursor），空/缺=结束；
 * offset：limitParam/offsetParam/pageSize（缺省 limit/offset/100），items 不足一页或空=结束；
 * none：一次取完。
 */
async function fetchCollection(
  collection: string,
  shape: ApiShape,
  opts: MappedDataConnectorOptions,
  tokens: TokenProvider | null,
): Promise<CollectionFetch> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES
  const baseUrl = opts.baseUrl.trim().replace(/\/$/, '')
  const itemsPath = shape.itemsPath ?? 'items'
  const completeField = shape.pagination.completeField ?? 'complete'
  const label = opts.sourceId !== undefined && opts.sourceId !== '' ? `${opts.sourceId}/${collection}` : collection
  const path = (shape.collectionPath ?? '').replaceAll('{collection}', encodeURIComponent(collection))
  const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`

  const rows: SourceRow[] = []
  let complete = true
  let truncated = false
  let upstreamIncomplete = false
  const mode = shape.pagination.mode

  const take = async (query: URLSearchParams): Promise<Record<string, unknown>> =>
    getJson(`${url}${query.toString() ? `?${query.toString()}` : ''}`, label, tokens, fetchImpl, requestTimeoutMs)

  if (mode === 'cursor') {
    const cursorParam = shape.pagination.cursorParam ?? 'cursor'
    const nextField = shape.pagination.nextField ?? 'nextCursor'
    let cursor: string | null = null
    for (let page = 0; page < maxPages; page++) {
      const query = new URLSearchParams()
      if (cursor !== null) query.set(cursorParam, cursor)
      const body = await take(query)
      rows.push(...pageItems(body, itemsPath, label))
      if (readField(body, completeField) === false) {
        complete = false
        upstreamIncomplete = true
      }
      const next = readField(body, nextField)
      if (typeof next !== 'string' || next === '') break
      cursor = next
      if (page === maxPages - 1) {
        complete = false
        truncated = true
      }
    }
  } else if (mode === 'offset') {
    const limitParam = shape.pagination.limitParam ?? 'limit'
    const offsetParam = shape.pagination.offsetParam ?? 'offset'
    const pageSize = shape.pagination.pageSize ?? 100
    let offset = 0
    for (let page = 0; page < maxPages; page++) {
      const query = new URLSearchParams()
      query.set(limitParam, String(pageSize))
      query.set(offsetParam, String(offset))
      const body = await take(query)
      const got = pageItems(body, itemsPath, label)
      rows.push(...got)
      if (readField(body, completeField) === false) {
        complete = false
        upstreamIncomplete = true
      }
      if (got.length < pageSize) break // 不足一页或空=结束
      offset += pageSize
      if (page === maxPages - 1) {
        complete = false
        truncated = true
      }
    }
  } else {
    const body = await take(new URLSearchParams())
    rows.push(...pageItems(body, itemsPath, label))
    if (readField(body, completeField) === false) {
      complete = false
      upstreamIncomplete = true
    }
  }
  return { rows, complete, truncated, upstreamIncomplete }
}

/**
 * snapshot 模式取数：一次 GET `path`，按 `collectionPaths`（集合键→响应体点路径）
 * 拆出 rows；pagination 只支持 none。
 */
async function fetchSnapshot(
  shape: ApiShape,
  opts: MappedDataConnectorOptions,
  tokens: TokenProvider | null,
): Promise<{ rows: SourceRows; complete: boolean; upstreamIncomplete: boolean }> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS
  const baseUrl = opts.baseUrl.trim().replace(/\/$/, '')
  const completeField = shape.pagination.completeField ?? 'complete'
  const path = shape.path ?? ''
  const label = opts.sourceId !== undefined && opts.sourceId !== '' ? `${opts.sourceId}/snapshot` : 'snapshot'
  const body = await getJson(`${baseUrl}${path.startsWith('/') ? path : `/${path}`}`, label, tokens, fetchImpl, requestTimeoutMs)

  const rows: SourceRows = {}
  for (const [key, jsonPath] of Object.entries(shape.collectionPaths ?? {})) {
    rows[key] = pageItems(body, jsonPath, label)
  }
  const upstreamIncomplete = readField(body, completeField) === false
  return { rows, complete: !upstreamIncomplete, upstreamIncomplete }
}

/**
 * 部署侧工厂：`dataSources.register(sourceId, createMappedDataConnector(…))`。
 * 缺 baseUrl/shape 非法时即刻抛错（deny-by-default：缺 URL 不登记由装配侧把关）。
 */
export function createMappedDataConnector(opts: MappedDataConnectorOptions): MappedDataConnector {
  const shape = opts.shape
  if (shape.mode === 'collections') {
    if (!(shape.collectionPath ?? '').includes('{collection}')) {
      throw new Error(`shape.collectionPath 须含 {collection} 模板: ${shape.collectionPath ?? '(缺省)'}`)
    }
    if (opts.baseUrl.trim() === '') throw new Error('baseUrl 不能为空（部署配置注入）')
  } else if (shape.mode === 'snapshot') {
    if (shape.pagination.mode !== 'none') {
      throw new Error(`snapshot 模式 pagination 只支持 none（实得 ${shape.pagination.mode}）`)
    }
    if ((shape.path ?? '') === '') throw new Error('shape.path 不能为空（snapshot 模式）')
    if (opts.baseUrl.trim() === '') throw new Error('baseUrl 不能为空（部署配置注入）')
  } else {
    throw new Error(`shape.mode 非法: ${String((shape as { mode: unknown }).mode)}`)
  }

  const token = (opts.auth?.token ?? '').trim()
  const tokens: TokenProvider | null = token !== '' ? staticTokenProvider(token) : null

  return {
    version: 'mapped-data-1.0.0',
    // 来源性质按 kind 标注（与 data-source-ext 同口径）：simulated 测试 API 不得标 business-source
    nature: opts.kind === 'formal' ? 'business-source' : 'simulated',
    ...(opts.sourceId !== undefined ? { sourceId: opts.sourceId } : {}),
    async fetch(query: DataQuery, scope): Promise<ConnectorFetchOutput> {
      if (query.instanceIds?.length) {
        throw new Error('配置驱动连接器暂不支持 instanceIds 查询；不会扩大取数范围')
      }
      const wanted =
        query.objectTypes !== undefined && query.objectTypes.length > 0
          ? query.objectTypes
          : scope.objectTypes
      const take = wantedCollections(opts.maps, wanted)

      const rows: SourceRows = {}
      let complete = true
      let truncated = false
      let upstreamIncomplete = false

      if (opts.shape.mode === 'collections') {
        // 集合按映射首现顺序取（确定性）；wanted 外的集合不拉（对齐 tax-connector 按需取候选）
        const order: string[] = []
        for (const m of opts.maps) {
          if (take.has(m.collection) && !order.includes(m.collection)) order.push(m.collection)
        }
        for (const collection of order) {
          const out = await fetchCollection(collection, opts.shape, opts, tokens)
          rows[collection] = out.rows
          complete = complete && out.complete
          truncated = truncated || out.truncated
          upstreamIncomplete = upstreamIncomplete || out.upstreamIncomplete
        }
      } else {
        const out = await fetchSnapshot(opts.shape, opts, tokens)
        complete = out.complete
        upstreamIncomplete = out.upstreamIncomplete
        // 与 collections 同一取舍语义：wanted 外集合的行不进转换
        for (const [key, rs] of Object.entries(out.rows)) {
          if (take.has(key)) rows[key] = rs
        }
      }

      // 行 → dataset 走 core 纯转换（映射即转换；业务窗按 timeField，无时间字段不冒充时效）
      const transformed = transformSourceRows({
        rows,
        maps: opts.maps,
        ...(query.timeWindow !== undefined ? { timeWindow: query.timeWindow } : {}),
        provenance: 'connector',
      })

      const reasons: string[] = []
      if (truncated) reasons.push(`触顶 maxPages=${opts.maxPages ?? DEFAULT_MAX_PAGES} 截断`)
      if (upstreamIncomplete) reasons.push('上游 completeField 显式 false')

      return {
        dataset: transformed.dataset,
        complete,
        paged: opts.shape.pagination.mode !== 'none',
        ...(complete ? {} : { truncatedReason: reasons.join('；') || '取数分页不全（complete=false）' }),
        businessWindow: transformed.businessWindow,
      }
    },
  }
}
