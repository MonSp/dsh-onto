/**
 * 业务动作执行器（可信执行 T4.1 / R1 可靠幂等 / R6 幂等作用域）—— 批准 / 幂等 / 失败补偿闭环。
 *
 * 威胁面（评估结论 §5 + R1/R6 复核）：O2 行为定义描述的业务动作此前只用来筛选
 * 输入行为记录（BEHAVIOR_CALL），从不执行；接入执行闭环后仍存在——
 * - 台账损坏/执行后崩溃/跨会话并发可重复调用连接器（R1）；
 * - 演练与旧执行上下文的台账被新上下文错误重放（R6）。
 *
 * 闭环口径（R1/R6 修订）：
 * - **本体治理**：动作必须是包内声明的 O2BehaviorType（behaviorId 闭合），目标对象过收权清单，
 *   锚点类型与载荷 schema 见 validateActionIntent（R4）；
 * - **批准**：每次执行经宿主系统批准卡；批准上下文摘要绑定包名/版本 + 行为契约指纹 +
 *   对象 + 载荷 + 连接器目标（R6）——上下文变化不得静默沿用旧批准；
 * - **业务幂等键（R6）**：业务操作标识（显式 operationId；缺省=同载荷即同操作）+ 行为/对象/载荷
 *   + 连接器身份与环境。演练（dryrun 环境）与真实环境天然隔离；重复同载荷业务动作 =
 *   新的显式 operationId，而不是绕过旧台账；
 * - **持久意图与互斥（R1）**：批准前原子占位（wx 创建 executing 记录）= 跨会话/跨进程互斥；
 *   连接器调用前持久化已批准意图 + `dispatched` 相位；终态原子替换落盘；
 * - **故障恢复（R1）**：台账读失败/非法 JSON/摘要不符一律 fail-closed（ACTION_LEDGER_CORRUPT），
 *   不得当作「未执行」重跑；重启遇到 `executing` 先查外部回执（connector.queryResult），
 *   有回执恢复原结果、无确定回执进 `unknown`（禁止自动二次执行）；
 *   超时 ≠ 无副作用：效应不明进 `unknown` 对账，不得直接写「无效应失败」；
 * - **失败补偿**：仅在外部回执证明已产生效应（ActionExecuteError 带单号）且可反向时触发
 *   saga 补偿；补偿失败显式留痕（compensationError 可回查）；
 * - **旧台账（R6）**：旧格式记录（无上下文字段）只读保留——同业务操作命中旧台账 fail-closed
 *   （ACTION_LEDGER_LEGACY），不删除、不当作未执行；
 * - **连接器**：`ActionConnector` 是唯一副作用出口；execute 接收完整稳定幂等键（不是 8 位
 *   展示用 actionId）；可选 queryResult 供对账；执行期间固定连接器实例。
 *
 * 设计说明（vs BEHAVIOR_CALL）：场景 pipeline 的 BEHAVIOR_CALL 仍是行为记录物化（分析口径）；
 * 业务动作**不随分析自动触发**——分析可重放、动作有真实副作用，自动触发违反「认定在人工」。
 * @module @dsh-onto/backend/action-executor
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { actionDigest, type ApprovalGrant } from './agent-approval.js'
import { AgentToolError, isRecord } from './agent-policy.js'

/** 动作意图：行为 ID + 锚点对象 + 载荷（业务动作的最小受治理面）。 */
export interface ActionIntent {
  behaviorId: string
  objectRef: string
  payload: Record<string, unknown>
}

/** 动作台账状态。`executing` 为在途；`unknown` 为效应待核实（对账，禁止自动重跑）。 */
export type ActionStatus =
  | 'executing'
  | 'succeeded'
  | 'failed'
  | 'compensated'
  | 'compensation-failed'
  | 'unknown'

/** 连接器身份与环境（R6：业务幂等键组成——演练与真实环境隔离，不依赖「当前 connector」隐含上下文）。 */
export interface ConnectorIdentity {
  id: string
  env: string
}

/** 台账记录：业务幂等键 + 批准上下文 + 执行/补偿终态（全程可回查）。 */
export interface ActionRecord {
  actionId: string
  /** 业务幂等键（台账文件名）：操作标识 + 行为/对象/载荷 + 连接器身份环境。 */
  businessKey: string
  /** 批准上下文摘要（R6）：包名/版本 + 行为契约指纹 + 对象 + 载荷 + 连接器目标。 */
  approvalContext: string
  /** 连接器身份（注册时登记；执行期间固定实例）。 */
  connector: ConnectorIdentity
  /** 显式业务操作标识（缺省 = 同载荷即同操作）。 */
  operationId?: string
  behaviorId: string
  objectRef: string
  payload: Record<string, unknown>
  status: ActionStatus
  /** executing 相位：claimed=已占位未派发；dispatched=已派发连接器（回执不明时对账）。 */
  phase?: 'claimed' | 'dispatched'
  /** 连接器回执（外部单号 / 演练单号）。 */
  externalRef?: string
  error?: string
  /** 补偿失败详情（可回查）。 */
  compensationError?: string
  approvalDigest: string
  approvedAt: string
  executedAt: string
  compensatedAt?: string
}

/**
 * 动作连接器（唯一副作用出口）：
 * - `execute(intent, actionId, idempotencyKey)`：产生外部效应；`idempotencyKey` 是完整稳定
 *   幂等键（连接器按它去重；8 位 actionId 只用于展示）；
 * - `compensate(intent, externalRef)`：反向动作（仅在回执证明已产生效应时触发）；
 * - `queryResult?(intent, idempotencyKey)`：查询前次执行结果（故障恢复对账）——
 *   `succeeded` 带回执 / `not-executed` 确认未执行 / `unknown` 效应不明。
 * execute 可抛 {@link ActionExecuteError}（携带 externalRef）表示**部分效应**；
 * 可抛 {@link ActionNoEffectError} 明确**无外部效应**；其余异常一律按效应不明处理（对账）。
 */
export interface ActionConnector {
  execute(intent: ActionIntent, actionId: string, idempotencyKey: string): Promise<{ externalRef: string }>
  compensate(intent: ActionIntent, externalRef: string): Promise<void>
  queryResult?(
    intent: ActionIntent,
    idempotencyKey: string,
  ): Promise<{ state: 'succeeded'; externalRef: string } | { state: 'not-executed' } | { state: 'unknown' }>
}

/** 连接器部分效应失败：已产生 externalRef 但动作未成——执行器据此触发补偿回滚。 */
export class ActionExecuteError extends Error {
  readonly externalRef: string

  constructor(message: string, externalRef: string) {
    super(message)
    this.name = 'ActionExecuteError'
    this.externalRef = externalRef
  }
}

/** 连接器确认无外部效应（已受理前拒绝/校验失败等）——按无效应失败留痕，不触发补偿。 */
export class ActionNoEffectError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ActionNoEffectError'
  }
}

/** 演练连接器：不触达外部系统；单号 dryrun:<幂等键>；补偿留痕不报错。 */
export const dryRunConnector: ActionConnector = {
  async execute(_intent, _actionId, idempotencyKey) {
    return { externalRef: `dryrun:${idempotencyKey}` }
  },
  async compensate() {
    /* 演练补偿：无外部效应可回滚，留痕即可 */
  },
  async queryResult() {
    return { state: 'unknown' }
  },
}

let connector: ActionConnector = dryRunConnector
let connectorIdentity: ConnectorIdentity = { id: 'dryrun', env: 'dryrun' }

/** 当前连接器身份（入台账、进业务幂等键；不依赖隐含上下文）。 */
export function currentConnectorIdentity(): ConnectorIdentity {
  return { ...connectorIdentity }
}

/**
 * 注册真实连接器（apiSources 接入点）；传 null 复位为演练连接器。
 * `identity` 须为稳定的连接器身份与环境（业务幂等键据此隔离演练/真实、租户/环境）。
 */
export function registerActionConnector(next: ActionConnector | null, identity?: ConnectorIdentity): void {
  connector = next ?? dryRunConnector
  connectorIdentity = next === null ? { id: 'dryrun', env: 'dryrun' } : (identity ?? { id: 'adhoc', env: 'adhoc' })
}

/** actions/ 目录（workspace 根之下，同 runs/ 惯例）。 */
function actionsDir(root: string): string {
  return join(root, 'actions')
}

function recordPath(root: string, businessKey: string): string {
  return join(actionsDir(root), `${businessKey}.json`)
}

/** 旧格式台账路径（R6 只读保留：无上下文字段的记录，按旧摘要命名）。 */
export function legacyRecordPath(root: string, intent: ActionIntent): string {
  return join(actionsDir(root), `${digestAction(intent)}.json`)
}

/**
 * 读台账（R1 fail-closed）：无记录 → null；损坏/非法 JSON/摘要不符 → ACTION_LEDGER_CORRUPT，
 * **不得**当作「未执行」自动重跑。
 */
export function loadActionRecord(root: string, businessKey: string): ActionRecord | null {
  const file = recordPath(root, businessKey)
  if (!existsSync(file)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new AgentToolError('ACTION_LEDGER_CORRUPT', `动作台账 ${businessKey} 无法解析——fail-closed，请人工核对（不自动重跑）`)
  }
  if (!isRecord(parsed)) {
    throw new AgentToolError('ACTION_LEDGER_CORRUPT', `动作台账 ${businessKey} 结构非法——fail-closed，请人工核对（不自动重跑）`)
  }
  const record = parsed as unknown as ActionRecord
  if (record.businessKey !== businessKey || typeof record.approvalContext !== 'string' || record.connector === undefined) {
    throw new AgentToolError('ACTION_LEDGER_CORRUPT', `动作台账 ${businessKey} 摘要/上下文不符——fail-closed，请人工核对（不自动重跑）`)
  }
  return record
}

/** 旧格式台账探测（R6）：命中即存在需人工核对的历史动作（只读保留，不删除）。 */
export function loadLegacyActionRecord(root: string, intent: ActionIntent): Record<string, unknown> | null {
  const file = legacyRecordPath(root, intent)
  if (!existsSync(file)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return isRecord(parsed) ? parsed : { raw: true }
  } catch {
    return { raw: true }
  }
}

/** 原子落盘（R1）：临时文件 + rename 替换；占位创建用 wx（唯一键事务）。 */
function saveActionRecord(root: string, record: ActionRecord, opts?: { createNew: boolean }): void {
  mkdirSync(actionsDir(root), { recursive: true })
  const file = recordPath(root, record.businessKey)
  const text = `${JSON.stringify(record, null, 2)}\n`
  if (opts?.createNew === true) {
    writeFileSync(file, text, { encoding: 'utf8', flag: 'wx' })
    return
  }
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
}

/** 释放占位（批准被拒时回收；无外部效应，不构成动作历史）。 */
function releaseClaim(root: string, businessKey: string): void {
  try {
    unlinkSync(recordPath(root, businessKey))
  } catch {
    /* 已被并发方接管/清理：忽略 */
  }
}

/** 旧口径动作摘要（R6 旧台账探测沿用；新业务幂等键见 businessKeyOf）。 */
export function digestAction(intent: ActionIntent): string {
  return actionDigest({
    action: 'execute_behavior_action',
    behaviorId: intent.behaviorId,
    objectRef: intent.objectRef,
    payload: intent.payload,
  })
}

/**
 * 业务幂等键（R6）：业务操作标识（显式 operationId；缺省 = 同载荷即同操作）
 * + 行为/对象/载荷 + 连接器身份与环境——演练与真实环境隔离，不同租户/环境不串台。
 */
export function businessKeyOf(
  intent: ActionIntent,
  identity: ConnectorIdentity,
  operationId?: string,
): string {
  return actionDigest({
    action: 'business-op',
    operationId: operationId ?? 'auto',
    behaviorId: intent.behaviorId,
    objectRef: intent.objectRef,
    payload: intent.payload,
    connectorId: identity.id,
    env: identity.env,
  })
}

/**
 * 批准上下文摘要（R6）：包名/版本 + 行为契约指纹 + 对象 + 载荷 + 连接器目标——
 * 上下文变化（新版本/行为契约改变）→ ACTION_CONTEXT_CHANGED，不静默沿用旧批准。
 */
export function approvalContextDigest(
  intent: ActionIntent,
  identity: ConnectorIdentity,
  pkg: { name: string; version: string },
  behavior: { id: string; anchor?: string; name?: string; relations?: string[]; states?: string[] },
): string {
  return actionDigest({
    action: 'execute_behavior_action',
    package: { name: pkg.name, version: pkg.version },
    behaviorContract: {
      id: behavior.id,
      anchor: behavior.anchor ?? '',
      name: behavior.name ?? '',
      relations: [...(behavior.relations ?? [])].sort(),
      states: [...(behavior.states ?? [])].sort(),
    },
    objectRef: intent.objectRef,
    payload: intent.payload,
    connectorTarget: { id: identity.id, env: identity.env },
  })
}

/**
 * 运行时对象引用（R4 契约闭合）：`TYPE:instance` 完整实例引用——
 * 类型段须为本体 ID 语法、实例段非空且不含分隔符（空实例段/裸类型/歧义引用 → null）。
 */
export function parseObjectRef(ref: string): { type: string; instance: string } | null {
  const i = ref.indexOf(':')
  if (i <= 0) return null
  const type = ref.slice(0, i)
  const instance = ref.slice(i + 1)
  if (!/^[A-Z]+-[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(type)) return null
  if (instance === '' || /[\s:]/.test(instance)) return null
  return { type, instance }
}

/** 载荷内「业务对象引用」值形态（R4：额外对象引用须纳入授权校验）。 */
const PAYLOAD_REF_RE = /^[A-Z]+-[A-Z0-9]+(?:-[A-Z0-9]+)*:[^\s:]+$/

/** 动作载荷显式 schema（R4：连接器可校验的结构契约——不把任意 JSON 直接解释成业务指令）。 */
function validatePayloadEnvelope(payload: Record<string, unknown>, isGranted?: (objectRef: string) => boolean): void {
  const MAX_DEPTH = 4
  let serialized: string
  try {
    serialized = JSON.stringify(payload)
  } catch {
    throw new AgentToolError('INVALID_ARGS', 'payload 不是可序列化的 JSON 值')
  }
  if (serialized.length > 8192) {
    throw new AgentToolError('INVALID_ARGS', 'payload 超出动作载荷上限（8KB）')
  }
  const walk = (v: unknown, depth: number, path: string): void => {
    if (depth > MAX_DEPTH) {
      throw new AgentToolError('INVALID_ARGS', `payload.${path} 嵌套过深（≤${MAX_DEPTH} 层）`)
    }
    if (v === null) return
    switch (typeof v) {
      case 'boolean':
        return
      case 'number':
        if (!Number.isFinite(v)) throw new AgentToolError('INVALID_ARGS', `payload.${path} 数字须为有限值`)
        return
      case 'string': {
        // 额外业务对象引用（TYPE:instance）纳入授权校验，不能只检查顶层锚点
        if (PAYLOAD_REF_RE.test(v) && isGranted !== undefined && !isGranted(v)) {
          throw new AgentToolError('OBJECT_NOT_GRANTED', `payload.${path} 引用对象 ${v} 未收权（deny-by-default）`)
        }
        return
      }
      case 'object': {
        if (Array.isArray(v)) {
          v.forEach((item, i) => walk(item, depth + 1, `${path}[${i}]`))
          return
        }
        const proto = Object.getPrototypeOf(v)
        if (proto !== Object.prototype && proto !== null) {
          throw new AgentToolError('INVALID_ARGS', `payload.${path} 须为纯 JSON 对象`)
        }
        for (const [k, item] of Object.entries(v)) {
          if (k === '__proto__' || k === 'constructor' || k === 'prototype') {
            throw new AgentToolError('INVALID_ARGS', `payload.${path} 含非法键 ${k}`)
          }
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
            throw new AgentToolError('INVALID_ARGS', `payload.${path} 含非法键名 ${k}`)
          }
          walk(item, depth + 1, path === '' ? k : `${path}.${k}`)
        }
        return
      }
      default:
        throw new AgentToolError('INVALID_ARGS', `payload.${path} 含非 JSON 值（${typeof v}）`)
    }
  }
  walk(payload, 0, '')
}

/**
 * 执行前校验（R4 行为与锚点的契约闭合）：
 * - 行为必须包内声明（O2 闭合）；
 * - 目标对象须为完整实例引用（`TYPE:instance`），且类型与 `behavior.anchor` 一致
 *   （已收权但锚点类型不符 = 契约缺口，拒绝且不弹批准卡）；
 * - 载荷过显式 schema（纯 JSON 树 + 键名/深度/规模），其中的业务对象引用须逐个收权。
 * 行为 ID、锚点类型及对象授权全部通过后才轮到批准卡（调用方顺序保证）。
 */
export function validateActionIntent(
  behaviors: ReadonlyArray<{ id: string; anchor?: string }>,
  intent: ActionIntent,
  opts?: { isGranted?: (objectRef: string) => boolean },
): void {
  const decl = behaviors.find((b) => b.id === intent.behaviorId)
  if (decl === undefined) {
    throw new AgentToolError('INVALID_ARGS', `行为 ${intent.behaviorId} 未在包内声明（O2 闭合）——动作必须是本体治理的行为`)
  }
  const target = parseObjectRef(intent.objectRef)
  if (target === null) {
    throw new AgentToolError(
      'INVALID_ARGS',
      `对象 ${intent.objectRef} 不是完整实例引用（须为 TYPE:instance）——类型本身/空实例段/歧义引用不得作为动作目标`,
    )
  }
  if (decl.anchor !== undefined && target.type !== decl.anchor) {
    throw new AgentToolError(
      'INVALID_ARGS',
      `行为 ${intent.behaviorId} 锚点为 ${decl.anchor}，目标对象类型 ${target.type} 与锚点不符——该行为不适用于此对象`,
    )
  }
  if (!isRecord(intent.payload)) {
    throw new AgentToolError('INVALID_ARGS', 'payload 必须是 JSON 对象')
  }
  validatePayloadEnvelope(intent.payload, opts?.isGranted)
}

export interface ExecuteActionInput {
  root: string
  intent: ActionIntent
  /** 批准上下文绑定面（R6）：包名/版本 + 行为契约指纹进上下文摘要。 */
  pkg: { name: string; version: string }
  behavior: { id: string; anchor?: string; name?: string; relations?: string[]; states?: string[] }
  /** 显式业务操作标识（R6）：重复同载荷业务动作 = 新 operationId（新批准、新台账）。 */
  operationId?: string
  /**
   * 批准回调（占位成功后调用——同键并发第二路不重复弹卡）。
   * 入参是批准上下文摘要（绑定包/契约/对象/载荷/连接器目标）。
   */
  requestGrant: (contextDigest: string) => Promise<ApprovalGrant>
  /** 同键在途等待（ms）：第二路等待回读；0 = 立即 ACTION_IN_FLIGHT。缺省 2000。 */
  inFlightWaitMs?: number
}

export interface ExecuteActionResult {
  record: ActionRecord
  /** true = 本次未执行、回读既有记录（note 说明回读的是哪次业务操作与环境）。 */
  replayed: boolean
  note?: string
}

function replayNote(record: ActionRecord): string {
  const op = record.operationId ?? 'auto'
  return `回读业务操作 ${op}（连接器 ${record.connector.id}，环境 ${record.connector.env}）`
}

/** 在途记录处置（R1 并发互斥）：有界等待回读；超时后 dispatched 相位按外部回执对账恢复。 */
async function handleInFlight(
  root: string,
  businessKey: string,
  conn: ActionConnector,
  waitMs: number,
): Promise<ExecuteActionResult> {
  const deadline = Date.now() + waitMs
  for (;;) {
    const record = loadActionRecord(root, businessKey)
    if (record === null) {
      throw new AgentToolError(
        'ACTION_IN_FLIGHT',
        `业务操作 ${businessKey.slice(0, 12)} 的占位已被回收——稍后重试（不重复批准/执行）`,
      )
    }
    if (record.status !== 'executing') {
      return { record, replayed: true, note: replayNote(record) }
    }
    if (Date.now() >= deadline) {
      // 超时：dispatched 相位先查外部回执（崩溃恢复/效应对账）；其余（含批准在途）不打扰
      if (record.phase === 'dispatched' && conn.queryResult !== undefined) {
        return recoverInFlight(root, record, conn)
      }
      throw new AgentToolError(
        'ACTION_IN_FLIGHT',
        `业务操作 ${businessKey.slice(0, 12)} 正在执行中（跨会话互斥占位）——不重复批准/执行；稍后回读台账确认结果`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(5, waitMs))))
  }
}

/** 恢复在途记录（R1）：查外部回执 → 恢复/对账；禁止自动二次执行。 */
async function recoverInFlight(root: string, record: ActionRecord, conn: ActionConnector): Promise<ExecuteActionResult> {
  const intent: ActionIntent = {
    behaviorId: record.behaviorId,
    objectRef: record.objectRef,
    payload: record.payload,
  }
  let outcome: Awaited<ReturnType<NonNullable<ActionConnector['queryResult']>>> | undefined
  try {
    outcome = await conn.queryResult?.(intent, record.businessKey)
  } catch {
    outcome = undefined
  }
  if (outcome !== undefined) {
    if (outcome.state === 'succeeded') {
      const settled: ActionRecord = {
        ...record,
        status: 'succeeded',
        externalRef: outcome.externalRef,
        executedAt: record.executedAt || new Date().toISOString(),
      }
      saveActionRecord(root, settled)
      return { record: settled, replayed: true, note: `${replayNote(settled)}——崩溃恢复：按外部回执 ${outcome.externalRef} 恢复，不重跑` }
    }
    if (outcome?.state === 'not-executed') {
      const settled: ActionRecord = {
        ...record,
        status: 'failed',
        error: '外部确认未执行（对账通过）：无业务效应',
        executedAt: record.executedAt || new Date().toISOString(),
      }
      saveActionRecord(root, settled)
      return { record: settled, replayed: true, note: `${replayNote(settled)}——外部确认无效应，按失败留痕（不自动重跑）` }
    }
  }
  // 无确定回执 → 效应待核实（对账）：禁止自动二次执行
  const unknown: ActionRecord = {
    ...record,
    status: 'unknown',
    error: record.error ?? '执行中断且无确定外部回执——效应待核实（人工对账后处置）',
  }
  saveActionRecord(root, unknown)
  return { record: unknown, replayed: true, note: `${replayNote(unknown)}——效应待核实，不自动重跑` }
}

/**
 * 执行闭环（R1/R6）：
 * 旧台账 fail-closed → 既有记录核对（重放/上下文冲突/在途恢复）→ 原子占位（互斥）
 * → 系统批准卡 → 持久已批意图 → 连接器执行（固定实例 + 完整幂等键）
 * → 失败按效应面补偿/对账 → 终态原子落盘。
 */
export async function executeBehaviorAction(
  input: ExecuteActionInput,
): Promise<ExecuteActionResult> {
  const { root, intent, pkg, behavior, operationId, requestGrant } = input
  const conn = pinConnector() // 执行期间固定连接器实例（执行/补偿不换注册）
  const identity = currentConnectorIdentity()
  const businessKey = businessKeyOf(intent, identity, operationId)
  const contextDigest = approvalContextDigest(intent, identity, pkg, behavior)
  const waitMs = input.inFlightWaitMs ?? 2000

  // R6：旧格式台账只读保留 + fail-closed——不删除、不当作「未执行」重跑
  if (operationId === undefined) {
    const legacy = loadLegacyActionRecord(root, intent)
    if (legacy !== null) {
      throw new AgentToolError(
        'ACTION_LEDGER_LEGACY',
        `动作 ${intent.behaviorId} ${intent.objectRef} 命中旧格式台账（无上下文字段）——只读保留待人工核对，`
          + '不自动重放也不自动重跑；确需重复同载荷业务动作时请用显式 operationId 发起新业务操作',
      )
    }
  }

  const existing = loadActionRecord(root, businessKey)
  if (existing !== null) {
    if (existing.status === 'executing') {
      return handleInFlight(root, businessKey, conn, waitMs)
    }
    if (existing.approvalContext !== contextDigest) {
      throw new AgentToolError(
        'ACTION_CONTEXT_CHANGED',
        `业务操作 ${businessKey.slice(0, 12)} 的批准上下文已变化（包版本/行为契约/连接器目标）——`
          + '不静默回读旧结果、不直接再执行；请人工检查并外部对账后以新的业务操作标识发起',
      )
    }
    return { record: existing, replayed: true, note: replayNote(existing) }
  }

  // 原子占位（跨会话/跨进程互斥）：wx 创建 = 唯一键事务
  const actionId = `act-${businessKey.slice(0, 12)}`
  const base = {
    actionId,
    businessKey,
    approvalContext: contextDigest,
    connector: identity,
    ...(operationId !== undefined ? { operationId } : {}),
    behaviorId: intent.behaviorId,
    objectRef: intent.objectRef,
    payload: intent.payload,
  }
  const claim: ActionRecord = {
    ...base,
    status: 'executing',
    phase: 'claimed',
    approvalDigest: '',
    approvedAt: '',
    executedAt: '',
  }
  try {
    saveActionRecord(root, claim, { createNew: true })
  } catch {
    // 占位失败 = 已有同键记录（并发方抢先）→ 等待回读，不重复批准/执行
    return handleInFlight(root, businessKey, conn, waitMs)
  }

  // 批准卡（占位后）：同键并发第二路不会走到这里
  let grant: ApprovalGrant
  try {
    grant = await requestGrant(contextDigest)
  } catch (e) {
    releaseClaim(root, businessKey) // 批准被拒：回收占位（无外部效应）
    throw e
  }
  const approved: ActionRecord = {
    ...claim,
    approvalDigest: grant.approvalDigest,
    approvedAt: grant.approvedAt,
  }
  saveActionRecord(root, approved)

  // 派发（先持久 dispatched 相位，再调连接器——崩溃窗口可对账）
  const dispatched: ActionRecord = { ...approved, phase: 'dispatched', executedAt: new Date().toISOString() }
  saveActionRecord(root, dispatched)

  let externalRef: string | undefined
  try {
    const out = await conn.execute(intent, actionId, businessKey)
    externalRef = out.externalRef
    const record: ActionRecord = {
      ...dispatched,
      status: 'succeeded',
      externalRef,
    }
    saveActionRecord(root, record)
    return { record, replayed: false }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    // 效应三分（R1）：带单号 = 效应已产生 → 补偿；显式无效应 → failed；其余 → 效应不明（对账）
    if (e instanceof ActionExecuteError) {
      let status: ActionStatus = 'compensated'
      let compensatedAt: string | undefined
      let compensationError: string | undefined
      try {
        await conn.compensate(intent, e.externalRef)
        compensatedAt = new Date().toISOString()
      } catch (compErr) {
        status = 'compensation-failed'
        compensationError = compErr instanceof Error ? compErr.message : String(compErr)
      }
      const record: ActionRecord = {
        ...dispatched,
        status,
        externalRef: e.externalRef,
        error,
        ...(compensatedAt !== undefined ? { compensatedAt } : {}),
        ...(compensationError !== undefined ? { compensationError } : {}),
      }
      saveActionRecord(root, record)
      throw new AgentToolError(
        'ACTION_FAILED',
        `动作执行失败（${status}，台账 ${actionId}）：${error}`,
      )
    }
    if (e instanceof ActionNoEffectError) {
      const record: ActionRecord = { ...dispatched, status: 'failed', error }
      saveActionRecord(root, record)
      throw new AgentToolError(
        'ACTION_FAILED',
        `动作执行失败（failed，台账 ${actionId}）：${error}`,
      )
    }
    // 超时/中断等效应不明：不写「无效应失败」、不补偿（无回执）——对账待核实
    const record: ActionRecord = {
      ...dispatched,
      status: 'unknown',
      error: `${error}（效应不明——待人工对账，不自动重试）`,
    }
    saveActionRecord(root, record)
    throw new AgentToolError(
      'ACTION_UNKNOWN_EFFECT',
      `动作执行中断（效应待核实，台账 ${actionId}）：${error}——超时/中断不等于无副作用，须外部对账后再处置`,
    )
  }
}

/** 固定连接器实例（执行与补偿之间不换注册）。 */
function pinConnector(): ActionConnector {
  return connector
}

