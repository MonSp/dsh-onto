import { h, useState, useEffect, setReact } from './react'
import type { ReactNode, Ctx, PluginModule } from './types'
import { zh, en } from './locale'
import { CSS } from './styles'

const NS = 'dsh-tax.run'
const PANEL_ID = 'dsh-tax-run'
const PKG_NAME = 'tax-risk'
const PKG_VERSION = '1.0.0'
const DEFAULT_SCENARIO = 'SCN-TAX-BURDEN-ANOMALY'
const SOURCE_ID = 'SRC-TAX-CORE'

function unwrap<T>(result: unknown): T {
  if (result && typeof result === 'object' && 'ok' in (result as Record<string, unknown>)) {
    const r = result as {
      ok: boolean
      value?: T
      error?: { message: string; code?: string; details?: { origCode?: string } }
    }
    if (r.ok) return r.value as T
    const code = r.error?.details?.origCode ?? r.error?.code
    const msg = r.error?.message ?? 'remote error'
    throw new Error(code ? `${code}: ${msg}` : msg)
  }
  return result as T
}

function errText(e: unknown): string {
  if (e && typeof e === 'object') {
    const anyE = e as { code?: string; details?: { origCode?: string }; message?: string }
    const code = anyE.details?.origCode ?? anyE.code
    const msg = anyE.message ?? String(e)
    if (code && !msg.startsWith(code)) return `${code}: ${msg}`
    return msg
  }
  return String(e)
}

interface ScenarioRow {
  id: string
  name: string
  goal: string
}

interface EvidenceEntry {
  ruleId: string
  score: number
  evidence: string
}

interface PendingCheck {
  ruleId?: string
  note: string
}

interface CandidateRow {
  candidateId: string
  objectRef: string
  riskScore: number
  hitRuleIds: string[]
  evidenceChains: EvidenceEntry[]
  pendingChecks: PendingCheck[]
  pendingVerification?: boolean
}

interface RunResult {
  runId: string
  scenarioId: string
  candidates: CandidateRow[]
  humanReviewRequired: true
  dataStatus?: string
  contractStatus?: string
  audit?: { passed: boolean }
}

function statusTone(s: string | undefined): 'ok' | 'warn' | 'err' | undefined {
  if (s === 'verified' || s === 'conformant') return 'ok'
  if (s === 'conditional' || s === 'pending') return 'warn'
  if (s === 'insufficient' || s === 'unverified' || s === 'non-conformant') return 'err'
  return undefined
}

function RunPanel(props: { t: (k: string) => string; ctx: Ctx }) {
  const { t, ctx } = props
  const api = ctx.remote['ontoRuntime']
  const [scenarios, setScenarios] = useState<ScenarioRow[]>([])
  const [scenarioId, setScenarioId] = useState(DEFAULT_SCENARIO)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [result, setResult] = useState<RunResult | null>(null)

  useEffect(() => {
    if (!api) return
    void (async () => {
      setError('')
      try {
        const out = unwrap<{ scenarios: ScenarioRow[] }>(
          await api.listScenarios({ name: PKG_NAME, version: PKG_VERSION }),
        )
        const list = out.scenarios ?? []
        setScenarios(list)
        if (list.length > 0 && !list.some((s) => s.id === scenarioId)) {
          setScenarioId(list.find((s) => s.id === DEFAULT_SCENARIO)?.id ?? list[0].id)
        }
      } catch (e) {
        setError(errText(e))
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!api) {
    return h('div', { className: 'txri-gov' }, h('p', { className: 'txri-err' }, 'remote.ontoRuntime missing'))
  }

  const run = () => {
    void (async () => {
      setError('')
      setBusy('run')
      setResult(null)
      try {
        const out = unwrap<{ result: RunResult }>(
          await api.runScenario({
            name: PKG_NAME,
            version: PKG_VERSION,
            scenarioId,
            sourceId: SOURCE_ID,
            analysisMode: 'explore',
          }),
        )
        setResult(out.result)
      } catch (e) {
        setError(errText(e))
      } finally {
        setBusy('')
      }
    })()
  }

  const cands = result?.candidates ?? []

  const resultView = (): ReactNode[] => {
    if (!result) return [h('p', { key: 'e', className: 'txri-note' }, t('empty'))]
    return [
      h(
        'p',
        { key: 'rid', className: 'txri-note txri-mono' },
        `${t('runId')}: ${result.runId}`,
      ),
      h(
        'div',
        { key: 'meta', className: 'txri-bar' },
        result.dataStatus !== undefined
          ? h('span', { className: `tag ${statusTone(result.dataStatus) ?? ''}` }, `${t('dataStatus')}: ${result.dataStatus}`)
          : null,
        result.contractStatus !== undefined
          ? h('span', { className: `tag ${statusTone(result.contractStatus) ?? ''}` }, `${t('contractStatus')}: ${result.contractStatus}`)
          : null,
        result.audit !== undefined
          ? h('span', { className: `tag ${result.audit.passed ? 'ok' : 'err'}` }, `${t('audit')}: ${result.audit.passed ? 'PASS' : 'FAIL'}`)
          : null,
        h('span', { className: 'tag ok' }, t('humanReview')),
      ),
      cands.length === 0
        ? h('p', { key: 'nc', className: 'txri-note' }, t('noCandidates'))
        : h(
            'table',
            { key: 'ct' },
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', null, 'candidateId'),
                h('th', null, t('objectRef')),
                h('th', null, t('riskScore')),
                h('th', null, t('hitRules')),
              ),
            ),
            h(
              'tbody',
              null,
              ...cands.map((c) =>
                h(
                  'tr',
                  { key: c.candidateId },
                  h('td', { className: 'txri-mono' }, c.candidateId),
                  h('td', { className: 'txri-mono' }, c.objectRef),
                  h('td', null, String(c.riskScore)),
                  h('td', { className: 'txri-mono' }, (c.hitRuleIds ?? []).join(', ') || '—'),
                ),
              ),
            ),
          ),
      ...cands.slice(0, 3).map((c, i) =>
        h(
          'div',
          { key: `d${i}`, className: 'txri-panel', style: { marginBottom: '8px' } },
          h('strong', null, `${c.candidateId} · ${t('evidence')}`),
          (c.evidenceChains ?? []).length === 0
            ? h('p', { className: 'txri-note' }, t('evidenceEmpty'))
            : h(
                'ul',
                null,
                ...(c.evidenceChains ?? []).map((e, j) =>
                  h('li', { key: j, className: 'txri-mono' }, `${e.ruleId}: ${e.evidence} (${e.score})`),
                ),
              ),
          h('strong', null, t('pendingChecks')),
          (c.pendingChecks ?? []).length === 0
            ? h('p', { className: 'txri-note' }, t('pendingEmpty'))
            : h(
                'ul',
                null,
                ...(c.pendingChecks ?? []).map((p, j) => h('li', { key: j }, p.note)),
              ),
        ),
      ),
    ]
  }

  return h(
    'div',
    { className: 'txri-gov' },
    h('h3', null, t('title')),
    h('p', { className: 'txri-sub' }, t('subtitle')),
    error ? h('p', { className: 'txri-err' }, `${t('error')}: ${error}`) : null,
    h(
      'div',
      { className: 'txri-bar' },
      h('label', null, `${t('scenario')}: `),
      h(
        'select',
        {
          value: scenarioId,
          disabled: busy !== '',
          onChange: (e: { target: { value: string } }) => setScenarioId(e.target.value),
        },
        ...scenarios.map((s) => h('option', { key: s.id, value: s.id }, `${s.id} — ${s.name}`)),
      ),
      h('span', { className: 'txri-note' }, `${t('sourceId')}: ${SOURCE_ID}`),
      h(
        'button',
        { type: 'button', className: 'txri-primary', disabled: !!busy || !scenarioId, onClick: () => run() },
        busy === 'run' ? t('running') : t('run'),
      ),
    ),
    h('div', { className: 'txri-panel' }, ...resultView()),
  )
}

export function createPlugin(React: typeof import('react')): PluginModule {
  setReact(React)

  return {
    inject: ['slots', 'locale', 'remote', 'remote.ontoRuntime'],
    apply(ctx: Ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-tax: dictionaries')

      ctx.effect(() => {
        const style = document.createElement('style')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'dsh-tax: styles')

      function PanelIcon({ size }: { size?: number }) {
        const px = size || 20
        return h(
          'svg',
          { viewBox: '0 0 24 24', width: px, height: px, 'aria-hidden': true, style: { display: 'block' } },
          h('rect', { x: 4, y: 4, width: 16, height: 16, rx: 3, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8 }),
          h('path', { d: 'M8 16V10M12 16v-3M16 16V8', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
        )
      }

      function Panel() {
        return h(RunPanel, { t: ctx.locale.bind(NS), ctx })
      }

      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, Panel),
      )
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 3, locale: NS, label: () => ctx.locale.bind(NS)('panel') },
          PanelIcon,
        ),
      )
    },
  }
}
