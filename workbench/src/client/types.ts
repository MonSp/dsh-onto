/** Shared structural types for the workbench client half (no runtime side effects). */

/** Remote call result: the gateway never rejects; branch on `ok`. */
export type RemoteResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { message: string; code?: string } }

export type ReactNode = import('react').ReactNode

export interface LocaleRuntime {
  register(ns: string, dict: { zh: Record<string, string>; en: Record<string, string> }): void
  bind(ns: string): (key: string) => string
}

export interface SlotsRuntime {
  inject(name: string, register: () => unknown): void
  register(spec: Record<string, unknown>, component: unknown): unknown
}

/** 远程命名空间上的方法：返回形状由 unwrap 统一解包。 */
export type RemoteFn = (...args: unknown[]) => Promise<unknown>

export interface Ctx {
  effect(dispose: void | (() => void), key?: string): void
  locale: LocaleRuntime
  slots: SlotsRuntime
  remote: Record<string, Record<string, RemoteFn> | undefined>
  provide(name: string, value: unknown): void
  /** 右栏 tab 类型注册表（shell 的 ui-sidebar-right reflect 服务；结构面手写，零 import）。 */
  sidebarRightTabs: { register(def: SidebarRightTabDefinitionLike): () => void }
}

/** SidebarRightTabDefinition 最小结构面（与 ui-sidebar-right 对齐）。 */
export interface SidebarRightTabDefinitionLike {
  id: string
  kind: string
  priority?: 'extension' | 'builtin' | 'fallback'
  title: (address: string) => string
  guide?: Array<{ id: string; order: number; title: () => string; description?: () => string }>
}

export interface ModuleRequire {
  (id: 'react'): typeof import('react')
  (id: string): unknown
}

export interface PluginModule {
  inject?: string[]
  apply(ctx: Ctx): void
}

export interface Window {
  __ModuleLoader__: {
    load(entry: { id: string; factory(require: ModuleRequire): PluginModule }): void
  }
}
