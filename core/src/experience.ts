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
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { findConclusionPhrases } from './llm.js'
import { isSafeRunId } from './runstore.js'
import { isInsideDir, PackageStoreError } from './store.js'
import type { DraftItem, OntologyPackage } from './types.js'

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

/* ───────────────────────── 结构检索（S5.1） ───────────────────────── */

export interface RetrievalHit {
  note: ExperienceNote
  score: number
  reasons: string[]
}

export interface RetrievalResult {
  hits: RetrievalHit[]
  /** 无命中（score < 阈值）→ 冷启动：全量执行、不类比、不硬迁移。 */
  coldStart: boolean
  /** digest 精确同构短路命中的经验（直接复用其 DiffTable，跳过差异修正）。 */
  digestMatch?: ExperienceNote
}

/** 集合 Jaccard 相似（双方皆空 = 1）。 */
function jaccard(a: readonly string[], b: readonly string[]): number {
  const A = new Set(a)
  const B = new Set(b)
  if (A.size === 0 && B.size === 0) return 1
  const inter = [...A].filter((x) => B.has(x)).length
  const union = new Set([...A, ...B]).size
  return union === 0 ? 1 : inter / union
}

function sameArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

/** 跨包参赛须在 externalRefs 声明（按包名匹配）；命中降权因子（初始值，验收时校准）。 */
const CROSS_SCOPE_FACTOR = 0.5

/**
 * 字段级 signature 新旧对照（P4-5）：命中理由不只 Jaccard——
 * 逐字段给出「同 / 源→新 / 集合增删」，结构位、可回指、无自由流程。
 * 与 buildDiffTable 同源比对口径；digest 同构时全字段为「同」。
 */
export function signatureFieldReasons(query: TaskSignature, source: TaskSignature): string[] {
  const out: string[] = []
  const eq = (label: string, a: string, b: string): void => {
    out.push(a === b ? `${label} 同（${a}）` : `${label} 源=${a} → 新=${b}`)
  }
  eq('scenarioId', source.scenarioId, query.scenarioId)
  eq('packageScope', source.packageScope, query.packageScope)
  eq('dataBand', source.dataBand, query.dataBand)
  if (query.stepShape === source.stepShape) {
    out.push('stepShape 同')
  } else {
    out.push(`stepShape 源≠新（源=${source.stepShape} → 新=${query.stepShape}）`)
  }
  if (query.goalClass === source.goalClass) {
    out.push('goalClass 同')
  } else {
    out.push(`goalClass 源=「${source.goalClass}」→ 新=「${query.goalClass}」`)
  }
  const rules = diffStrSets(query.ruleRefs, source.ruleRefs)
  out.push(
    `ruleRefs 共有${rules.shared.length}/新独有${rules.onlyQ.length}/源独有${rules.onlyS.length}`
      + (rules.onlyQ.length > 0 || rules.onlyS.length > 0
        ? `（新:${rules.onlyQ.join(',') || '—'} 源:${rules.onlyS.join(',') || '—'}）`
        : ''),
  )
  const skills = diffStrSets(query.skillRefs, source.skillRefs)
  out.push(
    `skillRefs 共有${skills.shared.length}/新独有${skills.onlyQ.length}/源独有${skills.onlyS.length}`
      + (skills.onlyQ.length > 0 || skills.onlyS.length > 0
        ? `（新:${skills.onlyQ.join(',') || '—'} 源:${skills.onlyS.join(',') || '—'}）`
        : ''),
  )
  if (sameStrArray(query.inputShape, source.inputShape)) {
    out.push(`inputShape 同（${query.inputShape.join(',') || '—'}）`)
  } else {
    out.push(`inputShape 源=[${source.inputShape.join(',') || '—'}] → 新=[${query.inputShape.join(',') || '—'}]`)
  }
  return out
}

/**
 * 结构检索：纯字段匹配（无向量）。打分（初始权重，验收时校准）：
 * 同 scenarioId +0.4｜stepShape 一致 +0.2｜ruleRefs∪skillRefs Jaccard +0.2×jac｜
 * inputShape 一致 +0.1｜dataBand 一致 +0.1；原始分 ≥ 阈值（默认 0.6）→ top-k 命中，
 * 否则冷启动。跨包（externalRefs 声明内）按原始分过阈，展示分 ×0.5 仅降权排序。
 * 命中 reasons 附字段级 signature 新旧对照（P4-5），不止 Jaccard 数字。
 */
export function retrieveSimilar(
  root: string,
  query: {
    signature: TaskSignature
    /** 查询方包的 externalRefs（跨包参赛声明）。 */
    externalRefs?: readonly string[]
  },
  opts?: { topK?: number; threshold?: number },
): RetrievalResult {
  const topK = opts?.topK ?? 3
  const threshold = opts?.threshold ?? 0.6
  const q = query.signature
  const qRules = [...new Set([...q.ruleRefs, ...q.skillRefs])].sort()
  const declared = (query.externalRefs ?? []).map((s) => String(s))

  const pool = listExperienceNotes(root).filter(
    (n) => !n.counterexample && n.misTransfer?.judged !== true,
  )

  // digest 精确同构短路（digest 含 packageScope，同构即同包，作用域检查隐含成立）
  const digestMatch = pool.find((n) => n.signature.digest === q.digest)
  if (digestMatch) {
    return {
      hits: [
        {
          note: digestMatch,
          score: 1,
          reasons: ['digest 同构', ...signatureFieldReasons(q, digestMatch.signature)],
        },
      ],
      coldStart: false,
      digestMatch,
    }
  }

  const hits: RetrievalHit[] = []
  for (const note of pool) {
    const s = note.signature
    const pkgName = s.packageScope.split('@')[0]
    const sameScope = s.packageScope === q.packageScope
    // 声明形态：裸包名 `med-safety` 或全量 `med-safety@1.0.0`（按包名匹配，spec S5.1）
    const declaredCross = !sameScope && declared.some((d) => d === pkgName || d === s.packageScope)
    if (!sameScope && !declaredCross) continue

    let score = 0
    const reasons: string[] = []
    if (s.scenarioId === q.scenarioId) {
      score += 0.4
      reasons.push('同 scenarioId')
    }
    if (s.stepShape === q.stepShape) {
      score += 0.2
      reasons.push('stepShape 一致')
    }
    const jac = jaccard(qRules, [...new Set([...s.ruleRefs, ...s.skillRefs])])
    if (jac > 0) {
      score += 0.2 * jac
      reasons.push(`规则/技能 Jaccard=${jac.toFixed(2)}`)
    }
    if (sameArray(s.inputShape, q.inputShape)) {
      score += 0.1
      reasons.push('inputShape 一致')
    }
    if (s.dataBand === q.dataBand) {
      score += 0.1
      reasons.push('dataBand 一致')
    }
    // 阈值按原始分判定；跨包展示分 ×0.5 仅影响排序（否则满分 0.5 永远过不了阈值）
    if (score >= threshold) {
      if (!sameScope) {
        score *= CROSS_SCOPE_FACTOR
        reasons.push(`跨包降权 ×${CROSS_SCOPE_FACTOR}`)
      }
      // P4-5：命中理由附字段级 signature 新旧对照（不止 Jaccard 数字）
      reasons.push(...signatureFieldReasons(q, s))
      hits.push({ note, score, reasons })
    }
  }

  hits.sort((a, b) =>
    a.score === b.score ? (a.note.runId < b.note.runId ? -1 : 1) : b.score - a.score,
  )
  const top = hits.slice(0, topK)
  return { hits: top, coldStart: top.length === 0 }
}

/* ───────────────────────── 差异表与差异修正（S4.2 / S5.2） ───────────────────────── */

function sameStrArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

function diffStrSets(q: readonly string[], s: readonly string[]): {
  shared: string[]
  onlyQ: string[]
  onlyS: string[]
} {
  const Q = new Set(q)
  const S = new Set(s)
  return {
    shared: [...Q].filter((x) => S.has(x)).sort(),
    onlyQ: [...Q].filter((x) => !S.has(x)).sort(),
    onlyS: [...S].filter((x) => !Q.has(x)).sort(),
  }
}

/**
 * 机械差异：签名字段逐项比对生成 DiffTable 初稿——不让模型干机器的活。
 * item 只指结构位；unknown 恒空（机械稿不猜）。
 */
export function buildDiffTable(query: TaskSignature, source: TaskSignature): DiffTable {
  const reusable: DiffTable['reusable'] = []
  const mustChange: DiffTable['mustChange'] = []

  if (query.scenarioId === source.scenarioId) {
    reusable.push({ item: 'scenarioId', note: '同场景' })
  } else {
    mustChange.push({ item: 'scenarioId', why: `源=${source.scenarioId} → 新=${query.scenarioId}` })
  }

  if (query.goalClass === source.goalClass) {
    reusable.push({ item: 'goalClass', note: '目标一致' })
  } else {
    mustChange.push({ item: 'goalClass', why: `源=「${source.goalClass}」→ 新=「${query.goalClass}」` })
  }

  if (query.stepShape === source.stepShape) {
    reusable.push({ item: 'stepShape', note: '步骤依赖同构' })
  } else {
    mustChange.push({ item: 'stepShape', why: `源=${source.stepShape} → 新=${query.stepShape}` })
  }

  const rules = diffStrSets(query.ruleRefs, source.ruleRefs)
  if (rules.shared.length > 0) {
    reusable.push({ item: 'ruleRefs', note: `共有 ${rules.shared.length} 条：${rules.shared.join(', ')}` })
  }
  if (rules.onlyQ.length > 0) {
    mustChange.push({ item: 'ruleRefs', why: `新任务独有（须纳入）：${rules.onlyQ.join(', ')}` })
  }
  if (rules.onlyS.length > 0) {
    mustChange.push({ item: 'ruleRefs', why: `源独有（不迁移）：${rules.onlyS.join(', ')}` })
  }

  const skills = diffStrSets(query.skillRefs, source.skillRefs)
  if (skills.shared.length > 0) {
    reusable.push({ item: 'skillRefs', note: `共有技能：${skills.shared.join(', ')}` })
  }
  if (skills.onlyQ.length > 0 || skills.onlyS.length > 0) {
    mustChange.push({
      item: 'skillRefs',
      why: `新=${skills.onlyQ.join(',') || '—'} / 源=${skills.onlyS.join(',') || '—'}`,
    })
  }

  if (sameStrArray(query.inputShape, source.inputShape)) {
    reusable.push({ item: 'inputShape', note: '输入形状一致' })
  } else {
    mustChange.push({ item: 'inputShape', why: `源=[${source.inputShape.join(',')}] → 新=[${query.inputShape.join(',')}]` })
  }

  if (query.dataBand === source.dataBand) {
    reusable.push({ item: 'dataBand', note: `规模档一致（${query.dataBand}）` })
  } else {
    mustChange.push({ item: 'dataBand', why: `源=${source.dataBand} → 新=${query.dataBand}` })
  }

  return { reusable, mustChange, unknown: [] }
}

export interface DiffRevision {
  diff: DiffTable
  /** 修正置信度 [0,1]；< 0.75 → 强制转人工（§5.2 人工闸）。 */
  confidence: number
  engine: 'llm' | 'heuristic'
}

/** 启发式修正（LLM 失败回落）：保守——reusable 空、mustChange=机械稿全量、unknown=其余。 */
export function heuristicRevise(draft: DiffTable): DiffRevision {
  return {
    diff: {
      reusable: [],
      mustChange: [...draft.mustChange],
      unknown: draft.reusable.map((r) => ({ item: r.item, risk: '启发式不背书，需人工确认' })),
    },
    confidence: 0.5,
    engine: 'heuristic',
  }
}

/** 差异修正用的最小 LLM 端口（只起草 DiffTable JSON；可由 DeepSeek 适配或测试桩实现）。 */
export interface DiffLlmPort {
  complete(prompt: string): Promise<string>
}

function isDiffTable(v: unknown): v is DiffTable {
  if (typeof v !== 'object' || v === null) return false
  const d = v as Record<string, unknown>
  const entry = (x: unknown, keys: string[]): boolean =>
    typeof x === 'object' && x !== null &&
    keys.every((k) => typeof (x as Record<string, unknown>)[k] === 'string')
  return (
    Array.isArray(d.reusable) && d.reusable.every((x) => entry(x, ['item', 'note'])) &&
    Array.isArray(d.mustChange) && d.mustChange.every((x) => entry(x, ['item', 'why'])) &&
    Array.isArray(d.unknown) && d.unknown.every((x) => entry(x, ['item', 'risk']))
  )
}

function clamp01(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5
}

/**
 * 差异修正（双路）：LLM 只修差异、只起草 DiffTable（禁打分/禁认定/禁编造引用）；
 * 失败或输出非法 → 启发式保守回落。返回实际引擎。
 */
export async function reviseDiff(
  llm: DiffLlmPort | null,
  input: { query: TaskSignature; source: TaskSignature; draft: DiffTable },
): Promise<DiffRevision> {
  if (!llm) return heuristicRevise(input.draft)
  const prompt = [
    '你是经验差异修正助手。只起草 DiffTable JSON，不做规则判定，不输出认定。',
    '只输出一个 JSON 对象，不要 markdown 代码块、不要解释文字。',
    '格式：{"reusable":[{"item":"...","note":"..."}],"mustChange":[{"item":"...","why":"..."}],"unknown":[{"item":"...","risk":"..."}],"confidence":0到1的数字}',
    'item 只允许指到结构位：特征名、OBJ.attr 引用、ruleId、skillId、reviewFocus 条目；不接受自由流程步骤（pipeline 由场景卡锁死）。',
    '拿不准就放 unknown；宁可少报不要乱报。',
    `新任务签名：${JSON.stringify(input.query)}`,
    `源经验签名：${JSON.stringify(input.source)}`,
    `机械差异初稿：${JSON.stringify(input.draft)}`,
  ].join('\n')
  try {
    const text = await llm.complete(prompt)
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) return heuristicRevise(input.draft)
    const parsed = JSON.parse(text.slice(start, end + 1)) as { confidence?: unknown }
    if (!isDiffTable(parsed)) return heuristicRevise(input.draft)
    return {
      diff: { reusable: parsed.reusable, mustChange: parsed.mustChange, unknown: parsed.unknown },
      confidence: clamp01(parsed.confidence),
      engine: 'llm',
    }
  } catch {
    return heuristicRevise(input.draft)
  }
}

/** 人工闸：unknown 非空或置信度 < 0.75 → 强制转人工（执行走冷启动保守路径）。 */
export function requiresHumanReview(rev: DiffRevision): boolean {
  return rev.diff.unknown.length > 0 || rev.confidence < 0.75
}

/** unknown 条目列入本轮 reviewFocus（§5.2 人工闸）。 */
export function reviewFocusFrom(rev: DiffRevision): string[] {
  return rev.diff.unknown.map((u) => u.item)
}

/* ───────────────────────── 抽象巩固（S6，P3-1） ───────────────────────── */

export interface SkillAbstraction {
  /** 聚簇键：packageScope + stepShape。 */
  clusterKey: string
  signature: TaskSignature
  memberRunIds: string[]
  /** 待入草案队列的 SkillTemplate 草案（含 weights 对齐包内规则；provenance.runId = 代表轨迹）。 */
  draft: DraftItem
}

/**
 * 自动技能抽象（S6）：成功且非反例、未判误迁移的经验按 packageScope+stepShape 聚簇；
 * 簇员 ≥ minCluster（默认 2）→ 产出 SkillTemplate 草案（weights 对齐包内打分规则，
 * steps 含 reviewFocus 沉淀）。草案只入队列（pending），物化必经人审——自动化止步于草案。
 */
export function abstractSkillDrafts(
  root: string,
  input: { pkg: OntologyPackage; minCluster?: number },
): SkillAbstraction[] {
  const { pkg } = input
  const minCluster = input.minCluster ?? 2
  const scope = `${pkg.meta.name}@${pkg.meta.version}`
  const pool = listExperienceNotes(root).filter(
    (n) =>
      n.signature.packageScope === scope &&
      n.outcome === 'success' &&
      !n.counterexample &&
      n.misTransfer?.judged !== true,
  )
  const clusters = new Map<string, ExperienceNote[]>()
  for (const n of pool) {
    const key = `${n.signature.packageScope}|${n.signature.stepShape}`
    const arr = clusters.get(key) ?? []
    arr.push(n)
    clusters.set(key, arr)
  }
  const out: SkillAbstraction[] = []
  for (const [clusterKey, members] of clusters) {
    if (members.length < minCluster) continue
    // 代表轨迹 = 最新一条（签名与簇一致）
    const rep = [...members].sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1))[0]
    const scenario = pkg.scenarios.find((s) => s.id === rep.signature.scenarioId)
    const slug = rep.signature.scenarioId.replace(/^SCN-[A-Z0-9]+-/, '') || 'EXP'
    const domainTag = pkg.meta.domain || 'EXP'
    const focus = [...new Set(members.flatMap((m) => m.reviewFocus ?? []))]
    const weights: Record<string, number> = {}
    for (const r of pkg.scoreRules) weights[r.id] = r.weight
    const draft: DraftItem = {
      layer: 'O2',
      targetKind: 'SkillTemplate',
      name: `${scenario?.name ?? rep.signature.scenarioId}经验模板`,
      payload: {
        id: `SKL-${domainTag}-EXP-${slug}`,
        weights,
        steps: ['候选 {candidateId}', ...focus],
        outputTemplate: '摘要：{riskScore}',
      },
      confidence: 0.8,
      rationale: `经验闭环抽象：${members.length} 条成功轨迹（${members.map((m) => m.runId).join(', ')}）`,
    }
    out.push({ clusterKey, signature: rep.signature, memberRunIds: members.map((m) => m.runId), draft })
  }
  return out
}

export interface CounterAbstraction {
  clusterKey: string
  memberRunIds: string[]
  draft: DraftItem
}

/**
 * 反例利用（S6，P3-2）：counterexample 经验按 packageScope+stepShape 聚簇；
 * 簇员 ≥ minCluster → 草案——outcomeReason 含结论性表述 → RedLine（只落红线），
 * 否则 → ExclusionRule（downweight，条件待人审细化）。confidence 0.7 < 0.75 → 强制人审。
 */
export function abstractCounterexampleDrafts(
  root: string,
  input: { pkg: OntologyPackage; minCluster?: number },
): CounterAbstraction[] {
  const { pkg } = input
  const minCluster = input.minCluster ?? 2
  const scope = `${pkg.meta.name}@${pkg.meta.version}`
  const pool = listExperienceNotes(root).filter(
    (n) =>
      n.signature.packageScope === scope &&
      n.counterexample &&
      n.misTransfer?.judged !== true,
  )
  const clusters = new Map<string, ExperienceNote[]>()
  for (const n of pool) {
    const key = `${n.signature.packageScope}|${n.signature.stepShape}`
    const arr = clusters.get(key) ?? []
    arr.push(n)
    clusters.set(key, arr)
  }
  const out: CounterAbstraction[] = []
  for (const [clusterKey, members] of clusters) {
    if (members.length < minCluster) continue
    const rep = [...members].sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1))[0]
    const runList = members.map((m) => m.runId).join(', ')
    const texts = members.map((m) => m.outcomeReason ?? '').join(' ')
    const phrases = [...new Set(findConclusionPhrases(texts))]
    let draft: DraftItem
    if (phrases.length > 0) {
      draft = {
        layer: 'O3',
        targetKind: 'RedLine',
        name: `反例红线:${phrases[0]}`,
        payload: { scenarioId: rep.signature.scenarioId, phrases },
        confidence: 0.7,
        rationale: `经验反例红线：${members.length} 条（${runList}）`,
      }
    } else {
      const focus = [...new Set(members.flatMap((m) => m.reviewFocus ?? []))]
      const scenario = pkg.scenarios.find((s) => s.id === rep.signature.scenarioId)
      draft = {
        layer: 'O2',
        targetKind: 'ExclusionRule',
        name: `${scenario?.name ?? rep.signature.scenarioId}反例排除`,
        payload: {
          action: 'downweight',
          factor: 0.5,
          condition: focus.length > 0 ? `tag == '${focus[0]}'` : "tag == 'exp-counter'",
          description: `经验反例：${members.length} 条（${runList}）；条件待人审细化`,
        },
        confidence: 0.7,
        rationale: `经验反例排除：${members.length} 条（${runList}）`,
      }
    }
    out.push({ clusterKey, memberRunIds: members.map((m) => m.runId), draft })
  }
  return out
}

/* ───────────────────────── 压缩/遗忘（S6，P3-3） ───────────────────────── */

export interface CompressionReport {
  total: number
  kept: number
  archived: number
  /** archived / total——压缩比指标（§S7）。 */
  compressionRatio: number
  tiers: { counter: number; referenced: number; reuseEvidence: number; fresh: number; stale: number }
  archivedRunIds: string[]
}

/**
 * 记忆压缩/遗忘（S6）：按 outcome 与引用关系分层——
 * 反例留警示｜被复用过（他人的 reusedFrom 指向）留高价值｜自身有 reusedFrom 留复用证据｜
 * 新鲜（< retainDays）留｜其余陈旧未引用 → 归档到 experiences/archive/（不硬删）。
 * 默认 dryRun（apply=false 只出报告）；retainDays 初始值 90，验收时校准。
 */
export function compressExperiences(
  root: string,
  opts?: { retainDays?: number; apply?: boolean },
): CompressionReport {
  const retainDays = opts?.retainDays ?? 90
  const apply = opts?.apply === true
  const notes = listExperienceNotes(root)
  const referenced = new Set(notes.map((n) => n.reusedFrom?.runId).filter((x): x is string => !!x))
  const now = Date.now()
  const tiers = { counter: 0, referenced: 0, reuseEvidence: 0, fresh: 0, stale: 0 }
  const archivedRunIds: string[] = []
  let kept = 0
  for (const n of notes) {
    const ageDays = (now - Date.parse(n.savedAt)) / 86_400_000
    if (n.counterexample) {
      tiers.counter++
      kept++
      continue
    }
    if (referenced.has(n.runId)) {
      tiers.referenced++
      kept++
      continue
    }
    if (n.reusedFrom) {
      tiers.reuseEvidence++
      kept++
      continue
    }
    if (ageDays < retainDays) {
      tiers.fresh++
      kept++
      continue
    }
    tiers.stale++
    archivedRunIds.push(n.runId)
  }
  if (apply && archivedRunIds.length > 0) {
    const dir = experiencesDir(root)
    const archiveDir = join(dir, 'archive')
    mkdirSync(archiveDir, { recursive: true })
    for (const runId of archivedRunIds) {
      const src = join(dir, `${runId}.json`)
      if (existsSync(src)) {
        writeFileSync(join(archiveDir, `${runId}.json`), readFileSync(src, 'utf8'), 'utf8')
        rmSync(src)
      }
    }
  }
  const total = notes.length
  return {
    total,
    kept,
    archived: archivedRunIds.length,
    compressionRatio: total === 0 ? 0 : archivedRunIds.length / total,
    tiers,
    archivedRunIds,
  }
}

/* ───────────────────────── 人审回填（S5.4） ───────────────────────── */

/**
 * 人审回填：pending-human 改判、误迁移只由人判（by 必须非空人工身份）、reviewFocus 沉淀。
 * 禁改 signature / runId（不在 patch 面）；认定在人工——人工可覆盖 outcome（机器闸不否决人审）。
 * reusedFromRunId：补写复用归因（S5.4.4），diff 按当前 signature 机械生成。
 */
export function reviewExperienceNote(
  root: string,
  runId: unknown,
  patch: {
    outcome?: ExperienceOutcome
    outcomeReason?: string
    misTransfer?: { judged: boolean; by: string; note?: string }
    reviewFocus?: string[]
    reusedFromRunId?: string
  },
): ExperienceNote {
  const note = loadExperienceNote(root, runId)
  if (patch.outcome !== undefined) {
    if (!['success', 'partial', 'failure', 'pending-human'].includes(patch.outcome)) {
      throw new PackageStoreError('INVALID_ARGS', 'invalid outcome')
    }
    note.outcome = patch.outcome
  }
  if (patch.outcomeReason !== undefined) {
    if (typeof patch.outcomeReason !== 'string') {
      throw new PackageStoreError('INVALID_ARGS', 'invalid outcomeReason')
    }
    note.outcomeReason = patch.outcomeReason
  }
  if (patch.misTransfer !== undefined) {
    const m = patch.misTransfer
    if (typeof m.judged !== 'boolean') {
      throw new PackageStoreError('INVALID_ARGS', 'misTransfer.judged must be boolean')
    }
    if (typeof m.by !== 'string' || m.by.trim() === '') {
      throw new PackageStoreError('INVALID_ARGS', 'misTransfer.by must be a human identity')
    }
    note.misTransfer = { judged: m.judged, by: m.by.trim(), note: typeof m.note === 'string' ? m.note : '' }
  }
  if (patch.reviewFocus !== undefined) {
    if (!Array.isArray(patch.reviewFocus) || patch.reviewFocus.some((s) => typeof s !== 'string')) {
      throw new PackageStoreError('INVALID_ARGS', 'invalid reviewFocus')
    }
    note.reviewFocus = [...patch.reviewFocus]
  }
  if (patch.reusedFromRunId !== undefined) {
    const src = loadExperienceNote(root, patch.reusedFromRunId)
    note.reusedFrom = {
      runId: patch.reusedFromRunId,
      diff: buildDiffTable(note.signature, src.signature),
    }
  }
  note.savedAt = new Date().toISOString()
  saveExperienceNote(root, note)
  return note
}
