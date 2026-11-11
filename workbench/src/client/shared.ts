import { useEffect, useState } from './react'
import { selectedStore } from './helpers'
import type { SelectedPkg } from './helpers'

export function useSharedSelected(): [SelectedPkg | null, (next: SelectedPkg | null) => void] {
  const [v, setV] = useState<SelectedPkg | null>(selectedStore.get())
  useEffect(() => selectedStore.subscribe(() => setV(selectedStore.get())), [])
  return [v, (next) => selectedStore.set(next)]
}
