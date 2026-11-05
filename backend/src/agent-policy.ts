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
import type { ScenarioRunResult } from '@dsh-onto/core'

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
 * 错误信封：任何出口不得裸抛。
 * - 原生 fs/系统错误 → 只留机器码（`工具执行失败（ENOENT）`），原文不入模型面；
 * - 受控/业务错误 → 保留机器码与 message（剥服务端目录）；
 * - 其余 → RUN_FAILED + 受控短消息。
 */
export function asToolError(e: unknown, extraRedact: readonly string[] = []): AgentToolError {
  if (isSystemError(e)) {
    const code = errorCode(e, 'UNKNOWN_ERROR')
    return new AgentToolError(code, `工具执行失败（${code}）`)
  }
  const code = errorCode(e, 'RUN_FAILED')
  const raw = e instanceof Error ? e.message : String(e)
  return new AgentToolError(code, scrub(raw, extraRedact))
}

/** execute 统一信封：体内任何抛出经 asToolError 收口后重抛。 */
export function toolExecute<A, R>(
  fn: (args: A) => R | Promise<R>,
  extraRedact: readonly string[] = [],
): (args: A) => Promise<R> {
  return async (args: A): Promise<R> => {
    try {
      return await fn(args)
    } catch (e) {
      throw asToolError(e, extraRedact)
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

export function rememberPhrases(runId: string, phrases: readonly string[]): void {
  if (typeof runId !== 'string' || runId === '') return
  if (phraseRegistry.size >= PHRASE_REGISTRY_MAX) {
    const oldest = phraseRegistry.keys().next().value
    if (oldest !== undefined) phraseRegistry.delete(oldest)
  }
  phraseRegistry.set(runId, [...phrases])
}

export function recallPhrases(runId: string): string[] | undefined {
  return phraseRegistry.get(runId)
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
  'scenarioId',
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
export function enforceOutputPolicy(
  result: ScenarioRunResult,
  phrases?: readonly string[],
): ScenarioRunResult {
  const list = phrases !== undefined
    ? [...new Set(phrases.filter((p) => p !== ''))]
    : collectPhrases(result)
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
  const out = walk(result, '') as ScenarioRunResult
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
    lines.push(`- ${idFace('candidateId', c.candidateId)}（${idFace('objectRef', c.objectRef)}）riskScore=${c.riskScore}`)
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
