import { h, useState, useEffect, useRef } from './react'
import type { ReactNode } from './types'

/* ═══════════════════════════════════════════════════════════════════
 * 小组件
 * ═══════════════════════════════════════════════════════════════════ */

export function Tag(props: { text: string; tone?: 'ok' | 'warn' | 'err' }) {
  const cls = props.tone ? `ow-tag ${props.tone}` : 'ow-tag'
  return h('span', { className: cls }, props.text)
}

export function Row(props: { label?: string; children?: ReactNode }) {
  return h(
    'div',
    { className: 'ow-row' },
    props.label ? h('span', { className: 'ow-label' }, props.label) : null,
    props.children,
  )
}

export function Card(props: { title?: string; children?: ReactNode }) {
  return h(
    'div',
    { className: 'ow-card' },
    props.title ? h('h3', { className: 'ow-h2' }, props.title) : null,
    props.children,
  )
}

/* ── 全局 toast 竖排栈：多面板同时报错不再叠在同一坐标 ────────────── */
let toastSeq = 0
const toastStack: number[] = []
const toastListeners = new Set<() => void>()

function notifyToastStack(): void {
  for (const fn of toastListeners) fn()
}

function pushToast(id: number): void {
  if (!toastStack.includes(id)) {
    toastStack.push(id)
    notifyToastStack()
  }
}

function removeToast(id: number): void {
  const i = toastStack.indexOf(id)
  if (i >= 0) {
    toastStack.splice(i, 1)
    notifyToastStack()
  }
}

function useToastStackIndex(id: number): number {
  const [idx, setIdx] = useState(() => toastStack.indexOf(id))
  useEffect(() => {
    const sync = () => setIdx(toastStack.indexOf(id))
    toastListeners.add(sync)
    sync()
    return () => {
      toastListeners.delete(sync)
    }
  }, [id])
  return idx
}

/**
 * 悬浮提示壳：fixed 右上角竖排堆叠、可点 × 关闭。
 * - text 变更（含清空后再来）→ 重新露出；
 * - 同文案重复 setError：父级须先 setError('') 再置新值（React 同值 bailout），
 *   本组件在 text 非空的每次挂载/变更 effect 里复位 hidden。
 */
function Toast(props: { text: string; kind: 'err' | 'ok'; role?: string }) {
  const idRef = useRef(0)
  if (idRef.current === 0) idRef.current = ++toastSeq
  const id = idRef.current
  const [hidden, setHidden] = useState(false)
  const text = props.text
  const idx = useToastStackIndex(id)

  useEffect(() => {
    setHidden(false)
  }, [text])

  useEffect(() => {
    if (text && !hidden) pushToast(id)
    else removeToast(id)
    return () => removeToast(id)
  }, [id, text, hidden])

  if (!text || hidden) return null
  // 估高 64 + 间隙 8：与 .ow-toast padding/两行文案大致匹配，避免完全重叠
  const top = 14 + Math.max(0, idx) * 72
  return h(
    'div',
    { className: `ow-toast ${props.kind}`, role: props.role, style: { top: `${top}px` } },
    h('span', { className: 'ow-toast-msg' }, text),
    h(
      'button',
      {
        type: 'button',
        className: 'ow-toast-x',
        'aria-label': 'close',
        onClick: () => setHidden(true),
      },
      '×',
    ),
  )
}

/** 统一错误悬浮提示：所有面板的错误一律走这里，可见不吞、可关闭。 */
export function ErrorBanner(props: { text: string }) {
  if (!props.text) return null
  // key=text：清空后再来同文案会卸载重挂，绕过「同值 bailout + hidden 残留」
  return h(Toast, { key: props.text, text: props.text, kind: 'err', role: 'alert' })
}

/** 统一成功/信息悬浮提示。 */
export function OkBanner(props: { text: string }) {
  if (!props.text) return null
  return h(Toast, { key: props.text, text: props.text, kind: 'ok' })
}

/** 统一加载态。 */
export function Loading(props: { text: string }) {
  if (!props.text) return null
  return h('span', { className: 'ow-loading' }, props.text)
}

/** 表单行：label + 控件。 */
export function Field(props: { label: string; children?: ReactNode }) {
  return h(
    'div',
    { className: 'ow-row' },
    h('label', null, props.label),
    props.children,
  )
}

/** 场景 pipeline 只读可视化：步骤列表展示 stepType/order/skillRefs。 */
export function PipelineView(props: {
  steps: Array<{ stepId?: string; stepType?: string; order?: string; skillRefs?: string[]; label?: string }>
  emptyText: string
}) {
  const steps = props.steps ?? []
  if (steps.length === 0) return h('p', { className: 'ow-note' }, props.emptyText)
  return h(
    'ol',
    { className: 'ow-pipe' },
    ...steps.map((s, i) =>
      h(
        'li',
        { key: s.stepId ?? i },
        h('span', { className: 'ow-mono' }, `${s.stepId ?? `s${i + 1}`}`),
        h(Tag, { text: s.stepType ?? '?' }),
        s.order ? h(Tag, { text: s.order, tone: 'warn' }) : null,
        ...(s.skillRefs ?? []).map((r) => h(Tag, { key: r, text: r, tone: 'ok' })),
        s.label ? h('span', { className: 'ow-note' }, s.label) : null,
      ),
    ),
  )
}

/* ═══════════════════════════════════════════════════════════════════
 * 包管理
 * ═══════════════════════════════════════════════════════════════════ */
