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
}
