import { h, useState, useEffect, useCallback, useMemo, useRef } from '../react'
import type { ReactNode } from '../types'
import type { Ctx } from '../types'
import { Tag, Row, Card, ErrorBanner, OkBanner, Loading, Field, PipelineView } from '../ui'
import { unwrap, errText, fmt } from '../helpers'

/* ═══════════════════════════════════════════════════════════════
 * 校验派生
 * ═══════════════════════════════════════════════════════════════ */

export function ValidatePanel(props: {
  t: (k: string) => string
  apis: Ctx
  selected: { name: string; version: string } | null
}) {
  const { t, apis, selected } = props
  const [report, setReport] = useState<Record<string, unknown> | null>(null)
  const [gate, setGate] = useState<Record<string, unknown> | null>(null)
  const [deriveInfo, setDeriveInfo] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  // D11：签发前一键预检清单（校验写盘 → 派生 → 加载门禁；签发动作仍人工）
  const [preflight, setPreflight] = useState<string[] | null>(null)

  const act = async (label: string, fn: () => Promise<void>) => {
    setBusy(label)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy('')
    }
  }

  if (!selected) return h('div', { className: 'ow-card' }, h('p', { className: 'ow-note' }, t('none')))
  const vApi = apis.remote['ontoValidate']
  const dApi = apis.remote['ontoDerive']
  const r = report as { score?: number; passed?: boolean; errors?: Array<Record<string, string>>; warnings?: Array<Record<string, string>>; info?: Array<Record<string, string>> } | null

  return h(
    'div',
    { className: 'ow-card' },
    h('h3', { className: 'ow-h2' }, t('tabValidate')),
    h('div', { className: 'ow-row' }, h(Loading, { text: busy ? `${t('busy')} (${busy})` : '' })),
    h(ErrorBanner, { text: error }),
    h(
      'div',
      { className: 'ow-row' },
      h(
        'button',
        {
          className: 'ow-btn',
          disabled: !!busy,
          onClick: () =>
            void act('validate', async () => {
              const out = unwrap<{ report: Record<string, unknown> }>(await vApi!.validate({ name: selected.name, version: selected.version }))
              setReport(out.report)
            }),
        },
        busy === 'validate' ? t('busy') : t('validateBtn'),
      ),
      h(
        'button',
        {
          className: 'ow-btn',
          disabled: !!busy,
          onClick: () =>
            void act('derive', async () => {
              const out = unwrap<{ sources: number; derived: number; sourceDigest: string }>(
                await dApi!.derive({ name: selected.name, version: selected.version }),
              )
              setDeriveInfo(`sources=${out.sources} derived=${out.derived} digest=${out.sourceDigest.slice(0, 12)}…`)
            }),
        },
        busy === 'derive' ? t('busy') : t('deriveBtn'),
      ),
      h(
        'button',
        {
          className: 'ow-btn ghost',
          disabled: !!busy,
          onClick: () =>
            void act('gate', async () => {
              const out = unwrap<Record<string, unknown>>(await dApi!.gate({ name: selected.name, version: selected.version }))
              setGate(out)
            }),
        },
        busy === 'gate' ? t('busy') : t('gateBtn'),
      ),
      h(
        'button',
        {
          className: 'ow-btn',
          disabled: !!busy,
          onClick: () =>
            void act('preflight', async () => {
              const lines: string[] = []
              // 1) 校验写盘（质量报告落盘，同「执行校验」）
              const vOut = unwrap<{ report: Record<string, unknown> }>(
                await vApi!.validate({ name: selected.name, version: selected.version }),
              )
              setReport(vOut.report)
              const vr = vOut.report as { score?: number; errors?: unknown[]; warnings?: unknown[] }
              const errN = (vr.errors ?? []).length
              const warnN = (vr.warnings ?? []).length
              lines.push(
                errN === 0
                  ? `✓ 校验：质量分 ${String(vr.score ?? '')}，错误 0，警告 ${warnN}`
                  : `✗ 校验：错误 ${errN} —— 先修复再签发`,
              )
              if (errN > 0) {
                setPreflight(lines)
                return
              }
              // 2) 派生（写 derived/** + manifest）
              const dOut = unwrap<{ sources: number; derived: number; sourceDigest: string }>(
                await dApi!.derive({ name: selected.name, version: selected.version }),
              )
              setDeriveInfo(`sources=${dOut.sources} derived=${dOut.derived} digest=${dOut.sourceDigest.slice(0, 12)}…`)
              lines.push(`✓ 派生：sources=${dOut.sources}，derived=${dOut.derived}`)
              // 3) 加载门禁
              const g = unwrap<Record<string, unknown>>(
                await dApi!.gate({ name: selected.name, version: selected.version }),
              )
              setGate(g)
              lines.push(g['ok'] ? '✓ 加载门禁通过' : `✗ 加载门禁：${String(g['reason'] ?? '')}`)
              if (g['ok']) lines.push('→ 可「提交评审」→ 人工签发（签发只能人工）')
              setPreflight(lines)
            }),
        },
        busy === 'preflight' ? t('busy') : t('preflightBtn'),
      ),
    ),
    preflight
      ? h(
          'div',
          { key: 'preflight', style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 2 } },
          ...preflight.map((l, i) => h('div', { key: i, className: 'ow-note' }, l)),
        )
      : null,
    deriveInfo ? h('p', { className: 'ow-note' }, deriveInfo) : null,
    gate
      ? h(
          'p',
          { className: 'ow-note' },
          (gate['ok'] ? t('gateOk') : `${t('drift')}: ${String(gate['reason'] ?? '')}`),
        )
      : null,
    r
      ? h(
          'div',
          null,
          h(
            'div',
            { className: 'ow-row' },
            h(Tag, { text: `${t('score')} ${String(r.score ?? '')}`, tone: r.passed ? 'ok' : 'err' }),
            h('span', { className: 'ow-stat' }, `${t('errors')} ${r.errors?.length ?? 0}`),
            h('span', { className: 'ow-stat' }, `${t('warnings')} ${r.warnings?.length ?? 0}`),
          ),
          ...(['errors', 'warnings', 'info'] as const).map((level) =>
            h(
              'div',
              { key: level },
              h('div', { className: 'ow-label' }, t(level)),
              h(
                'table',
                { className: 'ow-table' },
                h(
                  'tbody',
                  null,
                  ...((r[level] ?? []) as Array<Record<string, string>>).map((issue, i: number) =>
                    h(
                      'tr',
                      { key: i },
                      h('td', null, h(Tag, { text: issue['code'] ?? '', tone: level === 'errors' ? 'err' : level === 'warnings' ? 'warn' : undefined })),
                      h('td', { className: 'ow-mono' }, `${issue['where'] ?? ''} ${issue['message'] ?? ''}`),
                    ),
                  ),
                ),
              ),
            ),
          ),
        )
      : null,
  )
}
