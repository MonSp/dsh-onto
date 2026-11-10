import type { RemoteResult } from './types'

export function errText(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e && typeof (e as { message: unknown }).message === 'string') {
    return (e as { message: string }).message
  }
  if (typeof e === 'string') return e
  try {
    return JSON.stringify(e)
  } catch {
    return String(e)
  }
}

export function unwrap<T>(result: unknown): T {
  if (result && typeof result === 'object' && 'ok' in (result as Record<string, unknown>)) {
    const r = result as RemoteResult<T>
    if (r.ok) return r.value
    throw new Error(errText(r.error))
  }
  return result as T
}

export function fmt(n: number | undefined, digits = 3): string {
  return typeof n === 'number' ? n.toFixed(digits) : '—'
}

/* ═══════════════════════════════════════════════════════════════════
 * 包选中共享态：主区工作台与右栏图谱同一来源（conversational-modeling P1 修正）
 * ═══════════════════════════════════════════════════════════════════ */

export interface SelectedPkg {
  name: string
  version: string
}

export const selectedStore = {
  value: null as SelectedPkg | null,
  listeners: new Set<() => void>(),
  get(): SelectedPkg | null {
    return this.value
  },
  set(next: SelectedPkg | null): void {
    this.value = next
    for (const fn of [...this.listeners]) fn()
  },
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  },
}
