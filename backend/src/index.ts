/**
 * Host entry of @dsh-onto/backend —— named `apply` only（禁止 default export 混用）。
 * @module @dsh-onto/backend
 */
import type { Context } from '@deepseek-ai/cordis'
import * as agentSkills from './agent-skills.js'
import * as agentTools from './agent-tools.js'
import {
  OntoDerive,
  OntoKnowledge,
  OntoModel,
  OntoRuntime,
  OntoValidate,
  OntoWorkspace,
} from './services.js'
import { registerTicketSimConnector } from './action-connector-ticketsim.js'
import { registerExtApiConnector } from './action-connector-ext.js'
import { createExtDataConnector } from './data-source-ext.js'
import { dataSources } from './data-sources.js'
import { businessPolicy, createLazyUserResolver } from './business-policy.js'
import { setFormalActionEnabled } from './action-executor.js'

export * from './services.js'
export * from './agent-hooks.js'

/**
 * 注册全部 dsh-onto* wire 服务与 agent 工具/skill 面。
 * @param ctx - Cordis context supplied by the dsh loader.
 */
export function apply(ctx: Context): void {
  ctx.plugin(OntoWorkspace)
  ctx.plugin(OntoModel)
  ctx.plugin(OntoValidate)
  ctx.plugin(OntoDerive)
  ctx.plugin(OntoKnowledge)
  ctx.plugin(OntoRuntime)
  // agent 面按服务依赖各自挂载：tools/skills 缺席只跳过对应能力。
  ctx.plugin(agentTools)
  ctx.plugin(agentSkills)
  // F1 模拟连接器（kind=simulated）：显式配置 DSH_TICKET_SIM_URL 才注册（缺省 dryrun，不触达外部）。
  const ticketSimUrl = process.env.DSH_TICKET_SIM_URL
  if (typeof ticketSimUrl === 'string' && ticketSimUrl !== '') {
    registerTicketSimConnector({ baseUrl: ticketSimUrl })
    console.log('[dsh-onto] ticket-sim connector registered (kind=simulated):', ticketSimUrl)
  }
  // M3/F2 外部业务 API：显式配置才注册。client_credentials（DSH_EXT_API_CLIENT_ID/SECRET）
  // 优先——自动续签（静态 token 必然过期）；DSH_EXT_API_TOKEN 仅作静态兼容。
  // 演练 kind=simulated；真实验收经 DSH_EXT_API_KIND=formal 走正式动作开关。
  const extApiUrl = process.env.DSH_EXT_API_URL
  const extClientId = process.env.DSH_EXT_API_CLIENT_ID
  const extClientSecret = process.env.DSH_EXT_API_CLIENT_SECRET
  const extApiToken = process.env.DSH_EXT_API_TOKEN
  const hasCreds = typeof extClientId === 'string' && extClientId !== ''
    && typeof extClientSecret === 'string' && extClientSecret !== ''
  const hasStatic = typeof extApiToken === 'string' && extApiToken !== ''
  if (typeof extApiUrl === 'string' && extApiUrl !== '' && (hasCreds || hasStatic)) {
    const extKind = process.env.DSH_EXT_API_KIND === 'formal' ? 'formal' : 'simulated'
    const auth = hasCreds
      ? { clientId: extClientId as string, clientSecret: extClientSecret as string }
      : { token: extApiToken as string }
    registerExtApiConnector({
      baseUrl: extApiUrl,
      ...auth,
      identity: { id: 'ext-api', env: 'test', kind: extKind },
    })
    dataSources.register('ext-api', createExtDataConnector({ baseUrl: extApiUrl, ...auth, kind: extKind }))
    console.log('[dsh-onto] ext-api connector + data source registered (kind=' + extKind
      + ', auth=' + (hasCreds ? 'client_credentials' : 'static') + '):', extApiUrl)
  }
  // M1-C 六元组身份提供者：userId 优先取宿主账号会话（可信宿主，迟到读取），部署断言 DSH_BIZ_USER_ID 兜底；
  // tenant/roles/dataScope 只认部署断言（环境变量；账号服务不承载业务角色），不认工具参数自称。
  // 拿不到完整身份 → null（正式模式保持关闭，不以自由字符串替代身份集成）。
  // roles 只认部署断言（DSH_BIZ_ROLES）——模型/工具参数自称的角色一律无效。
  const resolveHostUserId = createLazyUserResolver(async () => {
    const svc = (ctx as {
      deepseekAccount?: { getDeviceIdentity?: () => Promise<{ userId?: unknown }> }
    }).deepseekAccount
    if (svc === undefined || typeof svc.getDeviceIdentity !== 'function') return null
    const id = await svc.getDeviceIdentity()
    return typeof id?.userId === 'string' ? id.userId : null
  }, 5_000)
  businessPolicy.setIdentityProvider(() => {
    const userId = resolveHostUserId() ?? process.env.DSH_BIZ_USER_ID
    const tenant = process.env.DSH_BIZ_TENANT
    const roles = (process.env.DSH_BIZ_ROLES ?? '').split(',').map((r) => r.trim()).filter((r) => r !== '')
    if (typeof userId !== 'string' || userId === '' || typeof tenant !== 'string' || tenant === '' || roles.length === 0) {
      return null
    }
    const types = (process.env.DSH_BIZ_SCOPE_TYPES ?? '').split(',').map((t) => t.trim()).filter((t) => t !== '')
    const filter = process.env.DSH_BIZ_SCOPE_FILTER
    return {
      userId,
      tenant,
      roles,
      dataScope: {
        objectTypes: types,
        ...(typeof filter === 'string' && filter !== '' ? { instanceFilter: filter } : {}),
      },
    }
  })
  // 正式动作总开关（部署面）：DSH_FORMAL_ACTION_ENABLED=1 由用户在部署侧显式开启——
  // AI/工具面不得代开（方案红线）。缺省关闭：formal 动作一律 FORMAL_ACTION_DISABLED（零外部效应）。
  if (process.env.DSH_FORMAL_ACTION_ENABLED === '1') {
    setFormalActionEnabled(true)
    console.log('[dsh-onto] formal action ENABLED by deployment config')
  }
}
