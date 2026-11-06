/**
 * 经验闭环（experience-loop）：任务结构签名与经验记录（spec experience-loop S4）。
 *
 * 签名不是任务描述文本，而是 O1/O2/O3 引用的结构摘要——类比按它召回，
 * 它同时就是适用边界（签名不匹配的域不迁移）。全部字段从 OntologyPackage +
 * datasetSummary 机械导出，无自由文本、无 embedding。
 *
 * RunRecord 管「发生了什么」（runstore，人审面留痕）；ExperienceNote 管
 * 「经验学到了什么」（学习层标注）。分开存（runs/ vs experiences/），互不覆盖。
 * @module @dsh-onto/core/experience
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { isSafeRunId } from './runstore.js'
import { isInsideDir, PackageStoreError } from './store.js'
import type { OntologyPackage } from './types.js'

export const EXPERIENCES_DIR = 'experiences'

export interface TaskSignature {
  scenarioId: string
  /** <name>@<version>；跨包参赛须在 externalRefs 声明。 */
  packageScope: string
  /** scenario.goal 归一（trim，取场景卡原文，不自由发挥）。 */
  goalClass: string
  /** pipeline 规范串：DATA_INGEST>BEHAVIOR_CALL>RULE_EVALUATE(before-scoring)>… */
  stepShape: string
  /** scoreRefs/exclusionRefs/全量（排序去重）。 */
  ruleRefs: string[]
  /** pipeline skillRefs 并集（排序去重）。 */
  skillRefs: string[]
  /** inputs 的 `name:type` 排序串。 */
  inputShape: string[]
  /** datasetSummary.candidates 分档（S<50，M<500，L 其余）。 */
  dataBand: 'S' | 'M' | 'L'
  /** sha256(canonicalJson(以上字段))——精确同构判定。 */
  digest: string
}

/** 键序稳定的规范 JSON（同 runstore 口径：对象键递归排序；数组保序）。 */
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

/** 候选数分档（初始值，验收时校准）。 */
export function dataBandOf(candidates: number): 'S' | 'M' | 'L' {
  if (candidates < 50) return 'S'
  if (candidates < 500) return 'M'
  return 'L'
}

export function buildTaskSignature(input: {
  pkg: OntologyPackage
  scenarioId: string
  datasetSummary: { objects: number; relations: number; behaviors: number; candidates: number }
}): TaskSignature {
  const { pkg, scenarioId, datasetSummary } = input
  const scenario = pkg.scenarios.find((s) => s.id === scenarioId)
  if (!scenario) {
    throw new PackageStoreError('NOT_FOUND', `scenario not found: ${scenarioId}`)
  }
  const stepShape = scenario.pipeline
    .map((s) => (s.order ? `${s.stepType}(before-scoring)` : s.stepType))
    .join('>')
  const scoreRefs = scenario.scoreRefs ?? pkg.scoreRules.map((r) => r.id)
  const exclusionRefs = scenario.exclusionRefs ?? pkg.exclusionRules.map((r) => r.id)
  const ruleRefs = [...new Set([...scoreRefs, ...exclusionRefs])].sort()
  const skillRefs = [...new Set(scenario.pipeline.flatMap((s) => s.skillRefs ?? []))].sort()
  const inputShape = scenario.inputs.map((i) => `${i.name}:${i.type}`).sort()
  const core = {
    scenarioId,
    packageScope: `${pkg.meta.name}@${pkg.meta.version}`,
    goalClass: scenario.goal.trim(),
    stepShape,
    ruleRefs,
    skillRefs,
    inputShape,
    dataBand: dataBandOf(datasetSummary.candidates),
  }
  return { ...core, digest: createHash('sha256').update(canonicalJson(core)).digest('hex') }
}

/* ───────────────────────── 差异表（S4.2，类型先行；生成逻辑 P1-4） ───────────────────────── */

/** 类比的产物是差异表，不是新流程。item 只允许指到结构位（特征/OBJ.attr/ruleId/skillId/reviewFocus）。 */
export interface DiffTable {
  reusable: Array<{ item: string; note: string }>
  mustChange: Array<{ item: string; why: string }>
  unknown: Array<{ item: string; risk: string }>
}

/* ───────────────────────── 经验记录（S4.3） ───────────────────────── */

export type ExperienceOutcome = 'success' | 'partial' | 'failure' | 'pending-human'

export interface ExperienceNote {
  /** 关联 workspace/runs/<runId>.json。 */
  runId: string
  signature: TaskSignature
  outcome: ExperienceOutcome
  outcomeReason?: string
  skillRefsUsed: string[]
  /** 本轮复用自哪条经验、差异是什么。 */
  reusedFrom?: { runId: string; diff: DiffTable }
  /** 反例：类比不参赛，只作警示。 */
  counterexample: boolean
  /** 误迁移只由人判，模型不自评。 */
  misTransfer?: { judged: boolean; by: string; note: string }
  /** 上轮 pendingChecks/人审修正的沉淀（下轮检索提示）。 */
  reviewFocus?: string[]
  savedAt: string
}

function requireSafeRunId(runId: unknown): string {
  if (!isSafeRunId(runId)) {
    throw new PackageStoreError('INVALID_ARGS', 'invalid runId')
  }
  return runId
}

/** experiences/ 目录（workspace 根之下；与 runs/ 同族，不进包目录）。 */
export function experiencesDir(root: string): string {
  return join(root, EXPERIENCES_DIR)
}

function notePath(root: string, runId: unknown): string {
  return join(experiencesDir(root), `${requireSafeRunId(runId)}.json`)
}

/** 轻形状校验：加载器验形（损坏记录 fail-loud，不裸抛 TypeError）。 */
function isExperienceNote(value: unknown): value is ExperienceNote {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  const sig = v.signature as Record<string, unknown> | undefined
  const reused = v.reusedFrom as Record<string, unknown> | undefined
  const mis = v.misTransfer as Record<string, unknown> | undefined
  return (
    typeof v.runId === 'string' &&
    typeof v.savedAt === 'string' &&
    typeof v.counterexample === 'boolean' &&
    Array.isArray(v.skillRefsUsed) &&
    v.skillRefsUsed.every((s) => typeof s === 'string') &&
    (v.outcome === 'success' ||
      v.outcome === 'partial' ||
      v.outcome === 'failure' ||
      v.outcome === 'pending-human') &&
    typeof sig === 'object' &&
    sig !== null &&
    typeof sig.digest === 'string' &&
    typeof sig.scenarioId === 'string' &&
    (v.outcomeReason === undefined || typeof v.outcomeReason === 'string') &&
    (v.reviewFocus === undefined ||
      (Array.isArray(v.reviewFocus) && v.reviewFocus.every((s) => typeof s === 'string'))) &&
    (reused === undefined ||
      (typeof reused === 'object' && reused !== null && typeof reused.runId === 'string')) &&
    (mis === undefined ||
      (typeof mis === 'object' && mis !== null && typeof mis.judged === 'boolean'))
  )
}

/** 落盘经验记录（同 runId 覆盖）。返回文件绝对路径（服务端内部用，勿回显模型面）。 */
export function saveExperienceNote(root: string, note: ExperienceNote): string {
  requireSafeRunId(note.runId)
  const dir = experiencesDir(root)
  if (!isInsideDir(root, dir)) {
    throw new PackageStoreError('INVALID_ARGS', 'invalid experience path')
  }
  mkdirSync(dir, { recursive: true })
  const file = notePath(root, note.runId)
  writeFileSync(file, `${JSON.stringify(note, null, 2)}\n`, 'utf8')
  return file
}

/** 读取经验记录。非法 runId → INVALID_ARGS；缺失 → NOT_FOUND；损坏 → PACKAGE_MALFORMED。 */
export function loadExperienceNote(root: string, runId: unknown): ExperienceNote {
  const file = notePath(root, runId)
  if (!existsSync(file)) {
    throw new PackageStoreError('NOT_FOUND', `experience ${String(runId)} not found`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new PackageStoreError('PACKAGE_MALFORMED', `experience ${String(runId)} note is corrupt`)
  }
  if (!isExperienceNote(parsed)) {
    throw new PackageStoreError('PACKAGE_MALFORMED', `experience ${String(runId)} note is corrupt`)
  }
  return parsed
}

/** 列出全部经验记录（savedAt 降序，同刻按 runId 升序保确定性）；损坏条目跳过。 */
export function listExperienceNotes(root: string): ExperienceNote[] {
  const dir = experiencesDir(root)
  if (!existsSync(dir)) return []
  const out: ExperienceNote[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const file = join(dir, name)
    if (!statSync(file).isFile()) continue
    try {
      out.push(loadExperienceNote(root, name.slice(0, -'.json'.length)))
    } catch {
      /* skip malformed entries — 显式 load 仍 fail-loud */
    }
  }
  return out.sort((a, b) =>
    a.savedAt === b.savedAt ? (a.runId < b.runId ? -1 : 1) : a.savedAt > b.savedAt ? -1 : 1,
  )
}
