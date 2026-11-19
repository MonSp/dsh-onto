/**
 * TAX 只读数据连接器（插件侧装配，不改 core/runtime）。
 *
 * 对接 mock tax-api（`GET /api/v1/data/:collection`）：
 * - taxpayers / invoices / bankFlows / taxReturns / benchmarks → O1 对象与关系
 * - riskCandidates → 候选（含上游特征，与 examples/tax-run.json 口径一致）
 *
 * sourceId 由部署侧 `dataSources.register('SRC-TAX-CORE', …)` 登记；
 * 本模块只实现 DataConnector 契约，不自行发起未登记地址请求。
 * @module @dsh-tax/app/tax-connector
 */
import type {
  ConnectorFetchOutput,
  DataConnector,
  DataQuery,
} from '@dsh-onto/runtime'
import type {
  RuntimeBehaviorInstance,
  RuntimeCandidate,
  RuntimeObjectInstance,
  RuntimeRelationInstance,
} from '@dsh-onto/core'

export interface TaxApiConnectorOptions {
  /** 部署配置的 tax-api 基址（仅回环 mock；不写进本体包）。 */
  baseUrl: string
  /** 连接器性质：缺省 simulated（本地测试闭环）。 */
  kind?: 'simulated' | 'formal'
  requestTimeoutMs?: number
  fetchImpl?: typeof fetch
}

type Json = Record<string, unknown>
type CollectionName =
  | 'taxpayers'
  | 'invoices'
  | 'bankFlows'
  | 'taxReturns'
  | 'benchmarks'
  | 'riskCandidates'

const TIME_KEY_RE =
  /(?:^|_)(?:at|ts|time|date|timestamp|datetime|occurredat|createdat|updatedat|lastupdated|filingdate|issuedate|registrationdate)$|(?:At|Time|Date|Ts|Timestamp|Datetime|On|Updated|FilingDate|IssueDate|RegistrationDate)$/

function recordTimeMs(attrs: Record<string, unknown>): number | undefined {
  let best: number | undefined
  for (const [k, v] of Object.entries(attrs)) {
    if (!TIME_KEY_RE.test(k)) continue
    let ms: number | undefined
    if (typeof v === 'string' && v !== '') ms = Date.parse(v)
    else if (typeof v === 'number' && Number.isFinite(v)) ms = v > 1e12 ? v : v * 1000
    if (ms !== undefined && (best === undefined || ms < best)) best = ms
  }
  return best
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

async function fetchAll(
  baseUrl: string,
  collection: CollectionName,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ items: Json[]; complete: boolean }> {
  const items: Json[] = []
  let cursor: string | null = null
  let complete = true
  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams()
    if (cursor !== null) params.set('cursor', cursor)
    const url = `${baseUrl}/api/v1/data/${collection}${params.toString() ? `?${params}` : ''}`
    let res: Response
    try {
      res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
    } catch (e) {
      throw new Error(`tax-api 取数失败（${collection}）：${e instanceof Error ? e.message : String(e)}`)
    }
    if (res.status !== 200) {
      throw new Error(`tax-api 取数拒绝（${collection} ${res.status}）`)
    }
    const body = (await res.json().catch(() => ({}))) as Json
    const pageItems = Array.isArray(body.items) ? (body.items as Json[]) : []
    items.push(...pageItems)
    const next = typeof body.nextCursor === 'string' && body.nextCursor !== '' ? body.nextCursor : null
    if (next === null) {
      complete = body.complete !== false
      break
    }
    cursor = next
    if (page === 19) complete = false
  }
  return { items, complete }
}

/** 纳税人 id：idRule `<tin>`。 */
function taxpayerId(r: Json): string {
  return str(r.tin)
}
/** 发票 id：idRule `<invoice_code>:<invoice_no>`。 */
function invoiceId(r: Json): string {
  return `${str(r.invoiceCode)}:${str(r.invoiceNo)}`
}
/** 流水 id：idRule `<bank_code>:<flow_no>`。 */
function flowId(r: Json): string {
  return `${str(r.bankCode)}:${str(r.flowNo)}`
}
/** 申报 id：idRule `<taxpayer_tin>:<return_type>:<period>`。 */
function returnId(r: Json): string {
  return `${str(r.taxpayerTin)}:${str(r.returnType)}:${str(r.period)}`
}
/** 基准 id：idRule `<industry_code>:<tax_type>:<period>:<region_code>`。 */
function benchmarkId(r: Json): string {
  return `${str(r.industryCode)}:${str(r.taxType)}:${str(r.period)}:${str(r.regionCode)}`
}

function needType(wanted: string[] | undefined, type: string): boolean {
  return wanted === undefined || wanted.length === 0 || wanted.includes(type)
}

/**
 * 组装 RuntimeDataset（纯结构适配）：
 * - 对象 attrs 与 O1 属性同名（field-maps 描述同源映射）
 * - 关系仅连接同批内两端均存在的实例（ingest 闭合）
 * - 候选 objectRef 必须命中纳税人对象 id
 */
export async function fetchTaxDataset(
  opts: TaxApiConnectorOptions,
  query: DataQuery,
  scope: { objectTypes: string[]; instanceFilter?: string },
): Promise<ConnectorFetchOutput> {
  const baseUrl = opts.baseUrl.trim().replace(/\/$/, '')
  const fetchImpl = opts.fetchImpl ?? fetch
  const timeoutMs = opts.requestTimeoutMs ?? 8_000
  const wanted =
    query.objectTypes && query.objectTypes.length > 0
      ? query.objectTypes
      : scope.objectTypes.length > 0
        ? scope.objectTypes
        : []
  const want = (t: string) => needType(wanted, t)

  let complete = true
  const load = async (name: CollectionName): Promise<Json[]> => {
    const r = await fetchAll(baseUrl, name, fetchImpl, timeoutMs)
    complete = complete && r.complete
    return r.items
  }

  const objects: RuntimeObjectInstance[] = []
  const relations: RuntimeRelationInstance[] = []
  const behaviors: RuntimeBehaviorInstance[] = []
  const candidates: RuntimeCandidate[] = []
  const recordTimes: number[] = []

  const pushObj = (id: string, type: string, attrs: Json): void => {
    objects.push({ id, type, attrs: { ...attrs } })
    const ms = recordTimeMs(attrs)
    if (ms !== undefined) recordTimes.push(ms)
  }

  const taxpayerRows = want('OBJ-TAX-TAXPAYER') ? await load('taxpayers') : []
  for (const r of taxpayerRows) pushObj(taxpayerId(r), 'OBJ-TAX-TAXPAYER', r)

  const invoiceRows = want('OBJ-TAX-INVOICE') ? await load('invoices') : []
  for (const r of invoiceRows) pushObj(invoiceId(r), 'OBJ-TAX-INVOICE', r)

  const flowRows = want('OBJ-TAX-BANK-FLOW') ? await load('bankFlows') : []
  for (const r of flowRows) pushObj(flowId(r), 'OBJ-TAX-BANK-FLOW', r)

  const returnRows = want('OBJ-TAX-TAX-RETURN') ? await load('taxReturns') : []
  for (const r of returnRows) pushObj(returnId(r), 'OBJ-TAX-TAX-RETURN', r)

  const benchmarkRows = want('OBJ-TAX-INDUSTRY-BENCHMARK') ? await load('benchmarks') : []
  for (const r of benchmarkRows) pushObj(benchmarkId(r), 'OBJ-TAX-INDUSTRY-BENCHMARK', r)

  const ids = new Set(objects.map((o) => o.id))
  const addRel = (type: string, from: string, to: string): void => {
    if (!ids.has(from) || !ids.has(to)) return
    relations.push({ id: `R-${type}-${from}-${to}`, type, from, to })
  }

  for (const r of invoiceRows) {
    addRel('REL-TAX-ISSUES-INVOICE', str(r.sellerTin), invoiceId(r))
    addRel('REL-TAX-RECEIVES-INVOICE', str(r.buyerTin), invoiceId(r))
  }
  for (const r of returnRows) addRel('REL-TAX-FILES-RETURN', str(r.taxpayerTin), returnId(r))
  for (const r of benchmarkRows) {
    // 行业基准按同行业纳税人挂接（行业属性在纳税人行上）
    for (const t of taxpayerRows) {
      if (str(t.industryCode) === str(r.industryCode)) {
        addRel('REL-TAX-BENCHMARK-MATCH', taxpayerId(t), benchmarkId(r))
      }
    }
  }

  // 候选：仅保留 objectRef 命中本批纳税人者（ingest 闭合）
  const candRows = await load('riskCandidates')
  const taxpayerIds = new Set(taxpayerRows.map(taxpayerId))
  for (const r of candRows) {
    const objectRef = str(r.objectRef)
    if (!taxpayerIds.has(objectRef)) continue
    const rawFeatures = r.features
    const features: Record<string, number | string> = {}
    if (rawFeatures !== null && typeof rawFeatures === 'object' && !Array.isArray(rawFeatures)) {
      for (const [k, v] of Object.entries(rawFeatures as Json)) {
        if (typeof v === 'number' && Number.isFinite(v)) features[k] = v
        else if (typeof v === 'string' && v !== '') features[k] = v
      }
    }
    candidates.push({
      candidateId: str(r.candidateId),
      objectRef,
      features,
      tags: Array.isArray(r.tags) ? (r.tags as string[]).filter((x) => typeof x === 'string') : [],
    })
  }

  // 时间窗过滤（记录时间；与 data-source-ext 同口径）
  const winFrom = query.timeWindow !== undefined ? Date.parse(query.timeWindow.from) : NaN
  const winTo = query.timeWindow !== undefined ? Date.parse(query.timeWindow.to) : NaN
  const hasWin = query.timeWindow !== undefined && Number.isFinite(winFrom) && Number.isFinite(winTo)
  let kept = objects
  if (hasWin) {
    kept = objects.filter((o) => {
      const ms = recordTimeMs(o.attrs ?? {})
      if (ms === undefined) return true // 无时间字段的维表（字典型）保留
      return ms >= winFrom && ms <= winTo
    })
  }
  const keptIds = new Set(kept.map((o) => o.id))
  const keptRels = relations.filter((r) => keptIds.has(r.from) && keptIds.has(r.to))
  const keptCands = candidates.filter((c) => keptIds.has(c.objectRef))

  const businessWindow =
    recordTimes.length > 0
      ? {
          from: new Date(Math.min(...recordTimes)).toISOString(),
          to: new Date(Math.max(...recordTimes)).toISOString(),
        }
      : {
          from: query.timeWindow?.from ?? '1970-01-01T00:00:00.000Z',
          to: '',
        }

  return {
    dataset: { objects: kept, relations: keptRels, behaviors, candidates: keptCands, provenance: 'connector' },
    complete,
    paged: true,
    ...(complete ? {} : { truncatedReason: 'tax-api 分页不全或触顶截断（complete=false）' }),
    businessWindow,
  }
}

/** 部署侧工厂：`dataSources.register('SRC-TAX-CORE', createTaxDataConnector(…))`。 */
export function createTaxDataConnector(opts: TaxApiConnectorOptions): DataConnector {
  return {
    version: 'tax-api-1.0.0',
    nature: opts.kind === 'formal' ? 'business-source' : 'simulated',
    async fetch(query: DataQuery, scope): Promise<ConnectorFetchOutput> {
      return fetchTaxDataset(opts, query, scope)
    },
  }
}
