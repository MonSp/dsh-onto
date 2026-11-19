import { h, useState, useEffect, setReact } from './react'
import type { ReactNode, Ctx, PluginModule } from './types'
import { zh, en } from './locale'
import { CSS } from './styles'

const NS = 'dsh-aml.governance'
const PANEL_ID = 'dsh-aml-governance'

function unwrap<T>(result: unknown): T {
  if (result && typeof result === 'object' && 'ok' in (result as Record<string, unknown>)) {
    const r = result as { ok: boolean; value?: T; error?: { message: string } }
    if (r.ok) return r.value as T
    throw new Error(r.error?.message ?? 'remote error')
  }
  return result as T
}

function Tag(props: { text: string; tone?: 'ok' | 'warn' | 'err' }) {
  const cls = props.tone ? `tag ${props.tone}` : 'tag'
  return h('span', { className: cls }, props.text)
}

function statusTone(status: string): 'ok' | 'warn' | 'err' | undefined {
  if (status === 'succeeded' || status === 'approved' || status === 'consumed' || status === 'passed') return 'ok'
  if (status === 'executing' || status === 'pending' || status === 'dispatched' || status === 'unknown') return 'warn'
  if (status === 'failed' || status === 'rejected' || status === 'canceled') return 'err'
  return undefined
}

interface RunRow {
  runId: string
  scenarioId: string
  package: { name: string; version: string }
  datasetDigest: string
  auditPassed: boolean
  savedAt: string
}

interface ChainData {
  decisions: Array<{
    decisionId: string
    candidateIds: string[]
    reviewer: string
    decision: string
    reason?: string
    snapshotDigest: string
    ruleFingerprint: string
  }>
  proposals: Array<{
    proposalId: string
    decisionId: string
    candidateId: string
    behaviorId: string
    objectRef: string
    operationId: string
    status: string
  }>
  actions: Array<{
    actionId: string
    decisionId?: string
    proposalId?: string
    behaviorId: string
    objectRef: string
    status: string
    approvalDigest: string
    externalRef?: string
  }>
}

function GovernancePanel(props: { t: (k: string) => string; ctx: Ctx }) {
  const { t, ctx } = props
  const api = ctx.remote['ontoRuntime']
  const [runs, setRuns] = useState<RunRow[]>([])
  const [chain, setChain] = useState<ChainData | null>(null)
  const [chainRunId, setChainRunId] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const loadRuns = () => {
    if (!api) return
    void (async () => {
      setError('')
      setBusy('runs')
      try {
        const out = unwrap<{ runs: RunRow[] }>(await api.listRuns())
        setRuns(out.runs ?? [])
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy('')
      }
    })()
  }

  useEffect(() => {
    loadRuns()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!api) {
    return h('div', { className: 'aml-gov' }, h('p', { className: 'aml-err' }, 'remote.ontoRuntime missing'))
  }

  const openChain = (runId: string) => {
    void (async () => {
      setError('')
      setBusy('chain')
      try {
        const out = unwrap<ChainData>(await api.reviewChain({ runId }))
        setChain(out)
        setChainRunId(runId)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy('')
      }
    })()
  }

  const chainView = (): ReactNode[] => {
    if (!chain) return []
    const empty = chain.decisions.length === 0 && chain.proposals.length === 0 && chain.actions.length === 0
    return [
      h('h3', { key: 'ct' }, t('chain')),
      h('p', { key: 'cr', className: 'aml-note aml-mono' }, chainRunId),
      empty ? h('p', { key: 'ce', className: 'aml-note' }, t('chainEmpty')) : null,
      chain.decisions.length > 0
        ? h(
            'table',
            { key: 'dt' },
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', null, t('decision')),
                h('th', null, t('decisionId')),
                h('th', null, t('reason')),
                h('th', null, t('candidates')),
                h('th', null, t('reviewer')),
                h('th', null, t('snapshot')),
              ),
            ),
            h(
              'tbody',
              null,
              ...chain.decisions.map((d) =>
                h(
                  'tr',
                  { key: d.decisionId },
                  h('td', null, h(Tag, { text: d.decision, tone: statusTone(d.decision) })),
                  h('td', { className: 'aml-mono' }, d.decisionId),
                  h('td', null, d.reason ?? '—'),
                  h('td', { className: 'aml-mono' }, d.candidateIds.join(', ')),
                  h('td', { className: 'aml-mono' }, d.reviewer),
                  h('td', { className: 'aml-mono' }, `${d.snapshotDigest.slice(0, 8)} / ${d.ruleFingerprint}`),
                ),
              ),
            ),
          )
        : null,
      chain.proposals.length > 0
        ? h(
            'table',
            { key: 'pt' },
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', null, t('proposal')),
                h('th', null, t('decisionId')),
                h('th', null, t('operation')),
                h('th', null, t('behaviorObject')),
                h('th', null, t('status')),
              ),
            ),
            h(
              'tbody',
              null,
              ...chain.proposals.map((p) =>
                h(
                  'tr',
                  { key: p.proposalId },
                  h('td', { className: 'aml-mono' }, p.proposalId),
                  h('td', { className: 'aml-mono' }, p.decisionId),
                  h('td', { className: 'aml-mono' }, p.operationId),
                  h('td', { className: 'aml-mono' }, `${p.behaviorId} → ${p.objectRef}`),
                  h('td', null, h(Tag, { text: p.status, tone: statusTone(p.status) })),
                ),
              ),
            ),
          )
        : null,
      chain.actions.length > 0
        ? h(
            'table',
            { key: 'at' },
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', null, t('action')),
                h('th', null, t('proposalId')),
                h('th', null, t('status')),
                h('th', null, t('behaviorObject')),
                h('th', null, t('externalRef')),
                h('th', null, t('approval')),
              ),
            ),
            h(
              'tbody',
              null,
              ...chain.actions.map((a) =>
                h(
                  'tr',
                  { key: a.actionId },
                  h('td', { className: 'aml-mono' }, a.actionId),
                  h('td', { className: 'aml-mono' }, a.proposalId ?? '—'),
                  h('td', null, h(Tag, { text: a.status, tone: statusTone(a.status) })),
                  h('td', { className: 'aml-mono' }, `${a.behaviorId} → ${a.objectRef}`),
                  h('td', { className: 'aml-mono' }, a.externalRef ?? '—'),
                  h('td', { className: 'aml-mono' }, a.approvalDigest.slice(0, 12)),
                ),
              ),
            ),
          )
        : null,
      h('p', { key: 'sim', className: 'aml-sim' }, t('simulatedNote')),
      h('p', { key: 'hr', className: 'aml-note' }, t('humanReview')),
    ]
  }

  return h(
    'div',
    { className: 'aml-gov' },
    h('h3', null, t('title')),
    h('p', { className: 'aml-sub' }, t('subtitle')),
    error ? h('p', { className: 'aml-err' }, `${t('error')}: ${error}`) : null,
    h(
      'div',
      { className: 'aml-bar' },
      h('button', { type: 'button', disabled: !!busy, onClick: () => loadRuns() }, t('refresh')),
      h('span', { className: 'aml-note' }, `${t('runs')}: ${runs.length}`),
    ),
    runs.length > 0
      ? h(
          'table',
          null,
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              h('th', null, t('runId')),
              h('th', null, t('scenario')),
              h('th', null, t('package')),
              h('th', null, t('audit')),
              h('th', null, t('savedAt')),
              h('th', null, ''),
            ),
          ),
          h(
            'tbody',
            null,
            ...runs.slice(0, 30).map((r) =>
              h(
                'tr',
                { key: r.runId },
                h('td', { className: 'aml-mono' }, r.runId),
                h('td', { className: 'aml-mono' }, r.scenarioId),
                h('td', { className: 'aml-mono' }, `${r.package.name}@${r.package.version}`),
                h('td', null, h(Tag, { text: r.auditPassed ? 'passed' : 'failed', tone: r.auditPassed ? 'ok' : 'err' })),
                h('td', { className: 'aml-mono' }, r.savedAt.slice(0, 19).replace('T', ' ')),
                h(
                  'td',
                  null,
                  h(
                    'button',
                    {
                      type: 'button',
                      disabled: !!busy,
                      onClick: () => openChain(r.runId),
                    },
                    t('loadChain'),
                  ),
                ),
              ),
            ),
          ),
        )
      : h('p', { className: 'aml-note' }, t('empty')),
    ...chainView(),
  )
}

export function createPlugin(React: typeof import('react')): PluginModule {
  setReact(React)

  return {
    // UI 半：由 client.ts 在 $mount 后嵌套注册；inject 解锁 remote.ontoRuntime 访问。
    inject: ['slots', 'locale', 'remote', 'remote.ontoRuntime'],
    apply(ctx: Ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-aml: dictionaries')
      const t = ctx.locale.bind(NS)

      ctx.effect(() => {
        const style = document.createElement('style')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'dsh-aml: styles')

      function PanelIcon({ size }: { size?: number }) {
        const px = size || 20
        return h(
          'svg',
          { viewBox: '0 0 24 24', width: px, height: px, 'aria-hidden': true, style: { display: 'block' } },
          h('rect', { x: 4, y: 4, width: 16, height: 16, rx: 3, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8 }),
          h('path', { d: 'M8 12h8M8 16h5M8 8h8', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
        )
      }

      function Panel() {
        return h(GovernancePanel, { t, ctx })
      }

      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, Panel),
      )
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 2, locale: NS, label: () => t('panel') },
          PanelIcon,
        ),
      )
    },
  }
}
