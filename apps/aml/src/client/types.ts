/** AML client structural types (classic-script half; no harness imports). */

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

export type RemoteFn = (...args: unknown[]) => Promise<unknown>

export interface Ctx {
  effect(dispose: void | (() => void), key?: string): void
  locale: LocaleRuntime
  slots: SlotsRuntime
  remote: Record<string, Record<string, RemoteFn> | undefined>
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
