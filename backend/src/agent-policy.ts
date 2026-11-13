/**
 * 工具面策略层：模型面出口口径的唯一裁决点（tool-face-policy P2.2 / P2.4）。
 *
 * - 禁语双面执行：value 闸（enforceOutputPolicy）+ render 闸（renderRunText），
 *   短语清单双源（命中 ∪ 场景红线）经 runId 注册表从 execute 带到 render；
 * - 错误信封：受控错误透传机器码与业务语义，原生 fs/系统错误只留机器码；
 * - 输出契约断言：装配期逐字段验形，畸形产出落受控错误（I5）。
 * core/wire 人审面不经过本模块。
 * @module @dsh-onto/backend/agent-policy
 */
import {
  buildDiffTable,
  requiresHumanReview,
  reviseDiff,
  type DiffLlmPort,
  type RunDiff,
  type ScenarioRunResult,
  type TaskSignature,
} from '@dsh-onto/core'

/* ───────────────────────── 错误面（P2.4） ───────────────────────── */

/** 工具层错误；message 直接面向模型，code 供测试与断言。 */
export class AgentToolError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'AgentToolError'
    this.code = code
  }
}

/** 服务端目录清单：错误 message 经此处剥除（含全部 versionDir/dataDir 派生路径）。 */
const serverDirs: string[] = []

/** 注册服务端目录（apply 时传 dataDir；工具错误不再回显其中任何路径）。 */
export function registerServerDir(dir: string): void {
  if (dir !== '' && !serverDirs.includes(dir)) serverDirs.push(dir)
}

function scrub(message: string, extraRedact: readonly string[]): string {
  let msg = message
  for (const d of [...serverDirs, ...extraRedact]) {
    if (d === '') continue
    const esc = d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    msg = msg.replace(new RegExp(esc, 'gi'), '<pkg>')
  }
  return msg
}

/** 原生 fs/SystemError（errno/syscall 或 errno 词形码）：原文含绝对路径，一律只留机器码（I2）。 */
function isSystemError(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  if ('errno' in e || 'syscall' in e) return true
  const code = (e as { code?: unknown }).code
  // errno 词形（ENOENT/EACCES/…）：全大写无下划线；受控码均为 SCREAMING_SNAKE 带下划线。
  return typeof code === 'string' && /^[A-Z]+$/.test(code)
}

function errorCode(e: unknown, fallback: string): string {
  return e instanceof Error && 'code' in e && typeof (e as { code?: unknown }).code === 'string'
    ? (e as { code: string }).code
    : fallback
}

/**
 * 错误 message 含任一短语 → 整段退避（保留机器码；I1 错误载体）。
 * 不做子串手术（P2.2：嵌套/重组残片无法证明完备）——与 render 拼接后兜底同口径。
 */
export function retreatPhraseEcho(message: string, phrases: readonly string[]): string {
  const list = phrases.filter((p) => typeof p === 'string' && p !== '')
  if (list.length === 0) return message
  if (list.some((p) => message.includes(p))) {
    return '错误消息含禁语，已整段脱敏'
  }
  return message
}

/**
 * 错误信封：任何出口不得裸抛。
 * - 原生 fs/系统错误 → 只留机器码（`工具执行失败（ENOENT）`），原文不入模型面；
 * - 受控/业务错误 → 保留机器码与 message（剥服务端目录 + 禁语整段退避）；
 * - 其余 → RUN_FAILED + 受控短消息。
 */
export function asToolError(
  e: unknown,
  extraRedact: readonly string[] = [],
  phrases: readonly string[] = [],
): AgentToolError {
  if (isSystemError(e)) {
    const code = errorCode(e, 'UNKNOWN_ERROR')
    return new AgentToolError(code, `工具执行失败（${code}）`)
  }
  const code = errorCode(e, 'RUN_FAILED')
  const raw = e instanceof Error ? e.message : String(e)
  return new AgentToolError(code, retreatPhraseEcho(scrub(raw, extraRedact), phrases))
}

/**
 * execute 统一信封：体内任何抛出经 asToolError 收口后重抛。
 * `phrases` 可为清单或按 args 惰性取值的 getter（仅 catch 时求值）——
 * 入参回显（objectRef/candidateId…）含红线短语时错误面整段退避（I1）。
 */
export function toolExecute<A, R>(
  fn: (args: A) => R | Promise<R>,
  extraRedact: readonly string[] = [],
  phrases: readonly string[] | ((args: A) => readonly string[]) = [],
): (args: A) => Promise<R> {
  return async (args: A): Promise<R> => {
    try {
      return await fn(args)
    } catch (e) {
      const list = typeof phrases === 'function' ? phrases(args) : phrases
      throw asToolError(e, extraRedact, list)
    }
  }
}

/* ───────────────────────── 禁语面（P2.2） ───────────────────────── */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 短语清单双源：命中 ∪ 场景红线（execute 一次取定；只取命中会漏模板字面碰撞）。 */
export function collectPhrases(result: ScenarioRunResult, extra: readonly string[] = []): string[] {
  const hits = (result.audit?.forbiddenPhraseHits ?? []).map((h) => h.phrase)
  return [...new Set([...hits, ...extra].filter((p) => typeof p === 'string' && p !== ''))]
}

/** execute→render 清单注册表（value 被快照克隆且 phrase 已空化，无法从 value 反推）。 */
const phraseRegistry = new Map<string, string[]>()
const PHRASE_REGISTRY_MAX = 256

/**
 * 持久后端（spec run-insight S2.1，关 backlog #2）：RunRecord.redlines 是清单的落盘面，
 * rememberPhrases 写内存；recallPhrases 内存未命中介后端回读（跨进程/跨会话 render 仍遮蔽）。
 * 清单仅用于遮蔽，永不随渲染文本出模型面。未配置时行为不变（纯函数测试路径）。
 */
export type PhraseRecall = (runId: string) => readonly string[] | undefined
let phraseRecall: PhraseRecall | null = null

export function configurePhraseStore(recall: PhraseRecall | null): void {
  phraseRecall = recall
  phraseRegistry.clear()
}

export function rememberPhrases(runId: string, phrases: readonly string[]): void {
  if (typeof runId !== 'string' || runId === '') return
  if (phraseRegistry.size >= PHRASE_REGISTRY_MAX) {
    const oldest = phraseRegistry.keys().next().value
    if (oldest !== undefined) phraseRegistry.delete(oldest)
  }
  phraseRegistry.set(runId, [...phrases])
}

export function recallPhrases(runId: string): string[] | undefined {
  const hit = phraseRegistry.get(runId)
  if (hit !== undefined) return hit
  const loaded = phraseRecall?.(runId)
  return loaded === undefined ? undefined : [...new Set(loaded.filter((p) => typeof p === 'string' && p !== ''))]
}

/* ───────────────────────── E2-2：top-1 差异修正接生产（reviseDiff 双路 + 转人工闸） ───────────────────────── */

/** 差异修正 LLM 端口（默认 null → heuristic 离线腿；configureDiffLlm 可注入以启用 LLM 腿）。 */
let diffLlm: DiffLlmPort | null = null

export function configureDiffLlm(port: DiffLlmPort | null): void {
  diffLlm = port
}

/** recall/invoke top-1 修正回执（结构位：引擎/置信度/人工闸/差异项）。 */
export interface TopHitRevision {
  advice: string
  revision: {
    engine: 'llm' | 'heuristic' | 'digest'
    confidence: number
    humanGate: boolean
    mustChange: string[]
    unknown: string[]
  }
}

/**
 * top-1 差异修正 + 转人工闸（E2-2，spec experience-loop S5.1/S5.2）：
 * - digest 同构 → 短路跳过修正（S5.1），advice 直接可参考复用；
 * - 否则 buildDiffTable 初稿 → reviseDiff 双路（LLM 腿可注入，失败/缺省回落 heuristic）
 *   → requiresHumanReview 闸（unknown 非空或置信度 <0.75 → 转人工）；
 * - advice 携带 engine/confidence 结构位；unknown/mustChange 回执供测试与人审定位。
 * 经验只提示不改分——本函数不触碰打分语义。
 */
export async function reviseTopHitAdvice(
  query: TaskSignature,
  source: TaskSignature,
): Promise<TopHitRevision> {
  if (query.digest === source.digest) {
    return {
      advice: '结构同构可参考复用（digest 同构短路跳过差异修正；仍须过验证闸门，humanReviewRequired=true）',
      revision: { engine: 'digest', confidence: 1, humanGate: false, mustChange: [], unknown: [] },
    }
  }
  const draft = buildDiffTable(query, source)
  const rev = await reviseDiff(diffLlm, { query, source, draft })
  const humanGate = requiresHumanReview(rev)
  const mustChange = rev.diff.mustChange.map((m) => m.item)
  const unknown = rev.diff.unknown.map((u) => u.item)
  const conf = rev.confidence.toFixed(2)
  const parts: string[] = []
  if (mustChange.length > 0) parts.push(`结构位差异（${mustChange.join(', ')}）`)
  if (unknown.length > 0) parts.push(`待确认（${unknown.join(', ')}）`)
  const detail = parts.length > 0 ? `${parts.join('；')} → ` : ''
  const advice = humanGate
    ? `低置信度：${detail}转人工确认后方可复用（engine=${rev.engine}, confidence=${conf}）`
    : `修正后可参考复用${mustChange.length > 0 ? `（需按差异表调整：${mustChange.join(', ')}）` : ''}`
      + `（engine=${rev.engine}, confidence=${conf}；仍须过验证闸门，humanReviewRequired=true）`
  return {
    advice,
    revision: { engine: rev.engine, confidence: rev.confidence, humanGate, mustChange, unknown },
  }
}

/** 脱敏占位标记候选（首选用「禁语已脱敏」，与既有测试/文案一致）。 */
const MASK_TOKENS = ['【禁语已脱敏】', '【已屏蔽】', '【内容已隐藏】'] as const

/** 选首枚不含任何短语的标记——防「短语 ⊂ 标记」时标记自嵌泄漏（P2.2）。 */
function pickMaskToken(phrases: readonly string[]): string {
  for (const m of MASK_TOKENS) {
    if (!phrases.some((p) => m.includes(p))) return m
  }
  return ''
}

/** 短语非空即必须有可用标记；全冲突（病态构造）fail-loud，不带短语回显。 */
function requireMaskToken(phrases: readonly string[]): string {
  const token = pickMaskToken(phrases)
  if (token === '') {
    throw new AgentToolError('INVALID_TOOL_OUTPUT', '输出契约失败: 禁语短语与脱敏标记冲突')
  }
  return token
}

/**
 * ID 回指面：tool 层不改写命中（S2.3「每一分回指 ruleId 由 core 保证，工具层不改写」）。
 * 短语若撞进 ID 面（禁语 ⊂ ID 的构造形态），「不改写」与「零容忍」不可兼得——
 * fail-loud 拒绝产出（错误消息不回显短语），而非静默改写 ID 或放行短语。
 */
const ID_FACE_KEYS: ReadonlySet<string> = new Set([
  'id',
  'ruleId',
  'hitRuleIds',
  'objectRef',
  'candidateId',
  'runId',
  'runIdA',
  'runIdB',
  'scenarioId',
  'scenarioA',
  'scenarioB',
  'check',
  'missing',
  'requireReviewFor',
  'startedAt',
  'ts',
])

/**
 * value 闸（tool-face-policy P2.2）：整字段重遮 + ID 面 fail-loud + 断言闸门。
 * walk 带 copy-on-write：无变化返回同引用——幂等是结构性的，不依赖清单为空。
 * `phrase` 字段空化兼幂等锚点；core/wire 人审面不经过本函数。
 */
export function enforceOutputPolicy<T>(
  result: T,
  phrases?: readonly string[],
): T {
  const list = phrases !== undefined
    ? [...new Set(phrases.filter((p) => p !== ''))]
    : collectPhrases(result as unknown as ScenarioRunResult)
  if (list.length === 0) return result
  const token = requireMaskToken(list)
  const walk = (v: unknown, key: string): unknown => {
    if (typeof v === 'string') {
      if (key === 'phrase') return v === '' ? v : '' // hits[].phrase 不回显短语本体
      if (ID_FACE_KEYS.has(key)) {
        if (list.some((p) => v.includes(p))) {
          throw new AgentToolError('INVALID_TOOL_OUTPUT', `输出契约失败: 禁语短语与 ID 回指字段冲突（${key}）`)
        }
        return v
      }
      return list.some((p) => v.includes(p)) ? token : v
    }
    if (Array.isArray(v)) {
      let changed = false
      const out = v.map((x) => {
        const w = walk(x, key)
        if (w !== x) changed = true
        return w
      })
      return changed ? out : v
    }
    if (isRecord(v)) {
      let changed = false
      const out: Record<string, unknown> = {}
      for (const [k, item] of Object.entries(v)) {
        const w = walk(item, k)
        if (w !== item) changed = true
        out[k] = w
      }
      return changed ? out : v
    }
    return v
  }
  const out = walk(result, '') as T
  assertNoForbiddenPhrases(out, list)
  return out
}

/** 断言闸门（I1）：模型面任何字符串不得含禁语短语；违规受控失败，错误不回显短语。 */
export function assertNoForbiddenPhrases(value: unknown, phrases: readonly string[]): void {
  const real = phrases.filter((p) => p !== '')
  if (real.length === 0) return
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      if (real.some((p) => v.includes(p))) {
        throw new AgentToolError('INVALID_TOOL_OUTPUT', '输出契约失败: 禁语短语泄漏到模型可见面')
      }
      return
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x)
      return
    }
    if (isRecord(v)) {
      for (const item of Object.values(v)) walk(item)
    }
  }
  walk(value)
}

/**
 * render 拼接后兜底（P2.2 同口径）：模板固定字面碰撞、短语横跨分隔符重组等
 * 病态构造——整段渲染文本替换为标记。清单为空原样返回。
 */
export function retreatRenderText(text: string, phrases: readonly string[]): string {
  const list = phrases.filter((p) => p !== '')
  if (list.length === 0) return text
  if (!list.some((p) => text.includes(p))) return text
  return requireMaskToken(list)
}

/** 面向模型的合规渲染：候选摘要 + 强制合规页脚（render 闸，tool-face-policy P2.2）。 */
export function renderRunText(result: ScenarioRunResult, phrases?: readonly string[]): string {
  const list = phrases !== undefined
    ? [...new Set(phrases.filter((p) => p !== ''))]
    : (recallPhrases(result.runId) ?? collectPhrases(result))
  const token = list.length > 0 ? requireMaskToken(list) : ''
  // 自由文本片段级整值重遮；ID 回指片段不改写（撞短语 fail-loud）。
  const face = (s: string) => (list.some((p) => s.includes(p)) ? token : s)
  const idFace = (key: string, s: string) => {
    if (list.some((p) => s.includes(p))) {
      throw new AgentToolError('INVALID_TOOL_OUTPUT', `输出契约失败: 禁语短语与 ID 回指字段冲突（${key}）`)
    }
    return s
  }
  const lines: string[] = []
  lines.push(`场景 ${idFace('scenarioId', result.scenarioId)} · 运行 ${idFace('runId', result.runId)}`)
  for (const c of result.candidates) {
    lines.push(`- ${idFace('candidateId', c.candidateId)}（${idFace('objectRef', c.objectRef)}）riskScore=${c.riskScore} riskLevel=${c.riskLevel ?? '—'}`)
    lines.push(`  命中规则: ${c.hitRuleIds.map((id) => idFace('hitRuleIds', id)).join(', ') || '—'}`)
    for (const e of c.evidenceChains) {
      lines.push(`  证据[${idFace('ruleId', e.ruleId)}] ${face(e.evidence)} (score=${e.score})`)
    }
    for (const p of c.pendingChecks) {
      const missing =
        p.missing && p.missing.length > 0 ? `（缺 ${p.missing.map((m) => idFace('missing', m)).join(', ')}）` : ''
      lines.push(`  待核实: ${face(p.note)}${missing}`)
    }
    if (c.pendingVerification) lines.push('  pendingVerification=true')
    for (const n of c.narrative) lines.push(`  叙述: ${face(n)}`)
  }
  for (const x of result.excluded) {
    lines.push(`排除: ${idFace('candidateId', x.candidateId)}（${idFace('ruleId', x.ruleId)}）`)
  }
  lines.push('—— 合规 ——')
  lines.push('humanReviewRequired=true（认定出口只在人工复核）')
  const hits = result.audit.forbiddenPhraseHits
  lines.push(`禁语扫描: ${hits.length === 0 ? '0 命中（通过）' : `${hits.length} 命中`}`)
  for (const h of hits) {
    // 命中清单只给位置；短语本体不经渲染面（P2.2）。
    lines.push(`  禁语命中 @ ${face(h.where)}`)
  }
  lines.push(`三层闭合: ${result.audit.passed ? 'passed' : 'failed'}`)
  const text = lines.join('\n')
  // 拼接后兜底：模板固定字面碰撞、短语横跨分隔符重组等病态构造——整段退避为标记。
  return list.some((p) => text.includes(p)) ? token : text
}

/* ───────────────────────── 输出契约断言（I5） ───────────────────────── */

function invalidOutput(detail: string): AgentToolError {
  return new AgentToolError('INVALID_TOOL_OUTPUT', `输出契约失败: ${detail}`)
}

/** 装配断言：工具结果必须完整携带输出契约要件且逐字段验形；失败即 isError，不产出残缺结果。 */
export function assertRunContract(result: ScenarioRunResult): void {
  if (typeof result.scenarioId !== 'string' || typeof result.runId !== 'string') {
    throw invalidOutput('scenarioId/runId 需要字符串')
  }
  if (!Array.isArray(result.candidates)) {
    throw invalidOutput('candidates 不是数组')
  }
  for (const c of result.candidates) {
    if (typeof c.candidateId !== 'string' || typeof c.objectRef !== 'string') {
      throw invalidOutput('候选需要字符串 candidateId 与 objectRef')
    }
    // Number.isFinite 同时拒 NaN/Infinity 与非数字（typeof NaN === 'number'，纯 typeof 拦不住）。
    if (!Number.isFinite(c.riskScore)) {
      throw invalidOutput(`${c.candidateId} riskScore 非有限数`)
    }
    // riskLevel 可选（旧包/直调路径可能缺），但有则必须是字符串——render 直接插值。
    if (c.riskLevel !== undefined && typeof c.riskLevel !== 'string') {
      throw invalidOutput(`${c.candidateId} riskLevel 需要字符串`)
    }
    for (const key of ['hitRuleIds', 'evidenceChains', 'pendingChecks', 'narrative'] as const) {
      if (!Array.isArray(c[key])) {
        throw invalidOutput(`${c.candidateId} ${key} 不是数组`)
      }
    }
    if (c.hitRuleIds.some((id) => typeof id !== 'string')) {
      throw invalidOutput(`${c.candidateId} hitRuleIds 需要字符串条目`)
    }
    if (c.narrative.some((n) => typeof n !== 'string')) {
      throw invalidOutput(`${c.candidateId} narrative 需要字符串条目`)
    }
    // 证据链 score 同为规则引擎产物：包权重 YAML `.inf` 会让其成 Infinity（riskScore 有夹取
    // 不暴露），须在出口契约拦截，不产出非有限数证据（round-13 minor）；条目逐字段验形，
    // render 直接解引用 ruleId/evidence——错型不得裸抛 TypeError（I5）。
    for (const e of c.evidenceChains) {
      if (!isRecord(e) || !Number.isFinite(e.score)) {
        throw invalidOutput(`${c.candidateId} evidenceChains 条目需要有限 score`)
      }
      if (typeof e.ruleId !== 'string' || typeof e.evidence !== 'string') {
        throw invalidOutput(`${c.candidateId} evidenceChains 条目需要字符串 ruleId 与 evidence`)
      }
    }
    for (const p of c.pendingChecks) {
      if (!isRecord(p) || typeof p.note !== 'string') {
        throw invalidOutput(`${c.candidateId} pendingChecks 条目需要字符串 note`)
      }
      if (p.missing !== undefined && p.missing !== null) {
        if (!Array.isArray(p.missing) || p.missing.some((m) => typeof m !== 'string')) {
          throw invalidOutput(`${c.candidateId} pendingChecks.missing 需要字符串数组`)
        }
      }
    }
  }
  if (!Array.isArray(result.excluded)) {
    throw invalidOutput('excluded 不是数组')
  }
  for (const x of result.excluded) {
    if (!isRecord(x) || typeof x.candidateId !== 'string' || typeof x.ruleId !== 'string') {
      throw invalidOutput('excluded 条目需要字符串 candidateId 与 ruleId')
    }
  }
  if (result.humanReviewRequired !== true) {
    throw invalidOutput('humanReviewRequired 必须为 true')
  }
  if (!result.audit || !Array.isArray(result.audit.forbiddenPhraseHits)) {
    throw invalidOutput('audit.forbiddenPhraseHits 缺失')
  }
  for (const h of result.audit.forbiddenPhraseHits) {
    if (!isRecord(h) || typeof h.phrase !== 'string' || typeof h.where !== 'string') {
      throw invalidOutput('forbiddenPhraseHits 条目需要字符串 phrase 与 where')
    }
  }
}

/** diff 装配断言（I5）：RunDiff 逐字段验形，分数有限或 null，不产出残缺对比。 */
export function assertDiffContract(diff: RunDiff): void {
  if (typeof diff.runIdA !== 'string' || typeof diff.runIdB !== 'string') {
    throw invalidOutput('diff runIdA/runIdB 需要字符串')
  }
  if (typeof diff.scenarioA !== 'string' || typeof diff.scenarioB !== 'string') {
    throw invalidOutput('diff scenarioA/scenarioB 需要字符串')
  }
  for (const key of ['packageA', 'packageB'] as const) {
    const p = diff[key]
    if (!isRecord(p) || typeof p.name !== 'string' || typeof p.version !== 'string') {
      throw invalidOutput(`diff ${key} 需要 name/version 字符串`)
    }
  }
  if (typeof diff.sameDataset !== 'boolean') {
    throw invalidOutput('diff sameDataset 需要布尔')
  }
  if (!Array.isArray(diff.candidates)) {
    throw invalidOutput('diff candidates 不是数组')
  }
  for (const c of diff.candidates) {
    if (!isRecord(c) || typeof c.candidateId !== 'string') {
      throw invalidOutput('diff 候选需要字符串 candidateId')
    }
    for (const key of ['riskScoreA', 'riskScoreB', 'riskScoreDelta'] as const) {
      const v = c[key]
      if (v !== null && !(typeof v === 'number' && Number.isFinite(v))) {
        throw invalidOutput(`diff ${c.candidateId} ${key} 需要有限数或 null`)
      }
    }
    for (const key of ['hitRuleIdsAdded', 'hitRuleIdsRemoved', 'pendingChecksAdded', 'pendingChecksRemoved'] as const) {
      if (!Array.isArray(c[key]) || (c[key] as unknown[]).some((x) => typeof x !== 'string')) {
        throw invalidOutput(`diff ${c.candidateId} ${key} 需要字符串数组`)
      }
    }
  }
  for (const key of ['excludedAdded', 'excludedRemoved'] as const) {
    const list = diff[key]
    if (!Array.isArray(list)) {
      throw invalidOutput(`diff ${key} 不是数组`)
    }
    for (const x of list) {
      if (!isRecord(x) || typeof x.candidateId !== 'string' || typeof x.ruleId !== 'string') {
        throw invalidOutput(`diff ${key} 条目需要字符串 candidateId 与 ruleId`)
      }
    }
  }
  if (typeof diff.auditPassedA !== 'boolean' || typeof diff.auditPassedB !== 'boolean') {
    throw invalidOutput('diff auditPassedA/B 需要布尔')
  }
  if (diff.humanReviewRequired !== true) {
    throw invalidOutput('humanReviewRequired 必须为 true')
  }
}

/**
 * diff 面向模型的渲染（render 闸同口径：片段级重遮 + ID 面 fail-loud + 拼接后兜底）。
 * 清单缺省取 recallPhrases(runIdA/B)（持久后端回读 RunRecord.redlines）。
 */
export function renderRunDiffText(diff: RunDiff, phrases?: readonly string[]): string {
  const list = phrases !== undefined
    ? [...new Set(phrases.filter((p) => p !== ''))]
    : [
        ...new Set(
          [...(recallPhrases(diff.runIdA) ?? []), ...(recallPhrases(diff.runIdB) ?? [])].filter(
            (p) => typeof p === 'string' && p !== '',
          ),
        ),
      ]
  const token = list.length > 0 ? requireMaskToken(list) : ''
  const face = (s: string) => (list.some((p) => s.includes(p)) ? token : s)
  const idFace = (key: string, s: string) => {
    if (list.some((p) => s.includes(p))) {
      throw new AgentToolError('INVALID_TOOL_OUTPUT', `输出契约失败: 禁语短语与 ID 回指字段冲突（${key}）`)
    }
    return s
  }
  const lines: string[] = []
  lines.push(`对比 运行 ${idFace('runIdA', diff.runIdA)} → ${idFace('runIdB', diff.runIdB)}`)
  lines.push(
    `包 ${idFace('packageA', diff.packageA.name)}@${idFace('packageA', diff.packageA.version)}（${idFace('scenarioA', diff.scenarioA)}）` +
      ` → ${idFace('packageB', diff.packageB.name)}@${idFace('packageB', diff.packageB.version)}（${idFace('scenarioB', diff.scenarioB)}）`,
  )
  lines.push(`同数据: ${diff.sameDataset ? 'yes' : 'no'}`)
  for (const c of diff.candidates) {
    const a = c.riskScoreA === null ? '—' : String(c.riskScoreA)
    const b = c.riskScoreB === null ? '—' : String(c.riskScoreB)
    const d = c.riskScoreDelta === null ? '' : `（Δ=${c.riskScoreDelta}）`
    lines.push(`- ${idFace('candidateId', c.candidateId)} riskScore ${a} → ${b}${d}`)
    if (c.hitRuleIdsAdded.length > 0) {
      lines.push(`  命中+: ${c.hitRuleIdsAdded.map((x) => idFace('hitRuleIds', x)).join(', ')}`)
    }
    if (c.hitRuleIdsRemoved.length > 0) {
      lines.push(`  命中-: ${c.hitRuleIdsRemoved.map((x) => idFace('hitRuleIds', x)).join(', ')}`)
    }
    if (c.pendingChecksAdded.length > 0) lines.push(`  待核实+: ${c.pendingChecksAdded.map(face).join('; ')}`)
    if (c.pendingChecksRemoved.length > 0) lines.push(`  待核实-: ${c.pendingChecksRemoved.map(face).join('; ')}`)
  }
  for (const x of diff.excludedAdded) {
    lines.push(`排除+: ${idFace('candidateId', x.candidateId)}（${idFace('ruleId', x.ruleId)}）`)
  }
  for (const x of diff.excludedRemoved) {
    lines.push(`排除-: ${idFace('candidateId', x.candidateId)}（${idFace('ruleId', x.ruleId)}）`)
  }
  lines.push('—— 合规 ——')
  lines.push('humanReviewRequired=true（认定出口只在人工复核）')
  lines.push(`三层闭合: A=${diff.auditPassedA ? 'passed' : 'failed'} · B=${diff.auditPassedB ? 'passed' : 'failed'}`)
  const text = lines.join('\n')
  return list.some((p) => text.includes(p)) ? token : text
}

/* ───────────────────────── 批量执行契约（S2.3） ───────────────────────── */

export interface BatchRunSummary {
  candidateCount: number
  hitRuleCount: number
  excludedCount: number
  auditPassed: boolean
  forbiddenPhraseHitCount: number
  humanReviewRequired: true
}

export interface BatchRunItem {
  scenarioId: string
  status: 'ok' | 'error'
  runId?: string
  summary?: BatchRunSummary
  error?: { code: string; message: string }
}

export interface BatchRunOutput {
  results: BatchRunItem[]
  humanReviewRequired: true
}

/** 批量装配断言（I5）：单项要么完整 ok 形态、要么 error 形态；摘要计数有限且人审恒真。 */
export function assertBatchContract(out: BatchRunOutput): void {
  if (out.humanReviewRequired !== true) {
    throw invalidOutput('humanReviewRequired 必须为 true')
  }
  if (!Array.isArray(out.results)) {
    throw invalidOutput('results 不是数组')
  }
  for (const item of out.results) {
    if (!isRecord(item) || typeof item.scenarioId !== 'string') {
      throw invalidOutput('批量条目需要字符串 scenarioId')
    }
    if (item.status === 'ok') {
      const s = item.summary
      if (typeof item.runId !== 'string' || !isRecord(s)) {
        throw invalidOutput(`${item.scenarioId} ok 条目需要 runId 与 summary`)
      }
      for (const key of ['candidateCount', 'hitRuleCount', 'excludedCount', 'forbiddenPhraseHitCount'] as const) {
        if (typeof s[key] !== 'number' || !Number.isFinite(s[key]) || s[key] < 0) {
          throw invalidOutput(`${item.scenarioId} summary.${key} 需要非负有限数`)
        }
      }
      if (typeof s.auditPassed !== 'boolean' || s.humanReviewRequired !== true) {
        throw invalidOutput(`${item.scenarioId} summary 需要布尔 auditPassed 且 humanReviewRequired=true`)
      }
    } else if (item.status === 'error') {
      const e = item.error
      if (!isRecord(e) || typeof e.code !== 'string' || typeof e.message !== 'string') {
        throw invalidOutput(`${item.scenarioId} error 条目需要字符串 code 与 message`)
      }
    } else {
      throw invalidOutput(`${item.scenarioId} status 需要 ok 或 error`)
    }
  }
}

/** 批量结果渲染（render 闸同口径：error.message 片段重遮 + 拼接后兜底 + 合规页脚）。 */
export function renderBatchText(out: BatchRunOutput, phrases?: readonly string[]): string {
  // 清单 = 显式（包级全红线）∪ recall（各 runId 命中∪场景红线）——
  // 二者缺一即窄于双源：模板固定字面碰撞/失败场景红线可经拼接漏出（挂点病同族）。
  const list = [
    ...new Set(
      [
        ...(phrases ?? []),
        ...out.results
          .flatMap((item) => (item.runId ? (recallPhrases(item.runId) ?? []) : []))
          .filter((p) => typeof p === 'string' && p !== ''),
      ].filter((p) => typeof p === 'string' && p !== ''),
    ),
  ]
  const token = list.length > 0 ? requireMaskToken(list) : ''
  const face = (s: string) => (list.some((p) => s.includes(p)) ? token : s)
  const idFace = (key: string, s: string) => {
    if (list.some((p) => s.includes(p))) {
      throw new AgentToolError('INVALID_TOOL_OUTPUT', `输出契约失败: 禁语短语与 ID 回指字段冲突（${key}）`)
    }
    return s
  }
  const lines: string[] = []
  lines.push(`批量运行 ${out.results.length} 个场景`)
  for (const item of out.results) {
    if (item.status === 'ok' && item.summary) {
      const s = item.summary
      lines.push(
        `- ${idFace('scenarioId', item.scenarioId)} ok 运行 ${idFace('runId', item.runId ?? '')} ` +
          `候选=${s.candidateCount} 命中规则=${s.hitRuleCount} 排除=${s.excludedCount} ` +
          `审计=${s.auditPassed ? 'passed' : 'failed'} 禁语=${s.forbiddenPhraseHitCount}`,
      )
    } else if (item.error) {
      lines.push(`- ${idFace('scenarioId', item.scenarioId)} error ${item.error.code}: ${face(item.error.message)}`)
    } else {
      lines.push(`- ${idFace('scenarioId', item.scenarioId)} 不完整条目`)
    }
  }
  lines.push('—— 合规 ——')
  lines.push('humanReviewRequired=true（认定出口只在人工复核）')
  const text = lines.join('\n')
  return list.some((p) => text.includes(p)) ? token : text
}

/**
 * export 摘要渲染（render 闸同口径，S2.4）：禁纯序列化直出——JSON.stringify 无拼接后
 * 兜底，跨分隔符重组/模板碰撞同族可漏（评审 critical）。清单缺省 recall(runId)
 * （持久后端回读 RunRecord.redlines），片段重遮 + 整段兜底。
 */
export function renderExportText(
  out: {
    runId: string
    locator: string
    auditPassed: boolean
    candidateCount: number
    hitRuleCount: number
    excludedCount: number
    forbiddenPhraseHitCount: number
  },
  phrases?: readonly string[]): string {
  const list = [
    ...new Set(
      [
        ...(phrases ?? []),
        ...(recallPhrases(out.runId) ?? []),
      ].filter((p) => typeof p === 'string' && p !== ''),
    ),
  ]
  const token = list.length > 0 ? requireMaskToken(list) : ''
  const face = (s: string) => (list.some((p) => s.includes(p)) ? token : s)
  const idFace = (key: string, s: string) => {
    if (list.some((p) => s.includes(p))) {
      throw new AgentToolError('INVALID_TOOL_OUTPUT', `输出契约失败: 禁语短语与 ID 回指字段冲突（${key}）`)
    }
    return s
  }
  const lines: string[] = []
  lines.push(`审计导出 运行 ${idFace('runId', out.runId)}`)
  lines.push(`归档 ${face(out.locator)}`)
  lines.push(
    `候选=${out.candidateCount} 命中规则=${out.hitRuleCount} 排除=${out.excludedCount} ` +
      `审计=${out.auditPassed ? 'passed' : 'failed'} 禁语=${out.forbiddenPhraseHitCount}`,
  )
  lines.push('—— 合规 ——')
  lines.push('humanReviewRequired=true（认定出口只在人工复核）')
  const text = lines.join('\n')
  return list.some((p) => text.includes(p)) ? token : text
}
