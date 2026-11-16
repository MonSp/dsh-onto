/**
 * 模型最终回答守卫（可信回答 T3 + R2 字段级核验）—— `llm/stream` 出口闸。
 *
 * 威胁面（评估结论 §3）：工具出口有输出策略，但模型最终回答不受同等检查——可把结果重新表述成
 * 越界认定结论、改写关键数字（如把 riskScore 0.90 说成 0.95）、或不调用场景工具直接编造分析。
 *
 * 防线（最终回答与工具出口同等口径）：
 * 1. 禁语扫描：命中红线短语 → 【禁语已脱敏】，原文不透出。
 * 2. 字段级数字核验（R2）：权威事实按 run / 场景 / candidateId / 字段（风险分、review 阈值、
 *    证据分）建模，来源优先取可信结构化运行结果（RunRecord），渲染文本正则只是兜底。
 *    回答里**明确识别**的 `candidateId + riskScore` / 阈值 / 证据分声明逐字段核验：
 *    - 一致（容忍两位小数舍入）→ 逐字保留；
 *    - 不一致且可唯一绑定 → 以运行事实核正；
 *    - 无法可靠绑定（未知候选、裸声明、跨轮歧义未引 run）→ 标记【未核验数字】，
 *      不猜测含义、不擅自改值（旧「候选邻域全部小数替换」算法已废除——会污染相邻
 *      阈值/证据分/叙述数字）。
 * 3. 无运行支撑（T3.2）：整个会话没有场景运行证据时，分数/结论类数字一律降级 + 文末固定页脚，
 *    不放行「没跑过就报分」。
 *
 * 流式口径：文本按**整块缓冲**——text-delta 累积不放行，block-end 时对汇编文本全量处理后
 * 一次放出（安全优先于打字机效果；短语遮蔽/数字核正都是跨词元模式，增量切分必漏检）。
 * block-end 的汇编块以处理后文本覆写（权威内容）。跨块声明（上一块止于「候选+分数关键词」）
 * 经 `nextOpenClaim` 残留下传，下一块开头的数字按同一声明核验。
 *
 * 核验说明（可审计）：每处核正/待核验标记在 ProcessedAnswer.notes 留结构化说明
 * （遮蔽类不回显被遮蔽数值原文）。
 *
 * 口径：reasoning-delta（思考块）不过闸——非最终表达；purpose 非空（compaction / session-title）
 * 与无 sessionId 的一次性调用不过闸——不是会话最终回答。
 *
 * 语义级评估（T3.2 附带项）：红线字面 + 认定性模式族（进 forbiddenPhrases 即可捕获「把模板话术
 * 改成认定句」这类改写）+ 数字核正已覆盖主要越界面；**纯语义越界**（不含红线字面的新编结论句）
 * 字符串抓不到，需要语义裁判（如小模型按红线量表批改回答）。评估结论：暂不引入——(a) 逐回答加
 * 一次 LLM 调用增时延成本，(b) 裁判也是模型、需再设兜底形成套娃，(c) humanReviewRequired 恒真 +
 * 人审面已兜住认定出口。留待后续以「审读回执」形态接入（T3 后续项）。
 * @module @dsh-onto/backend/agent-answer-guard
 */
import type { GenerateOptions, RequestMessage, StreamChunk } from '@deepseek-ai/dsh-llm'

/** 禁语遮蔽记号（与 agent-policy 工具出口同口径）。 */
export const ANSWER_MASK_TOKEN = '【禁语已脱敏】'
/** 无据数字记号。 */
export const UNVERIFIED_NUMBER_TOKEN = '【未核验数字】'
/** 无运行支撑页脚（T3.2 降级）。 */
export const UNGROUNDED_FOOTER =
  '\n\n—— 回答核验 ——\n未经场景工具运行核验：分数/结论类数字已按输出策略降级；'
  + '业务判断以 run_scenario 结果与人工复核为准（humanReviewRequired=true）。'

const RUN_TOOL_NAMES = new Set(['run_scenario', 'run_scenarios', 'invoke_expert'])

/** 单轮运行的结构化事实（runId 消歧 + 字段分池）。 */
export interface RunFactEntry {
  runId: string | null
  scenarioId: string | null
  /** candidateId → 权威风险分（全精度）。 */
  scores: Map<string, number>
  /** review 阈值（该轮全部阈值声明）。 */
  thresholds: number[]
  /** 证据分（该轮全部 `(score=n)` / 证据分声明）。 */
  evidenceScores: number[]
}

/** 权威事实：按 run / 场景 / candidateId / 字段建模（R2）。 */
export interface AnswerFacts {
  /** 会话内是否存在场景运行证据（run_* / invoke_expert 成功结果）。 */
  grounded: boolean
  /** 每轮运行事实（同候选跨轮可经 runId 消歧）。 */
  runs: RunFactEntry[]
}

export const emptyAnswerFacts = (): AnswerFacts => ({ grounded: false, runs: [] })

/** 跨块声明残留：上一块以「候选 + 分数/阈值关键词」结尾、数字未出现。 */
export interface OpenClaim {
  kind: 'score' | 'threshold' | 'evidence'
  candId: string | null
}

function collectText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
      const t = (block as { text?: unknown }).text
      if (typeof t === 'string') parts.push(t)
    }
  }
  return parts.join('\n')
}

/** 从渲染文本兜底提取单轮事实（结构化运行记录缺失时用；口径同 run 工具 render）。 */
function parseRunText(text: string): RunFactEntry {
  const entry: RunFactEntry = {
    runId: null,
    scenarioId: null,
    scores: new Map(),
    thresholds: [],
    evidenceScores: [],
  }
  const runM = /run-[A-Za-z0-9]{4,}/.exec(text)
  if (runM !== null) entry.runId = runM[0]
  const scnM = /SCN-[A-Za-z0-9][A-Za-z0-9-]*/.exec(text)
  if (scnM !== null) entry.scenarioId = scnM[0]
  const scoreRe = /(CAND-[\w.-]+)[\s\S]{0,40}?riskScore[=:：]([0-9.]+)/g
  let match: RegExpExecArray | null
  while ((match = scoreRe.exec(text)) !== null) {
    const score = Number(match[2])
    if (Number.isFinite(score)) entry.scores.set(match[1], score)
  }
  const thresholdRe = /review[\s≤<=]{1,4}([0-9.]+)|(?:阈值|threshold)[^\n0-9A-Za-z%]{0,8}([0-9]+(?:\.[0-9]+)?)/gi
  while ((match = thresholdRe.exec(text)) !== null) {
    const n = Number(match[1] ?? match[2])
    if (Number.isFinite(n)) entry.thresholds.push(n)
  }
  const evidenceRe = /\(score[=:：]\s*([0-9.]+)\)/gi
  while ((match = evidenceRe.exec(text)) !== null) {
    const n = Number(match[1])
    if (Number.isFinite(n)) entry.evidenceScores.push(n)
  }
  return entry
}

/**
 * 从请求消息提取权威事实：
 * 优先可信结构化运行结果（`loadRunFacts` 按 runId 供数——服务端运行记录），
 * 缺失时才回退渲染文本正则。tool-call 名 → toolCallId 映射后只认 run_* / invoke_expert 成功结果。
 */
export function extractAnswerFacts(
  messages: readonly RequestMessage[] | readonly unknown[],
  opts?: { loadRunFacts?: (runId: string) => RunFactEntry | undefined },
): AnswerFacts {
  const facts = emptyAnswerFacts()
  const toolNameById = new Map<string, string>()
  const runTexts: string[] = []
  for (const raw of messages) {
    const m = raw as { role?: unknown; content?: unknown; toolCallId?: unknown; isError?: unknown }
    if (m.role === 'assistant') {
      for (const block of Array.isArray(m.content) ? (m.content as unknown[]) : []) {
        const b = block as { type?: unknown; id?: unknown; name?: unknown }
        if (b.type === 'tool-call' && typeof b.id === 'string' && typeof b.name === 'string') {
          toolNameById.set(b.id, b.name)
        }
      }
    } else if (m.role === 'tool') {
      const name = typeof m.toolCallId === 'string' ? toolNameById.get(m.toolCallId) : undefined
      if (name !== undefined && RUN_TOOL_NAMES.has(name) && m.isError !== true) {
        runTexts.push(collectText(m.content))
      }
    }
  }
  for (const text of runTexts) {
    facts.grounded = true
    const parsed = parseRunText(text)
    const structured =
      parsed.runId !== null && opts?.loadRunFacts !== undefined ? opts.loadRunFacts(parsed.runId) : undefined
    facts.runs.push(structured ?? parsed)
  }
  return facts
}

/** 风险分/阈值取值域（∈ [0,1]；留 1.05 余量容纳显示误差）。 */
const isScoreLike = (n: number): boolean => n >= 0 && n <= 1.05

const round2 = (n: number): number => Number(n.toFixed(2))

/** 数字与权威值一致（含两位小数舍入容忍）。 */
function matchesTruth(v: number, truth: number): boolean {
  return Math.abs(v - truth) < 0.006 || Math.abs(v - round2(truth)) < 0.006
}

/** 事实解析结果。 */
type Resolution =
  | { kind: 'unique'; value: number; runId: string | null }
  | { kind: 'ambiguous' }
  | { kind: 'none' }

function resolveScore(facts: AnswerFacts, candId: string, hint: string | null): Resolution {
  const runs = hint === null ? facts.runs : facts.runs.filter((r) => r.runId === hint)
  const values: Array<{ value: number; runId: string | null }> = []
  for (const r of runs) {
    const v = r.scores.get(candId)
    if (typeof v === 'number') values.push({ value: v, runId: r.runId })
  }
  return uniqueOf(values)
}

function resolveThreshold(facts: AnswerFacts, hint: string | null): Resolution {
  const runs = hint === null ? facts.runs : facts.runs.filter((r) => r.runId === hint)
  const values = runs.flatMap((r) => r.thresholds.map((v) => ({ value: v, runId: r.runId })))
  return uniqueOf(values)
}

function resolveEvidence(facts: AnswerFacts, hint: string | null, v: number): Resolution {
  const runs = hint === null ? facts.runs : facts.runs.filter((r) => r.runId === hint)
  const pool = runs.flatMap((r) => r.evidenceScores.map((x) => ({ value: x, runId: r.runId })))
  // 证据分有多条（逐条证据），取「可与该声明对应的」任一命中；全不中 → none
  const hit = pool.find((p) => matchesTruth(v, p.value))
  if (hit !== undefined) return { kind: 'unique', value: hit.value, runId: hit.runId }
  return { kind: 'none' }
}

function uniqueOf(values: Array<{ value: number; runId: string | null }>): Resolution {
  if (values.length === 0) return { kind: 'none' }
  const distinct = new Set(values.map((v) => v.value))
  if (distinct.size === 1) return { kind: 'unique', value: values[0].value, runId: values[0].runId }
  return { kind: 'ambiguous' }
}

/** 声明种类 → 人话（核验说明用）。 */
const FIELD_LABEL: Record<OpenClaim['kind'], string> = {
  score: '风险分',
  threshold: '阈值',
  evidence: '证据分',
}

interface Claim {
  kind: OpenClaim['kind']
  candId: string | null
  /** 数字在文本中的起点。 */
  at: number
  /** 数字词法单元长度。 */
  len: number
  value: number
}

/** 捕获组在 match 内的起止（/d 标志 indices）。 */
function groupSpan(match: RegExpExecArray, group: number): { at: number; len: number } {
  const idx = match.indices?.[group]
  if (idx === undefined) return { at: match.index, len: match[0].length }
  return { at: idx[0], len: idx[1] - idx[0] }
}

/** 与声明同行的候选 ID（最近优先，前邻优先于后邻）。 */
function bindCandidate(text: string, at: number): string | null {
  const lineStart = text.lastIndexOf('\n', at - 1) + 1
  const lineEnd = text.indexOf('\n', at)
  const end = lineEnd === -1 ? text.length : lineEnd
  const line = text.slice(lineStart, end)
  const re = /CAND-[\w.-]+/g
  let best: { id: string; dist: number; before: boolean } | null = null
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) !== null) {
    const pos = lineStart + m.index
    const before = pos <= at
    const dist = before ? at - pos : pos - at
    if (
      best === null
      || (before && !best.before)
      || (before === best.before && dist < best.dist)
    ) {
      best = { id: m[0], dist, before }
    }
  }
  return best === null ? null : best.id
}

/** 收集全部数字声明（候选风险分 / 阈值 / 证据分），按起点去重（长者优先）。 */
function collectClaims(text: string): Claim[] {
  const claims: Claim[] = []
  const add = (match: RegExpExecArray, kind: OpenClaim['kind'], numGroup: number, candId?: string | null): void => {
    const span = groupSpan(match, numGroup)
    const value = Number(text.slice(span.at, span.at + span.len))
    if (!Number.isFinite(value) || !isScoreLike(value)) return
    claims.push({ kind, candId: candId !== undefined ? candId : bindCandidate(text, match.index), at: span.at, len: span.len, value })
  }

  // 证据分：`(score=n)` 精确形 + 「证据(分) score=n」叙述形
  const evidenceParen = /\(score[=:：]\s*([0-9]+(?:\.[0-9]+)?)\)/gid
  let m: RegExpExecArray | null
  while ((m = evidenceParen.exec(text)) !== null) add(m, 'evidence', 1, null)
  const evidencePhrase = /(?:证据(?:分|数)?|evidence)[^\n0-9A-Za-z%]{0,6}(?:score[^\n0-9A-Za-z%]{0,4})?([0-9]+(?:\.[0-9]+)?)(?!\s*%)/gid
  while ((m = evidencePhrase.exec(text)) !== null) add(m, 'evidence', 1)

  // 阈值：`review≤n` / `review = n` / `阈值 n` / `threshold=n`
  const thresholdReview = /review[\s≤<=]{1,4}([0-9]+(?:\.[0-9]+)?)(?!\s*%)/gid
  while ((m = thresholdReview.exec(text)) !== null) add(m, 'threshold', 1, null)
  const thresholdWord = /(?:阈值|threshold)[^\n0-9A-Za-z%]{0,8}([0-9]+(?:\.[0-9]+)?)(?!\s*%)/gid
  while ((m = thresholdWord.exec(text)) !== null) add(m, 'threshold', 1, null)

  // 候选风险分 / 裸分数声明（关键词后数字）
  const scoreClaim = /(riskScore|风险评分|风险得分|风险分|得分|score)[^\n0-9A-Za-z%]{0,8}([0-9]+(?:\.[0-9]+)?)(?!\s*%)/gid
  while ((m = scoreClaim.exec(text)) !== null) add(m, 'score', 2)

  // Markdown 表格：表头语义列逐字段核验
  collectTableClaims(text, add)

  // 重叠去重：起点早者优先，同起点长者优先
  claims.sort((a, b) => (a.at - b.at) || (b.len - a.len))
  const out: Claim[] = []
  let lastEnd = -1
  for (const c of claims) {
    if (c.at < lastEnd) continue
    out.push(c)
    lastEnd = c.at + c.len
  }
  return out
}

/** Markdown 表格列语义 → 数字声明（表头识别「风险分/阈值/证据」列）。 */
function collectTableClaims(
  text: string,
  add: (match: RegExpExecArray, kind: OpenClaim['kind'], numGroup: number, candId?: string | null) => void,
): void {
  const lines = text.split('\n')
  // 每行在全文中的起始偏移（声明 span 须是全文坐标）
  const lineStart: number[] = []
  let pos = 0
  for (const line of lines) {
    lineStart.push(pos)
    pos += line.length + 1
  }
  let tableStart = -1
  const flush = (from: number, to: number): void => {
    // from..to 是连续 `|` 行区间
    const rows = lines.slice(from, to).map((l) => l.split('|').map((c) => c.trim()))
    if (rows.length < 2) return
    const header = rows[0]
    const colKind: Array<OpenClaim['kind'] | null> = header.map((h) => {
      if (/风险分|riskScore|风险评分|风险得分|得分|score/i.test(h)) return 'score'
      if (/阈值|threshold/i.test(h)) return 'threshold'
      if (/证据|evidence/i.test(h)) return 'evidence'
      return null
    })
    for (let r = 1; r < rows.length; r++) {
      const cells = rows[r]
      if (cells.every((c) => /^[-:\s]*$/.test(c))) continue // 表头分隔行
      const rowText = lines[from + r]
      const base = lineStart[from + r]
      const cand = /CAND-[\w.-]+/.exec(rowText)?.[0] ?? null
      // 单元偏移：按 `|` 切分并累计（trim 后的单元在行内的真实位置）
      let cursor = 0
      for (let c = 0; c < cells.length; c++) {
        const cell = cells[c]
        const rawCellAt = rowText.indexOf(cell, cursor)
        const at = base + (rawCellAt >= 0 ? rawCellAt : cursor)
        cursor = (at - base) + cell.length
        const kind = colKind[c]
        if (kind === null || kind === undefined) continue
        const num = /^[0-9]+(?:\.[0-9]+)?$/.exec(cell)
        if (num === null) continue
        const fake = {
          index: at,
          0: cell,
          1: cell,
          2: cell,
          indices: [[at, at + cell.length], [at, at + cell.length], [at, at + cell.length]],
        } as unknown as RegExpExecArray
        add(fake, kind, 1, kind === 'score' ? cand : null)
      }
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const isRow = lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')
    if (isRow) {
      if (tableStart === -1) tableStart = i
    } else if (tableStart !== -1) {
      flush(tableStart, i)
      tableStart = -1
    }
  }
  if (tableStart !== -1) flush(tableStart, lines.length)
}

/** 声明解析（kind + 绑定候选）。 */
function resolveClaim(
  facts: AnswerFacts,
  claim: Claim,
  hint: string | null,
): Resolution {
  if (claim.kind === 'score') {
    return claim.candId === null ? { kind: 'none' } : resolveScore(facts, claim.candId, hint)
  }
  if (claim.kind === 'threshold') return resolveThreshold(facts, hint)
  return resolveEvidence(facts, hint, claim.value)
}

/** 文本内的 run 引用（声明位置之前最近一个 runId 作为消歧提示）。 */
function runHintAt(text: string, at: number, facts: AnswerFacts): string | null {
  const re = /run-[A-Za-z0-9]{4,}/g
  let hint: string | null = null
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index >= at) break
    const id = m[0]
    if (facts.runs.some((r) => r.runId === id)) hint = id
  }
  return hint
}

/** 上一块以「候选 + 关键词」收尾、数字未出现 → 跨块声明残留。 */
const TRAILING_OPEN_CLAIM =
  /(?:^|[^\w.-])((CAND-[\w.-]+)[^\n]{0,40}?)?(风险评分|风险得分|风险分|riskScore|得分|score|阈值|threshold)[^\n0-9A-Za-z%]{0,4}$/

/** 块首数字（跨块声明的另一半）。 */
const LEADING_NUMBER = /^\s*([0-9]+(?:\.[0-9]+)?)(?!\s*%)/

export interface ProcessedAnswer {
  text: string
  maskedPhrases: number
  correctedNumbers: number
  maskedNumbers: number
  /** 出现过分数/结论类引用（无运行支撑时驱动页脚）。 */
  claimSeen: boolean
  /** 可审计的核验说明（遮蔽类不回显被遮蔽数值原文）。 */
  notes: string[]
  /** 跨块声明残留（下一块开头数字按此核验）。 */
  nextOpenClaim: OpenClaim | null
}

/**
 * 全量处理一段回答文本（block-end 权威路径与测试入口）：
 * 禁语遮蔽 → 字段级数字核验（R2）/降级。
 * `ctx.openClaim` 为上一块的跨块声明残留；结果里的 `nextOpenClaim` 供下一块使用。
 */
export function processAnswerText(
  input: string,
  ctx: { phrases: readonly string[]; facts: AnswerFacts; openClaim?: OpenClaim | null },
): ProcessedAnswer {
  const out: ProcessedAnswer = {
    text: input,
    maskedPhrases: 0,
    correctedNumbers: 0,
    maskedNumbers: 0,
    claimSeen: false,
    notes: [],
    nextOpenClaim: null,
  }
  for (const phrase of ctx.phrases) {
    if (phrase === '' || !out.text.includes(phrase)) continue
    const parts = out.text.split(phrase)
    out.maskedPhrases += parts.length - 1
    out.text = parts.join(ANSWER_MASK_TOKEN)
  }

  const claims = collectClaims(out.text)

  // 跨块残留：上一块的「候选+关键词」接本块开头数字 → 同一声明
  const openClaim = ctx.openClaim ?? null
  if (openClaim !== null) {
    const lead = LEADING_NUMBER.exec(out.text)
    if (lead !== null) {
      const value = Number(lead[1])
      if (Number.isFinite(value) && isScoreLike(value)) {
        claims.push({ kind: openClaim.kind, candId: openClaim.candId, at: lead.index + lead[0].indexOf(lead[1]), len: lead[1].length, value })
        claims.sort((a, b) => a.at - b.at)
      }
    }
  }

  // 逐声明核验（倒序替换防位移）
  for (let i = claims.length - 1; i >= 0; i--) {
    const claim = claims[i]
    const hint = runHintAt(out.text, claim.at, ctx.facts)
    out.claimSeen = true
    const res = resolveClaim(ctx.facts, claim, hint)
    const label = FIELD_LABEL[claim.kind]
    const where = claim.candId !== null ? `${claim.candId} ${label}` : label
    const raw = out.text.slice(claim.at, claim.at + claim.len)
    if (res.kind === 'unique' && matchesTruth(claim.value, res.value)) {
      continue // 一致（含两位小数舍入）→ 逐字保留
    }
    if (res.kind === 'unique') {
      const next = String(res.value)
      out.text = out.text.slice(0, claim.at) + next + out.text.slice(claim.at + claim.len)
      out.correctedNumbers++
      out.notes.push(`${where} 声明 ${raw}→${next}${res.runId !== null ? `（${res.runId}）` : ''}——按运行事实核正`)
      continue
    }
    // none / ambiguous：无法可靠绑定 → 标记待核验，不擅自改值
    out.text = out.text.slice(0, claim.at) + UNVERIFIED_NUMBER_TOKEN + out.text.slice(claim.at + claim.len)
    out.maskedNumbers++
    out.notes.push(
      res.kind === 'ambiguous'
        ? `${where} 跨多轮运行取值不一致且未引 run 消歧——已标记待核验`
        : `${where} 声明无法绑定权威事实——已标记待核验`,
    )
  }

  // 无运行支撑（T3.2）：会话无场景运行证据时，分数/结论类引用驱动整体降级
  if (!ctx.facts.grounded) {
    if (/(CAND-[\w.-]+)/.test(out.text)) out.claimSeen = true
    if (out.claimSeen) {
      const sweep = /(?<![\w.-])\d+\.\d+(?![\w.%])/g
      out.text = out.text.replace(sweep, (raw) => {
        const n = Number(raw)
        if (!isScoreLike(n)) return raw
        out.maskedNumbers++
        return UNVERIFIED_NUMBER_TOKEN
      })
    }
  }

  // 跨块残留检测（处理后文本；止于「候选+关键词」且无数字跟随）
  const trailing = TRAILING_OPEN_CLAIM.exec(out.text)
  if (trailing !== null) {
    const kw = trailing[3]
    const kind: OpenClaim['kind'] =
      /阈值|threshold/.test(kw) ? 'threshold' : /证据|evidence/.test(kw) ? 'evidence' : 'score'
    out.nextOpenClaim = { kind, candId: trailing[2] ?? null }
    if (trailing[2] !== undefined) out.claimSeen = true
  }
  return out
}

/**
 * 生成 `llm/stream` 瀑布监听器：包裹下游流，对最终回答文本过输出策略（见模块头三防线）。
 * `phrases` 惰性求值（红线清单可随包变更失效重建）；`loadRunFacts` 供可信结构化运行事实。
 */
export function createAnswerGuard(deps: {
  phrases: () => readonly string[]
  loadRunFacts?: (runId: string) => RunFactEntry | undefined
}): (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk> {
  return (options, next): AsyncIterable<StreamChunk> => {
    // 会话最终回答才过闸：一次性/辅助调用（compaction、session-title、内部分析）跳过。
    if (options.purpose !== undefined || options.sessionId === undefined) return next()
    const facts = extractAnswerFacts(options.messages, {
      ...(deps.loadRunFacts !== undefined ? { loadRunFacts: deps.loadRunFacts } : {}),
    })
    const ctx = {
      facts,
      openClaim: null as OpenClaim | null,
      get phrases(): string[] {
        return deps.phrases().filter((p) => typeof p === 'string' && p !== '')
      },
    }
    return (async function* guarded() {
      // 整块缓冲：delta 累积不放行；block-end 全量处理后一次放出（跨词元模式增量切分必漏检）。
      const buffers = new Map<number, string>()
      let footerDue = false
      for await (const chunk of next()) {
        switch (chunk.type) {
          case 'text-delta': {
            buffers.set(chunk.index, (buffers.get(chunk.index) ?? '') + chunk.text)
            break
          }
          case 'block-end': {
            if (chunk.block.type === 'text') {
              const streamed = buffers.get(chunk.index) ?? ''
              buffers.delete(chunk.index)
              // 权威内容以汇编块为准；块缺失文本时回退流式缓冲
              const source = chunk.block.text !== '' ? chunk.block.text : streamed
              const processed = processAnswerText(source, ctx)
              ctx.openClaim = processed.nextOpenClaim
              if (processed.claimSeen) footerDue = footerDue || !facts.grounded
              if (processed.text !== '') {
                yield { type: 'text-delta', index: chunk.index, text: processed.text }
              }
              yield { type: 'block-end', index: chunk.index, block: { type: 'text', text: processed.text } }
            } else {
              buffers.delete(chunk.index)
              yield chunk
            }
            break
          }
          case 'finish': {
            if (footerDue) {
              // 无运行支撑降级页脚：独立文本块附于回答末尾（先于 finish 发出）
              const index = 1000
              yield { type: 'block-start', index, blockType: 'text' }
              yield { type: 'text-delta', index, text: UNGROUNDED_FOOTER }
              yield { type: 'block-end', index, block: { type: 'text', text: UNGROUNDED_FOOTER } }
            }
            yield chunk
            break
          }
          default:
            yield chunk
            break
        }
      }
    })()
  }
}
