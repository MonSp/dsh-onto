/** Locale binder installed in apply after ctx.locale.bind(NS). */
export let t: (key: string) => string = (key) => key

export function installT(fn: (key: string) => string): void {
  t = fn
}
