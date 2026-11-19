/**
 * 服务端数据连接器入口（可信数据 M1-B 正式通道）—— 取数与来源证据（DataSnapshot）。
 *
 * 口径（方案 §5 + docs/design/bc-shared-interfaces.md）：
 * - **正式通道**：工具接受逻辑 `sourceId` + 对象/时间窗等查询条件，由服务端连接器取数；
 *   不得接受 Agent 自称的 `provenance=connector`——provenance 与 dataBasis 只在本模块产出。
 * - **探索通道**：内联/文件数据（agent-tools.loadDatasetFromArgs 打标），明确未核实，
 *   不允许据此直接进入正式动作。
 * - **来源证据**：每次取数产出 {@link DataSnapshot}（来源 ID、连接器版本、租户、查询摘要、
 *   取数时间、业务时间窗、完整性、受保护存储 locator + 内容摘要、来源性质）。
 *   完整快照落受控存储（workspace snapshots/），记录保留可回查 locator 与摘要，
 *   不把敏感原始数据复制进 Agent 上下文。
 * - 连接器接入只证明「通过已登记来源获得」，不自动证明数据正确或业务完整——
 *   正式分析另查时效、完整性、必需特征（runScenario 的 dataStatus 判定）。
 * - `nature: 'simulated'`（本地/测试闭环，F1 记录显式标注）与 `'business-source'` 分开；
 *   模拟来源即使 formal 计算通过也不能调用真实业务动作（动作门在 C/D 包）。
 * @module @dsh-onto/runtime/data-sources
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DataBasisInput, DataSnapshot, RuntimeDataset } from '@dsh-onto/core'
import { AgentToolError, isRecord } from './agent-policy.js'
import { scopedRuntimeObject } from './context.js'

/** 取数查询条件（逻辑条件，不放凭证/地址）。 */
export interface DataQuery {
  /** 对象类型过滤（O1 类型 id）。 */
  objectTypes?: string[]
  /** 业务时间窗（ISO；连接器按窗取数）。 */
  timeWindow?: { from: string; to: string }
  /** 实例过滤（可选，服务端策略可进一步收窄）。 */
  instanceIds?: string[]
}

/** 连接器取数输出（连接器自报完整性与业务时间窗；fresh 由服务端按窗判定）。 */
export interface ConnectorFetchOutput {
  dataset: RuntimeDataset
  /** 完整性：分页/截断状态。complete=false → formal 不可得可处置结果。 */
  complete: boolean
  paged?: boolean
  truncatedReason?: string
  /** 数据覆盖的业务时间窗。 */
  businessWindow: { from: string; to: string }
}

/**
 * 数据连接器（apiSources 的运行时接入面）：按查询条件取数。
 * 地址、凭证、租户由部署配置决定——本体中的任意 endpoint 不直接发起网络请求。
 */
export interface DataConnector {
  /** 连接器实现版本（进快照，旧快照可辨识来源版本）。 */
  version: string
  /** 来源性质：模拟（本地/测试闭环）或业务来源。 */
  nature: 'simulated' | 'business-source'
  fetch(query: DataQuery, scope: { tenant: string; objectTypes: string[]; instanceFilter?: string }): Promise<ConnectorFetchOutput>
}

/** 取数结果：dataset（含 provenance=connector）+ 快照 + dataBasis（runScenario 入参）。 */
export interface FetchResult {
  dataset: RuntimeDataset
  snapshot: DataSnapshot
  dataBasis: DataBasisInput
}

/** snap-<uuid8>（runId 同惯例）。 */
function newSnapshotId(): string {
  const hex = createHash('sha256').update(`${Date.now()}-${Math.random()}`).digest('hex')
  return `snap-${hex.slice(0, 8)}`
}

/** 键序稳定 canonical JSON（摘要与落盘共用）。 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const rec = value as Record<string, unknown>
  const keys = Object.keys(rec).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`).join(',')}}`
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * 数据源注册表（服务端）：sourceId → 连接器。
 * 由部署配置/适配器注册；Agent 工具面只传 sourceId，不可传连接器本体。
 */
export class DataSourceRegistry {
  private readonly connectors = new Map<string, DataConnector>()
  /** 时效上限（小时）：businessWindow.to 距取数时刻超过此限 → fresh=false。缺省 72h。 */
  maxAgeHours = 72

  register(sourceId: string, connector: DataConnector): void {
    if (typeof sourceId !== 'string' || sourceId === '') {
      throw new AgentToolError('INVALID_ARGS', 'sourceId 必须是非空字符串')
    }
    if (this.connectors.has(sourceId)) {
      throw new AgentToolError('INVALID_ARGS', `数据源已登记: ${sourceId}（不覆盖；换名或先注销）`)
    }
    this.connectors.set(sourceId, connector)
  }

  unregister(sourceId: string): void {
    this.connectors.delete(sourceId)
  }

  has(sourceId: string): boolean {
    return this.connectors.has(sourceId)
  }

  list(): Array<{ sourceId: string; version: string; nature: string }> {
    return [...this.connectors.entries()].map(([sourceId, c]) => ({
      sourceId,
      version: c.version,
      nature: c.nature,
    }))
  }

  /**
   * 正式取数：服务端连接器按查询条件取数 → DataSnapshot（受控存储）+ dataBasis。
   * 未登记 sourceId → INVALID_ARGS（deny-by-default；不回退内联）。
   */
  async fetch(input: {
    sourceId: string
    query: DataQuery
    tenant: string
    /** 取数范围（C 包 BusinessIdentity.dataScope 收窄；缺省 = 连接器全量）。 */
    dataScope?: { objectTypes: string[]; instanceFilter?: string }
    /** 受控存储根（workspace 根；快照落 snapshots/）。 */
    root: string
    /** Validate the returned dataset before persisting any snapshot. */
    authorizeDataset?: (dataset: RuntimeDataset) => void
    /** 可测注入位（fresh 判定与时戳）；缺省 = new Date()。 */
    now?: () => Date
  }): Promise<FetchResult> {
    const connector = this.connectors.get(input.sourceId)
    if (connector === undefined) {
      throw new AgentToolError(
        'INVALID_ARGS',
        `数据源未登记: ${input.sourceId}——正式取数只走服务端登记连接器（deny-by-default）；`
          + '探索分析请用 dataset/datasetPath 通道（结果标注未核实）',
      )
    }
    const scope = {
      tenant: input.tenant,
      objectTypes: input.dataScope?.objectTypes ?? input.query.objectTypes ?? [],
      ...(input.dataScope?.instanceFilter !== undefined ? { instanceFilter: input.dataScope.instanceFilter } : {}),
    }
    const out = await connector.fetch(input.query, scope)
    if (!isRecord(out) || !isRecord(out.dataset)) {
      throw new AgentToolError('INVALID_ARGS', '连接器输出非法：须为 { dataset, complete, businessWindow }')
    }
    input.authorizeDataset?.(out.dataset)
    const now = (input.now ?? (() => new Date()))()
    const fetchedAt = now.toISOString()
    // 时效判定（服务端按业务时间窗）：窗尾距取数时刻超过 maxAgeHours → 超时效
    const windowEnd = Date.parse(out.businessWindow.to)
    const maxAgeMs = this.maxAgeHours * 3600_000
    const fresh = Number.isFinite(windowEnd) ? now.getTime() - windowEnd <= maxAgeMs : false

    const snapshotId = newSnapshotId()
    const queryDigest = sha256Hex(canonicalJson(input.query))
    const content = canonicalJson(out.dataset)
    const locatorKey = `snapshots/${snapshotId}.json`
    const locator = { key: locatorKey, sha256: sha256Hex(content) }
    const snapshot: DataSnapshot = {
      snapshotId,
      sourceId: input.sourceId,
      connectorVersion: connector.version,
      tenant: input.tenant,
      queryDigest,
      fetchedAt,
      businessWindow: out.businessWindow,
      completeness: {
        complete: out.complete === true,
        ...(out.paged !== undefined ? { paged: out.paged } : {}),
        ...(out.truncatedReason !== undefined ? { truncatedReason: out.truncatedReason } : {}),
      },
      locator,
      nature: connector.nature,
    }
    // 受控存储：完整快照落 workspace snapshots/（原子写）；Agent 上下文只见 locator+摘要
    saveSnapshot(input.root, snapshot, content)

    const dataBasis: DataBasisInput = {
      nature: connector.nature,
      complete: snapshot.completeness.complete,
      fresh,
      snapshotId,
      sourceId: input.sourceId,
    }
    // provenance 只由本通道产出（调用方自称 connector 一律被入口覆盖/拒绝）
    const dataset = { ...out.dataset, provenance: 'connector' } as RuntimeDataset
    return { dataset, snapshot, dataBasis }
  }
}

/** 快照原子落盘（tmp+rename；同 runstore 惯例）。 */
function saveSnapshot(root: string, snapshot: DataSnapshot, content: string): void {
  const dir = join(root, 'snapshots')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${snapshot.snapshotId}.json`)
  const body = `${JSON.stringify({ snapshot, dataset: JSON.parse(content) }, null, 2)}\n`
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, body, 'utf8')
  renameSync(tmp, file)
}

/** 快照读取（受控存储回查；locator 摘要不符 → 拒绝，防换内容保 locator）。 */
export function loadSnapshot(root: string, snapshotId: string): { snapshot: DataSnapshot; dataset: RuntimeDataset } {
  if (!/^snap-[0-9a-f]{8}$/.test(snapshotId)) {
    throw new AgentToolError('INVALID_ARGS', `snapshotId 非法: ${snapshotId}`)
  }
  const file = join(root, 'snapshots', `${snapshotId}.json`)
  if (!existsSync(file)) {
    throw new AgentToolError('NOT_FOUND', `快照不存在: ${snapshotId}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new AgentToolError('INVALID_ARGS', `快照损坏: ${snapshotId}（人工核对，不自动重取）`)
  }
  if (!isRecord(parsed) || !isRecord(parsed.snapshot) || !isRecord(parsed.dataset)) {
    throw new AgentToolError('INVALID_ARGS', `快照结构非法: ${snapshotId}`)
  }
  const snapshot = parsed.snapshot as unknown as DataSnapshot
  const dataset = parsed.dataset as unknown as RuntimeDataset
  const content = canonicalJson(dataset)
  if (sha256Hex(content) !== snapshot.locator?.sha256) {
    throw new AgentToolError('INVALID_ARGS', `快照摘要不符: ${snapshotId}（内容被改，拒绝回查）`)
  }
  return { snapshot, dataset }
}

/**
 * 服务端共享注册表（同 registerActionConnector 模式）：部署适配器在此登记连接器，
 * Agent 工具 / wire / CLI 同一入口（sourceId 只在此解析，不接受调用方自带连接器）。
 */
export const dataSources = scopedRuntimeObject(Symbol('dataSources'), () => new DataSourceRegistry())

/** 测试辅助：直接登记（绕过重复校验的便捷面，仅测试调用；生产用 dataSources.register）。 */
export function registerDataSourceForTest(sourceId: string, connector: DataConnector): void {
  dataSources.unregister(sourceId)
  dataSources.register(sourceId, connector)
}

/** 测试辅助：清空登记。 */
export function clearDataSourcesForTest(): void {
  for (const { sourceId } of dataSources.list()) dataSources.unregister(sourceId)
}
