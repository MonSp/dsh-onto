/**
 * React bindings installed once from the classic-script factory require('react').
 * ESM live bindings: modules import { h, useState, … } and observe values after setReact().
 */
import type * as ReactNS from 'react'

type ReactModule = typeof ReactNS

export let h: ReactModule['createElement']
export let useState: ReactModule['useState']
export let useEffect: ReactModule['useEffect']
export let useCallback: ReactModule['useCallback']
export let useMemo: ReactModule['useMemo']
export let useRef: ReactModule['useRef']
export let Fragment: ReactModule['Fragment']

export function setReact(mod: ReactModule): void {
  h = mod.createElement
  useState = mod.useState
  useEffect = mod.useEffect
  useCallback = mod.useCallback
  useMemo = mod.useMemo
  useRef = mod.useRef
  Fragment = mod.Fragment
}
