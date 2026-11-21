/** React bindings from classic-script factory require('react'). */
import type * as ReactNS from 'react'

type ReactModule = typeof ReactNS

export let h: ReactModule['createElement']
export let useState: ReactModule['useState']
export let useEffect: ReactModule['useEffect']
export let Component: typeof ReactNS.Component

export function setReact(mod: ReactModule): void {
  h = mod.createElement
  useState = mod.useState
  useEffect = mod.useEffect
  Component = mod.Component
}
