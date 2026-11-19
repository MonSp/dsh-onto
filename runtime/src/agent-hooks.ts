/**
 * bundle 内跨模块钩子：包写入路径通知 skill 目录失效。
 * @module @dsh-onto/runtime/agent-hooks
 */

import { currentRuntimeContext, runtimeState } from './context.js'

const invalidatorsKey = Symbol('skillInvalidators')
const invalidatorsFor = () => runtimeState(invalidatorsKey, () => new Set<() => void>())

/** 注册失效回调；返回注销函数（provider dispose 时调用）。 */
export function registerSkillInvalidator(fn: () => void): () => void {
  const invalidators = invalidatorsFor()
  const bound = currentRuntimeContext().bind(fn)
  invalidators.add(bound)
  return () => {
    invalidators.delete(bound)
  }
}

/** 包内容变更（save/materialize/import）后调用，刷新 SKL skill 目录。 */
export function invalidateSkillCatalog(): void {
  for (const fn of invalidatorsFor()) fn()
}
