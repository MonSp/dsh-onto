import { RuntimeContext, runtimeContextForHost } from './context.js'

function bindMethods<T extends object>(value: T, context: RuntimeContext): T {
  const copy = { ...value }
  for (const key of Reflect.ownKeys(value)) {
    const fn = Reflect.get(value, key)
    if (typeof fn === 'function') Reflect.set(copy, key, context.bind(fn as (...args: any[]) => any))
  }
  return copy
}

/** Bind deferred host callbacks without changing their schemas or receiver. */
export function bindRuntimeHost<T extends { root: object }>(
  host: T,
  context = runtimeContextForHost(host.root),
): T {
  const services = new Map<PropertyKey, object>()
  return new Proxy(host, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (property === 'on' && typeof value === 'function') {
        return (...args: unknown[]) => {
          if (args[0] !== 'dispose' && typeof args[1] === 'function') {
            args[1] = context.bind(args[1] as (...args: any[]) => any)
          }
          return value.apply(target, args)
        }
      }
      if ((property === 'tools' || property === 'skills') && value !== undefined) {
        let service = services.get(property)
        if (service !== undefined) return service
        service = new Proxy(value as object, {
          get(original, method) {
            const call = Reflect.get(original, method, original)
            if (typeof call !== 'function') return call
            return (...args: any[]) => {
              if (property === 'tools' && method === 'register') {
                const definition = bindMethods<Record<string, any>>(args[0], context)
                definition.output = bindMethods(args[0].output, context)
                args[0] = definition
                if (args[1] !== undefined) args[1] = bindMethods(args[1], context)
              } else if (property === 'tools' && method === 'guard') {
                args[0] = context.bind(args[0])
              } else if (property === 'skills' && method === 'registerProvider') {
                const factory = args[0]
                args[0] = context.bind((...input: any[]) => bindMethods(factory(...input), context))
              }
              return call.apply(original, args)
            }
          },
        })
        services.set(property, service)
        return service
      }
      return value
    },
  })
}
