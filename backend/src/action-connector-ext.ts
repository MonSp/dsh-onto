/**
 * 外部业务 API 连接器适配（M3/F2 演练）—— `ActionConnector` 的 HTTP 适配，
 * 对接带 Bearer 认证的外部测试工单 API（真实测试 API 接入时换 baseUrl/token 即可）。
 *
 * 语义对齐：
 * - externalRef 恒来自外部回执（EXT-TKT-*），不在本进程伪造；
 * - 超时/网络失败 → 效应不明（对账口径）；受理前拒/鉴权失败/业务冲突 → 无效应；
 * - queryResult：S7 三态——只有外部系统明确回执（succeeded 带回执 / not-executed）才能定终态；
 *   查无/未见键一律保持 unknown（待人工对账）——不得用审计窗口「查不到」收窄成 not-executed
 *   （分页截断/并发冲刷会把「效应不明」误判为「未执行」，人工重发 → 重复外部效应）；
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
import { createTokenProvider, staticTokenProvider, type TokenProvider } from './ext-token.js'

export interface ExtApiConnectorOptions {
  /** 外部测试 API 地址（http://127.0.0.1:3920）。 */
  baseUrl: string
  /** Bearer token（静态配置；与 client_credentials 二选一，后者优先）。 */
  token?: string
  /** OAuth2 client_credentials 自动续签（真实集成首选——静态 token 必然过期）。 */
  clientId?: string
  clientSecret?: string
  /** 签发端点（缺省 <baseUrl>/oauth/token）。 */
  tokenUrl?: string
  /** 连接器身份：id/env/kind 覆盖（缺省 kind=simulated；真实验收用 formal）。 */
  identity?: { id?: string; env?: string; kind?: ConnectorKind }
  requestTimeoutMs?: number
  fetchImpl?: typeof fetch
}

export function createExtApiConnector(opts: ExtApiConnectorOptions): ActionConnector {
  const baseUrl = opts.baseUrl.trim().replace(/\/$/, '')
  const fetchImpl = opts.fetchImpl ?? fetch
  const requestTimeoutMs = opts.requestTimeoutMs ?? 5_000
  const tokens: TokenProvider = opts.clientId !== undefined && opts.clientSecret !== undefined
    ? createTokenProvider({
        tokenUrl: opts.tokenUrl ?? `${baseUrl}/oauth/token`,
        clientId: opts.clientId,
        clientSecret: opts.clientSecret,
        fetchImpl,
      })
    : staticTokenProvider((opts.token ?? '').trim())

  async function request(path: string, init: RequestInit): Promise<{ res: Response; body: Record<string, unknown> }> {
    const send = async (): Promise<{ res: Response; body: Record<string, unknown> }> => {
      const token = await tokens.getToken()
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
    let out = await send()
    // 401 TOKEN_EXPIRED：令牌生命周期事件——失效重签后按幂等键安全重试一次
    if (out.res.status === 401 && errCode(out.body) === 'TOKEN_EXPIRED') {
      tokens.invalidate()
      out = await send()
    }
    return out
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
      // 查无/未见键 → 保持 unknown（S7 三态，待人工对账）：只有外部系统明确回执才能定终态。
      // 禁回退「审计窗口收窄」（audit/operations?limit=200 查不到即断言 not-executed）——
      // 分页截断/并发冲刷会把「效应不明」误判为「未执行」，人工重发 → 重复外部效应（fail-open）。
      return { state: 'unknown' as const }
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
