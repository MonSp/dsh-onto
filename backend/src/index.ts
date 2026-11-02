/**
 * Host entry of @caliber/backend —— named `apply` only（禁止 default export 混用）。
 * @module @caliber/backend
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  CaliberDerive,
  CaliberKnowledge,
  CaliberModel,
  CaliberRuntime,
  CaliberValidate,
  CaliberWorkspace,
} from './services.js'

export * from './services.js'

/**
 * 注册全部 caliber* wire 服务。
 * @param ctx - Cordis context supplied by the dsh loader.
 */
export function apply(ctx: Context): void {
  ctx.plugin(CaliberWorkspace)
  ctx.plugin(CaliberModel)
  ctx.plugin(CaliberValidate)
  ctx.plugin(CaliberDerive)
  ctx.plugin(CaliberKnowledge)
  ctx.plugin(CaliberRuntime)
}
