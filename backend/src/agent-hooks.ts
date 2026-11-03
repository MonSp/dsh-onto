/**
 * bundle 内跨模块钩子：包写入路径通知 skill 目录失效。
 * @module @dsh-onto/backend/agent-hooks
 */

const invalidators = new Set<() => void>()

/** 注册失效回调；返回注销函数（provider dispose 时调用）。 */
export function registerSkillInvalidator(fn: () => void): () => void {
  invalidators.add(fn)
  return () => {
    invalidators.delete(fn)
  }
}

/** 包内容变更（save/materialize/import）后调用，刷新 SKL skill 目录。 */
export function invalidateSkillCatalog(): void {
  for (const fn of invalidators) fn()
}
