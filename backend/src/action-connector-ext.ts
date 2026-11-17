/**
 * 外部业务 API 连接器适配（M3/F2 演练）—— `ActionConnector` 的 HTTP 适配，
 * 对接带 Bearer 认证的外部测试工单 API（真实测试 API 接入时换 baseUrl/token 即可）。
 *
 * 语义对齐：
 * - externalRef 恒来自外部回执（EXT-TKT-*），不在本进程伪造；
 * - 超时/网络失败 → 效应不明（对账口径）；受理前拒/鉴权失败/业务冲突 → 无效应；
 * - queryResult：外部回 `unknown`（未见该键）时用外部审计面收窄——审计零记录 = 确认未执行；
 * - kind 由部署配置：演练为 simulated；真实 F2 验收用 formal（受正式动作总开关约束）。
 * @module @dsh-onto/backend/action-connector-ext
 */
import {
  ActionExecuteError,
  ActionNoEffectError,
  registerActionConnector,
  type ActionConnector,
  type ActionIntent,
  type ConnectorKind,
} from './action-executor.js'

export interface ExtApiConnectorOptions {
  /** 外部测试 API 地址（http://127.0.0.1:3910）。 */
  baseUrl: string
  /** Bearer token（可信认证身份来自部署配置，不收调用方自称）。 */
  token: string
  /** 连接器身份：id/env/kind 覆盖（缺省 kind=simulated；真实验收用 formal）。 */
  identity?: { id?: string; env?: string; kind?: ConnectorKind }
  requestTimeoutMs?: number
  fetchImpl?: typeof fetch
}

export function createExtApiConnector(opts: ExtApiConnectorOptions): ActionConnector {
  const baseUrl = opts.baseUrl.trim().replace(/\/$/, '')
  const token = opts.token.trim()
  const fetchImpl = opts.fetchImpl ?? fetch
  const requestTimeoutMs = opts.requestTimeoutMs ?? 5_000

  async function request(path: string, init: RequestInit): Promise<{ res: Response; body: Record<string, unknown> }> {
    let res: Response
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(requestTimeoutMs),
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
      })
    } catch (e) {
      throw new Error(`外部 API 请求失败（效应不明，须对账）：${e instanceof Error ? e.message : String(e)}`)
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    return { res, body }
  }

  function errCode(body: Record<string, unknown>): string {
    const e = body.error
    if (e !== null && typeof e === 'object' && 'code' in e) return String((e as Record<string, unknown>).code)
    return ''
  }

  return {
    async execute(intent: ActionIntent, _actionId: string, idempotencyKey: string): Promise<{ externalRef: string }> {
      const payload = intent.payload
      const reqBody = {
        title: typeof payload.title === 'string' && payload.title.length > 0 ? payload.title : `${intent.behaviorId} → ${intent.objectRef}`,
        severity: typeof payload.severity === 'string' ? payload.severity : 'medium',
        candidateId: payload.candidateId,
        runId: payload.runId,
        objectRef: intent.objectRef,
        // 外部业务键冲突面与本地同口径：同操作标识 + 不同载荷 → 409（防御纵深，本地台账先拦）
        operationId: idempotencyKey,
        payload,
      }
      const { res, body } = await request('/api/v1/tickets', {
        method: 'POST',
        headers: { 'idempotency-key': idempotencyKey },
        body: JSON.stringify(reqBody),
      })
      const ticketNo = typeof body.ticketNo === 'string' ? body.ticketNo : undefined
      if ((res.status === 201 || res.status === 200) && ticketNo !== undefined) {
        return { externalRef: ticketNo }
      }
      if (res.status === 401 || res.status === 403) {
        throw new ActionNoEffectError(`外部 API 鉴权/越权拒绝（${res.status} ${errCode(body)}）：零外部效应`)
      }
      if (res.status === 422) {
        throw new ActionNoEffectError(`外部 API 受理前拒绝：${errCode(body) || res.status}`)
      }
      if (res.status === 409) {
        // 同操作标识不同载荷：无新效应（既有单在 body.ticketNo），按无效应失败留痕
        throw new ActionNoEffectError(`外部 API 业务键冲突（OPERATION_CONFLICT）：同操作标识载荷不一致，无新效应`)
      }
      if (ticketNo !== undefined) {
        throw new ActionExecuteError(`外部 API 受理后失败：${errCode(body) || res.status}`, ticketNo)
      }
      throw new Error(`外部 API 未知响应 ${res.status}（效应不明，须对账）`)
    },

    async compensate(_intent: ActionIntent, externalRef: string): Promise<void> {
      const { res, body } = await request(`/api/v1/tickets/${encodeURIComponent(externalRef)}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'compensate' }),
      })
      if (res.status !== 200) {
        throw new Error(`外部 API 补偿失败：${errCode(body) || res.status}`)
      }
    },

    async queryResult(_intent: ActionIntent, idempotencyKey: string) {
      let out: { res: Response; body: Record<string, unknown> }
      try {
        out = await request(`/api/v1/tickets?key=${encodeURIComponent(idempotencyKey)}`, { method: 'GET' })
      } catch {
        return { state: 'unknown' as const }
      }
      if (out.res.status !== 200) return { state: 'unknown' as const }
      if (out.body.state === 'succeeded' && typeof out.body.externalRef === 'string') {
        return { state: 'succeeded' as const, externalRef: out.body.externalRef }
      }
      if (out.body.state === 'not-executed') return { state: 'not-executed' as const }
      // 外部对未见键回 unknown：用外部审计面收窄——审计零记录 = 确认从未受理
      try {
        const audit = await request(`/api/v1/audit/operations?limit=200`, { method: 'GET' })
        const ops = Array.isArray(audit.body.items) ? (audit.body.items as Array<Record<string, unknown>>) : []
        const seen = ops.some((o) => o.idempotencyKey === idempotencyKey || o.operationId === idempotencyKey)
        return seen ? { state: 'unknown' as const } : { state: 'not-executed' as const }
      } catch {
        return { state: 'unknown' as const }
      }
    },
  }
}

/** 注册外部业务 API 连接器（演练缺省 kind=simulated；真实 F2 验收传 formal）。 */
export function registerExtApiConnector(opts: ExtApiConnectorOptions): void {
  registerActionConnector(createExtApiConnector(opts), {
    id: opts.identity?.id ?? 'ext-api',
    env: opts.identity?.env ?? 'test',
    kind: opts.identity?.kind ?? 'simulated',
  })
}
