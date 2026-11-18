/**
 * 人审批准闸（可信人审 T2.1）—— 不可伪造的批准凭证。
 *
 * 威胁面：`humanApproved: true` 是模型可写的布尔量，不构成真实审批事件。
 * 防线：人审写动作在工具执行体内经宿主 ApprovalService（@deepseek-ai/dsh-user-approval）
 * 向用户发实况批准卡；只有服务回执 `'allowed-once'` 才放行。审批问答成对落会话
 * 事件（`approval/asked`/`approval/decided`），模型无法伪造或重放。
 *
 * 摘要绑定：批准前对动作载荷（草案 ID + 内容指纹 + 目标包）算摘要并写进批准卡
 * reason；批准回执与随后落库之间草案内容漂移 → `APPROVAL_STALE` 拒绝，凭证不跨内容生效。
 *
 * fail-closed：无审批面（服务缺席 / 无会话 agent）一律拒绝——宁可不可用，
 * 不可伪造。工作台画布 ✓/✕ 是独立的人审面（wire reviewCandidate），不经本闸。
 * @module @dsh-onto/runtime/agent-approval
 */
import { createHash } from 'node:crypto'
import { AgentToolError } from './agent-policy.js'

/** 工具执行上下文（dsh-tools ToolExecutionInput 的最小结构面：callId/agent/signal）。 */
export interface ToolExecCtx {
  readonly callId?: string
  readonly agent?: unknown
  readonly signal?: AbortSignal
}

/** 宿主审批面（ApprovalService.request 的最小结构面；不硬依赖 harness 包）。 */
export interface ApprovalLike {
  request(req: {
    agent: unknown
    toolName: string
    callId?: string
    reason?: string
    signal?: AbortSignal
  }): Promise<unknown>
}

/** 一次人审请求：动作语义 + 内容摘要 + 给批准卡看的摘要行。 */
export interface ApprovalAsk {
  toolName: string
  action: string
  /** 动作载荷指纹（先算后问；回执后复核）。 */
  digest: string
  summary: string
}

/** 批准回执（放行后随 review 留痕）。 */
export interface ApprovalGrant {
  approvalDigest: string
  approvedAt: string
}

/**
 * 键序稳定的 canonical JSON（与 runstore 同口径：对象键排序，数组保序）。
 * undefined/NaN/±Infinity 用裸标记（JSON.stringify 永不产出的形态）与字面 null 区分——
 * 摘要碰撞会让不同载荷共用同一批准凭证（凭证跨内容生效），故不可塌缩成 'null'。
 */
function canonicalJson(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return Number.isNaN(value) ? 'NaN' : value > 0 ? 'Infinity' : '-Infinity'
  }
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const rec = value as Record<string, unknown>
  const keys = Object.keys(rec).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`).join(',')}}`
}

/** 动作载荷指纹：sha256(canonicalJson(parts))。 */
export function actionDigest(parts: unknown): string {
  return createHash('sha256').update(canonicalJson(parts)).digest('hex')
}

/** 草案行（摘要绑定用）：ID + 定位 + 载荷全量参与指纹。 */
export interface DigestDraftRow {
  id: string
  layer: string
  targetKind: string
  targetId?: string
  op?: string
  name: string
  payload: unknown
}

/** 批次指纹：ID 排序后逐条哈希（绑定「批准的就是这批内容」）。 */
export function digestDraftBatch(packageName: string, version: string, rows: DigestDraftRow[]): string {
  const items = rows
    .map((r) => ({
      id: r.id,
      layer: r.layer,
      targetKind: r.targetKind,
      targetId: r.targetId ?? '',
      op: r.op ?? '',
      name: r.name,
      payload: r.payload,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return actionDigest({ action: 'apply_draft', name: packageName, version, items })
}

/**
 * 向宿主审批面请求人审放行。仅 `'allowed-once'` 通过；
 * `'rejected'/'cancelled'/'unavailable'` 与审批面缺席一律拒绝（fail-closed）。
 */
export async function requestHostApproval(
  host: { approval?: ApprovalLike },
  exec: ToolExecCtx | undefined,
  ask: ApprovalAsk,
): Promise<ApprovalGrant> {
  // 迟到读取：审批服务可能晚于本插件加载，调用时取而非注册时取。
  const approval = host.approval
  const agent = exec?.agent
  if (approval === undefined || approval === null || agent === undefined || agent === null) {
    throw new AgentToolError(
      'APPROVAL_UNAVAILABLE',
      `人审闸不可用（fail-closed）：「${ask.action}」需要宿主审批面（ApprovalService + 会话 agent）。`
        + '请在带审批面的宿主会话中执行；工作台人审面（画布 ✓/✕）不受影响。',
    )
  }
  const reason = `人审请求：${ask.action}（批次摘要 ${ask.digest.slice(0, 12)}）——${ask.summary}`
  let outcome: unknown
  try {
    outcome = await approval.request({
      agent,
      toolName: ask.toolName,
      ...(exec?.callId !== undefined ? { callId: exec.callId } : {}),
      reason,
      ...(exec?.signal !== undefined ? { signal: exec.signal } : {}),
    })
  } catch (e) {
    throw new AgentToolError(
      'APPROVAL_UNAVAILABLE',
      `人审闸请求失败（fail-closed）：${e instanceof Error ? e.message : String(e)}`,
    )
  }
  if (outcome !== 'allowed-once') {
    throw new AgentToolError(
      'APPROVAL_DENIED',
      `人审未放行（${String(outcome)}）：「${ask.action}」已取消。`
        + '仅当用户在系统批准卡上点允许后才可执行；不得以会话台词替代批准卡。',
    )
  }
  return { approvalDigest: ask.digest, approvedAt: new Date().toISOString() }
}
