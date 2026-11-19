import { AsyncLocalStorage } from 'node:async_hooks'

const storage = new AsyncLocalStorage<RuntimeContext>()
const hosts = new WeakMap<object, RuntimeContext>()
let standalone: RuntimeContext | undefined

export class RuntimeContextError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'RuntimeContextError'
  }
}

/** One host's state. AsyncLocalStorage carries ownership through existing APIs. */
export class RuntimeContext {
  private readonly states = new Map<symbol, unknown>()
  private readonly stopHooks = new Set<() => void>()
  private readonly cleanupHooks = new Set<() => void>()
  private active = 0
  private stopping = false
  private closed = false
  private claimed = false

  get accepting(): boolean { return !this.stopping }
  get disposed(): boolean { return this.closed }

  assertActive(): void {
    if (this.stopping) throw new RuntimeContextError('RUNTIME_DISPOSED', '运行上下文已停用，拒绝新操作')
  }

  claim(): void {
    this.assertActive()
    if (this.claimed) throw new RuntimeContextError('RUNTIME_PROVIDER_CONFLICT', '同一宿主已有本体运行服务提供者')
    this.claimed = true
  }

  state<T>(key: symbol, create: () => T): T {
    if (this.closed) throw new RuntimeContextError('RUNTIME_DISPOSED', '运行上下文已释放')
    if (!this.states.has(key)) this.states.set(key, create())
    return this.states.get(key) as T
  }

  onStop(fn: () => void): void { this.stopHooks.add(fn) }
  onCleanup(fn: () => void): void { this.cleanupHooks.add(fn) }

  run<T>(fn: () => T): T {
    this.assertActive()
    this.active++
    let result: T
    try {
      result = storage.run(this, fn)
    } catch (error) {
      this.release()
      throw error
    }
    if (result !== null && typeof result === 'object' && Symbol.asyncIterator in result) {
      const source = result as AsyncIterable<unknown>
      const context = this
      let iterator: AsyncIterator<unknown> | undefined
      let released = false
      let returning: Promise<IteratorResult<unknown>> | undefined
      const release = () => {
        if (released) return
        released = true
        context.stopHooks.delete(stop)
        context.release()
      }
      const stream: AsyncIterableIterator<unknown> = {
        [Symbol.asyncIterator]() { return this },
        async next() {
          if (released) return { done: true, value: undefined }
          if (!context.accepting) return stream.return!()
          try {
            iterator ??= storage.run(context, () => source[Symbol.asyncIterator]())
            const next = await storage.run(context, () => iterator!.next())
            if (next.done) {
              if (returning !== undefined) await returning
              else release()
            }
            return next
          } catch (error) {
            await stream.return!()
            throw error
          }
        },
        return() {
          return returning ??= (async () => {
            try { return await storage.run(context, () => iterator?.return?.()) ?? { done: true, value: undefined } }
            finally { release() }
          })()
        },
      }
      const stop = () => { void stream.return!().catch(() => {}) }
      context.stopHooks.add(stop)
      return stream as T
    }
    if (result !== null && typeof result === 'object' && 'then' in result) {
      return Promise.resolve(result).finally(() => this.release()) as T
    }
    this.release()
    return result
  }

  bind<F extends (...args: any[]) => any>(fn: F): F {
    const context = this
    return function (this: unknown, ...args: Parameters<F>): ReturnType<F> {
      return context.run(() => fn.apply(this, args))
    } as F
  }

  dispose(): void {
    if (this.stopping) return
    this.stopping = true
    for (const fn of this.stopHooks) fn()
    this.finish()
  }

  private release(): void {
    this.active--
    this.finish()
  }

  private finish(): void {
    if (!this.stopping || this.active !== 0 || this.closed) return
    this.closed = true
    try { for (const fn of this.cleanupHooks) fn() }
    finally {
      this.states.clear()
      this.stopHooks.clear()
      this.cleanupHooks.clear()
    }
  }
}

export function createRuntimeContext(): RuntimeContext { return new RuntimeContext() }

/** Compatibility scope for standalone calls/tests; dsh hosts never use it. */
export function currentRuntimeContext(): RuntimeContext {
  return storage.getStore() ?? (standalone ??= createRuntimeContext())
}

export function runtimeState<T>(key: symbol, create: () => T): T {
  return currentRuntimeContext().state(key, create)
}

export function runtimeContextForHost(host: object): RuntimeContext {
  let context = hosts.get(host)
  if (context === undefined || !context.accepting) {
    context = createRuntimeContext()
    hosts.set(host, context)
  }
  return context
}

/** Explicit injection is useful for standalone adapters and test fixtures. */
export function provideRuntimeContext(host: object, context: RuntimeContext): void {
  context.assertActive()
  const previous = hosts.get(host)
  if (previous !== undefined && previous !== context && previous.accepting) {
    throw new RuntimeContextError('RUNTIME_PROVIDER_CONFLICT', '宿主运行上下文已登记，不允许覆盖')
  }
  hosts.set(host, context)
}

/** Stateless facade: the actual object is owned by the current runtime context. */
export function scopedRuntimeObject<T extends object>(key: symbol, create: () => T): T {
  return new Proxy({} as T, {
    get(_target, property) {
      const target = runtimeState(key, create)
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
    set(_target, property, value) {
      const target = runtimeState(key, create)
      return Reflect.set(target, property, value, target)
    },
  })
}
