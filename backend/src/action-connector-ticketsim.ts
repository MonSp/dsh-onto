/**
 * ticket-sim 模拟连接器（F1/M2-D）—— `ActionConnector` 的 HTTP 适配，kind=simulated。
 *
 * externalRef 恒来自 ticket-sim 服务的网络回执（SIM-TKT-*），不在本进程内伪造；
 * 超时/网络失败按「效应不明」抛出（对账口径，不静默当无效应失败）。
 * 执行器错误分类用真实类（instanceof ActionExecuteError / ActionNoEffectError）。
 * @module @dsh-onto/backend/action-connector-ticketsim
 */
import { ActionExecuteError, ActionNoEffectError, registerActionConnector, type ActionConnector, type ActionIntent } from './action-executor.js'

export interface TicketSimConnectorOptions {
  /** ticket-sim 服务地址（http://127.0.0.1:<port>）。 */
  baseUrl: string
  /** 调用方超时（ms）；超时 = 效应不明，走对账。缺省 5000。 */
  requestTimeoutMs?: number
  /** fetch 注入（测试用）。 */
  fetchImpl?: typeof fetch
  /** 连接器身份：id/env 覆盖（kind 恒 simulated）。 */
  identity?: { id?: string; env?: string }
}

/** 创建 ticket-sim 连接器（不注册；调 {@link registerTicketSimConnector} 或 registerActionConnector）。 */
export function createTicketSimConnector(opts: TicketSimConnectorOptions): ActionConnector {
  const baseUrl = opts.baseUrl.replace(/\/$/, '')
  const fetchImpl = opts.fetchImpl ?? fetch
  const requestTimeoutMs = opts.requestTimeoutMs ?? 5_000

  async function request(path: string, init: RequestInit): Promise<{ res: Response; body: Record<string, unknown> }> {
    let res: Response
    try {
      res = await fetchImpl(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(requestTimeoutMs) })
    } catch (e) {
      throw new Error(`ticket-sim 请求失败（效应不明，须对账）：${e instanceof Error ? e.message : String(e)}`)
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    return { res, body }
  }

  return {
    async execute(intent: ActionIntent, _actionId: string, idempotencyKey: string): Promise<{ externalRef: string }> {
      const payload = intent.payload
      const title = typeof payload.title === 'string' && payload.title.length > 0
        ? payload.title
        : `${intent.behaviorId} → ${intent.objectRef}`
      const { res, body } = await request('/tickets', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
        body: JSON.stringify({
          title,
          severity: typeof payload.severity === 'string' ? payload.severity : 'medium',
          candidateId: payload.candidateId,
          runId: payload.runId,
          objectRef: intent.objectRef,
          behaviorId: intent.behaviorId,
          payload,
        }),
      })
      if ((res.status === 201 || res.status === 200) && body.ok === true && typeof body.ticketNo === 'string') {
        return { externalRef: body.ticketNo }
      }
      if (res.status === 422) {
        throw new ActionNoEffectError(`ticket-sim 受理前拒绝：${String(body.error ?? res.status)}`)
      }
      if (typeof body.ticketNo === 'string') {
        throw new ActionExecuteError(`ticket-sim 受理后失败：${String(body.error ?? res.status)}`, body.ticketNo)
      }
      throw new Error(`ticket-sim 未知响应 ${res.status}（效应不明，须对账）`)
    },
    async compensate(_intent: ActionIntent, externalRef: string): Promise<void> {
      const { res, body } = await request(`/tickets/${encodeURIComponent(externalRef)}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'compensate' }),
      })
      if (res.status !== 200 || body.ok !== true) {
        throw new Error(`ticket-sim 补偿失败：${String(body.error ?? res.status)}`)
      }
    },
    async queryResult(_intent: ActionIntent, idempotencyKey: string) {
      let out: { res: Response; body: Record<string, unknown> }
      try {
        out = await request(`/tickets?key=${encodeURIComponent(idempotencyKey)}`, { method: 'GET' })
      } catch {
        return { state: 'unknown' as const }
      }
      if (out.res.status !== 200) return { state: 'unknown' as const }
      if (out.body.state === 'succeeded' && typeof out.body.externalRef === 'string') {
        return { state: 'succeeded' as const, externalRef: out.body.externalRef }
      }
      return { state: 'not-executed' as const }
    },
  }
}

/** 注册 ticket-sim 连接器（kind=simulated：模拟执行，结果不得当真实业务成功）。 */
export function registerTicketSimConnector(opts: TicketSimConnectorOptions): void {
  registerActionConnector(createTicketSimConnector(opts), {
    id: opts.identity?.id ?? 'ticket-sim',
    env: opts.identity?.env ?? 'local-sim',
    kind: 'simulated',
  })
}
