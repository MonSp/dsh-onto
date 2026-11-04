/**
 * 规则引擎（规范 §9.2）：排除（before-scoring）→ 打分（按 weight 加权）。
 *
 * - 每一分必须能回指规则 ID；输出永远不含「认定」。
 * - 缺失特征 → pendingVerification=true（待核实，不硬判）。
 * - 禁止 LLM 参与打分——本模块是唯一判分路径。
 *
 * 表达式语言（自研，无 eval）：
 *   number | 'string' | true | false | identifier | tag
 *   + - * / ，括号，min/max/abs/clamp
 *   == != > < >= <= ，&& ||
 *   `tag == 'x'` 表示标签成员判断。
 */

export class MissingFeatureError extends Error {
  readonly feature: string
  constructor(feature: string) {
    super(`missing feature: ${feature}`)
    this.name = 'MissingFeatureError'
    this.feature = feature
  }
}

export class ExpressionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExpressionError'
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 词法
 * ═══════════════════════════════════════════════════════════════════════════ */

type Tok =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'id'; v: string }
  | { k: 'op'; v: string }

function tokenize(src: string): Tok[] {
  const toks: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++
      continue
    }
    if (c === "'" || c === '"') {
      let j = i + 1
      let s = ''
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) {
          s += src[j + 1]
          j += 2
          continue
        }
        s += src[j]
        j++
      }
      if (j >= src.length) throw new ExpressionError(`unterminated string in: ${src}`)
      toks.push({ k: 'str', v: s })
      i = j + 1
      continue
    }
    if (/[0-9]/.test(c)) {
      let j = i
      while (j < src.length && /[0-9._]/.test(src[j])) j++
      const raw = src.slice(i, j).replace(/_/g, '')
      const v = Number(raw)
      if (!Number.isFinite(v)) throw new ExpressionError(`bad number ${raw} in: ${src}`)
      toks.push({ k: 'num', v })
      i = j
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++
      // 允许 `<ID>.<attr>` 形态与带连字符的 ID 段继续拼接
      while (
        j < src.length &&
        (src[j] === '.' ||
          (src[j] === '-' && j + 1 < src.length && /[A-Za-z0-9_]/.test(src[j + 1])))
      ) {
        if (src[j] === '.') {
          j++
          while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++
        } else {
          j++
          while (j < src.length && /[A-Za-z0-9_-]/.test(src[j])) j++
        }
      }
      toks.push({ k: 'id', v: src.slice(i, j) })
      i = j
      continue
    }
    const two = src.slice(i, i + 2)
    if (['==', '!=', '>=', '<=', '&&', '||'].includes(two)) {
      toks.push({ k: 'op', v: two })
      i += 2
      continue
    }
    if ('+-*/()<>=!,'.includes(c)) {
      toks.push({ k: 'op', v: c })
      i++
      continue
    }
    throw new ExpressionError(`unexpected character '${c}' in: ${src}`)
  }
  return toks
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 语法（递归下降）
 * ═══════════════════════════════════════════════════════════════════════════ */

type Node =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'id'; name: string }
  | { t: 'tag' }
  | { t: 'un'; op: string; a: Node }
  | { t: 'bin'; op: string; a: Node; b: Node }
  | { t: 'call'; name: string; args: Node[] }

class Parser {
  private toks: Tok[]
  private pos = 0
  constructor(toks: Tok[]) {
    this.toks = toks
  }
  private peek(): Tok | undefined {
    return this.toks[this.pos]
  }
  private eat(op: string): boolean {
    const t = this.peek()
    if (t && t.k === 'op' && t.v === op) {
      this.pos++
      return true
    }
    return false
  }
  private expect(op: string): void {
    if (!this.eat(op)) throw new ExpressionError(`expected '${op}'`)
  }
  parse(): Node {
    const n = this.parseOr()
    if (this.pos !== this.toks.length) throw new ExpressionError('trailing tokens')
    return n
  }
  private parseOr(): Node {
    let a = this.parseAnd()
    while (this.eat('||')) a = { t: 'bin', op: '||', a, b: this.parseAnd() }
    return a
  }
  private parseAnd(): Node {
    let a = this.parseCmp()
    while (this.eat('&&')) a = { t: 'bin', op: '&&', a, b: this.parseCmp() }
    return a
  }
  private parseCmp(): Node {
    const a = this.parseAdd()
    const t = this.peek()
    if (t && t.k === 'op' && ['==', '!=', '>', '<', '>=', '<='].includes(t.v)) {
      this.pos++
      return { t: 'bin', op: t.v, a, b: this.parseAdd() }
    }
    return a
  }
  private parseAdd(): Node {
    let a = this.parseMul()
    for (;;) {
      if (this.eat('+')) a = { t: 'bin', op: '+', a, b: this.parseMul() }
      else if (this.eat('-')) a = { t: 'bin', op: '-', a, b: this.parseMul() }
      else return a
    }
  }
  private parseMul(): Node {
    let a = this.parseUnary()
    for (;;) {
      if (this.eat('*')) a = { t: 'bin', op: '*', a, b: this.parseUnary() }
      else if (this.eat('/')) a = { t: 'bin', op: '/', a, b: this.parseUnary() }
      else return a
    }
  }
  private parseUnary(): Node {
    if (this.eat('-')) return { t: 'un', op: '-', a: this.parseUnary() }
    if (this.eat('!')) return { t: 'un', op: '!', a: this.parseUnary() }
    return this.parsePrimary()
  }
  private parsePrimary(): Node {
    const t = this.peek()
    if (!t) throw new ExpressionError('unexpected end')
    if (t.k === 'num') {
      this.pos++
      return { t: 'num', v: t.v }
    }
    if (t.k === 'str') {
      this.pos++
      return { t: 'str', v: t.v }
    }
    if (t.k === 'op' && t.v === '(') {
      this.pos++
      const n = this.parseOr()
      this.expect(')')
      return n
    }
    if (t.k === 'id') {
      this.pos++
      if (t.v === 'true') return { t: 'bool', v: true }
      if (t.v === 'false') return { t: 'bool', v: false }
      if (t.v === 'tag') return { t: 'tag' }
      const next = this.peek()
      if (next && next.k === 'op' && next.v === '(') {
        this.pos++
        const args: Node[] = []
        if (!this.eat(')')) {
          args.push(this.parseOr())
          while (this.eat(',')) args.push(this.parseOr())
          this.expect(')')
        }
        return { t: 'call', name: t.v, args }
      }
      return { t: 'id', name: t.v }
    }
    throw new ExpressionError(`unexpected token ${JSON.stringify(t)}`)
  }
}

function parseExpr(src: string): Node {
  return new Parser(tokenize(src)).parse()
}

/**
 * 表达式语法校验（validate 层用）：非法返回错误消息，合法返回 null。
 * 在包质量门禁拦截，避免坏表达式到运行时才暴露（排除规则求值异常原先
 * 被静默吞成「不匹配」——方向保守但不可见；语法错误现在在 validate 报 error）。
 */
export function validateExpression(src: string): string | null {
  try {
    parseExpr(src)
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 求值
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface EvalEnv {
  features: Record<string, number | string>
  tags: string[]
  /** true 时缺失特征抛 MissingFeatureError；false 返回 undefined。 */
  strictMissing?: boolean
}

type Val = number | string | boolean | undefined

function truthy(v: Val): boolean {
  if (v === undefined || v === false) return false
  if (v === true) return true
  if (typeof v === 'number') return v !== 0
  return v.length > 0
}

function num(v: Val, ctx: string): number {
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  throw new ExpressionError(`expected number for ${ctx}, got ${String(v)}`)
}

function evalNode(n: Node, env: EvalEnv): Val {
  switch (n.t) {
    case 'num':
      return n.v
    case 'str':
      return n.v
    case 'bool':
      return n.v
    case 'tag':
      // `tag` 只用于 `tag == 'x'` / `tag != 'x'` 成员判断
      return 'tag'
    case 'id': {
      const v = env.features[n.name]
      if (v === undefined) {
        if (env.strictMissing) throw new MissingFeatureError(n.name)
        return undefined
      }
      return v
    }
    case 'un': {
      const a = evalNode(n.a, env)
      if (n.op === '-') return -num(a, 'unary -')
      return !truthy(a)
    }
    case 'call': {
      const args = n.args.map((a) => evalNode(a, env))
      switch (n.name) {
        case 'min':
          return Math.min(...args.map((a, i) => num(a, `min#${i}`)))
        case 'max':
          return Math.max(...args.map((a, i) => num(a, `max#${i}`)))
        case 'abs':
          return Math.abs(num(args[0], 'abs'))
        case 'clamp':
          return Math.min(num(args[2], 'clamp'), Math.max(num(args[1], 'clamp'), num(args[0], 'clamp')))
        default:
          throw new ExpressionError(`unknown function ${n.name}`)
      }
    }
    case 'bin': {
      if (n.op === '&&') return truthy(evalNode(n.a, env)) ? evalNode(n.b, env) : false
      if (n.op === '||') return truthy(evalNode(n.a, env)) ? true : evalNode(n.b, env)
      const a = evalNode(n.a, env)
      const b = evalNode(n.b, env)
      switch (n.op) {
        case '+':
          return typeof a === 'string' || typeof b === 'string'
            ? String(a ?? '') + String(b ?? '')
            : num(a, '+') + num(b, '+')
        case '-':
          return num(a, '-') - num(b, '-')
        case '*':
          return num(a, '*') * num(b, '*')
        case '/':
          return num(a, '/') / num(b, '/')
        case '==':
          // `tag == 'x'` → 标签成员
          if (n.a.t === 'tag' && typeof b === 'string') return env.tags.includes(b)
          return a === b
        case '!=':
          if (n.a.t === 'tag' && typeof b === 'string') return !env.tags.includes(b)
          return a !== b
        case '>':
          return num(a, '>') > num(b, '>')
        case '<':
          return num(a, '<') < num(b, '<')
        case '>=':
          return num(a, '>=') >= num(b, '>=')
        case '<=':
          return num(a, '<=') <= num(b, '<=')
        default:
          throw new ExpressionError(`unknown operator ${n.op}`)
      }
    }
  }
}

/** 对外：严格求值（缺失特征抛 MissingFeatureError）。 */
export function evaluate(expression: string, env: EvalEnv): Val {
  return evalNode(parseExpr(expression), { ...env, strictMissing: env.strictMissing ?? true })
}

/** 对外：宽松求值（缺失特征 → undefined）。 */
export function evaluateLoose(expression: string, env: EvalEnv): Val {
  return evalNode(parseExpr(expression), { ...env, strictMissing: false })
}

/** 收集表达式引用的特征名（缺失检测用）。 */
export function referencedFeatures(expression: string): string[] {
  const names = new Set<string>()
  const walk = (n: Node): void => {
    switch (n.t) {
      case 'id':
        names.add(n.name)
        break
      case 'un':
        walk(n.a)
        break
      case 'bin':
        walk(n.a)
        walk(n.b)
        break
      case 'call':
        n.args.forEach(walk)
        break
      default:
        break
    }
  }
  walk(parseExpr(expression))
  return [...names]
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 规则执行
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface RuleEngineConfig {
  exclusion: Array<{
    id: string
    name: string
    action: 'drop' | 'downweight'
    factor: number | null
    condition: string
  }>
  scoring: Array<{
    id: string
    name: string
    weight: number
    expression: string
    threshold: number | null
    evidenceTemplate: string | null
  }>
}

export interface RuleCandidateInput {
  candidateId: string
  objectRef: string
  features: Record<string, number | string>
  tags: string[]
}

export interface RuleEvalCandidateResult {
  candidateId: string
  objectRef: string
  riskScore: number
  hitRuleIds: string[]
  evidenceChains: Array<{ ruleId: string; score: number; evidence: string }>
  pendingChecks: Array<{ ruleId?: string; missing?: string[]; note: string }>
  pendingVerification: boolean
}

export interface RuleEvalResult {
  candidates: RuleEvalCandidateResult[]
  excluded: Array<{ candidateId: string; ruleId: string }>
  ruleHitLog: Array<{ ruleId: string; candidateId: string; score: number; ts: string }>
}

/** 回填证据模板 `{feature}` 占位符。 */
export function fillTemplate(template: string, features: Record<string, number | string>): string {
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const v = features[name]
    return v === undefined ? '未知' : String(v)
  })
}

/**
 * 执行规则引擎：排除 → 打分 → 加权汇总。
 * `now` 用于 ruleHitLog 时间戳（测试可注入）。
 */
export function evaluateRules(
  config: RuleEngineConfig,
  candidates: RuleCandidateInput[],
  now: () => Date = () => new Date(),
): RuleEvalResult {
  const excluded: RuleEvalResult['excluded'] = []
  const survivors = applyExclusions(config.exclusion, candidates, excluded)
  const scored = scoreCandidates(config.scoring, survivors, now)
  return { candidates: scored.candidates, excluded, ruleHitLog: scored.ruleHitLog }
}

/** 排除段（before-scoring）：drop 剔除 / downweight 降权。 */
export function applyExclusions(
  exclusion: RuleEngineConfig['exclusion'],
  candidates: RuleCandidateInput[],
  excludedOut: RuleEvalResult['excluded'] = [],
): Array<RuleCandidateInput & { weightFactor: number }> {
  const out: Array<RuleCandidateInput & { weightFactor: number }> = []
  for (const cand of candidates) {
    const env: EvalEnv = { features: cand.features, tags: cand.tags, strictMissing: false }
    let dropped = false
    let weightFactor = 1
    for (const rule of exclusion) {
      let matched = false
      try {
        matched = truthy(evaluateLoose(rule.condition, env))
      } catch {
        matched = false
      }
      if (!matched) continue
      if (rule.action === 'drop') {
        excludedOut.push({ candidateId: cand.candidateId, ruleId: rule.id })
        dropped = true
        break
      }
      weightFactor *= typeof rule.factor === 'number' && Number.isFinite(rule.factor) ? rule.factor : 1
    }
    if (!dropped) out.push({ ...cand, weightFactor })
  }
  return out
}

/** 打分段：每条映射到 [0,1]，按 weight 加权；缺失特征 → 待核实不硬判。 */
export function scoreCandidates(
  scoring: RuleEngineConfig['scoring'],
  candidates: Array<RuleCandidateInput & { weightFactor?: number }>,
  now: () => Date = () => new Date(),
): { candidates: RuleEvalCandidateResult[]; ruleHitLog: RuleEvalResult['ruleHitLog'] } {
  const results: RuleEvalCandidateResult[] = []
  const ruleHitLog: RuleEvalResult['ruleHitLog'] = []

  for (const cand of candidates) {
    const weightFactor = cand.weightFactor ?? 1
    let total = 0
    const hitRuleIds: string[] = []
    const evidenceChains: RuleEvalCandidateResult['evidenceChains'] = []
    const pendingChecks: RuleEvalCandidateResult['pendingChecks'] = []

    for (const rule of scoring) {
      const needed = referencedFeatures(rule.expression).filter(
        (f) => cand.features[f] === undefined,
      )
      if (needed.length > 0) {
        pendingChecks.push({
          ruleId: rule.id,
          missing: needed,
          note: `缺失特征 ${needed.join(', ')}，待核实（不硬判）`,
        })
        continue
      }
      let raw: number
      try {
        raw = num(evaluate(rule.expression, { features: cand.features, tags: cand.tags }), rule.id)
      } catch (e) {
        pendingChecks.push({
          ruleId: rule.id,
          note: `表达式求值失败: ${e instanceof Error ? e.message : String(e)}（待核实）`,
        })
        continue
      }
      const score = Math.min(1, Math.max(0, raw))
      const weighted = score * rule.weight
      total += weighted
      const threshold = rule.threshold ?? 0
      if (score > 0 && score >= threshold) {
        hitRuleIds.push(rule.id)
      }
      if (score > 0) {
        evidenceChains.push({
          ruleId: rule.id,
          score: weighted,
          evidence: rule.evidenceTemplate
            ? fillTemplate(rule.evidenceTemplate, cand.features)
            : `规则 ${rule.id} 命中分 ${score.toFixed(3)}`,
        })
        ruleHitLog.push({
          ruleId: rule.id,
          candidateId: cand.candidateId,
          score: weighted,
          ts: now().toISOString(),
        })
      }
    }

    const riskScore = Math.min(1, Math.max(0, total * weightFactor))
    results.push({
      candidateId: cand.candidateId,
      objectRef: cand.objectRef,
      riskScore,
      hitRuleIds,
      evidenceChains,
      pendingChecks,
      pendingVerification: pendingChecks.length > 0,
    })
  }

  return { candidates: results, ruleHitLog }
}
