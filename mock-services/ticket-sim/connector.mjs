/**
 * ticket-sim 连接器适配 —— ActionConnector 形态的 HTTP 客户端（kind=simulated）。
 *
 * externalRef 恒来自 ticket-sim 服务的网络回执（SIM-TKT-*），不在本进程内伪造。
 * 错误类可注入：backend 集成时传入 dist/action-executor.js 的
 * ActionExecuteError / ActionNoEffectError（执行器按 instanceof 分类）；单测用本地同形类。
 */

/** 本地同形错误类（未注入时的缺省；字段与 backend 一致，便于独立测试）。 */
export class SimActionExecuteError extends Error {
  constructor(message, externalRef) {
    super(message)
    this.name = 'ActionExecuteError'
    this.externalRef = externalRef
  }
}

export class SimActionNoEffectError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ActionNoEffectError'
  }
}

/**
 * @param {object} opts
 * @param {string} opts.baseUrl            ticket-sim 服务地址（http://127.0.0.1:<port>）
 * @param {typeof SimActionExecuteError} [opts.ActionExecuteError]
 * @param {typeof SimActionNoEffectError} [opts.ActionNoEffectError]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {number} [opts.requestTimeoutMs] 调用方超时（超时=效应不明，走对账；不静默当失败）
 */
export function createTicketSimConnector(opts) {
  // trim：环境变量注入可能带首尾空白（cmd set 的经典坑），URL 拼接前先收干净。
  // 双副本之一：backend/src/action-connector-ticketsim.ts 有同一处理，改动须两处同步。
  const baseUrl = opts.baseUrl.trim().replace(/\/$/, '')
  const fetchImpl = opts.fetchImpl ?? fetch
  const requestTimeoutMs = opts.requestTimeoutMs ?? 5_000
  const ExecError = opts.ActionExecuteError ?? SimActionExecuteError
  const NoEffectError = opts.ActionNoEffectError ?? SimActionNoEffectError

  async function request(path, init) {
    let res
    try {
      res = await fetchImpl(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(requestTimeoutMs) })
    } catch (e) {
      throw new Error(`ticket-sim 请求失败（效应不明，须对账）：${e?.message ?? e}`)
    }
    const body = await res.json().catch(() => ({}))
    return { res, body }
  }

  return {
    id: 'ticket-sim',
    env: 'local-sim',
    kind: 'simulated',
    async execute(intent, actionId, idempotencyKey) {
      const payload = intent.payload ?? {}
      const title = typeof payload.title === 'string' && payload.title.length > 0
        ? payload.title
        : `${intent.behaviorId} → ${intent.objectRef}`
      const { res, body } = await request('/tickets', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
        body: JSON.stringify({
          title,
          severity: payload.severity ?? 'medium',
          candidateId: payload.candidateId,
          runId: payload.runId,
          objectRef: intent.objectRef,
          behaviorId: intent.behaviorId,
          payload,
        }),
      })
      if ((res.status === 201 || res.status === 200) && body.ok === true) {
        return { externalRef: body.ticketNo }
      }
      if (res.status === 422) {
        throw new NoEffectError(`ticket-sim 受理前拒绝：${body.error ?? res.status}`)
      }
      if (typeof body.ticketNo === 'string') {
        throw new ExecError(`ticket-sim 受理后失败：${body.error ?? res.status}`, body.ticketNo)
      }
      throw new Error(`ticket-sim 未知响应 ${res.status}（效应不明，须对账）`)
    },
    async compensate(intent, externalRef) {
      const { res, body } = await request(`/tickets/${encodeURIComponent(externalRef)}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'compensate' }),
      })
      if (res.status !== 200 || body.ok !== true) {
        throw new Error(`ticket-sim 补偿失败：${body.error ?? res.status}`)
      }
    },
    async queryResult(intent, idempotencyKey) {
      let out
      try {
        out = await request(`/tickets?key=${encodeURIComponent(idempotencyKey)}`, { method: 'GET' })
      } catch {
        return { state: 'unknown' }
      }
      if (out.res.status !== 200) return { state: 'unknown' }
      if (out.body.state === 'succeeded') return { state: 'succeeded', externalRef: out.body.externalRef }
      return { state: 'not-executed' }
    },
  }
}
