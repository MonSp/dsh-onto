/**
 * 接入面纯逻辑（api-to-plugin S2.6）：采样 / 映射预览 / 生成 / 回放的请求组装与路径围栏。
 *
 * - 与 CLI `source` / `plugin` / `replay` 同口径（cmdSource/cmdReplay/cmdPlugin）：
 *   shape 与集合解析、data/url 两路取数、probe 字段表、preview 走 core previewSourceMaps。
 * - 不依赖 services（防模块环）；不写第二套业务逻辑——转换/打分/回放全部在 core 纯函数。
 * - 路径围栏（防任意路径读写盘）：dir/outDir/fixturePath/againstDir 必须落在 fence 根内，
 *   相对路径按 fence 根解析；围栏口径同 tool-face-policy P2.1（isInsideDir + isSafeRelPath 双查）。
 * @module @dsh-onto/backend/source-face
 */
import { isAbsolute, relative, resolve } from 'node:path'
import {
  fetchShapeRows,
  fixtureToRows,
  isInsideDir,
  isSafeRelPath,
  previewSourceMaps,
  shapeCollectionKeys,
  type ApiShape,
  type GeneratePluginInput,
  type OntologyPackage,
  type ReplayInput,
  type SourceMapPreviewResult,
  type SourceRows,
} from '@dsh-onto/core'
import { AgentToolError } from './agent-policy.js'

function invalid(message: string): AgentToolError {
  return new AgentToolError('INVALID_ARGS', message)
}

/**
 * 路径围栏：相对路径按 fence 根解析，落点必须在根内（含 ADS 冒号段拒绝）。
 * 拒绝根自身（rel 为空）——outDir/fixture 等都必须是根内子路径。
 */
export function requireInsideFence(fence: string, label: string, raw: unknown): string {
  if (typeof raw !== 'string' || raw === '') throw invalid(`${label} required`)
  const path = isAbsolute(raw) ? resolve(raw) : resolve(fence, raw)
  const rel = relative(fence, path)
  if (!isInsideDir(fence, path) || !isSafeRelPath(rel)) {
    throw invalid(`${label} 越出工作区（围栏防穿越）: ${raw}`)
  }
  return path
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') throw invalid(`${label} required`)
  return value
}

/* ────────────────────────────── 取数（CLI sampleRows 同口径） ────────────────────────────── */

export interface SourceProbeRequest {
  sourceId?: string
  /** 样本 URL（仅构建期探测，不写入包）；与 data 二选一。 */
  url?: string
  /** 样本 JSON 对象（信封或快照体）；与 url 二选一。 */
  data?: unknown
  /** 集合键列表（缺省按 source-maps → shape.collectionPaths 回退）。 */
  collections?: string[]
  /** 每集合采样上限（缺省 50；0 = 跟分页走完）。 */
  samples?: number
}

const SAMPLE_TIMEOUT_MS = 8000

/** 默认 HTTP GET：全局 fetch + 超时 + 非 200 拒绝（CLI fetchJson 同口径）。 */
async function fetchSampleJson(url: string): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(SAMPLE_TIMEOUT_MS) })
  } catch (e) {
    throw invalid(`采样请求失败 ${url}: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (res.status !== 200) throw invalid(`采样请求拒绝 ${url} (${res.status})`)
  return res.json().catch(() => ({}))
}

/** shape 解析（CLI shapeOf 同口径）：sourceId 指名，否则取首个带 shape 的源。 */
export function resolveShapeOf(pkg: OntologyPackage, sourceId?: string): ApiShape {
  const src =
    typeof sourceId === 'string' && sourceId !== ''
      ? pkg.apiSources.find((s) => s.id === sourceId)
      : pkg.apiSources.find((s) => s.shape !== undefined) ?? pkg.apiSources[0]
  if (src === undefined) throw invalid('包内没有 apiSources')
  if (src.shape === undefined) throw invalid(`${src.id} 未声明 shape（api-sources.yaml 形态块）`)
  return src.shape
}

/** 集合解析（CLI collectionsFor 同口径）：显式 > source-maps 集合 > shape.collectionPaths。 */
export function resolveCollectionsOf(pkg: OntologyPackage, shape: ApiShape, explicit?: string[]): string[] {
  const flag = Array.isArray(explicit) ? explicit.map((s) => String(s).trim()).filter((s) => s !== '') : []
  if (flag.length > 0) return flag
  const fromMaps = [...new Set((pkg.sourceMaps ?? []).map((m) => m.collection))]
  if (fromMaps.length > 0) return fromMaps
  const fromShape = [...shapeCollectionKeys(shape)]
  if (fromShape.length > 0) return fromShape
  throw invalid('无法确定集合：请给 collections（或先写 source-maps / shape.collectionPaths）')
}

function normalizeProbeRequest(request: SourceProbeRequest): {
  url?: string
  data?: unknown
  samples: number
} {
  const hasUrl = typeof request?.url === 'string' && request.url !== ''
  const hasData = request?.data !== undefined && request.data !== null
  if (hasUrl === hasData) throw invalid('url（在线采样）与 data（粘贴样本）必须且只能提供一个')
  const samples = request?.samples ?? 50
  if (typeof samples !== 'number' || !Number.isFinite(samples) || samples < 0) {
    throw invalid('samples 必须是非负数')
  }
  if (hasData && (typeof request.data !== 'object')) {
    throw invalid('data 必须是 JSON 对象/数组')
  }
  if (hasUrl) {
    let parsed: URL
    try {
      parsed = new URL(request.url as string)
    } catch {
      throw invalid(`url 不是合法地址: ${String(request.url)}`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw invalid(`url 仅支持 http(s)（构建期探测）: ${parsed.protocol}`)
    }
  }
  return {
    ...(hasUrl ? { url: request.url as string } : {}),
    ...(hasData ? { data: request.data } : {}),
    samples,
  }
}

/**
 * 采样取行：data 走 fixtureToRows（= extractSnapshotRows/extractPageItems 同口径），
 * url 走 fetchShapeRows（分页在 core）。requestFn 仅供测试注入，缺省全局 fetch。
 */
export async function sampleRowsFor(
  pkg: OntologyPackage,
  request: SourceProbeRequest,
  requestFn?: (pathWithQuery: string) => Promise<unknown>,
): Promise<{ origin: string; rows: SourceRows }> {
  const norm = normalizeProbeRequest(request)
  const shape = resolveShapeOf(pkg, request?.sourceId)
  const collections = resolveCollectionsOf(pkg, shape, request?.collections)
  if (norm.data !== undefined) {
    return { origin: 'data:inline', rows: fixtureToRows(norm.data, shape, collections) }
  }
  const baseUrl = (norm.url as string).replace(/\/$/, '')
  const fn = requestFn ?? ((pathWithQuery: string) => fetchSampleJson(`${baseUrl}${pathWithQuery}`))
  const rows = await fetchShapeRows({ shape, collections, samples: norm.samples, request: fn })
  return { origin: `url:${baseUrl}`, rows }
}

/* ────────────────────────────── probe / preview 报告面 ────────────────────────────── */

export interface ProbeFieldReport {
  types: string[]
  nonNull: number
  samples: unknown[]
}

export type ProbeReport = Record<string, { rows: number; fields: Record<string, ProbeFieldReport> }>

/** 字段/类型/样例表（CLI probeReport 同口径）。 */
export function probeRowsReport(rows: SourceRows): ProbeReport {
  const out: ProbeReport = {}
  for (const [c, rs] of Object.entries(rows)) {
    const fields: Record<string, ProbeFieldReport> = {}
    for (const r of rs) {
      for (const [k, v] of Object.entries(r)) {
        const f = (fields[k] ??= { types: [], nonNull: 0, samples: [] })
        if (v !== null && v !== undefined) {
          f.nonNull += 1
          const t = Array.isArray(v) ? 'array' : typeof v
          if (!f.types.includes(t)) f.types.push(t)
          if (f.samples.length < 3 && !f.samples.includes(v)) f.samples.push(v)
        }
      }
    }
    out[c] = { rows: rs.length, fields }
  }
  return out
}

/** 映射预览（CLI `source map preview --json` 同口径）：计数 + 诊断 + 证据就绪度 + 业务窗。 */
export async function previewRowsFor(
  pkg: OntologyPackage,
  request: SourceProbeRequest,
  requestFn?: (pathWithQuery: string) => Promise<unknown>,
): Promise<{ origin: string } & SourceMapPreviewResult> {
  const { origin, rows } = await sampleRowsFor(pkg, request, requestFn)
  return { origin, ...previewSourceMaps(pkg, rows) }
}

/* ────────────────────────────── generate / replay 请求组装 ────────────────────────────── */

export interface GenerateWireRequest {
  dir: string
  scenarioId: string
  sourceId: string
  outDir: string
  force?: boolean
}

/** 生成请求 → core 输入：dir/outDir 双围栏（outDir 防任意路径写盘）。 */
export function generateRequestToInput(fence: string, request: GenerateWireRequest): GeneratePluginInput {
  return {
    versionDir: requireInsideFence(fence, 'dir', request?.dir),
    scenarioId: requireNonEmptyString(request?.scenarioId, 'scenarioId'),
    sourceId: requireNonEmptyString(request?.sourceId, 'sourceId'),
    outDir: requireInsideFence(fence, 'outDir', request?.outDir),
    force: request?.force === true,
  }
}

export interface ReplayWireRequest {
  dir: string
  scenarioId: string
  fixturePath?: string
  check?: boolean
  scopeTypes?: string[]
  againstDir?: string
  writeExpected?: boolean
}

/** 回放请求 → core 输入：fixture/against 与 dir 同围栏（防任意路径读盘）。 */
export function replayRequestToInput(fence: string, request: ReplayWireRequest): ReplayInput {
  const versionDir = requireInsideFence(fence, 'dir', request?.dir)
  const scenarioId = requireNonEmptyString(request?.scenarioId, 'scenarioId')
  const input: ReplayInput = {
    versionDir,
    scenarioId,
    check: request?.check === true,
    writeExpected: request?.writeExpected === true,
  }
  if (typeof request?.fixturePath === 'string' && request.fixturePath !== '') {
    input.fixturePath = requireInsideFence(fence, 'fixturePath', request.fixturePath)
  }
  if (typeof request?.againstDir === 'string' && request.againstDir !== '') {
    input.againstDir = requireInsideFence(fence, 'againstDir', request.againstDir)
  }
  if (Array.isArray(request?.scopeTypes)) {
    // 空清单必须省略：runReplay 收到空 scope 集会整批剔除（按 objectType 收权语义）。
    const scopeTypes = request.scopeTypes.map((s) => requireNonEmptyString(s, 'scopeTypes[]'))
    if (scopeTypes.length > 0) input.scopeTypes = scopeTypes
  }
  return input
}
