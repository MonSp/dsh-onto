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
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isInsideDir, isSafeRelPath, PackageStoreError } from './store.js'
import { readManifest } from './derive.js'
import { diffViewOf, type RunDiffView } from './diffview.js'
import { buildRunReport } from './report.js'
import type {
  MappingEvidenceInput,
  MappingReceipt,
  RuntimeDataset,
  ScenarioPrepSummary,
  ScenarioRunResult,
  ValidationIssue,
} from './types.js'

export const RUNS_DIR = 'runs'
export const RUNS_EXPORTS_DIR = 'exports'

/** 一条运行的人审面留痕（完整短语与证据链；模型面出口仍须过 enforceOutputPolicy）。 */
export interface RunRecord {
  /** Server-derived owner and scope fingerprint; older records have no access binding. */
  accessBinding?: string
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
  /**
   * 补数关联（issue #33 缺口1）：本次运行系对 `refillsRunId` 的 pendingChecks 缺数
   * 补数后重算——两 run 在台账层可关联对比（compare_runs / show_run_diff）。
   * 无关联时缺省（不落键，旧记录零回归）。
   */
  refillsRunId?: string
  /**
   * 映射校验回执（audit-package P1a）：过程层「数据映射正确」的可指认凭据。
   * 无 provenance 声明的数据集不落此键（与 A-9 无 prep 不落键同族）。
   */
  mappingReceipt?: MappingReceipt
  /**
   * 试算留痕（zero-concept-loop P2）：本 run 是草案试跑（沙箱规则配置，不落包）；
   * 正式运行不落键。
   */
  trial?: { draftIds: string[]; label?: string }
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
  accessBinding?: string
  package: { name: string; version: string }
  /** 实际参与打分的数据集（准备后 effective；无准备 = 原输入）。 */
  dataset: RuntimeDataset
  /** 调用方原输入；缺省 = dataset。有 prep 时必传以对账 inputDigest。 */
  inputDataset?: RuntimeDataset
  /** prep 摘要；缺省从 result.prep 取（runScenario 回填）。 */
  prep?: ScenarioPrepSummary
  /** 补数关联原 run（issue #33 缺口1）；无关联省略。 */
  refillsRunId?: string
  /** 映射证据（audit-package P1a）；缺省按 dataset.provenance 推导诚实证据态。 */
  mappingEvidence?: MappingEvidenceInput
  /** 试算标记（zero-concept-loop P2）；正式运行缺省不落键。 */
  trial?: { draftIds: string[]; label?: string }
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
  const savedAt = input.savedAt ?? new Date().toISOString()
  const mappingReceipt = buildMappingReceipt(input.mappingEvidence, inputDs, effDigest, savedAt)
  return {
    ...(input.accessBinding === undefined ? {} : { accessBinding: input.accessBinding }),
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
    ...(input.refillsRunId === undefined ? {} : { refillsRunId: input.refillsRunId }),
    ...(mappingReceipt === undefined ? {} : { mappingReceipt }),
    ...(input.trial === undefined ? {} : { trial: input.trial }),
    result,
    savedAt,
  }
}

/**
 * 映射校验回执推导（audit-package P1a）：
 * - connector + 证据（配置映射连接器透传）→ mappingApplied:true + 诊断/计数/锚点；
 * - connector + 无证据（手写连接器自映射）→ mappingApplied:false，显式无 source-map 回执；
 * - inline/file → mappingApplied:false（直入数据，无映射环节）；
 * - 未声明 provenance 且无证据 → 不落键（零回归）。
 */
function buildMappingReceipt(
  evidence: MappingEvidenceInput | undefined,
  inputDs: RuntimeDataset,
  datasetDigestValue: string,
  issuedAt: string,
): MappingReceipt | undefined {
  const provenance = inputDs.provenance
  if (provenance === undefined && evidence === undefined) return undefined
  const mappingApplied = evidence?.mappingApplied ?? false
  return {
    receiptVersion: 1,
    provenance: provenance ?? 'unspecified',
    mappingApplied,
    ...(evidence?.mapBasis === undefined ? {} : { mapBasis: evidence.mapBasis }),
    ...(evidence?.sourceAnchor === undefined ? {} : { sourceAnchor: evidence.sourceAnchor }),
    ...(evidence?.diagnostics === undefined
      ? {}
      : { diagnostics: summarizeDiagnostics(evidence.diagnostics) }),
    counts: {
      objects: inputDs.objects.length,
      relations: inputDs.relations.length,
      behaviors: inputDs.behaviors?.length ?? 0,
      candidates: inputDs.candidates.length,
    },
    ...(evidence?.businessWindow === undefined ? {} : { businessWindow: evidence.businessWindow }),
    datasetDigest: datasetDigestValue,
    issuedAt,
  }
}

/** 诊断汇总：错误/警告计数 + 代码归并计数（不展开行数据、不带短语）。 */
function summarizeDiagnostics(
  issues: readonly ValidationIssue[],
): NonNullable<MappingReceipt['diagnostics']> {
  let errors = 0
  let warnings = 0
  const byCode = new Map<string, { code: string; level: string; count: number }>()
  for (const issue of issues) {
    if (issue.level === 'error') errors += 1
    else if (issue.level === 'warn') warnings += 1
    const key = `${issue.level}\u0000${issue.code}`
    const entry = byCode.get(key)
    if (entry === undefined) byCode.set(key, { code: issue.code, level: issue.level, count: 1 })
    else entry.count += 1
  }
  return {
    errors,
    warnings,
    codes: [...byCode.values()].sort((a, b) =>
      a.level === b.level ? (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) : a.level < b.level ? -1 : 1,
    ),
  }
}

/**
 * 运行规则面指纹（review-decision 同一算法，实现下沉 core 供包清单共用）：
 * 包身份 + 规则命中日志（ruleId/score 排序）。换规则后旧决定不得照常套用。
 *
 * 规范化语义与 runtime `actionDigest`（agent-approval.ts）逐字节一致——
 * undefined/'undefined'、NaN/'NaN'、±Infinity 显式字面（score 为 NaN 时两实现仍同指纹，
 * 已落库 ReviewDecision.ruleFingerprint 不因本次下沉漂移）。注意与 runstore 自用
 * canonicalJson（datasetDigest）语义不同：那边 NaN→'null'，此处不得复用。
 */
export function ruleBasisDigest(rec: RunRecord): string {
  const actionCanonical = (value: unknown): string => {
    if (value === undefined) return 'undefined'
    if (typeof value === 'number' && !Number.isFinite(value)) {
      return Number.isNaN(value) ? 'NaN' : value > 0 ? 'Infinity' : '-Infinity'
    }
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
    if (Array.isArray(value)) return `[${value.map(actionCanonical).join(',')}]`
    const r = value as Record<string, unknown>
    const keys = Object.keys(r).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${actionCanonical(r[k])}`).join(',')}}`
  }
  return createHash('sha256').update(actionCanonical({
    action: 'review-rule-basis',
    package: `${rec.package.name}@${rec.package.version}`,
    ruleHitLog: [...rec.result.ruleHitLog]
      .map((h) => ({ ruleId: h.ruleId, score: h.score }))
      .sort((a, b) => (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : a.score - b.score)),
  })).digest('hex')
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

/* ───────────────────── 审计包（audit-package P1a） ───────────────────── */

/** 包清单（完整性层 + 分层责任 + 可验边界；manifest 自身不入 files——自证到成员为止）。 */
export interface RunExportManifest {
  kind: 'RunExportManifest'
  runId: string
  package: { name: string; version: string }
  scenarioId: string
  exportedAt: string
  /** 包内逐文件指纹（成员文件名 + sha256 + 字节数）。 */
  files: Array<{ name: string; sha256: string; bytes: number }>
  fingerprints: {
    datasetDigest: string
    inputDigest?: string
    /** ruleBasisDigest（review-decision 同一算法；换规则后旧决定不得套用）。 */
    ruleFingerprint: string
    /** 映射契约 sourceDigest（mappingReceipt.mapBasis.sourceDigest）。 */
    mapSourceDigest?: string
    /** 包派生 manifest sourceDigest（派生链指纹；包目录可读时）。 */
    packageSourceDigest?: string
  }
  humanReviewRequired: true
  /** 分层责任 → 可指认技术证据（合同语言同构 docs/raas-responsibility-clause.zh.md）。 */
  responsibility: {
    process: { owner: 'platform'; evidence: string[] }
    determination: { owner: 'human-reviewer'; evidence: string[] }
    data: { owner: 'customer'; evidence: string[] }
  }
  /** 可验什么、不可验什么（未签=P1a 可复核口径；signed 模板见 VERIFIABILITY_SIGNED）。 */
  verifiability: { canVerify: string[]; cannotVerify: string[] }
  /**
   * 签名标记（signed-delivery P1b，信息位——被签名覆盖自身）：
   * 本包已签、用哪把钥匙、签名块在哪。未签包不落键。
   */
  signature?: { keyId: string; alg: 'ed25519'; file: string }
}

/** 责任映射与可验边界（常量模板 + 字段路径引用；无业务短语，不进禁语扫描面）。 */
const RESPONSIBILITY = {
  process: {
    owner: 'platform' as const,
    evidence: [
      'run.json#/mappingReceipt（映射校验回执：来源/诊断/计数）',
      'run.json#/datasetDigest + inputDigest（数据指纹）',
      'run.json#/result/ruleHitLog（规则命中计分流水）',
      'run.json#/result/audit（三层闭合审计与禁语扫描）',
      'manifest.json#/fingerprints（包级指纹）',
    ],
  },
  determination: {
    owner: 'human-reviewer' as const,
    evidence: [
      'chain.json#/decisions[]（复核决定：reviewer + ruleFingerprint + snapshotDigest 绑定）',
      'chain.json#/proposals[] + actions[]（处置动作与外部回执）',
    ],
  },
  data: {
    owner: 'customer' as const,
    evidence: [
      'run.json#/mappingReceipt/provenance（数据来源标记）',
      'run.json#/mappingReceipt/sourceAnchor（快照/文件锚点）',
    ],
  },
}

const VERIFIABILITY = {
  canVerify: [
    '包内文件完整性（manifest.json#/files 逐文件 sha256 对照）',
    '一次判定的计算过程（证据链 + ruleHitLog + 审计项逐条对账）',
    '人审认定与运行的绑定关系（决定指纹与运行指纹一致性）',
    '数据映射校验结果（mappingReceipt 诊断与计数）',
  ],
  cannotVerify: [
    '本包完整性为同信任域自证（无平台签名）——离线验签属 P1b 路线图，不在本包承诺范围',
    '输入数据本身的真实性与及时性（数据层责任归数据提供方）',
    '定性结论（认定层责任归人审方；本包只含候选 + 证据链 + 人审提示）',
  ],
}

/** signed-delivery P1b：带平台签名的可验边界（信任根公钥离线验签）。 */
export const VERIFIABILITY_SIGNED = {
  canVerify: [
    '包来源（Ed25519 平台签名对照信任根公钥，离线验签）',
    '包内文件完整性（manifest.json#/files 逐文件 sha256 对照）',
    '一次判定的计算过程（证据链 + ruleHitLog + 审计项逐条对账）',
    '人审认定与运行的绑定关系（决定指纹与运行指纹一致性；人审决定随签名覆盖）',
    '数据映射校验结果（mappingReceipt 诊断与计数）',
  ],
  cannotVerify: [
    '输入数据本身的真实性与及时性（数据层责任归数据提供方）',
    '定性结论（认定层责任归人审方；本包只含候选 + 证据链 + 人审提示）',
    '签名时刻的权威时间戳（createdAt 为签发方自报；时间戳服务属路线图外）',
  ],
}

/** 审计包导出结果（全部 workspace 相对 locator）。 */
export interface AuditPackageExport {
  locator: string
  manifestLocator: string
  reportLocator: string
  chainLocator?: string
  archivedAt: string
  manifest: RunExportManifest
  /** 归档本体（人审面完整，含短语；模型面摘要另走脱敏闸）。 */
  archive: RunArchive
}

/**
 * 统一审计包（audit-package P1a）：run + 报表投影 + 治理链（可选）+ 包清单，
 * 一次写出 runs/exports/ 全套（覆盖幂等）。工具面与 wire 同调此函数——
 * 两个出口交付物逐字段同构。客户审计员脱离平台 UI 仅凭包内容复核一次判定。
 */
export function exportAuditPackage(
  root: string,
  runId: unknown,
  extras?: { chain?: unknown },
): AuditPackageExport {
  const id = requireSafeRunId(runId)
  const record = loadRunRecord(root, id)
  const dir = join(runsDir(root), RUNS_EXPORTS_DIR)
  assertInsideRoot(root, dir)
  mkdirSync(dir, { recursive: true })
  const rel = (name: string): string => `${RUNS_DIR}/${RUNS_EXPORTS_DIR}/${name}`
  const write = (name: string, body: unknown): { name: string; sha256: string; bytes: number } => {
    const text = `${JSON.stringify(body, null, 2)}\n`
    const bytes = Buffer.byteLength(text, 'utf8')
    writeFileSync(join(dir, name), text, 'utf8')
    return { name, sha256: createHash('sha256').update(text).digest('hex'), bytes }
  }

  const exportedAt = new Date().toISOString()
  const archive: RunArchive = { ...record, archivedAt: exportedAt }
  const report = buildRunReport(record)
  const members = [write(`${id}.json`, archive), write(`${id}-report.json`, report)]
  let chainLocator: string | undefined
  const chainFile = join(dir, `${id}-chain.json`)
  if (extras?.chain !== undefined) {
    members.push(write(`${id}-chain.json`, { runId: id, ...(extras.chain as object) }))
    chainLocator = rel(`${id}-chain.json`)
  } else if (existsSync(chainFile)) {
    // 无治理链数据源（CLI）：清掉上次导出的链文件——不留游离未登记成员（评审 gap-2）
    rmSync(chainFile, { force: true })
  }

  const manifest: RunExportManifest = {
    kind: 'RunExportManifest',
    runId: id,
    package: { name: record.package.name, version: record.package.version },
    scenarioId: record.scenarioId,
    exportedAt,
    files: members,
    fingerprints: {
      datasetDigest: record.datasetDigest,
      ...(record.inputDigest === undefined ? {} : { inputDigest: record.inputDigest }),
      ruleFingerprint: ruleBasisDigest(record),
      ...(record.mappingReceipt?.mapBasis?.sourceDigest === undefined
        ? {}
        : { mapSourceDigest: record.mappingReceipt.mapBasis.sourceDigest }),
      ...packageSourceDigestOf(root, record),
    },
    humanReviewRequired: true,
    responsibility: RESPONSIBILITY,
    verifiability: VERIFIABILITY,
  }
  // manifest 不自列（自证到成员为止）：files 只登记成员文件的指纹。
  write(`${id}-manifest.json`, manifest)

  return {
    locator: rel(`${id}.json`),
    manifestLocator: rel(`${id}-manifest.json`),
    reportLocator: rel(`${id}-report.json`),
    ...(chainLocator === undefined ? {} : { chainLocator }),
    archivedAt: exportedAt,
    manifest,
    archive,
  }
}

/** 包派生链指纹（版本目录可读时读 DerivedManifest.sourceDigest；否则缺省不落键）。 */
function packageSourceDigestOf(
  root: string,
  record: RunRecord,
): { packageSourceDigest?: string } {
  try {
    const dir = join(root, 'packages', record.package.name, record.package.version)
    const manifest = readManifest(dir)
    return manifest === null ? {} : { packageSourceDigest: manifest.sourceDigest }
  } catch {
    return {}
  }
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

/** 两轮运行记录 → 对比视图（报告面投影；缺席侧 null 不补 0）。 */
export function buildRunDiffView(a: RunRecord, b: RunRecord): RunDiffView {
  return diffViewOf(compareRunRecords(a, b))
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
