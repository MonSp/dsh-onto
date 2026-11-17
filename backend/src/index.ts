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
}
