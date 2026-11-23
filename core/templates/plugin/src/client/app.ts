import { h, useState, useEffect, setReact } from './react'
import type { ReactNode, Ctx, PluginModule } from './types'
import { zh, en } from './locale'
import { CSS } from './styles'
import { createDiffToolView, createReportToolView, ComparePanel, ReportSurface, reportTextSummary } from './report'
import { buildDefaultReportSurface, validateReportSurface } from '@dsh-onto/core/surface'
import { diffViewOf, type RunDiffView } from '@dsh-onto/core/diffview'
import type { RunReport } from '@dsh-onto/core/report'
import type { ReportPage } from '@dsh-onto/core/reportpage'

const NS = '__NS__'
const PANEL_ID = '__PANEL_ID__'
const PKG_NAME = '__PKG_NAME__'
const PKG_VERSION = '__PKG_VERSION__'
const DEFAULT_SCENARIO = '__SCENARIO_ID__'
const SOURCE_ID = '__SOURCE_ID__'

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
  const [report, setReport] = useState<RunReport | null>(null)

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
      setReport(null)
      try {
        const out = unwrap<{ result: { runId: string } }>(
          await api.runScenario({
            name: PKG_NAME,
            version: PKG_VERSION,
            scenarioId,
            sourceId: SOURCE_ID,
            analysisMode: 'explore',
          }),
        )
        // 固定页与对话报表共用 getRunReport 同一投影（chat-run-report S2.5）
        const rep = unwrap<{ report: RunReport }>(
          await api.getRunReport({ runId: out.result.runId }),
        )
        setReport(rep.report)
      } catch (e) {
        setError(errText(e))
      } finally {
        setBusy('')
      }
    })()
  }

  const resultView = (): ReactNode[] => {
    if (!report) return [h('p', { key: 'e', className: 'txri-note' }, t('empty'))]
    return [
      h('p', { key: 'rid', className: 'txri-note txri-mono' }, `${t('runId')}: ${report.runRef.runId}`),
      h(
        'div',
        { key: 'meta', className: 'txri-bar' },
        report.summary.dataStatus !== undefined
          ? h('span', { className: `tag ${statusTone(report.summary.dataStatus) ?? ''}` }, `${t('dataStatus')}: ${report.summary.dataStatus}`)
          : null,
        report.summary.contractStatus !== undefined
          ? h('span', { className: `tag ${statusTone(report.summary.contractStatus) ?? ''}` }, `${t('contractStatus')}: ${report.summary.contractStatus}`)
          : null,
        h('span', { className: `tag ${report.summary.auditPassed ? 'ok' : 'err'}` }, `${t('audit')}: ${report.summary.auditPassed ? 'PASS' : 'FAIL'}`),
        h('span', { className: 'tag ok' }, t('humanReview')),
      ),
      h(ReportSurface, {
        key: 'rs',
        surface: buildDefaultReportSurface(),
        report,
        t,
        navigate: () => {},
      }),
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

/** 报表页（chat-run-report S2.7）：沉淀的 surface 换 run 复用（绑定按稳定字段引用重解析）。 */
function ReportPages(props: { t: (k: string) => string; ctx: Ctx }) {
  const { t, ctx } = props
  const api = ctx.remote['ontoRuntime']
  const [pages, setPages] = useState<ReportPage[]>([])
  const [pageId, setPageId] = useState('')
  const [runs, setRuns] = useState<Array<{ runId: string; package?: { name?: string } }>>([])
  const [runId, setRunId] = useState('')
  const [report, setReport] = useState<RunReport | null>(null)
  const [compareRunId, setCompareRunId] = useState('')
  const [diff, setDiff] = useState<RunDiffView | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!api) return
    void (async () => {
      setError('')
      try {
        const out = unwrap<{ pages: ReportPage[] }>(await api.listReportPages())
        const list = out.pages ?? []
        setPages(list)
        if (list.length > 0) {
          setPageId((prev) => (prev !== '' ? prev : list[0].pageId))
          setRunId((prev) => (prev !== '' ? prev : list[0].createdFrom.runId))
        }
        const runsOut = unwrap<{ runs: Array<{ runId: string }> }>(await api.listRuns())
        setRuns(runsOut.runs ?? [])
      } catch (e) {
        setError(errText(e))
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!api || pageId === '' || runId === '') return
    void (async () => {
      setError('')
      setReport(null)
      try {
        const out = unwrap<{ report: RunReport }>(await api.getRunReport({ runId }))
        setReport(out.report)
      } catch (e) {
        setError(errText(e))
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId, runId])

  // 对比入口（report-export-compare）：选第二 run 即出对比卡，页面与对话同源
  useEffect(() => {
    if (!api || runId === '' || compareRunId === '' || compareRunId === runId) {
      setDiff(null)
      return
    }
    let live = true
    // 换 pair/换 run/换页即刻清旧卡，不残留到新数据落地
    setDiff(null)
    void (async () => {
      try {
        const out = unwrap<{ diff: Parameters<typeof diffViewOf>[0] }>(
          await api.compareRuns({ runIdA: runId, runIdB: compareRunId }),
        )
        if (!live) return
        setDiff(diffViewOf(out.diff))
      } catch (e) {
        if (!live) return
        setDiff(null)
        setError(errText(e))
      }
    })()
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId, runId, compareRunId])

  const page = pages.find((p) => p.pageId === pageId)
  // 渲染前校验闸（S2.2 两处共用）：wire 面数据亦须过同一契约
  const checked = page ? validateReportSurface(page.surface) : null
  const runOptions = runs.filter(
    (r) =>
      page === undefined ||
      r.runId === page.createdFrom.runId ||
      (r.package?.name ?? '') === page.createdFrom.package.name,
  )
  return h(
    'div',
    { className: 'txri-gov' },
    h('h3', null, t('pages')),
    error ? h('p', { className: 'txri-err' }, `${t('error')}: ${error}`) : null,
    pages.length === 0
      ? h('p', { className: 'txri-note' }, t('pagesEmpty'))
      : h(
          'div',
          null,
          h(
            'div',
            { className: 'txri-bar' },
            h('label', null, `${t('pages')}: `),
            h(
              'select',
              { value: pageId, onChange: (e: { target: { value: string } }) => setPageId(e.target.value) },
              ...pages.map((p) => h('option', { key: p.pageId, value: p.pageId }, `${p.name} (${p.pageId})`)),
            ),
            h('label', null, `${t('pagesRun')}: `),
            h(
              'select',
              { value: runId, onChange: (e: { target: { value: string } }) => setRunId(e.target.value) },
              ...runOptions.map((r) => h('option', { key: r.runId, value: r.runId }, r.runId)),
            ),
            h('label', null, `${t('compareWith')}: `),
            h(
              'select',
              {
                value: compareRunId,
                onChange: (e: { target: { value: string } }) => setCompareRunId(e.target.value),
              },
              h('option', { value: '' }, '—'),
              ...runOptions
                .filter((r) => r.runId !== runId)
                .map((r) => h('option', { key: r.runId, value: r.runId }, r.runId)),
            ),
          ),
          page && report
            ? checked !== null && checked.ok
              ? h(ReportSurface, {
                  surface: checked.value,
                  report,
                  t,
                  navigate: () => {},
                  diff: diff ?? undefined,
                })
              : h(
                  'div',
                  null,
                  h('p', { className: 'txri-note' }, t('reportBadSurface')),
                  reportTextSummary(report, t),
                )
            : h('p', { className: 'txri-note' }, t('reportLoading')),
          diff !== null ? h(ComparePanel, { diff, t }) : null,
        ),
  )
}

export function createPlugin(React: typeof import('react')): PluginModule {
  setReact(React)

  return {
    inject: ['slots', 'locale', 'remote', 'remote.ontoRuntime', 'layout'],
    apply(ctx: Ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), '__PLUGIN_INSERT_ID__: dictionaries')

      ctx.effect(() => {
        const style = document.createElement('style')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, '__PLUGIN_INSERT_ID__: styles')

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
        return h(
          'div',
          null,
          h(RunPanel, { t, ctx }),
          h(ReportPages, { t, ctx }),
        )
      }

      // 对话内交互报表（chat-run-report S2.5）：tool.call.toolview keyed = show_run_report
      const navigate = (): void => {
        try {
          ctx.layout?.selectPanel(PANEL_ID)
        } catch {
          /* 面板未注册时跳转静默降级（回退文本仍在） */
        }
      }
      const ReportToolView = createReportToolView({
        api: { getRunReport: (request: { runId: string }) => api().getRunReport(request) },
        t,
        navigate,
      })
      const DiffToolView = createDiffToolView({
        api: {
          compareRuns: (request: { runIdA: string; runIdB: string }) => api().compareRuns(request),
        },
        t,
      })
      function api() {
        const remote = ctx.remote['ontoRuntime']
        if (!remote) throw new Error('remote.ontoRuntime missing')
        return remote
      }

      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, Panel),
      )
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 3, locale: NS, label: () => t('panel') },
          PanelIcon,
        ),
      )
      ctx.slots.inject('tool.call.toolview', () =>
        ctx.slots.register(
          { name: 'tool.call.toolview', key: 'show_run_report', locale: NS },
          ReportToolView,
        ),
      )
      ctx.slots.inject('tool.call.toolview', () =>
        ctx.slots.register(
          { name: 'tool.call.toolview', key: 'show_run_diff', locale: NS },
          DiffToolView,
        ),
      )
    },
  }
}
