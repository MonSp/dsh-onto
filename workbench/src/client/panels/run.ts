import { h, useState, useEffect, useCallback, useMemo, useRef } from '../react'
import type { ReactNode } from '../types'
import type { Ctx } from '../types'
import { Tag, Row, Card, ErrorBanner, OkBanner, Loading, Field, PipelineView } from '../ui'
import { unwrap, errText, fmt } from '../helpers'

/* ═══════════════════════════════════════════════════════════════
 * 场景运行
 * ═══════════════════════════════════════════════════════════════ */

export function RunPanel(props: {
  t: (k: string) => string
  apis: Ctx
  selected: { name: string; version: string } | null
}) {
  const { t, apis, selected } = props
  const [scenarios, setScenarios] = useState<Array<{ id: string; name: string; goal: string }>>([])
  const [scenarioId, setScenarioId] = useState('')
  const [datasetText, setDatasetText] = useState('{\n  "objects": [],\n  "relations": [],\n  "behaviors": [],\n  "candidates": []\n}')
  const [result, setResult] = useState<Record<string, unknown> | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  // P1：本地暂存最近 N 次运行（不持久化，v0.4 再入库）
  const [history, setHistory] = useState<Array<{ hid: string; label: string; result: Record<string, unknown> }>>([])
  const [viewHid, setViewHid] = useState('')
  // 持久运行记录（run-insight S2.5）：workspace runs/ 落盘面，两轮对比 + 审计导出。
  const [runs, setRuns] = useState<Array<{
    runId: string
    scenarioId: string
    package: { name: string; version: string }
    datasetDigest: string
    auditPassed: boolean
    savedAt: string
  }>>([])
  const [selA, setSelA] = useState('')
  const [selB, setSelB] = useState('')
  const [diff, setDiff] = useState<Record<string, unknown> | null>(null)
  const [exportInfo, setExportInfo] = useState('')
  // D 包治理链（M2/D）：decision → proposal → action → externalRef
  const [chain, setChain] = useState<Record<string, unknown> | null>(null)
  const [chainRunId, setChainRunId] = useState('')
  const api = apis.remote['ontoRuntime']

  const loadRuns = () => {
    if (!api) return
    void (async () => {
      setError('')
      try {
        const out = unwrap<{ runs: typeof runs }>(await api.listRuns())
        setRuns(out.runs)
      } catch (e) {
        setError(errText(e))
      }
    })()
  }

  useEffect(() => {
    if (!api || !selected) return
    void (async () => {
      setError('')
      try {
        const out = unwrap<{ scenarios: Array<{ id: string; name: string; goal: string }> }>(
          await api.listScenarios({ name: selected.name, version: selected.version }),
        )
        setScenarios(out.scenarios)
        if (out.scenarios.length > 0) setScenarioId((s) => s || out.scenarios[0].id)
      } catch (e) {
        setError(errText(e))
      }
    })()
  }, [apis, selected])

  useEffect(() => {
    loadRuns()
  }, [apis])

  if (!selected) return h('div', { className: 'ow-card' }, h('p', { className: 'ow-note' }, t('none')))
  const res = (viewHid ? history.find((x) => x.hid === viewHid)?.result : result) as {
    humanReviewRequired?: boolean
    reviewGate?: { threshold: number; requireReviewFor: string[] }
    candidates?: Array<{
      candidateId: string
      riskScore: number
      hitRuleIds: string[]
      evidenceChains: Array<{ ruleId: string; score: number; evidence: string }>
      narrative: string[]
      pendingChecks: Array<{ note: string }>
      pendingVerification: boolean
    }>
    excluded?: Array<{ candidateId: string; ruleId: string }>
    audit?: {
      checks: Array<{ check: string; closed: boolean; detail: string }>
      forbiddenPhraseHits: Array<{ phrase: string; where: string }>
      passed: boolean
    }
  } | null

  return h(
    'div',
    { className: 'ow-card' },
    h('h3', { className: 'ow-h2' }, t('tabRun')),
    h('div', { className: 'ow-row' }, h(Loading, { text: busy ? `${t('busy')} (${busy})` : '' })),
    h(ErrorBanner, { text: error }),
    h(
      Row,
      { label: t('scenario') },
      h('select', {
        className: 'ow-sel',
        value: scenarioId,
        onChange: (e: { target: { value: string } }) => setScenarioId(e.target.value),
      }, ...scenarios.map((s) => h('option', { key: s.id, value: s.id }, `${s.name} (${s.id})`))),
      h(
        'button',
        {
          className: 'ow-btn',
          disabled: !!busy || !scenarioId,
          onClick: () =>
            void (async () => {
              setBusy('run')
              setError('')
              try {
                const dataset = JSON.parse(datasetText) as unknown
                const out = unwrap<{ result: Record<string, unknown> }>(
                  await api!.runScenario({ name: selected.name, version: selected.version, scenarioId, dataset }),
                )
                setResult(out.result)
                setViewHid('')
                const hid = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
                const label = `${scenarioId} @ ${new Date().toLocaleTimeString()}`
                setHistory((hlist) => [{ hid, label, result: out.result }, ...hlist].slice(0, 10))
                loadRuns()
              } catch (e) {
                setError(errText(e))
              } finally {
                setBusy('')
              }
            })(),
        },
        busy === 'run' ? t('busy') : t('runBtn'),
      ),
    ),
    h('div', { className: 'ow-label' }, t('dataset')),
    h('textarea', {
      className: 'ow-textarea',
      style: { minHeight: 140 },
      value: datasetText,
      onChange: (e: { target: { value: string } }) => setDatasetText(e.target.value),
    }),
    history.length > 0
      ? h(
          Row,
          { label: t('runHistory') },
          ...history.map((x) => {
            const isCurrent = viewHid ? viewHid === x.hid : x === history[0]
            return h('button', {
              key: x.hid,
              className: 'ow-btn ghost',
              style: isCurrent ? { outline: '2px solid var(--dsw-alias-brand,#3b6fd4)' } : undefined,
              disabled: !!busy,
              onClick: () => setViewHid(x.hid === viewHid ? '' : x.hid),
            }, x.label)
          }),
        )
      : null,
    res
      ? h(
          'div',
          { className: 'ow-card' },
          h(
            'div',
            { className: 'ow-row' },
            h(Tag, { text: t('humanReview'), tone: 'warn' }),
            h(Tag, {
              text: `${t('audit')}: ${res.audit?.passed ? t('passed') : t('failed')}`,
              tone: res.audit?.passed ? 'ok' : 'err',
            }),
            h(Tag, {
              text: `${t('forbidden')}: ${res.audit?.forbiddenPhraseHits?.length ?? 0}`,
              tone: (res.audit?.forbiddenPhraseHits?.length ?? 0) === 0 ? 'ok' : 'err',
            }),
            h('span', { className: 'ow-stat' }, `review≤${String(res.reviewGate?.threshold ?? '')}: ${(res.reviewGate?.requireReviewFor ?? []).join(', ') || '—'}`),
          ),
          h(
            'table',
            { className: 'ow-table' },
            h('thead', null, h('tr', null,
              h('th', null, t('chainCandidateId')), h('th', null, t('riskScore')), h('th', null, t('hits')),
              h('th', null, t('evidenceChains')), h('th', null, t('pending')), h('th', null, t('narrative'))),
            ),
            h(
              'tbody',
              null,
              ...(res.candidates ?? []).map((c) =>
                h(
                  'tr',
                  { key: c.candidateId },
                  h('td', null, c.candidateId),
                  h('td', null, h(Tag, { text: fmt(c.riskScore), tone: c.riskScore >= 0.75 ? 'err' : undefined })),
                  h('td', { className: 'ow-mono' }, (c.hitRuleIds ?? []).join('\n') || '—'),
                  h('td', { className: 'ow-mono' }, (c.evidenceChains ?? []).map((e) => `${e.ruleId}: ${e.evidence}`).join('\n') || '—'),
                  h('td', { className: 'ow-mono' }, (c.pendingChecks ?? []).map((p) => p.note).join('\n') || '—'),
                  h('td', { className: 'ow-mono' }, (c.narrative ?? []).join('\n')),
                ),
              ),
            ),
          ),
          (res.excluded ?? []).length > 0
            ? h('p', { className: 'ow-note' }, `${t('excluded')}: ${(res.excluded ?? []).map((x) => `${cand(x)}←${x.ruleId}`).join(', ')}`)
            : null,
          h(
            'table',
            { className: 'ow-table' },
            h('thead', null, h('tr', null, h('th', null, t('audit')), h('th', null, t('status')), h('th', null, t('info')))),
            h(
              'tbody',
              null,
              ...(res.audit?.checks ?? []).map((a) =>
                h(
                  'tr',
                  { key: a.check },
                  h('td', null, a.check),
                  h('td', null, h(Tag, { text: a.closed ? t('passed') : t('failed'), tone: a.closed ? 'ok' : 'err' })),
                  h('td', { className: 'ow-mono' }, a.detail),
                ),
              ),
            ),
          ),
        )
      : null,
    // 持久运行记录（S2.5）：列表 + 两轮对比 + 审计导出（只读薄视图）。
    h('h4', { className: 'ow-h2' }, t('runRecords')),
    h(
      'div',
      { className: 'ow-row' },
      h('span', { className: 'ow-note' }, t('selHint')),
      h(
        'button',
        {
          className: 'ow-btn',
          disabled: !!busy || !selA || !selB || selA === selB,
          onClick: () =>
            void (async () => {
              setBusy('compare')
              setError('')
              setDiff(null)
              try {
                const out = unwrap<{ diff: Record<string, unknown> }>(
                  await api!.compareRuns({ runIdA: selA, runIdB: selB }),
                )
                setDiff(out.diff)
              } catch (e) {
                setError(errText(e))
              } finally {
                setBusy('')
              }
            })(),
        },
        busy === 'compare' ? t('busy') : t('compareBtn'),
      ),
      h('button', { className: 'ow-btn ghost', disabled: !!busy, onClick: () => loadRuns() }, t('refresh')),
    ),
    runs.length > 0
      ? h(
          'table',
          { className: 'ow-table' },
          h(
            'thead',
            null,
            h('tr', null,
              h('th', null, 'A'), h('th', null, 'B'), h('th', null, 'runId'), h('th', null, t('scenario')),
              h('th', null, t('name')), h('th', null, t('digest')), h('th', null, t('audit')),
              h('th', null, t('savedAt')), h('th', null, t('actions'))),
          ),
          h(
            'tbody',
            null,
            ...runs.map((r) =>
              h(
                'tr',
                { key: r.runId },
                h('td', null, h('input', {
                  type: 'radio', name: 'onto-run-a', checked: selA === r.runId,
                  onChange: () => setSelA(r.runId),
                })),
                h('td', null, h('input', {
                  type: 'radio', name: 'onto-run-b', checked: selB === r.runId,
                  onChange: () => setSelB(r.runId),
                })),
                h('td', { className: 'ow-mono' }, r.runId),
                h('td', null, r.scenarioId),
                h('td', null, `${r.package.name}@${r.package.version}`),
                h('td', { className: 'ow-mono' }, r.datasetDigest),
                h('td', null, h(Tag, {
                  text: r.auditPassed ? t('passed') : t('failed'),
                  tone: r.auditPassed ? 'ok' : 'err',
                })),
                h('td', null, r.savedAt),
                h('td', null, h(
                  'button',
                  {
                    className: 'ow-btn ghost',
                    disabled: !!busy,
                    onClick: () =>
                      void (async () => {
                        setBusy('export')
                        setError('')
                        try {
                          const out = unwrap<{ locator: string; manifestLocator: string; chainLocator?: string }>(
                            await api!.exportAudit({ runId: r.runId }),
                          )
                          setExportInfo(
                            [out.locator, out.chainLocator, out.manifestLocator].filter(Boolean).join(' + '),
                          )
                        } catch (e) {
                          setError(errText(e))
                        } finally {
                          setBusy('')
                        }
                      })(),
                  },
                  t('exportAuditBtn'),
                ), h(
                  'button',
                  {
                    className: 'ow-btn ghost',
                    disabled: !!busy,
                    onClick: () =>
                      void (async () => {
                        setBusy('chain')
                        setError('')
                        try {
                          const out = unwrap<Record<string, unknown>>(
                            await api!.reviewChain({ runId: r.runId }),
                          )
                          setChain(out)
                          setChainRunId(r.runId)
                        } catch (e) {
                          setError(errText(e))
                        } finally {
                          setBusy('')
                        }
                      })(),
                  },
                  t('reviewChainBtn'),
                )),
              ),
            ),
          ),
        )
      : h('p', { className: 'ow-note' }, t('empty')),
    exportInfo
      ? h('p', { className: 'ow-note ow-mono' }, `${t('locator')}: ${exportInfo}`)
      : null,
    ...diffView(),
    ...chainView(),
  )

  /** D 包治理链视图：复核决定 → 动作提案 → 动作台账（含批准摘要与外部回执）。 */
  function chainView(): ReactNode[] {
    if (!chain) return []
    const c = chain as unknown as {
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
    const empty = c.decisions.length === 0 && c.proposals.length === 0 && c.actions.length === 0
    return [
      h('h4', { className: 'ow-h2' }, t('reviewChainTitle')),
      h('p', { className: 'ow-note ow-mono' }, chainRunId),
      empty ? h('p', { className: 'ow-note' }, t('chainEmpty')) : null,
      c.decisions.length > 0
        ? h('table', { className: 'ow-table' },
            h('thead', null, h('tr', null,
              h('th', null, t('chainDecision')), h('th', null, t('chainDecisionId')), h('th', null, t('chainReason')),
              h('th', null, t('chainCandidates')), h('th', null, t('chainReviewer')), h('th', null, t('chainSnapshot')))),
            h('tbody', null, ...c.decisions.map((d) =>
              h('tr', { key: d.decisionId },
                h('td', null, h(Tag, { text: d.decision, tone: d.decision === 'approved' ? 'ok' : 'err' })),
                h('td', { className: 'ow-mono' }, d.decisionId),
                h('td', null, d.reason ?? '—'),
                h('td', { className: 'ow-mono' }, d.candidateIds.join(', ')),
                h('td', { className: 'ow-mono' }, d.reviewer),
                h('td', { className: 'ow-mono' }, `${d.snapshotDigest.slice(0, 8)} / ${d.ruleFingerprint.slice(0, 8)}`),
              ))))
        : null,
      c.proposals.length > 0
        ? h('table', { className: 'ow-table' },
            h('thead', null, h('tr', null,
              h('th', null, t('chainProposal')), h('th', null, t('chainDecisionId')), h('th', null, t('chainCandidateId')),
              h('th', null, t('chainOperation')), h('th', null, t('chainBehObject')), h('th', null, t('chainStatus')))),
            h('tbody', null, ...c.proposals.map((p) =>
              h('tr', { key: p.proposalId },
                h('td', { className: 'ow-mono' }, p.proposalId),
                h('td', { className: 'ow-mono' }, p.decisionId),
                h('td', { className: 'ow-mono' }, p.candidateId),
                h('td', { className: 'ow-mono' }, p.operationId),
                h('td', { className: 'ow-mono' }, `${p.behaviorId} → ${p.objectRef}`),
                h('td', null, h(Tag, {
                  text: p.status,
                  tone: p.status === 'consumed' ? 'ok' : p.status === 'pending' ? 'warn' : undefined,
                })),
              ))))
        : null,
      c.actions.length > 0
        ? h('table', { className: 'ow-table' },
            h('thead', null, h('tr', null,
              h('th', null, t('chainAction')), h('th', null, t('chainProposalId')), h('th', null, t('chainStatus')),
              h('th', null, t('chainBehObject')), h('th', null, t('chainExternalRef')), h('th', null, t('chainApproval')))),
            h('tbody', null, ...c.actions.map((a) =>
              h('tr', { key: a.actionId },
                h('td', { className: 'ow-mono' }, a.actionId),
                h('td', { className: 'ow-mono' }, a.proposalId ?? '—'),
                h('td', null, h(Tag, {
                  text: a.status,
                  tone: a.status === 'succeeded' ? 'ok' : a.status === 'executing' ? 'warn' : 'err',
                })),
                h('td', { className: 'ow-mono' }, `${a.behaviorId} → ${a.objectRef}`),
                h('td', { className: 'ow-mono' }, a.externalRef ?? '—'),
                h('td', { className: 'ow-mono' }, a.approvalDigest ? a.approvalDigest.slice(0, 12) : '—'),
              ))))
        : null,
    ].filter(Boolean) as ReactNode[]
  }

  function diffView(): ReactNode[] {
    if (!diff) return []
    const d = diff as unknown as {
      runIdA: string
      runIdB: string
      sameDataset: boolean
      auditPassedA: boolean
      auditPassedB: boolean
      candidates: Array<{
        candidateId: string
        riskScoreA: number | null
        riskScoreB: number | null
        riskScoreDelta: number | null
        hitRuleIdsAdded: string[]
        hitRuleIdsRemoved: string[]
        pendingChecksAdded: string[]
        pendingChecksRemoved: string[]
      }>
      excludedAdded: Array<{ candidateId: string; ruleId: string }>
      excludedRemoved: Array<{ candidateId: string; ruleId: string }>
    }
    return [
      h('h4', { className: 'ow-h2' }, t('diffTitle')),
      h(
        'div',
        { className: 'ow-row' },
        h(Tag, { text: `${d.runIdA} → ${d.runIdB}` }),
        h(Tag, {
          text: `${t('sameDataset')}: ${d.sameDataset ? t('passed') : t('failed')}`,
          tone: d.sameDataset ? 'ok' : 'err',
        }),
        h(Tag, { text: `A ${d.auditPassedA ? t('passed') : t('failed')}`, tone: d.auditPassedA ? 'ok' : 'err' }),
        h(Tag, { text: `B ${d.auditPassedB ? t('passed') : t('failed')}`, tone: d.auditPassedB ? 'ok' : 'err' }),
        h(Tag, { text: t('humanReview'), tone: 'warn' }),
      ),
      h(
        'table',
        { className: 'ow-table' },
        h('thead', null, h('tr', null,
          h('th', null, t('chainCandidateId')), h('th', null, t('scoreAB')), h('th', null, t('hits')), h('th', null, t('pending')))),
        h(
          'tbody',
          null,
          ...d.candidates.map((c) =>
            h(
              'tr',
              { key: c.candidateId },
              h('td', null, c.candidateId),
              h('td', { className: 'ow-mono' },
                `${c.riskScoreA ?? '—'} → ${c.riskScoreB ?? '—'}${c.riskScoreDelta === null ? '' : ` (Δ=${c.riskScoreDelta})`}`),
              h('td', { className: 'ow-mono' },
                [...c.hitRuleIdsAdded.map((x) => `+${x}`), ...c.hitRuleIdsRemoved.map((x) => `-${x}`)].join('\n') || '—'),
              h('td', { className: 'ow-mono' },
                [...c.pendingChecksAdded.map((x) => `+${x}`), ...c.pendingChecksRemoved.map((x) => `-${x}`)].join('\n') || '—'),
            ),
          ),
        ),
      ),
      d.excludedAdded.length + d.excludedRemoved.length > 0
        ? h('p', { className: 'ow-note' },
            `${t('excluded')}: ${[
              ...d.excludedAdded.map((x) => `+${x.candidateId}←${x.ruleId}`),
              ...d.excludedRemoved.map((x) => `-${x.candidateId}←${x.ruleId}`),
            ].join(', ')}`)
        : null,
    ]
  }

  function cand(x: { candidateId: string }): string {
    return x.candidateId
  }
}
