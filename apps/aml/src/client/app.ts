import { h, useState, useEffect, setReact } from './react'
import type { ReactNode, Ctx, PluginModule } from './types'
import { zh, en } from './locale'
import { CSS } from './styles'

const NS = 'dsh-aml.governance'
const PANEL_ID = 'dsh-aml-governance'

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

/** 远程/本地错误 → 机器码 + 可读 message（S2.3 失败展示口径）。 */
function errText(e: unknown): string {
  if (e && typeof e === 'object') {
    const anyE = e as { code?: string; details?: { origCode?: string }; message?: string }
    const code = anyE.details?.origCode ?? anyE.code
    const msg = anyE.message ?? String(e)
    // unwrap 已拼过 code 时避免双前缀
    if (code && !msg.startsWith(code)) return `${code}: ${msg}`
    return msg
  }
  return String(e)
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

function reviewTone(status: string): 'ok' | 'warn' | 'err' | undefined {
  if (status === 'approved') return 'ok'
  if (status === 'pending') return 'warn'
  if (status === 'rejected') return 'err'
  return undefined
}

type ReviewStatus = 'pending' | 'approved' | 'rejected'

interface LatestDecision {
  decisionId: string
  decision: 'approved' | 'rejected'
  createdAt: string
  reason?: string
  candidateIds: string[]
}

interface RunRow {
  runId: string
  scenarioId: string
  package: { name: string; version: string }
  datasetDigest: string
  auditPassed: boolean
  savedAt: string
  reviewStatus: ReviewStatus
  latestDecision?: LatestDecision
}

interface EvidenceEntry {
  ruleId: string
  score: number
  evidence: string
}

interface PendingCheck {
  ruleId?: string
  missing?: string[]
  note: string
}

interface CandidateDetail {
  candidateId: string
  objectRef: string
  riskScore: number
  riskLevel?: string
  hitRuleIds: string[]
  evidenceChains: EvidenceEntry[]
  narrative: string[]
  pendingChecks: PendingCheck[]
  pendingVerification: boolean
}

interface RunDetail {
  record: {
    runId: string
    package: { name: string; version: string }
    scenarioId: string
    datasetDigest: string
    savedAt: string
    result: {
      candidates: CandidateDetail[]
      ruleHitLog: Array<{ ruleId: string; candidateId: string; score: number; ts: string }>
      reviewGate: { threshold: number; required: boolean; requireReviewFor: string[] }
      audit: {
        checks: Array<{ check: string; closed: boolean; detail: string }>
        forbiddenPhraseHits: Array<{ phrase: string; where: string }>
        passed: boolean
      }
      humanReviewRequired: true
    }
  }
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
    createdAt?: string
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
    phase?: string
    approvalDigest: string
    externalRef?: string
  }>
}

function isReconcilePending(a: ChainData['actions'][number]): boolean {
  return a.status === 'unknown' || a.status === 'dispatched' || a.phase === 'dispatched'
}

function GovernancePanel(props: { t: (k: string) => string; ctx: Ctx }) {
  const { t, ctx } = props
  const api = ctx.remote['ontoRuntime']
  const [runs, setRuns] = useState<RunRow[]>([])
  const [filter, setFilter] = useState<'all' | ReviewStatus>('all')
  const [detail, setDetail] = useState<RunDetail | null>(null)
  const [detailRunId, setDetailRunId] = useState('')
  const [chain, setChain] = useState<ChainData | null>(null)
  const [chainRunId, setChainRunId] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [okMsg, setOkMsg] = useState('')
  // 详情区当前候选
  const [selectedCandidate, setSelectedCandidate] = useState('')
  // 复核表单
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [decision, setDecision] = useState<'approved' | 'rejected'>('approved')
  const [reason, setReason] = useState('')

  const loadRuns = () => {
    if (!api) return
    void (async () => {
      setError('')
      setBusy('runs')
      try {
        const out = unwrap<{ runs: RunRow[] }>(await api.listRuns())
        setRuns(out.runs ?? [])
      } catch (e) {
        setError(errText(e))
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
    return h('div', { className: 'amli-gov' }, h('p', { className: 'amli-err' }, 'remote.ontoRuntime missing'))
  }

  const openRun = (runId: string) => {
    void (async () => {
      setError('')
      setOkMsg('')
      setBusy('detail')
      try {
        const out = unwrap<RunDetail>(await api.showRun({ runId }))
        setDetail(out)
        setDetailRunId(runId)
        const cands = out.record?.result?.candidates ?? []
        setSelectedIds(cands.map((c) => c.candidateId))
        setSelectedCandidate(cands[0]?.candidateId ?? '')
        setDecision('approved')
        setReason('')
        const chainOut = unwrap<ChainData>(await api.reviewChain({ runId }))
        setChain(chainOut)
        setChainRunId(runId)
      } catch (e) {
        setError(errText(e))
      } finally {
        setBusy('')
      }
    })()
  }

  const submitReview = () => {
    if (!detail || selectedIds.length === 0) return
    void (async () => {
      setError('')
      setOkMsg('')
      setBusy('review')
      try {
        const rec = detail.record
        const out = unwrap<{ decisionId: string; decision: string }>(
          await api.recordReviewDecision({
            runId: rec.runId,
            candidateIds: selectedIds,
            snapshotDigest: rec.datasetDigest,
            ruleFingerprint: `${rec.package.name}@${rec.package.version}`,
            decision,
            ...(reason.trim() !== '' ? { reason: reason.trim() } : {}),
          }),
        )
        setOkMsg(`${t('reviewSubmitted')}: ${out.decisionId} (${out.decision})`)
        loadRuns()
        const chainOut = unwrap<ChainData>(await api.reviewChain({ runId: rec.runId }))
        setChain(chainOut)
        setChainRunId(rec.runId)
      } catch (e) {
        setError(errText(e))
      } finally {
        setBusy('')
      }
    })()
  }

  const filtered = runs.filter((r) => filter === 'all' || r.reviewStatus === filter)

  const listView = (): ReactNode[] => {
    const counts = {
      all: runs.length,
      pending: runs.filter((r) => r.reviewStatus === 'pending').length,
      approved: runs.filter((r) => r.reviewStatus === 'approved').length,
      rejected: runs.filter((r) => r.reviewStatus === 'rejected').length,
    }
    return [
      h(
        'div',
        { key: 'bar', className: 'amli-bar' },
        h('button', { type: 'button', disabled: !!busy, onClick: () => loadRuns() }, t('refresh')),
        h('span', { className: 'amli-note' }, `${t('runs')}: ${runs.length}`),
        h(
          'span',
          { className: 'amli-note' },
          `${t('filter')}:`,
        ),
        ...(
          [
            ['all', t('filterAll')],
            ['pending', t('filterPending')],
            ['approved', t('filterApproved')],
            ['rejected', t('filterRejected')],
          ] as Array<['all' | ReviewStatus, string]>
        ).map(([key, label]) =>
          h(
            'button',
            {
              key,
              type: 'button',
              className: filter === key ? 'amli-primary' : '',
              onClick: () => setFilter(key),
            },
            `${label} (${counts[key]})`,
          ),
        ),
      ),
      filtered.length > 0
        ? h(
            'table',
            { key: 'tbl' },
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', null, t('runId')),
                h('th', null, t('scenario')),
                h('th', null, t('package')),
                h('th', null, t('reviewStatus')),
                h('th', null, t('audit')),
                h('th', null, t('savedAt')),
                h('th', null, ''),
              ),
            ),
            h(
              'tbody',
              null,
              ...filtered.slice(0, 40).map((r) =>
                h(
                  'tr',
                  { key: r.runId },
                  h('td', { className: 'amli-mono' }, r.runId),
                  h('td', { className: 'amli-mono' }, r.scenarioId),
                  h('td', { className: 'amli-mono' }, `${r.package.name}@${r.package.version}`),
                  h(
                    'td',
                    null,
                    h(Tag, {
                      text: t(r.reviewStatus),
                      tone: reviewTone(r.reviewStatus),
                    }),
                    r.latestDecision?.reason
                      ? h('div', { className: 'amli-note' }, r.latestDecision.reason)
                      : null,
                  ),
                  h('td', null, h(Tag, { text: r.auditPassed ? 'passed' : 'failed', tone: r.auditPassed ? 'ok' : 'err' })),
                  h('td', { className: 'amli-mono' }, r.savedAt.slice(0, 19).replace('T', ' ')),
                  h(
                    'td',
                    null,
                    h(
                      'button',
                      {
                        type: 'button',
                        className: detailRunId === r.runId ? 'amli-primary' : '',
                        disabled: !!busy,
                        onClick: () => openRun(r.runId),
                      },
                      t('openDetail'),
                    ),
                  ),
                ),
              ),
            ),
          )
        : h('p', { key: 'empty', className: 'amli-note' }, t('empty')),
    ]
  }

  const evidenceView = (): ReactNode[] => {
    if (!detail) return [h('p', { key: 'ne', className: 'amli-note' }, t('noDetail'))]
    const rec = detail.record
    const res = rec.result
    const cands = res.candidates ?? []
    const nodes: ReactNode[] = [
      h('h3', { key: 'et' }, t('evidence')),
      h('p', { key: 'er', className: 'amli-note amli-mono' }, rec.runId),
      h(
        'div',
        { key: 'meta', className: 'amli-note' },
        `${t('scenario')}: ${rec.scenarioId} · ${t('package')}: ${rec.package.name}@${rec.package.version} · `,
        `${t('datasetDigest')}: ${rec.datasetDigest.slice(0, 12)} · `,
        `${t('threshold')}: ${res.reviewGate?.threshold ?? '—'} · `,
        `${t('savedAt')}: ${rec.savedAt.slice(0, 19).replace('T', ' ')} · `,
        `${t('audit')}: `,
        h(Tag, { text: res.audit?.passed ? 'passed' : 'failed', tone: res.audit?.passed ? 'ok' : 'err' }),
      ),
    ]
    if (cands.length === 0) {
      nodes.push(h('p', { key: 'nc', className: 'amli-note' }, t('evidenceEmpty')))
      return nodes
    }
    const current =
      cands.find((c) => c.candidateId === selectedCandidate) ?? cands[0]
    nodes.push(
      h(
        'div',
        { key: 'sel', className: 'amli-cand-row' },
        h('span', { className: 'amli-note' }, `${t('candidates')}:`),
        ...cands.map((c) =>
          h(
            'button',
            {
              key: c.candidateId,
              type: 'button',
              className: current && c.candidateId === current.candidateId ? 'amli-primary' : '',
              onClick: () => setSelectedCandidate(c.candidateId),
            },
            c.candidateId,
          ),
        ),
      ),
    )
    if (current) {
      const warn = current.pendingVerification || (current.pendingChecks?.length ?? 0) > 0
      nodes.push(
        h(
          'div',
          { key: 'cmeta', className: 'amli-note' },
          `${t('objectRef')}: ${current.objectRef} · `,
          `${t('riskScore')}: ${current.riskScore}`,
          current.riskLevel ? ` · ${t('riskLevel')}: ${current.riskLevel}` : '',
          ` · ${t('hitRules')}: ${current.hitRuleIds.join(', ') || '—'}`,
        ),
      )
      if (warn) {
        nodes.push(
          h(
            'div',
            { key: 'warn', className: 'amli-warnbox' },
            `${t('pendingVerification')}${current.pendingVerification ? ' ✓' : ''}`,
          ),
        )
      }
      nodes.push(h('h4', { key: 'ech' }, t('evidenceChain')))
      nodes.push(
        current.evidenceChains?.length
          ? h(
              'ul',
              { key: 'ecl', className: 'amli-evidence' },
              ...current.evidenceChains.map((e, i) =>
                h(
                  'li',
                  { key: `${e.ruleId}-${i}` },
                  h('span', { className: 'amli-mono' }, `[${e.ruleId} score=${e.score}] `),
                  e.evidence,
                ),
              ),
            )
          : h('p', { key: 'ece', className: 'amli-note' }, t('evidenceEmpty')),
      )
      nodes.push(h('h4', { key: 'pch' }, t('pendingChecks')))
      nodes.push(
        current.pendingChecks?.length
          ? h(
              'ul',
              { key: 'pcl' },
              ...current.pendingChecks.map((p, i) =>
                h(
                  'li',
                  { key: i },
                  p.ruleId ? h('span', { className: 'amli-mono' }, `[${p.ruleId}] `) : null,
                  p.missing?.length ? h('span', { className: 'amli-mono' }, `missing=${p.missing.join(',')} `) : null,
                  p.note,
                ),
              ),
            )
          : h('p', { key: 'pce', className: 'amli-note' }, t('pendingChecksEmpty')),
      )
      if (current.narrative?.length) {
        nodes.push(h('h4', { key: 'nch' }, t('narrative')))
        nodes.push(
          h(
            'ul',
            { key: 'ncl' },
            ...current.narrative.map((n, i) => h('li', { key: i }, n)),
          ),
        )
      }
    }
    nodes.push(h('h4', { key: 'rhl' }, t('ruleHitLog')))
    nodes.push(
      (res.ruleHitLog ?? []).length
        ? h(
            'table',
            { key: 'rhlt' },
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', null, 'ruleId'),
                h('th', null, 'candidateId'),
                h('th', null, t('riskScore')),
                h('th', null, 'ts'),
              ),
            ),
            h(
              'tbody',
              null,
              ...(res.ruleHitLog ?? []).map((hrow, i) =>
                h(
                  'tr',
                  { key: i },
                  h('td', { className: 'amli-mono' }, hrow.ruleId),
                  h('td', { className: 'amli-mono' }, hrow.candidateId),
                  h('td', null, String(hrow.score)),
                  h('td', { className: 'amli-mono' }, hrow.ts.slice(0, 19).replace('T', ' ')),
                ),
              ),
            ),
          )
        : h('p', { key: 'rhle', className: 'amli-note' }, t('evidenceEmpty')),
    )
    nodes.push(h('h4', { key: 'ach' }, t('auditChecks')))
    nodes.push(
      (res.audit?.checks ?? []).length
        ? h(
            'ul',
            { key: 'acl' },
            ...(res.audit.checks ?? []).map((c, i) =>
              h(
                'li',
                { key: i },
                h(Tag, { text: c.closed ? 'closed' : 'open', tone: c.closed ? 'ok' : 'warn' }),
                ' ',
                h('span', { className: 'amli-mono' }, `${c.check}: `),
                c.detail,
              ),
            ),
          )
        : h('p', { key: 'ace', className: 'amli-note' }, t('evidenceEmpty')),
    )
    nodes.push(
      h(
        'p',
        { key: 'fph', className: 'amli-note' },
        `${t('forbiddenHits')}: ${(res.audit?.forbiddenPhraseHits ?? []).length}`,
      ),
    )
    return nodes
  }

  // 候选选择：详情打开时由 openRun 重置 selectedIds；此处仅渲染复选
  const reviewFormView = (): ReactNode[] => {
    if (!detail) return []
    const cands = detail.record.result.candidates ?? []
    if (cands.length === 0) return []
    return [
      h('div', { key: 'rf', className: 'amli-section' },
        h('h4', null, t('reviewForm')),
        h('p', { className: 'amli-note' }, t('reviewOnlyNote')),
        h(
          'div',
          { className: 'amli-cand-row' },
          h('span', { className: 'amli-note' }, `${t('selectCandidates')}:`),
          ...cands.map((c) => {
            const on = selectedIds.includes(c.candidateId)
            return h(
              'label',
              { key: c.candidateId, style: { display: 'inline-flex', gap: '4px', alignItems: 'center' } },
              h('input', {
                type: 'checkbox',
                checked: on,
                onChange: () => {
                  setSelectedIds((prev) =>
                    on ? prev.filter((x) => x !== c.candidateId) : [...prev, c.candidateId])
                },
              }),
              h('span', { className: 'amli-mono' }, c.candidateId),
            )
          }),
        ),
        h(
          'div',
          { className: 'amli-cand-row' },
          h('span', { className: 'amli-note' }, `${t('decision')}:`),
          h(
            'button',
            {
              type: 'button',
              className: decision === 'approved' ? 'amli-primary' : '',
              onClick: () => setDecision('approved'),
            },
            t('decisionApprove'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: decision === 'rejected' ? 'amli-danger' : '',
              onClick: () => setDecision('rejected'),
            },
            t('decisionReject'),
          ),
        ),
        h(
          'div',
          { className: 'amli-cand-row' },
          h('span', { className: 'amli-note' }, t('reasonLabel')),
          h('input', {
            type: 'text',
            value: reason,
            style: { flex: '1', minWidth: '160px' },
            onInput: (e: { target: { value: string } }) => setReason(e.target.value),
          }),
        ),
        h(
          'div',
          { className: 'amli-bar' },
          h(
            'button',
            {
              type: 'button',
              className: 'amli-primary',
              disabled: !!busy || selectedIds.length === 0,
              onClick: () => submitReview(),
            },
            t('submitReview'),
          ),
          okMsg ? h('span', { className: 'amli-ok' }, okMsg) : null,
        ),
      ),
    ]
  }

  const chainView = (): ReactNode[] => {
    if (!chain) return []
    const empty = chain.decisions.length === 0 && chain.proposals.length === 0 && chain.actions.length === 0
    const reconcileActions = chain.actions.filter(isReconcilePending)
    return [
      h('h3', { key: 'ct' }, t('chain')),
      h('p', { key: 'cr', className: 'amli-note amli-mono' }, chainRunId),
      reconcileActions.length > 0
        ? h(
            'div',
            { key: 'rq', className: 'amli-warnbox' },
            `${t('pendingReconcile')}: ${reconcileActions.map((a) => a.actionId).join(', ')} — ${t('noRetry')}`,
          )
        : null,
      empty ? h('p', { key: 'ce', className: 'amli-note' }, t('chainEmpty')) : null,
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
                  h('td', { className: 'amli-mono' }, d.decisionId),
                  h('td', null, d.reason ?? '—'),
                  h('td', { className: 'amli-mono' }, d.candidateIds.join(', ')),
                  h('td', { className: 'amli-mono' }, d.reviewer),
                  h('td', { className: 'amli-mono' }, `${d.snapshotDigest.slice(0, 8)} / ${d.ruleFingerprint}`),
                ),
              ),
            ),
          )
        : null,
      chain.proposals.length > 0
        ? h(
            'div',
            { key: 'pn' },
            h('p', { className: 'amli-note' }, t('proposalNotApproval')),
            h(
              'table',
              null,
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
                    h('td', { className: 'amli-mono' }, p.proposalId),
                    h('td', { className: 'amli-mono' }, p.decisionId),
                    h('td', { className: 'amli-mono' }, p.operationId),
                    h('td', { className: 'amli-mono' }, `${p.behaviorId} → ${p.objectRef}`),
                    h('td', null, h(Tag, { text: p.status, tone: statusTone(p.status) })),
                  ),
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
              ...chain.actions.map((a) => {
                const recon = isReconcilePending(a)
                return h(
                  'tr',
                  { key: a.actionId },
                  h('td', { className: 'amli-mono' }, a.actionId),
                  h('td', { className: 'amli-mono' }, a.proposalId ?? '—'),
                  h(
                    'td',
                    null,
                    recon
                      ? h(Tag, { text: t('pendingReconcile'), tone: 'warn' })
                      : h(Tag, { text: a.status, tone: statusTone(a.status) }),
                  ),
                  h('td', { className: 'amli-mono' }, `${a.behaviorId} → ${a.objectRef}`),
                  h('td', { className: 'amli-mono' }, a.externalRef ?? '—'),
                  h('td', { className: 'amli-mono' }, a.approvalDigest.slice(0, 12)),
                )
              }),
            ),
          )
        : null,
      h('p', { key: 'sim', className: 'amli-sim' }, t('simulatedNote')),
      h('p', { key: 'hr', className: 'amli-note' }, t('humanReview')),
    ]
  }

  return h(
    'div',
    { className: 'amli-gov' },
    h('h3', null, t('title')),
    h('p', { className: 'amli-sub' }, t('subtitle')),
    error ? h('p', { className: 'amli-err' }, `${t('error')}: ${error}`) : null,
    h(
      'div',
      { className: 'amli-layout' },
      h('div', { className: 'amli-panel' }, ...listView()),
      h(
        'div',
        { className: 'amli-panel' },
        ...evidenceView(),
        ...reviewFormView(),
        ...chainView(),
      ),
    ),
  )
}

export function createPlugin(React: typeof import('react')): PluginModule {
  setReact(React)

  return {
    // UI 半：由 client.ts 在 $mount 后嵌套注册；inject 解锁 remote.ontoRuntime 访问。
    inject: ['slots', 'locale', 'remote', 'remote.ontoRuntime'],
    apply(ctx: Ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-aml: dictionaries')

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
        return h(GovernancePanel, { t: ctx.locale.bind(NS), ctx })
      }

      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, Panel),
      )
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 2, locale: NS, label: () => ctx.locale.bind(NS)('panel') },
          PanelIcon,
        ),
      )
    },
  }
}
