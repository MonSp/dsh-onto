/* ─────────────────────────────────────────────────────────────────────────
 * 经验闭环（experience-loop P2-1）：经验列表 + 人审回填 + 新建回填 + 抽象草案
 * （反馈闭环②断链 A/B）：annotateExperience 新建/回填一体（缺卡按 RunRecord 补建）；
 * abstractExperiences 把经验聚簇成草案入人审队列（只入队不直写包），
 * includePriorVersions 放行同名历史版本经验（ISSUED 生产经验回流当前 DRAFT）。
 * ───────────────────────────────────────────────────────────────────────── */
import { h, useState, useEffect } from '../react'
import type { Ctx } from '../types'
import { Tag, ErrorBanner } from '../ui'
import { unwrap, errText } from '../helpers'

/** outcome 原 token → locale key（展示本地化；提交值仍传原 token）。 */
const OUTCOME_KEY: Record<string, string> = {
  success: 'outcomeSuccess',
  partial: 'outcomePartial',
  failure: 'outcomeFailure',
  'pending-human': 'outcomePendingHuman',
}

function outcomeText(t: (k: string) => string, token: string): string {
  const key = OUTCOME_KEY[token]
  return key === undefined ? token : t(key)
}

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
  // 回填表单（新建/回填同面：缺卡时 outcome 必填）
  const [formOutcome, setFormOutcome] = useState('')
  const [formReason, setFormReason] = useState('')
  // 三态：'' 不改 | 'true' 判误迁移 | 'false' 判非误迁移（by 取宿主身份，不收自报）
  const [formMis, setFormMis] = useState('')
  const [formNote, setFormNote] = useState('')
  const [formFocus, setFormFocus] = useState('')
  const [formCounter, setFormCounter] = useState(false)
  // 新建回填：手动输入 runId（经验列表外的旧 run）
  const [newRunId, setNewRunId] = useState('')
  // 抽象草案：含同名历史版本经验（断链 B）
  const [includePrior, setIncludePrior] = useState(false)
  const [abstractOut, setAbstractOut] = useState('')
  const api = apis.remote['ontoRuntime']

  const load = () => {
    if (!api) return
    void (async () => {
      setError('')
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
        // counterexample：新建恒随表单；回填仅在与当前值不同时发送（patch 语义，防误清机械反例）
        const currentCounter = viewNote !== null && (viewNote as { counterexample?: boolean }).counterexample === true
        if (viewNote === null || formCounter !== currentCounter) patch.counterexample = formCounter
        if (formMis === 'true' || formMis === 'false') {
          // misTransfer.by 不收自报：服务端取宿主可信身份（host:<userId>）
          patch.misTransfer = { judged: formMis === 'true', note: formNote }
        }
        if (formFocus.trim()) patch.reviewFocus = formFocus.split(',').map((s) => s.trim()).filter(Boolean)
        const out = unwrap<{ note: Record<string, unknown> }>(await api.annotateExperience(patch as never))
        setViewNote(out.note)
        load()
      } catch (e) {
        setError(errText(e))
      } finally {
        setBusy('')
      }
    })()
  }

  const abstract = () => {
    if (!api) return
    void (async () => {
      setBusy('abstract')
      setError('')
      setAbstractOut('')
      try {
        const out = unwrap<{
          package: string
          skills: number
          counters: number
          queued: Array<{ id: string; name: string; targetKind: string; status: string }>
        }>(await api.abstractExperiences({ includePriorVersions: includePrior } as never))
        // 回执恒含 humanReviewRequired=true（与工具面口径一致）；空簇不伪称「已入队」
        setAbstractOut(
          out.queued.length === 0
            ? `${out.package}: ${t('expAbstractNone')}（skills=${out.skills} counters=${out.counters}）· humanReviewRequired=true`
            : `${t('expAbstracted')}: ${out.package} skills=${out.skills} counters=${out.counters} → `
              + out.queued.map((q) => `${q.id}(${q.targetKind}/${q.status})`).join(', ')
              + ' · humanReviewRequired=true',
        )
      } catch (e) {
        setError(errText(e))
      } finally {
        setBusy('')
      }
    })()
  }

  const openNote = (runId: string) => {
    if (!api) return
    void (async () => {
      setBusy('show')
      setError('')
      setViewRun(runId)
      setFormOutcome('')
      setFormReason('')
      setFormMis('')
      setFormNote('')
      setFormCounter(false)
      setFormFocus('')
      try {
        const out = unwrap<{ note: Record<string, unknown> }>(await api.showExperience({ runId }))
        setViewNote(out.note)
        const focus = (out.note as { reviewFocus?: string[] }).reviewFocus
        if (Array.isArray(focus)) setFormFocus(focus.join(', '))
        // 表单反例勾选回显当前值（回填按差异发送，可清除机械置位的反例）
        setFormCounter((out.note as { counterexample?: boolean }).counterexample === true)
      } catch (e) {
        // 缺卡（S5.4.2 前旧 run）→ 新建模式：回填即补建；其它错误显式上墙、不静默进「新建」
        setViewNote(null)
        const msg = errText(e)
        setError(/not[-_ ]?found|不存在/i.test(msg) ? '' : msg)
      } finally {
        setBusy('')
      }
    })()
  }

  const startCreate = () => {
    const runId = newRunId.trim()
    if (runId === '') return
    setViewRun(runId)
    setViewNote(null)
    setFormOutcome('')
    setFormReason('')
    setFormMis('')
    setFormNote('')
    setFormCounter(false)
    setFormFocus('')
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
      h('input', {
        className: 'ow-in',
        placeholder: t('expRunId'),
        value: newRunId,
        onChange: (e: { target: { value: string } }) => setNewRunId(e.target.value),
      }),
      h('button', {
        className: 'ow-btn ghost',
        disabled: !!busy || newRunId.trim() === '',
        onClick: () => startCreate(),
      }, t('expCreateBtn')),
      h('button', {
        className: 'ow-btn',
        disabled: !!busy,
        onClick: () => abstract(),
      }, t('expAbstractBtn')),
      h('label', { className: 'ow-note', style: { display: 'inline-flex', gap: '4px', alignItems: 'center' } },
        h('input', {
          type: 'checkbox',
          checked: includePrior,
          onChange: (e: { target: { checked: boolean } }) => setIncludePrior(e.target.checked),
        }),
        t('expIncludePrior'),
      ),
    ),
    h('p', { className: 'ow-note' }, t('expAbstractHint')),
    abstractOut ? h('p', { className: 'ow-note' }, abstractOut) : null,
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
                  text: outcomeText(t, r.outcome),
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
                    onClick: () => openNote(r.runId),
                  },
                  t('expReviewBtn'),
                )),
              ),
            ),
          ),
        )
      : h('p', { className: 'ow-note' }, t('empty')),
    viewRun
      ? h(
          'div',
          { className: 'ow-row' },
          h('span', { className: 'ow-stat' }, `${viewRun}${viewNote === null ? `（${t('expCreateTitle')}）` : ''}`),
          h('select', {
            className: 'ow-sel',
            value: formOutcome,
            onChange: (e: { target: { value: string } }) => setFormOutcome(e.target.value),
          },
            h('option', { value: '' }, '—'),
            h('option', { value: 'success' }, outcomeText(t, 'success')),
            h('option', { value: 'partial' }, outcomeText(t, 'partial')),
            h('option', { value: 'failure' }, outcomeText(t, 'failure')),
            h('option', { value: 'pending-human' }, outcomeText(t, 'pending-human'))),
          h('input', {
            className: 'ow-in',
            placeholder: t('expReason'),
            value: formReason,
            onChange: (e: { target: { value: string } }) => setFormReason(e.target.value),
          }),
          viewNote === null
            ? h('label', { className: 'ow-note', style: { display: 'inline-flex', gap: '4px', alignItems: 'center' } },
                h('input', {
                  type: 'checkbox',
                  checked: formCounter,
                  onChange: () => setFormCounter((v: boolean) => !v),
                }),
                t('expCounter'))
            : null,
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
                // 新建须 outcome（人审定性）；回填至少一项
                (viewNote === null && !formOutcome) ||
                (!formOutcome && !formReason.trim() && formMis === '' && !formFocus.trim() && !formCounter),
              onClick: () => review(viewRun),
            },
            t('expReviewBtn'),
          ),
          h('span', { className: 'ow-note' }, t('expMisByHost')),
        )
      : null,
  )
}
