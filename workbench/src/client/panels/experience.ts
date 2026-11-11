import { h, useState, useEffect, useCallback, useMemo, useRef } from '../react'
import type { ReactNode } from '../types'
import type { Ctx } from '../types'
import { Tag, Row, Card, ErrorBanner, OkBanner, Loading, Field, PipelineView } from '../ui'
import { unwrap, errText, fmt } from '../helpers'

/* ═══════════════════════════════════════════════════════════════
 * 经验闭环（experience-loop P2-1）：经验列表 + 人审回填
 * ═══════════════════════════════════════════════════════════════ */

export function ExperiencePanel(props: {
  t: (k: string) => string
  apis: Ctx
}) {
  const { t, apis } = props
  const [rows, setRows] = useState<Array<{
    runId: string
    scenarioId: string
    packageScope: string
    outcome: string
    counterexample: boolean
    reusedFrom: string | null
    misTransferJudged: boolean
    reviewFocus: string[]
    savedAt: string
  }>>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [viewRun, setViewRun] = useState('')
  const [viewNote, setViewNote] = useState<Record<string, unknown> | null>(null)
  // 回填表单
  const [formOutcome, setFormOutcome] = useState('')
  const [formReason, setFormReason] = useState('')
  // 三态：'' 不改 | 'true' 判误迁移 | 'false' 判非误迁移（by 两者皆必填）
  const [formMis, setFormMis] = useState('')
  const [formBy, setFormBy] = useState('')
  const [formNote, setFormNote] = useState('')
  const [formFocus, setFormFocus] = useState('')
  const api = apis.remote['ontoRuntime']

  const load = () => {
    if (!api) return
    void (async () => {
      try {
        const out = unwrap<{ experiences: typeof rows }>(await api.listExperiences())
        setRows(out.experiences)
      } catch (e) {
        setError(errText(e))
      }
    })()
  }

  useEffect(() => {
    load()
  }, [apis])

  const review = (runId: string) => {
    if (!api) return
    void (async () => {
      setBusy('review')
      setError('')
      try {
        const patch: Record<string, unknown> = { runId }
        if (formOutcome) patch.outcome = formOutcome
        if (formReason.trim()) patch.outcomeReason = formReason
        if (formMis === 'true' || formMis === 'false') {
          patch.misTransfer = { judged: formMis === 'true', by: formBy, note: formNote }
        }
        if (formFocus.trim()) patch.reviewFocus = formFocus.split(',').map((s) => s.trim()).filter(Boolean)
        const out = unwrap<{ note: Record<string, unknown> }>(await api.reviewExperience(patch as never))
        setViewNote(out.note)
        load()
      } catch (e) {
        setError(errText(e))
      } finally {
        setBusy('')
      }
    })()
  }

  return h(
    'div',
    { className: 'ow-card' },
    h('h3', { className: 'ow-h2' }, t('expTitle')),
    h('p', { className: 'ow-note' }, t('expReviewHint')),
    h(ErrorBanner, { text: error }),
    h(
      'div',
      { className: 'ow-row' },
      h('button', { className: 'ow-btn ghost', disabled: !!busy, onClick: () => load() }, t('refresh')),
    ),
    rows.length > 0
      ? h(
          'table',
          { className: 'ow-table' },
          h(
            'thead',
            null,
            h('tr', null,
              h('th', null, 'runId'), h('th', null, t('scenario')), h('th', null, 'scope'),
              h('th', null, t('expOutcome')), h('th', null, t('expCounter')),
              h('th', null, t('expReused')), h('th', null, t('expMis')),
              h('th', null, t('expFocus')), h('th', null, t('savedAt')), h('th', null, t('actions'))),
          ),
          h(
            'tbody',
            null,
            ...rows.map((r) =>
              h(
                'tr',
                { key: r.runId },
                h('td', { className: 'ow-mono' }, r.runId),
                h('td', null, r.scenarioId),
                h('td', null, r.packageScope),
                h('td', null, h(Tag, {
                  text: r.outcome,
                  tone: r.outcome === 'success' ? 'ok' : r.outcome === 'failure' ? 'err' : 'warn',
                })),
                h('td', null, r.counterexample ? '✓' : '—'),
                h('td', { className: 'ow-mono' }, r.reusedFrom ?? '—'),
                h('td', null, r.misTransferJudged ? '✓' : '—'),
                h('td', null, r.reviewFocus.join(', ') || '—'),
                h('td', null, r.savedAt),
                h('td', null, h(
                  'button',
                  {
                    className: 'ow-btn ghost',
                    disabled: !!busy,
                    onClick: () =>
                      void (async () => {
                        setBusy('show')
                        setError('')
                        setViewRun(r.runId)
                        setFormOutcome('')
                        setFormReason('')
                        setFormMis('')
                        setFormBy('')
                        setFormNote('')
                        setFormFocus(r.reviewFocus.join(', '))
                        try {
                          const out = unwrap<{ note: Record<string, unknown> }>(
                            await api!.showExperience({ runId: r.runId }),
                          )
                          setViewNote(out.note)
                        } catch (e) {
                          setError(errText(e))
                        } finally {
                          setBusy('')
                        }
                      })(),
                  },
                  t('expReviewBtn'),
                )),
              ),
            ),
          ),
        )
      : h('p', { className: 'ow-note' }, t('empty')),
    viewRun && viewNote
      ? h(
          'div',
          { className: 'ow-row' },
          h('span', { className: 'ow-stat' }, `${viewRun}`),
          h('select', {
            className: 'ow-sel',
            value: formOutcome,
            onChange: (e: { target: { value: string } }) => setFormOutcome(e.target.value),
          },
            h('option', { value: '' }, '—'),
            h('option', { value: 'success' }, 'success'),
            h('option', { value: 'partial' }, 'partial'),
            h('option', { value: 'failure' }, 'failure'),
            h('option', { value: 'pending-human' }, 'pending-human')),
          h('input', {
            className: 'ow-in',
            placeholder: t('expReason'),
            value: formReason,
            onChange: (e: { target: { value: string } }) => setFormReason(e.target.value),
          }),
          h('select', {
            className: 'ow-sel',
            value: formMis,
            onChange: (e: { target: { value: string } }) => setFormMis(e.target.value),
          },
            h('option', { value: '' }, `${t('expMis')} —`),
            h('option', { value: 'true' }, `${t('expMis')} true`),
            h('option', { value: 'false' }, `${t('expMis')} false`)),
          formMis !== ''
            ? h('input', {
                className: 'ow-in',
                placeholder: t('expMisBy'),
                value: formBy,
                onChange: (e: { target: { value: string } }) => setFormBy(e.target.value),
              })
            : null,
          formMis !== ''
            ? h('input', {
                className: 'ow-in',
                placeholder: t('expMisNote'),
                value: formNote,
                onChange: (e: { target: { value: string } }) => setFormNote(e.target.value),
              })
            : null,
          h('input', {
            className: 'ow-in',
            placeholder: t('expFocus'),
            value: formFocus,
            onChange: (e: { target: { value: string } }) => setFormFocus(e.target.value),
          }),
          h(
            'button',
            {
              className: 'ow-btn',
              disabled:
                !!busy ||
                (!formOutcome && !formReason.trim() && formMis === '' && !formFocus.trim())
                // 误迁移判定必须带 by（人工身份）——前端先拦，不再把必填报错甩给后端。
                || (formMis !== '' && !formBy.trim()),
              onClick: () => review(viewRun),
            },
            t('expReviewBtn'),
          ),
        )
      : null,
  )
}
