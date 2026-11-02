/**
 * LLM 端口（规范 §5.4 边界）：只起草草案（带置信度），不做规则判定、
 * 不改已签发 Schema、不把候选写成认定。失败回落词面启发。
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DraftItem, LlmParseRequest, LlmParseResponse, LlmPort, SourceType } from './types.js'

/* ═══════════════════════════════════════════════════════════════════════════
 * 结论性表述词典（§5.3.2：禁止进入 O3 输出契约）
 * ═══════════════════════════════════════════════════════════════════════════ */

export const CONCLUSION_LEXICON = [
  '认定洗钱',
  '确定为地下钱庄',
  '已构成犯罪',
  '该客户系诈骗分子',
  '认定',
  '确定为',
  '已构成',
  '确诊',
  '属医疗事故',
  '证明了',
  '已证伪',
  '责任已归属',
  '确定舞弊',
  '该客户系',
  '必然导致',
] as const

/** 判断文本是否含结论性表述；返回命中的短语。 */
export function findConclusionPhrases(text: string): string[] {
  return CONCLUSION_LEXICON.filter((p) => text.includes(p))
}

/** 判断一条候选草案是否是结论性表述。 */
export function isConclusionLike(item: { name: string; payload: Record<string, unknown>; rationale: string }): boolean {
  const blob = `${item.name} ${item.rationale} ${JSON.stringify(item.payload)}`
  return findConclusionPhrases(blob).length > 0
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 词面启发解析（LLM 失败回落；亦是确定性测试基线）
 * ═══════════════════════════════════════════════════════════════════════════ */

function sentences(content: string): string[] {
  return content
    .split(/\r?\n|。|；|;/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

function pickName(line: string, fallback: string): string {
  const cleaned = line
    .replace(/^[#*\-\d.、\s]+/, '')
    .replace(/[=:：].*$/, '')
    .replace(/["'（）()]/g, '')
    .trim()
  return cleaned.length > 0 && cleaned.length <= 40 ? cleaned : fallback
}

function firstNumber(line: string): number | null {
  const m = /(-?\d+(?:\.\d+)?)/.exec(line)
  return m ? Number(m[1]) : null
}

/** 五类原料的词面启发路由（§5.5 prompt 路由的确定性对应实现）。 */
export function heuristicParse(request: LlmParseRequest): DraftItem[] {
  const items: DraftItem[] = []
  const lines = sentences(request.content)

  const pushConclusion = (line: string): void => {
    const phrases = findConclusionPhrases(line)
    if (phrases.length === 0) return
    items.push({
      layer: 'O3',
      targetKind: 'RedLine',
      name: `红线:${phrases[0]}`,
      payload: { phrases },
      confidence: 0.85,
      rationale: `结论性表述「${phrases.join('、')}」应落为禁语红线（禁止进输出契约）`,
    })
  }

  const pushScore = (line: string, confidence: number): void => {
    const n = firstNumber(line)
    if (n === null) return
    const weight = /权重|weight/i.test(line) ? n : undefined
    const threshold = /阈值|threshold/i.test(line) ? n : undefined
    items.push({
      layer: 'O2',
      targetKind: 'ScoreRule',
      name: pickName(line, `规则${items.length + 1}`),
      payload: {
        name: pickName(line, `规则${items.length + 1}`),
        weight: weight ?? 0,
        expression: '1',
        threshold,
        description: line,
      },
      confidence,
      rationale: `从口径行提取打分规则: ${line.slice(0, 60)}`,
    })
  }

  const pushExclusion = (line: string): void => {
    const down = /降权|downweight/i.test(line)
    const n = firstNumber(line)
    items.push({
      layer: 'O2',
      targetKind: 'ExclusionRule',
      name: pickName(line, `排除${items.length + 1}`),
      payload: {
        name: pickName(line, `排除${items.length + 1}`),
        action: down ? 'downweight' : 'drop',
        factor: down ? (n !== null && n > 0 && n <= 1 ? n : 0.5) : undefined,
        condition: extractCondition(line),
      },
      confidence: 0.78,
      rationale: `从排除/白名单口径提取: ${line.slice(0, 60)}`,
    })
  }

  const pushThresholdPolicy = (line: string): void => {
    const n = firstNumber(line)
    if (n === null) return
    if (/排除|白名单|豁免/.test(line)) {
      pushExclusion(line)
      return
    }
    pushScore(line, 0.72)
  }

  const extractCondition = (line: string): string => {
    const tag = /(?:标签|tag|类目)[为是:：]?\s*["'「]?([A-Za-z0-9_一-鿿-]+)/i.exec(line)
    if (tag) return `tag == '${tag[1]}'`
    return `tag == '${pickName(line, 'unknown')}'`
  }

  switch (request.sourceType) {
    case 'LEGACY_SYS': {
      for (const line of lines) {
        pushConclusion(line)
        if (/排除|白名单|降权|豁免/.test(line)) {
          pushExclusion(line)
        } else if (/权重|阈值|weight|threshold|占比|评分/i.test(line)) {
          pushScore(line, 0.8)
        }
      }
      // 结论性表述即使走 LLM 也禁止进 O3 输出契约——这里统一转 RedLine（§5.3.2）
      break
    }
    case 'CASE_SAMPLE': {
      const csvLines = lines.filter((l) => l.includes(','))
      if (csvLines.length >= 1) {
        const headers = csvLines[0].split(',').map((h) => h.trim()).filter(Boolean)
        if (headers.length > 0) {
          items.push({
            layer: 'O1',
            targetKind: 'ObjectType',
            name: '样本对象',
            payload: {
              name: '样本对象',
              attributes: headers.map((h) => ({ name: h, type: firstNumber(csvLines[1]?.split(',')[headers.indexOf(h)] ?? '') !== null ? 'float' : 'string' })),
            },
            confidence: 0.76,
            rationale: `从样例表头提取对象与属性: ${headers.join(', ')}`,
          })
          for (const h of headers) {
            items.push({
              layer: 'O1',
              targetKind: 'Attribute',
              name: h,
              payload: { ownerName: '样本对象', name: h, type: 'string' },
              confidence: 0.7,
              rationale: `样例列 ${h} 提取为属性`,
            })
          }
        }
        // 数值列统计口径
        const nCols = headers.length
        for (let i = 0; i < nCols; i++) {
          const col = headers[i]
          if (/amount|金额|count|笔数|次数|ratio|占比/i.test(col)) {
            items.push({
              layer: 'O2',
              targetKind: 'ScoreRule',
              name: `${col}统计口径`,
              payload: { name: `${col}统计口径`, weight: 0, expression: '1', description: `样例列 ${col} 的统计口径` },
              confidence: 0.68,
              rationale: `数值列 ${col} 提取统计口径`,
            })
          }
        }
      }
      for (const line of lines) {
        pushConclusion(line)
      }
      break
    }
    case 'POLICY': {
      for (const line of lines) {
        if (/不得|禁止|严禁|不得|不允许/.test(line)) {
          const phrases = [line.replace(/^(制度|规范|文件)?[：:]\s*/, '').slice(0, 30)]
          items.push({
            layer: 'O3',
            targetKind: 'RedLine',
            name: `红线:${phrases[0].slice(0, 12)}`,
            payload: { phrases },
            confidence: 0.88,
            rationale: `制度禁止性表述提取红线: ${line.slice(0, 60)}`,
          })
          continue
        }
        pushConclusion(line)
        if (/阈值|超过|不低于|占比|上限|下限/.test(line)) {
          pushThresholdPolicy(line)
        }
      }
      break
    }
    case 'SCHEMA_API': {
      for (const line of lines) {
        const kv = /^([\w.]+)\s*[(:：]\s*([A-Za-z_]+)\)?$/.exec(line.trim())
        const tableRow = /^\|?\s*([\w.]+)\s*\|+\s*([A-Za-z_]+)\s*\|?/.exec(line.trim())
        const field = kv ?? tableRow
        if (field) {
          items.push({
            layer: 'O1',
            targetKind: 'Attribute',
            name: field[1],
            payload: { name: field[1], type: mapFieldType(field[2] ?? 'string') },
            confidence: 0.82,
            rationale: `字段定义提取属性: ${line.slice(0, 60)}`,
          })
          continue
        }
        if (/\b(GET|POST|PUT|DELETE)\b|\/api\//.test(line)) {
          items.push({
            layer: 'O1',
            targetKind: 'ApiSource',
            name: pickName(line, `接口${items.length + 1}`),
            payload: { name: pickName(line, `接口${items.length + 1}`), sourceType: 'SCHEMA_API', endpoint: line.trim().slice(0, 120) },
            confidence: 0.8,
            rationale: `接口定义提取数据源: ${line.slice(0, 60)}`,
          })
        }
      }
      break
    }
    case 'WORK_ORDER': {
      const fields: Record<string, string> = {}
      for (const line of lines) {
        const kv = /^(目标|输入|输出|边界|结论|诉求)\s*[：:]\s*(.+)$/.exec(line.trim())
        if (kv) fields[kv[1]] = kv[2]
        pushConclusion(line)
      }
      if (Object.keys(fields).length > 0) {
        items.push({
          layer: 'O3',
          targetKind: 'ScenarioCard',
          name: fields['目标']?.slice(0, 20) ?? `场景${items.length + 1}`,
          payload: {
            name: fields['目标']?.slice(0, 20) ?? `场景${items.length + 1}`,
            goal: fields['目标'] ?? '',
            boundary: fields['边界'] ?? '',
            outputs: { fields: (fields['输出'] ?? '').split(/[、,，]/).map((s) => s.trim()).filter(Boolean) },
          },
          confidence: 0.74,
          rationale: `工单提取场景骨架: ${fields['目标'] ?? ''}`,
        })
      }
      break
    }
    default:
      break
  }

  return items
}

function mapFieldType(raw: string): 'string' | 'int' | 'float' | 'bool' | 'date' {
  const t = raw.toLowerCase()
  if (t.includes('int') || t.includes('long')) return 'int'
  if (t.includes('float') || t.includes('double') || t.includes('decimal') || t.includes('number')) return 'float'
  if (t.includes('bool')) return 'bool'
  if (t.includes('date') || t.includes('time')) return 'date'
  return 'string'
}

/** 词面启发 LLM 实现（确定性；亦是 API 失败时的回落）。 */
export class HeuristicLlm implements LlmPort {
  async parseSource(request: LlmParseRequest): Promise<LlmParseResponse> {
    return { items: heuristicParse(request) }
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * DeepSeek（OpenAI 兼容）Chat Completions 适配
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 按 §5.5 的 sourceType 路由 prompt 要点（输出统一 JSON 草案格式）。 */
export function buildPrompt(request: LlmParseRequest): { system: string; user: string } {
  const focus: Record<SourceType, string> = {
    LEGACY_SYS: '从算法/标签抽判定口径（权重/阈值/排除）；禁止输出认定；结论性表述只标记为红线候选。',
    CASE_SAMPLE: '从样例行抽实体、动作、统计口径。',
    POLICY: '抽阈值、排除项、禁语红线。',
    SCHEMA_API: '抽字段语义与映射（O1 属性/绑定）。',
    WORK_ORDER: '抽场景目标、输入输出（O3 场景骨架）。',
  }
  const system = [
    '你是业务本体建模助手。只起草草案（带置信度），不做规则判定，不输出认定。',
    '只输出一个 JSON 对象，不要 markdown 代码块、不要解释文字。',
    '格式：{"items":[{"layer":"O1|O2|O3","targetKind":"...","name":"非空字符串","payload":{...},"confidence":0到1的数字,"rationale":"依据"}]}',
    '逐条硬约束：layer 必须是 O1/O2/O3 之一；targetKind ∈ ObjectType|RelationType|Attribute|Dictionary|BehaviorType|ScoreRule|ExclusionRule|SkillTemplate|ScenarioCard|RedLine|FieldMap|ApiSource；name 非空字符串；payload 必须是对象；confidence 必须是 0..1 的数字。',
    '任一字段不合法整条会被丢弃——宁可少报不要乱报。items 可以为空数组。',
    '含「认定/确定为/已构成/确诊/证明了」等结论性表述时：targetKind=RedLine，payload.phrases 给出短语。',
    focus[request.sourceType],
  ].join('\n')
  return { system, user: `包：${request.packageName}\n原料类型：${request.sourceType}\n内容：\n${request.content}` }
}

/**
 * 读取 `~/.dsh/.env`（KEY=VALUE，# 注释）作为进程环境的回退来源。
 * 仅解析键名对应的三个变量；值永不外泄。
 */
function readDotEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    const path = join(homedir(), '.dsh', '.env')
    if (!existsSync(path)) return out
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
      if (!m) continue
      if (m[1] === 'DEEPSEEK_API_KEY' || m[1] === 'DEEPSEEK_BASE_URL' || m[1] === 'DEEPSEEK_MODEL') {
        out[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
      }
    }
  } catch {
    /* 回退来源不可用则只用进程环境 */
  }
  return out
}

export class DeepSeekLlm implements LlmPort {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly model: string

  constructor(opts: { baseUrl?: string; apiKey?: string; model?: string } = {}) {
    const dotEnv = readDotEnv()
    this.baseUrl = (
      opts.baseUrl ?? process.env['DEEPSEEK_BASE_URL'] ?? dotEnv['DEEPSEEK_BASE_URL'] ?? 'https://api.deepseek.com'
    ).replace(/\/$/, '')
    this.apiKey = opts.apiKey ?? process.env['DEEPSEEK_API_KEY'] ?? dotEnv['DEEPSEEK_API_KEY'] ?? ''
    this.model = opts.model ?? process.env['DEEPSEEK_MODEL'] ?? dotEnv['DEEPSEEK_MODEL'] ?? 'deepseek-chat'
  }

  async parseSource(request: LlmParseRequest): Promise<LlmParseResponse> {
    if (!this.apiKey) throw new Error('DEEPSEEK_API_KEY not configured')
    const { system, user } = buildPrompt(request)
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0,
      }),
    })
    if (!res.ok) throw new Error(`DeepSeek API ${res.status}`)
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const text = body.choices?.[0]?.message?.content ?? ''
    const jsonText = extractJson(text)
    const parsed = JSON.parse(jsonText) as { items?: DraftItem[] }
    return { items: Array.isArray(parsed.items) ? parsed.items : [] }
  }
}

function extractJson(text: string): string {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('LLM response has no JSON object')
  return text.slice(start, end + 1)
}

/** 解析引擎来源：deepseek=真实 LLM；heuristic=词面启发（含失败回落）。 */
export type ParseEngine = 'deepseek' | 'heuristic'

/**
 * 带回落的解析：LLM 失败 → 词面启发（§5.3.4）。返回实际使用的引擎。
 */
export async function parseWithFallback(
  llm: LlmPort,
  request: LlmParseRequest,
): Promise<LlmParseResponse & { engine: ParseEngine }> {
  try {
    const res = await llm.parseSource(request)
    if (res.items.length === 0) return { items: heuristicParse(request), engine: 'heuristic' }
    return { ...res, engine: llm instanceof DeepSeekLlm ? 'deepseek' : 'heuristic' }
  } catch {
    return { items: heuristicParse(request), engine: 'heuristic' }
  }
}
