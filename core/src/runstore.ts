/**
 * 运行记录注册表（RunRecord）：场景执行的持久留痕与审计归档（spec run-insight S2.1/S2.4）。
 *
 * - 落盘 `<workspaceRoot>/runs/<runId>.json`（人审面：掩蔽前完整结果 + 双源红线清单）；
 * - 归档 `<workspaceRoot>/runs/exports/<runId>.json`（RunRecord + archivedAt 页脚）；
 * - runId 单段校验 + isInsideDir 围栏（I3 同族）：穿越/ADS/多级下钻全拒；
 * - phraseRegistry 的持久后端经 loadRunRedlines 读 RunRecord.redlines（跨进程 render
 *   遮蔽，backlog #2）——清单仅用于遮蔽，永不随渲染文本出模型面。
 *
 * `runScenario` 保持纯执行；持久化由调用方（agent 工具 execute / CLI / wire）显式落盘。
 * @module @dsh-onto/core/runstore
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isInsideDir, isSafeRelPath, PackageStoreError } from './store.js'
import type { RuntimeDataset, ScenarioPrepSummary, ScenarioRunResult } from './types.js'

export const RUNS_DIR = 'runs'
export const RUNS_EXPORTS_DIR = 'exports'

/** 一条运行的人审面留痕（完整短语与证据链；模型面出口仍须过 enforceOutputPolicy）。 */
export interface RunRecord {
  runId: string
  package: { name: string; version: string }
  scenarioId: string
  startedAt: string
  /** sha256(canonicalJson(effectiveDataset))：键序稳定，同数据同指纹。 */
  datasetDigest: string
  /**
   * 调用方原始 dataset 的 digest（scenario-prep S2.4）。
   * 无准备时 === datasetDigest；旧记录缺省视为相等（向后兼容）。
   */
  inputDigest?: string
  datasetSummary: { objects: number; relations: number; behaviors: number; candidates: number }
  /** 当轮双源短语清单（命中 ∪ 场景红线）——phraseRegistry 的落盘面。 */
  redlines: string[]
  /** 执行层 prep 摘要（人审对账；无准备时缺省）。 */
  prep?: ScenarioPrepSummary
  /** 掩蔽前完整结果（core/wire/CLI 人审面口径）。 */
  result: ScenarioRunResult
  savedAt: string
}

/** 归档页脚（S2.4）：RunRecord 全量 + 导出时间戳。 */
export type RunArchive = RunRecord & { archivedAt: string }

/** runId 单段校验（同 versionDir 口径）：非空、无分隔符、无 `.`/`..`、无 `:`。 */
export function isSafeRunId(runId: unknown): runId is string {
  return typeof runId === 'string' && isSafeRelPath(runId) && !/[\\/]/.test(runId)
}

function requireSafeRunId(runId: unknown): string {
  if (!isSafeRunId(runId)) {
    throw new PackageStoreError('INVALID_ARGS', 'invalid runId')
  }
  return runId
}

/** 键序稳定的规范 JSON（对象键递归排序；数组保序）。 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const s = JSON.stringify(value)
    return s === undefined ? 'null' : s
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const rec = value as Record<string, unknown>
  const keys = Object.keys(rec).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`).join(',')}}`
}

/** 数据集指纹：sha256(规范 JSON)。同数据（键序无关）同摘要。 */
export function datasetDigest(dataset: RuntimeDataset): string {
  return createHash('sha256').update(canonicalJson(dataset)).digest('hex')
}

export function buildRunRecord(input: {
  package: { name: string; version: string }
  /** 实际参与打分的数据集（准备后 effective；无准备 = 原输入）。 */
  dataset: RuntimeDataset
  /** 调用方原输入；缺省 = dataset。有 prep 时必传以对账 inputDigest。 */
  inputDataset?: RuntimeDataset
  /** prep 摘要；缺省从 result.prep 取（runScenario 回填）。 */
  prep?: ScenarioPrepSummary
  result: ScenarioRunResult
  redlines: readonly string[]
  savedAt?: string
}): RunRecord {
  const { dataset, result } = input
  const prep = input.prep ?? result.prep
  // A-9：无 prep 路径不落 inputDigest/prep 键 → 与现状 RunRecord 逐字节一致；
  // 有 prep 才双 digest（原输入只留 digest，effective 进 datasetDigest）。
  const inputDs = input.inputDataset ?? dataset
  const effDigest = datasetDigest(dataset)
  const inputDigest = prep !== undefined ? datasetDigest(inputDs) : undefined
  return {
    runId: result.runId,
    package: { name: input.package.name, version: input.package.version },
    scenarioId: result.scenarioId,
    startedAt: result.startedAt,
    datasetDigest: effDigest,
    ...(inputDigest !== undefined ? { inputDigest } : {}),
    datasetSummary: {
      objects: dataset.objects.length,
      relations: dataset.relations.length,
      behaviors: dataset.behaviors?.length ?? 0,
      candidates: dataset.candidates.length,
    },
    redlines: [...new Set(input.redlines.filter((p) => typeof p === 'string' && p !== ''))],
    ...(prep !== undefined ? { prep } : {}),
    result,
    savedAt: input.savedAt ?? new Date().toISOString(),
  }
}

/** runs/ 目录（workspace 根之下）。 */
export function runsDir(root: string): string {
  return join(root, RUNS_DIR)
}

function recordPath(root: string, runId: unknown): string {
  return join(runsDir(root), `${requireSafeRunId(runId)}.json`)
}

function assertInsideRoot(root: string, dir: string): void {
  if (!isInsideDir(root, dir)) {
    throw new PackageStoreError('INVALID_ARGS', 'invalid run path')
  }
}

/** compare 消费的候选元素形：错型元素在加载期即 PACKAGE_MALFORMED，不带到调用方 TypeError。 */
function isCandidateShaped(c: unknown): boolean {
  if (typeof c !== 'object' || c === null) return false
  const v = c as Record<string, unknown>
  return (
    typeof v.candidateId === 'string' &&
    (v.riskScore === null || (typeof v.riskScore === 'number' && Number.isFinite(v.riskScore))) &&
    Array.isArray(v.hitRuleIds) &&
    v.hitRuleIds.every((x) => typeof x === 'string') &&
    Array.isArray(v.pendingChecks) &&
    v.pendingChecks.every(
      (p) =>
        typeof p === 'object' && p !== null &&
        typeof (p as Record<string, unknown>).note === 'string' &&
        ((p as Record<string, unknown>).ruleId === undefined ||
          typeof (p as Record<string, unknown>).ruleId === 'string'),
    )
  )
}

/** excluded 元素形（compareRunRecords 的 exKey 消费面）。 */
function isExcludedShaped(x: unknown): boolean {
  if (typeof x !== 'object' || x === null) return false
  const v = x as Record<string, unknown>
  return typeof v.candidateId === 'string' && typeof v.ruleId === 'string'
}

/** 轻形状校验：加载器验形（损坏记录 fail-loud，不裸抛 TypeError）。 */
function isRunRecord(value: unknown): value is RunRecord {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  const pkg = v.package as Record<string, unknown> | undefined
  const result = v.result as Record<string, unknown> | undefined
  const audit = result?.audit as Record<string, unknown> | undefined
  return (
    typeof v.runId === 'string' &&
    typeof v.scenarioId === 'string' &&
    typeof v.startedAt === 'string' &&
    typeof v.savedAt === 'string' &&
    typeof v.datasetDigest === 'string' &&
    typeof pkg === 'object' && pkg !== null &&
    typeof pkg.name === 'string' &&
    typeof pkg.version === 'string' &&
    Array.isArray(v.redlines) &&
    v.redlines.every((p) => typeof p === 'string') &&
    typeof result === 'object' && result !== null &&
    Array.isArray(result.candidates) &&
    result.candidates.every(isCandidateShaped) &&
    Array.isArray(result.excluded) &&
    result.excluded.every(isExcludedShaped) &&
    result.humanReviewRequired === true &&
    typeof audit === 'object' && audit !== null &&
    Array.isArray(audit.forbiddenPhraseHits)
  )
}

/** 落盘运行记录（人审面；同 runId 覆盖）。返回文件绝对路径（服务端内部用，勿回显模型面）。 */
export function saveRunRecord(root: string, record: RunRecord): string {
  requireSafeRunId(record.runId)
  const dir = runsDir(root)
  assertInsideRoot(root, dir)
  mkdirSync(dir, { recursive: true })
  const file = recordPath(root, record.runId)
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  return file
}

/** 读取运行记录。非法 runId → INVALID_ARGS；缺失 → NOT_FOUND；损坏 → PACKAGE_MALFORMED。 */
export function loadRunRecord(root: string, runId: unknown): RunRecord {
  const file = recordPath(root, runId)
  if (!existsSync(file)) {
    throw new PackageStoreError('NOT_FOUND', `run ${String(runId)} not found`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new PackageStoreError('PACKAGE_MALFORMED', `run ${String(runId)} record is corrupt`)
  }
  if (!isRunRecord(parsed)) {
    throw new PackageStoreError('PACKAGE_MALFORMED', `run ${String(runId)} record is corrupt`)
  }
  return parsed
}

/** phraseRegistry 持久后端的读取面（cross-process recall；只用于遮蔽）。 */
export function loadRunRedlines(root: string, runId: string): string[] | undefined {
  if (!isSafeRunId(runId)) return undefined
  try {
    return loadRunRecord(root, runId).redlines
  } catch {
    return undefined
  }
}

/** 列出全部运行记录（savedAt 降序，同刻按 runId 升序保确定性）；损坏条目跳过。 */
export function listRunRecords(root: string): RunRecord[] {
  const dir = runsDir(root)
  if (!existsSync(dir)) return []
  const out: RunRecord[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const file = join(dir, name)
    if (!statSync(file).isFile()) continue
    try {
      out.push(loadRunRecord(root, name.slice(0, -'.json'.length)))
    } catch {
      /* skip malformed entries — 显式 load 仍 fail-loud */
    }
  }
  return out.sort((a, b) =>
    a.savedAt === b.savedAt ? (a.runId < b.runId ? -1 : 1) : a.savedAt > b.savedAt ? -1 : 1,
  )
}

/** 归档导出（S2.4）：RunRecord 全量 + archivedAt，落 runs/exports/<runId>.json（覆盖幂等）。 */
export function exportRunArchive(
  root: string,
  runId: unknown,
): { locator: string; archive: RunArchive } {
  const id = requireSafeRunId(runId)
  const record = loadRunRecord(root, id)
  const dir = join(runsDir(root), RUNS_EXPORTS_DIR)
  assertInsideRoot(root, dir)
  mkdirSync(dir, { recursive: true })
  const archive: RunArchive = { ...record, archivedAt: new Date().toISOString() }
  writeFileSync(join(dir, `${id}.json`), `${JSON.stringify(archive, null, 2)}\n`, 'utf8')
  return { locator: `${RUNS_DIR}/${RUNS_EXPORTS_DIR}/${id}.json`, archive }
}

/* ───────────────────────── 两轮对比（S2.2） ───────────────────────── */

export interface RunDiffCandidate {
  candidateId: string
  riskScoreA: number | null
  riskScoreB: number | null
  /** B − A；单侧缺失为 null。 */
  riskScoreDelta: number | null
  hitRuleIdsAdded: string[]
  hitRuleIdsRemoved: string[]
  pendingChecksAdded: string[]
  pendingChecksRemoved: string[]
}

export interface RunDiff {
  runIdA: string
  runIdB: string
  scenarioA: string
  scenarioB: string
  packageA: { name: string; version: string }
  packageB: { name: string; version: string }
  sameDataset: boolean
  candidates: RunDiffCandidate[]
  excludedAdded: Array<{ candidateId: string; ruleId: string }>
  excludedRemoved: Array<{ candidateId: string; ruleId: string }>
  auditPassedA: boolean
  auditPassedB: boolean
  humanReviewRequired: true
}

/** 待核实点归一键（ruleId + note）；输出为可读形态。 */
function pendingKey(p: { ruleId?: string; note: string }): string {
  return p.ruleId ? `${p.ruleId}: ${p.note}` : p.note
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * 两轮对比（纯函数）：候选按 candidateId 并集，B 相对 A 的命中/待核实增删、分数 delta。
 * 跨版本（fork 改权重）与跨场景（同数据多视角）同口径——同数据由 datasetDigest 标记。
 */
export function compareRunRecords(a: RunRecord, b: RunRecord): RunDiff {
  const candA = new Map(a.result.candidates.map((c) => [c.candidateId, c]))
  const candB = new Map(b.result.candidates.map((c) => [c.candidateId, c]))
  const ids: string[] = []
  for (const c of a.result.candidates) ids.push(c.candidateId)
  for (const c of b.result.candidates) if (!candA.has(c.candidateId)) ids.push(c.candidateId)
  const candidates: RunDiffCandidate[] = ids.map((candidateId) => {
    const ca = candA.get(candidateId)
    const cb = candB.get(candidateId)
    const scoreA = ca === undefined ? null : finiteOrNull(ca.riskScore)
    const scoreB = cb === undefined ? null : finiteOrNull(cb.riskScore)
    const hitsA = new Set((ca?.hitRuleIds ?? []).filter((x) => typeof x === 'string'))
    const hitsB = new Set((cb?.hitRuleIds ?? []).filter((x) => typeof x === 'string'))
    const pendA = new Set((ca?.pendingChecks ?? []).map(pendingKey))
    const pendB = new Set((cb?.pendingChecks ?? []).map(pendingKey))
    return {
      candidateId,
      riskScoreA: scoreA,
      riskScoreB: scoreB,
      riskScoreDelta: scoreA !== null && scoreB !== null ? scoreB - scoreA : null,
      hitRuleIdsAdded: [...hitsB].filter((x) => !hitsA.has(x)),
      hitRuleIdsRemoved: [...hitsA].filter((x) => !hitsB.has(x)),
      pendingChecksAdded: [...pendB].filter((x) => !pendA.has(x)),
      pendingChecksRemoved: [...pendA].filter((x) => !pendB.has(x)),
    }
  })
  const exKey = (x: { candidateId: string; ruleId: string }): string => `${x.candidateId}|${x.ruleId}`
  const exA = new Map(a.result.excluded.map((x) => [exKey(x), x]))
  const exB = new Map(b.result.excluded.map((x) => [exKey(x), x]))
  return {
    runIdA: a.runId,
    runIdB: b.runId,
    scenarioA: a.scenarioId,
    scenarioB: b.scenarioId,
    packageA: a.package,
    packageB: b.package,
    sameDataset: a.datasetDigest === b.datasetDigest,
    candidates,
    excludedAdded: [...exB.values()].filter((x) => !exA.has(exKey(x))),
    excludedRemoved: [...exA.values()].filter((x) => !exB.has(exKey(x))),
    auditPassedA: a.result.audit.passed === true,
    auditPassedB: b.result.audit.passed === true,
    humanReviewRequired: true,
  }
}
