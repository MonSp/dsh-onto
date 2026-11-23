/**
 * 发布业务 v1 受控数据源配置：部署配置持久层 + 宿主启动恢复。
 *
 * 口径：
 * - apiBaseUrl / apiToken 是部署配置——不入包、不落发布台账（releases/manifests、history.jsonl）；
 *   本模块的 `source-configs.json` 是独立部署配置面（与发布台账分离存放）。
 * - 「免重启发布」只承诺生效即时性；重启存活靠宿主启动时 {@link restoreManagedDataSources}
 *   按本配置重建映射连接器登记（发布写入的运行中登记重启即失，不恢复则运行按未登记拒）。
 * - 恢复语义：已登记的 sourceId 不覆盖（部署 env / 插件自登记优先），只补缺——
 *   显式 publish（人工批准）可幂等替换；被动恢复只补空位。
 * - 恢复期逐条复核受控配置（sourceKind 白名单、基址 https 或回环 http）与包内转换契约
 *   （apiSources shape + source-maps）；任一缺失 fail-closed：该 sourceId 不登记，运行按未登记拒。
 * @module @dsh-onto/runtime/source-config
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PackageWorkspace, loadPackage } from '@dsh-onto/core'
import { AgentToolError, isRecord } from './agent-policy.js'
import { dataSources } from './data-sources.js'
import { createMappedDataConnector } from './data-source-map.js'

export const SOURCE_CONFIGS_FORMAT = 'dsh-onto-source-configs/1'

/** 受控数据源配置（部署配置；可能含静态令牌，与发布台账分离）。 */
export interface ManagedSourceConfig {
  sourceId: string
  /** 转换契约所在包（shape + source-maps 随包读取，不入本配置）。 */
  package: { name: string; version: string }
  sourceKind: 'simulated' | 'formal'
  apiBaseUrl: string
  /** 可选静态令牌（部署配置；不入包、不落台账）。 */
  apiToken?: string
  registeredAt: string
}

/** 启动恢复报告（跳过项带原因；loadError = 配置整体不可读，全部不登记）。 */
export interface SourceRestoreReport {
  restored: string[]
  skipped: Array<{ sourceId: string; reason: string }>
  loadError?: string
}

/** 受控基址校验（发布与恢复同口径）：https 任意；http 仅回环。 */
export function parseControlledBaseUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new AgentToolError('INVALID_ARGS', 'apiBaseUrl 不是合法 URL')
  }
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) {
    throw new AgentToolError('INVALID_ARGS', 'apiBaseUrl 仅允许 https 或回环 http（受控数据源配置）')
  }
  return url
}

/** 连接器性质白名单（发布与恢复同口径）。 */
export function parseSourceKind(raw: string): 'simulated' | 'formal' {
  if (raw === 'simulated' || raw === 'formal') return raw
  throw new AgentToolError('INVALID_ARGS', 'sourceKind 只能是 simulated|formal')
}

/** 配置落点（dataDir 根；与发布台账 releases/ 分离）。 */
export function sourceConfigsPath(dataDir: string): string {
  return join(dataDir, 'source-configs.json')
}

function writeSourceConfigs(dataDir: string, configs: readonly ManagedSourceConfig[]): void {
  const file = sourceConfigsPath(dataDir)
  mkdirSync(dirname(file), { recursive: true })
  const body = `${JSON.stringify({ format: SOURCE_CONFIGS_FORMAT, sources: configs }, null, 2)}\n`
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, body, 'utf8')
  renameSync(tmp, file)
}

function configEntryError(index: number, why: string): never {
  throw new AgentToolError('INVALID_ARGS', `受控数据源配置第 ${index + 1} 项非法：${why}`)
}

function parseSourceConfigEntry(raw: unknown, index: number): ManagedSourceConfig {
  if (!isRecord(raw)) configEntryError(index, '须为对象')
  const rec = raw as Record<string, unknown>
  if (typeof rec.sourceId !== 'string' || rec.sourceId === '') configEntryError(index, 'sourceId 须为非空字符串')
  if (!isRecord(rec.package)) configEntryError(index, 'package 须为对象')
  const pkg = rec.package as Record<string, unknown>
  if (typeof pkg.name !== 'string' || pkg.name === '' || typeof pkg.version !== 'string' || pkg.version === '') {
    configEntryError(index, 'package.name/version 须为非空字符串')
  }
  if (typeof rec.sourceKind !== 'string') configEntryError(index, 'sourceKind 须为字符串')
  parseSourceKind(rec.sourceKind)
  if (typeof rec.apiBaseUrl !== 'string') configEntryError(index, 'apiBaseUrl 须为字符串')
  if (rec.apiToken !== undefined && typeof rec.apiToken !== 'string') configEntryError(index, 'apiToken 须为字符串')
  if (typeof rec.registeredAt !== 'string' || rec.registeredAt === '') configEntryError(index, 'registeredAt 须为非空字符串')
  return {
    sourceId: rec.sourceId,
    package: { name: pkg.name, version: pkg.version },
    sourceKind: rec.sourceKind as 'simulated' | 'formal',
    apiBaseUrl: rec.apiBaseUrl,
    ...(typeof rec.apiToken === 'string' && rec.apiToken !== '' ? { apiToken: rec.apiToken } : {}),
    registeredAt: rec.registeredAt,
  }
}

/** 读取受控数据源配置；无文件返回空表，结构损坏抛错（调用方决定降级口径）。 */
export function loadSourceConfigs(dataDir: string): ManagedSourceConfig[] {
  const file = sourceConfigsPath(dataDir)
  if (!existsSync(file)) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new AgentToolError('INVALID_ARGS', '受控数据源配置损坏（source-configs.json 无法解析；人工核对，不自动重建）')
  }
  if (!isRecord(parsed) || parsed.format !== SOURCE_CONFIGS_FORMAT || !Array.isArray(parsed.sources)) {
    throw new AgentToolError('INVALID_ARGS', '受控数据源配置结构非法（format/sources）')
  }
  return (parsed.sources as unknown[]).map((raw, i) => parseSourceConfigEntry(raw, i))
}

/** 按 sourceId 写入/替换一条受控数据源配置（发布动作落盘面；原子写）。 */
export function upsertSourceConfig(dataDir: string, config: ManagedSourceConfig): void {
  const configs = loadSourceConfigs(dataDir).filter((c) => c.sourceId !== config.sourceId)
  configs.push(parseSourceConfigEntry(config, configs.length))
  writeSourceConfigs(dataDir, configs)
}

/**
 * 宿主启动恢复：按受控数据源配置重建映射连接器登记。
 * 已登记 sourceId 不覆盖（部署 env / 插件自登记优先）；包契约缺失或配置复核失败
 * → 跳过登记（fail-closed：运行按未登记拒）并记入报告。配置整体不可读 → 全部不登记。
 */
export function restoreManagedDataSources(dataDir: string): SourceRestoreReport {
  let configs: ManagedSourceConfig[]
  try {
    configs = loadSourceConfigs(dataDir)
  } catch (e) {
    const loadError = e instanceof Error ? e.message : String(e)
    console.warn(`[dsh-onto] 受控数据源配置恢复失败（fail-closed，全部不登记）：${loadError}`)
    return { restored: [], skipped: [], loadError }
  }
  const ws = new PackageWorkspace(join(dataDir, 'workspace'))
  const restored: string[] = []
  const skipped: Array<{ sourceId: string; reason: string }> = []
  for (const cfg of configs) {
    if (dataSources.has(cfg.sourceId)) {
      const reason = '已登记（部署/插件登记优先，恢复不覆盖）'
      skipped.push({ sourceId: cfg.sourceId, reason })
      console.warn(`[dsh-onto] 受控数据源恢复跳过 ${cfg.sourceId}：${reason}`)
      continue
    }
    try {
      parseSourceKind(cfg.sourceKind)
      parseControlledBaseUrl(cfg.apiBaseUrl)
      let pkg: ReturnType<typeof loadPackage>
      try {
        pkg = loadPackage(ws.versionDir(cfg.package.name, cfg.package.version))
      } catch {
        throw new AgentToolError('INVALID_ARGS', `包不可读或缺失：${cfg.package.name}@${cfg.package.version}`)
      }
      const src = pkg.apiSources.find((s) => s.id === cfg.sourceId)
      if (src === undefined || src.shape === undefined) {
        throw new AgentToolError('INVALID_ARGS', `${cfg.sourceId} 未在包 apiSources 声明 shape`)
      }
      const maps = pkg.sourceMaps ?? []
      if (maps.length === 0) {
        throw new AgentToolError('INVALID_ARGS', `${cfg.sourceId} 所在包无 source-maps：映射契约缺失`)
      }
      dataSources.register(cfg.sourceId, createMappedDataConnector({
        sourceId: cfg.sourceId,
        baseUrl: cfg.apiBaseUrl,
        shape: src.shape,
        maps,
        kind: cfg.sourceKind,
        ...(typeof cfg.apiToken === 'string' && cfg.apiToken !== '' ? { auth: { token: cfg.apiToken } } : {}),
      }))
      restored.push(cfg.sourceId)
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      skipped.push({ sourceId: cfg.sourceId, reason })
      console.warn(`[dsh-onto] 受控数据源恢复跳过 ${cfg.sourceId}：${reason}`)
    }
  }
  return { restored, skipped }
}
