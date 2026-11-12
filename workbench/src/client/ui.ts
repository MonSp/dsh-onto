import { h, useState, useEffect } from './react'
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

/** 悬浮提示壳：fixed 右上角、可点 × 关闭；text 变更时重新露出。 */
function Toast(props: { text: string; kind: 'err' | 'ok'; role?: string }) {
  const [hidden, setHidden] = useState(false)
  const text = props.text
  useEffect(() => {
    setHidden(false)
  }, [text])
  if (!text || hidden) return null
  return h(
    'div',
    { className: `ow-toast ${props.kind}`, role: props.role },
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
  return h(Toast, { text: props.text, kind: 'err', role: 'alert' })
}

/** 统一成功/信息悬浮提示。 */
export function OkBanner(props: { text: string }) {
  if (!props.text) return null
  return h(Toast, { text: props.text, kind: 'ok' })
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
