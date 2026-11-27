/**
 * 发布业务 v1 受控数据源配置：部署配置持久层 + 宿主启动恢复。
 *
 * 口径：
 * - apiBaseUrl / apiTokenEnv 是部署配置——不入包、不落发布台账（releases/manifests、history.jsonl）；
 *   本模块的 `source-configs.json` 是独立部署配置面（与发布台账分离存放）。
 * - 令牌只存**宿主 env 变量名**（apiTokenEnv），值不落盘、不过模型上下文——
 *   恢复/登记时从 process.env 解析；env 缺失 → 该 sourceId 跳过登记（fail-closed）。
 * - 「免重启发布」只承诺生效即时性；重启存活靠宿主启动时 {@link restoreManagedDataSources}
 *   按本配置重建映射连接器登记（发布写入的运行中登记重启即失，不恢复则运行按未登记拒）。
 * - 写路径（{@link upsertSourceConfig}）持跨进程互斥锁：「读配置 → 校验 sourceId 归属
 *   → 合并 → 原子替换」同一临界区（check 与 rename 之间的窗口也会后写覆盖先写）；
 *   同名 sourceId 归属其它包 → 拒（幂等替换只留给同包，最终判定在锁内）。
 * - 恢复语义：已登记的 sourceId 不覆盖（部署 env / 插件自登记优先），只补缺——
 *   显式 publish（人工批准）可幂等替换；被动恢复只补空位。
 * - 恢复期逐条复核受控配置（sourceKind 白名单、基址 https 或回环 http）与包内转换契约
 *   （apiSources shape + source-maps）；任一缺失 fail-closed：该 sourceId 不登记，运行按未登记拒。
 * @module @dsh-onto/runtime/source-config
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PackageWorkspace, loadPackage } from '@dsh-onto/core'
import { AgentToolError, isRecord } from './agent-policy.js'
import { dataSources } from './data-sources.js'
import { createMappedDataConnector } from './data-source-map.js'

export const SOURCE_CONFIGS_FORMAT = 'dsh-onto-source-configs/1'

/** env 变量名语法（令牌引用只存名字，不存值）。 */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** 受控数据源配置（部署配置；令牌以 env 变量名引用，与发布台账分离）。 */
export interface ManagedSourceConfig {
  sourceId: string
  /** 转换契约所在包（shape + source-maps 随包读取，不入本配置）。 */
  package: { name: string; version: string }
  sourceKind: 'simulated' | 'formal'
  apiBaseUrl: string
  /** 可选静态令牌的宿主 env 变量名（部署配置；值不落盘、不入包、不落台账）。 */
  apiTokenEnv?: string
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
  // WHATWG URL 的 IPv6 hostname 带方括号（"[::1]"）——归一后再比对回环白名单。
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(host)
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

/** 令牌 env 引用校验（只存名字；值由宿主 env 提供）。 */
export function parseTokenEnvName(raw: string): string {
  if (!ENV_NAME_RE.test(raw)) {
    throw new AgentToolError('INVALID_ARGS', 'apiTokenEnv 须是合法 env 变量名（如 DSH_SRC_TOKEN）')
  }
  return raw
}

/** 从宿主 env 解析令牌值；env 缺失/为空返回 null（调用方按无鉴权或 fail-closed 处置）。 */
export function resolveTokenEnv(name: string): string | null {
  const v = process.env[name]
  return typeof v === 'string' && v !== '' ? v : null
}

/** 配置落点（dataDir 根；与发布台账 releases/ 分离）。 */
export function sourceConfigsPath(dataDir: string): string {
  return join(dataDir, 'source-configs.json')
}

function parseSourceConfigsText(text: string | null): ManagedSourceConfig[] {
  if (text === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new AgentToolError('INVALID_ARGS', '受控数据源配置损坏（source-configs.json 无法解析；人工核对，不自动重建）')
  }
  if (!isRecord(parsed) || parsed.format !== SOURCE_CONFIGS_FORMAT || !Array.isArray(parsed.sources)) {
    throw new AgentToolError('INVALID_ARGS', '受控数据源配置结构非法（format/sources）')
  }
  return (parsed.sources as unknown[]).map((raw, i) => parseSourceConfigEntry(raw, i))
}

function readSourceConfigsRaw(dataDir: string): string | null {
  const file = sourceConfigsPath(dataDir)
  return existsSync(file) ? readFileSync(file, 'utf8') : null
}

/** 原子替换（tmp+rename）。调用方须持有跨进程锁。 */
function writeSourceConfigs(dataDir: string, configs: readonly ManagedSourceConfig[]): void {
  const file = sourceConfigsPath(dataDir)
  mkdirSync(dirname(file), { recursive: true })
  const body = `${JSON.stringify({ format: SOURCE_CONFIGS_FORMAT, sources: configs }, null, 2)}\n`
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, body, 'utf8')
  renameSync(tmp, file)
}

const LOCK_STALE_MS = 30_000
const LOCK_WAIT_MS = 10_000

function sleepMs(ms: number): void {
  // 同步等待（本模块写路径是同步 API）：Atomics.wait 主线程可用（Node）
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * 跨进程互斥（lockfile，`openSync(..., 'wx')` 原子创建）：把「读配置 → 校验 sourceId 归属
 * → 合并 → 原子替换」放进同一临界区——check 与 rename 之间的窗口也会造成后写覆盖先写。
 * 持锁进程死亡 → 按 mtime 超时打破陈锁（打破后重新竞争，不直接进临界区）。
 */
function withSourceConfigsLock<T>(dataDir: string, fn: () => T): T {
  const lockFile = `${sourceConfigsPath(dataDir)}.lock`
  mkdirSync(dirname(lockFile), { recursive: true })
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    let fd: number
    try {
      fd = openSync(lockFile, 'wx')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      try {
        if (Date.now() - statSync(lockFile).mtimeMs > LOCK_STALE_MS) rmSync(lockFile, { force: true })
      } catch {
        /* 锁已被并发方移除：下轮重新竞争 */
      }
      if (Date.now() > deadline) {
        throw new AgentToolError('INVALID_ARGS', '受控数据源配置写入锁超时（并发争用）：请重试')
      }
      sleepMs(5)
      continue
    }
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), 'utf8')
      return fn()
    } finally {
      closeSync(fd)
      rmSync(lockFile, { force: true })
    }
  }
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
  if (rec.apiTokenEnv !== undefined && typeof rec.apiTokenEnv !== 'string') configEntryError(index, 'apiTokenEnv 须为字符串')
  if (typeof rec.apiToken === 'string') configEntryError(index, 'apiToken 已废弃：令牌只存 env 变量名（apiTokenEnv），值不落盘')
  if (typeof rec.registeredAt !== 'string' || rec.registeredAt === '') configEntryError(index, 'registeredAt 须为非空字符串')
  return {
    sourceId: rec.sourceId,
    package: { name: pkg.name, version: pkg.version },
    sourceKind: rec.sourceKind as 'simulated' | 'formal',
    apiBaseUrl: rec.apiBaseUrl,
    ...(typeof rec.apiTokenEnv === 'string' && rec.apiTokenEnv !== ''
      ? { apiTokenEnv: parseTokenEnvName(rec.apiTokenEnv) }
      : {}),
    registeredAt: rec.registeredAt,
  }
}

/** 读取受控数据源配置；无文件返回空表，结构损坏抛错（调用方决定降级口径）。 */
export function loadSourceConfigs(dataDir: string): ManagedSourceConfig[] {
  return parseSourceConfigsText(readSourceConfigsRaw(dataDir))
}

/**
 * 按 sourceId 写入/替换一条受控数据源配置（发布动作落盘面）。
 * 跨进程互斥下完成「读 → sourceId 归属判定 → 合并 → 原子替换」：
 * 同名 sourceId 归属其它包 → 拒（幂等替换只留给同包；最终判定在锁内，调用方的提前检查不作数）。
 */
export function upsertSourceConfig(dataDir: string, config: ManagedSourceConfig): void {
  const entry = parseSourceConfigEntry(config, 0)
  withSourceConfigsLock(dataDir, () => {
    const configs = parseSourceConfigsText(readSourceConfigsRaw(dataDir))
    const owner = configs.find((c) => c.sourceId === entry.sourceId)
    if (owner !== undefined && owner.package.name !== entry.package.name) {
      throw new AgentToolError(
        'INVALID_ARGS',
        `sourceId ${entry.sourceId} 已被 ${owner.package.name}@${owner.package.version} 占用：换 sourceId 或由原包发布`,
      )
    }
    const merged = configs.filter((c) => c.sourceId !== entry.sourceId)
    merged.push(entry)
    writeSourceConfigs(dataDir, merged)
  })
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
      // 令牌从宿主 env 解析（值不落盘）；声明了 env 名但取不到值 → fail-closed 不登记。
      let token: string | null = null
      if (cfg.apiTokenEnv !== undefined) {
        token = resolveTokenEnv(cfg.apiTokenEnv)
        if (token === null) {
          throw new AgentToolError('INVALID_ARGS', `${cfg.sourceId} 令牌 env ${cfg.apiTokenEnv} 缺失/为空：fail-closed 不登记`)
        }
      }
      dataSources.register(cfg.sourceId, createMappedDataConnector({
        sourceId: cfg.sourceId,
        baseUrl: cfg.apiBaseUrl,
        shape: src.shape,
        maps,
        kind: cfg.sourceKind,
        mapBasis: { package: { name: cfg.package.name, version: cfg.package.version } },
        ...(token !== null ? { auth: { token } } : {}),
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
