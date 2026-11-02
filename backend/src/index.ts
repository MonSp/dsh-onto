/**
 * Host entry of @dsh-onto/backend —— named `apply` only（禁止 default export 混用）。
 * @module @dsh-onto/backend
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  OntoDerive,
  OntoKnowledge,
  OntoModel,
  OntoRuntime,
  OntoValidate,
  OntoWorkspace,
} from './services.js'

export * from './services.js'

/**
 * 注册全部 dsh-onto* wire 服务。
 * @param ctx - Cordis context supplied by the dsh loader.
 */
export function apply(ctx: Context): void {
  ctx.plugin(OntoWorkspace)
  ctx.plugin(OntoModel)
  ctx.plugin(OntoValidate)
  ctx.plugin(OntoDerive)
  ctx.plugin(OntoKnowledge)
  ctx.plugin(OntoRuntime)
}
