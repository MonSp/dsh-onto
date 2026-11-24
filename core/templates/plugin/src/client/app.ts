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
/** 生成期默认源 id（部署 env 登记可不在 source-configs.json；标注 string 防 token 替换后字面量窄化）。 */
const SOURCE_ID: string = '__SOURCE_ID__'
/** 数据通道：connector = sourceId 取数；dataset = 运行页内联 JSON（纯内容包）。 */
const DATA_MODE: string = '__DATA_MODE__'

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

/** 受控数据源摘要（listSourceConfigs；部署 env 登记的默认源可不在表内）。 */
interface SourceRow {
  sourceId: string
  sourceKind?: 'simulated' | 'formal'
  registeredAt?: string
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
  const [datasetText, setDatasetText] = useState('')
  // 双通道（issue #30 WP-B）：dataset=探索（内联）；source=正式（受控数据源，互斥口径）
  const [channel, setChannel] = useState<'dataset' | 'source'>(DATA_MODE === 'dataset' ? 'dataset' : 'source')
  const [sourceId, setSourceId] = useState(SOURCE_ID)
  const [sources, setSources] = useState<SourceRow[]>([])
  const [dataTrust, setDataTrust] = useState<{ provenance: string; verified: boolean; note: string } | null>(null)

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
    void (async () => {
      try {
        const out = unwrap<{ sources: SourceRow[] }>(
          await api.listSourceConfigs({ name: PKG_NAME, version: PKG_VERSION }),
        )
        const list = [...(out.sources ?? [])]
        // 生成期默认源（部署 env 登记可不在 source-configs.json）保底可选
        if (SOURCE_ID !== '' && !list.some((s) => s.sourceId === SOURCE_ID)) {
          list.unshift({ sourceId: SOURCE_ID })
        }
        setSources(list)
        if (list.length > 0 && !list.some((s) => s.sourceId === sourceId)) {
          setSourceId(list[0].sourceId)
        }
      } catch {
        // 选源面加载失败不堵运行区；通道切到正式时下拉为空并提示
        setSources(SOURCE_ID !== '' ? [{ sourceId: SOURCE_ID }] : [])
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
      setDataTrust(null)
      try {
        let dataset: unknown
        if (channel === 'dataset') {
          if (datasetText.trim() === '') throw new Error(t('datasetRequired'))
          try {
            dataset = JSON.parse(datasetText)
          } catch {
            throw new Error(t('datasetInvalid'))
          }
        } else if (sourceId === '') {
          throw new Error(t('sourceRequired'))
        }
        const out = unwrap<{ result: { runId: string; dataTrust?: { provenance: string; verified: boolean; note: string } } }>(
          await api.runScenario({
            name: PKG_NAME,
            version: PKG_VERSION,
            scenarioId,
            // sourceId（正式）与 dataset（探索）互斥——服务端同口径校验
            ...(channel === 'dataset' ? { dataset } : { sourceId }),
            analysisMode: 'explore',
          }),
        )
        setDataTrust(out.result.dataTrust ?? null)
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
      h('span', { className: 'txri-note' }, `${t('channel')}:`),
      h(
        'button',
        {
          type: 'button',
          className: channel === 'dataset' ? 'txri-primary' : '',
          disabled: busy !== '',
          onClick: () => setChannel('dataset'),
        },
        t('channelExplore'),
      ),
      h(
        'button',
        {
          type: 'button',
          className: channel === 'source' ? 'txri-primary' : '',
          disabled: busy !== '',
          onClick: () => setChannel('source'),
        },
        t('channelFormal'),
      ),
      channel === 'source'
        ? sources.length > 0
          ? h(
              'select',
              {
                value: sourceId,
                disabled: busy !== '',
                onChange: (e: { target: { value: string } }) => setSourceId(e.target.value),
              },
              ...sources.map((s) =>
                h(
                  'option',
                  { key: s.sourceId, value: s.sourceId },
                  s.sourceKind ? `${s.sourceId} · ${s.sourceKind}` : s.sourceId,
                ),
              ),
            )
          : h('span', { className: 'txri-note' }, t('sourcesEmpty'))
        : null,
      h(
        'button',
        { type: 'button', className: 'txri-primary', disabled: !!busy || !scenarioId, onClick: () => run() },
        busy === 'run' ? t('running') : t('run'),
      ),
    ),
    channel === 'dataset'
      ? h(
          'div',
          { className: 'txri-bar' },
          h('label', null, `${t('dataset')}: `),
          h('textarea', {
            className: 'txri-mono',
            rows: 8,
            style: { width: '100%', boxSizing: 'border-box' as const },
            value: datasetText,
            disabled: busy !== '',
            placeholder: '{ "objects": [], "relations": [], "behaviors": [], "candidates": [] }',
            onChange: (e: { target: { value: string } }) => setDatasetText(e.target.value),
          }),
          h('p', { className: 'txri-note' }, t('datasetHint')),
        )
      : h('p', { className: 'txri-note' }, t('sourceHint')),
    dataTrust
      ? h(
          'p',
          { className: 'txri-note' },
          `${t('dataTrust')}: ${dataTrust.provenance} (${dataTrust.verified ? 'verified' : 'unverified'}) — ${dataTrust.note}`,
        )
      : null,
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

/* ── 复核面（issue #30 WP-A）：队列 → 证据 → 决定 → 治理链（形制参照 apps/aml 治理工作台） ── */

function Tag(props: { text: string; tone?: 'ok' | 'warn' | 'err' }) {
  const cls = props.tone ? `tag ${props.tone}` : 'tag'
  return h('span', { className: cls }, props.text)
}

function reviewTone(status: string): 'ok' | 'warn' | 'err' | undefined {
  if (status === 'approved') return 'ok'
  if (status === 'pending') return 'warn'
  if (status === 'rejected') return 'err'
  return undefined
}

function chainTone(status: string): 'ok' | 'warn' | 'err' | undefined {
  if (status === 'succeeded' || status === 'approved' || status === 'consumed' || status === 'passed') return 'ok'
  if (status === 'executing' || status === 'pending' || status === 'dispatched' || status === 'unknown') return 'warn'
  if (status === 'failed' || status === 'rejected' || status === 'canceled') return 'err'
  return undefined
}

type ReviewStatus = 'pending' | 'approved' | 'rejected'

interface RunRow {
  runId: string
  scenarioId: string
  package: { name: string; version: string }
  datasetDigest: string
  auditPassed: boolean
  savedAt: string
  reviewStatus: ReviewStatus
  latestDecision?: {
    decisionId: string
    decision: 'approved' | 'rejected'
    createdAt: string
    reason?: string
    candidateIds: string[]
  }
}

interface CandidateDetail {
  candidateId: string
  objectRef: string
  riskScore: number
  riskLevel?: string
  hitRuleIds: string[]
  evidenceChains: Array<{ ruleId: string; score: number; evidence: string }>
  narrative: string[]
  pendingChecks: Array<{ ruleId?: string; missing?: string[]; note: string }>
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
      reviewGate?: { threshold: number; required: boolean; requireReviewFor: string[] }
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
  }>
  proposals: Array<{
    proposalId: string
    decisionId: string
    candidateId: string
    behaviorId: string
    objectRef: string
    operationId: string
    status: string
    payload: Record<string, unknown>
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

function ReviewPanel(props: { t: (k: string) => string; ctx: Ctx }) {
  const { t, ctx } = props
  const api = ctx.remote['ontoRuntime']
  const [runs, setRuns] = useState<RunRow[]>([])
  const [filter, setFilter] = useState<'all' | ReviewStatus>('all')
  const [detail, setDetail] = useState<RunDetail | null>(null)
  const [chain, setChain] = useState<ChainData | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [okMsg, setOkMsg] = useState('')
  const [selectedCandidate, setSelectedCandidate] = useState('')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [decision, setDecision] = useState<'approved' | 'rejected'>('approved')
  const [reason, setReason] = useState('')

  const loadRuns = () => {
    if (!api) return
    void (async () => {
      setError('')
      setBusy('runs')
      try {
        const out = unwrap<{ runs: RunRow[] }>(await api.listReviewQueue())
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
    return h('div', { className: 'txri-gov' }, h('p', { className: 'txri-err' }, 'remote.ontoRuntime missing'))
  }

  // 原子切换：先清空 detail/chain，避免「新 run 证据 + 旧 run 治理链」半成功态
  const openRun = (runId: string) => {
    void (async () => {
      setError('')
      setOkMsg('')
      setBusy('detail')
      setDetail(null)
      setChain(null)
      setSelectedIds([])
      setSelectedCandidate('')
      setDecision('approved')
      setReason('')
      try {
        const [detailOut, chainOut] = await Promise.all([
          Promise.resolve(api.showRun({ runId })).then((v) => unwrap<RunDetail>(v)),
          Promise.resolve(api.reviewChain({ runId })).then((v) => unwrap<ChainData>(v)),
        ])
        setDetail(detailOut)
        setChain(chainOut)
        const cands = detailOut.record?.result?.candidates ?? []
        // 不默认全选：批准须显式勾选候选，防一键批量误批
        setSelectedIds([])
        setSelectedCandidate(cands[0]?.candidateId ?? '')
      } catch (e) {
        setDetail(null)
        setChain(null)
        setError(errText(e))
      } finally {
        setBusy('')
      }
    })()
  }

  const reasonRequired = decision === 'approved'
  const reasonOk = !reasonRequired || reason.trim() !== ''
  const canSubmit = !busy && selectedIds.length > 0 && reasonOk

  const submitReview = () => {
    if (!detail || !canSubmit) return
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
      } catch (e) {
        setError(errText(e))
      } finally {
        setBusy('')
      }
    })()
  }

  const exportAudit = () => {
    if (!detail) return
    void (async () => {
      setError('')
      setOkMsg('')
      setBusy('export')
      try {
        const out = unwrap<{ locator: string; chainLocator?: string }>(
          await api.exportAudit({ runId: detail.record.runId }),
        )
        setOkMsg(`${t('exportAuditDone')}: ${out.locator}${out.chainLocator ? ` / ${out.chainLocator}` : ''}`)
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
        { key: 'bar', className: 'txri-bar' },
        h('button', { type: 'button', disabled: !!busy, onClick: () => loadRuns() }, t('refresh')),
        h('span', { className: 'txri-note' }, `${t('runs')}: ${runs.length}`),
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
              className: filter === key ? 'txri-primary' : '',
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
                  h('td', { className: 'txri-mono' }, r.runId),
                  h('td', { className: 'txri-mono' }, r.scenarioId),
                  h(
                    'td',
                    null,
                    h(Tag, { text: t(r.reviewStatus), tone: reviewTone(r.reviewStatus) }),
                    r.latestDecision?.reason
                      ? h('div', { className: 'txri-note' }, r.latestDecision.reason)
                      : null,
                  ),
                  h('td', null, h(Tag, { text: r.auditPassed ? 'PASS' : 'FAIL', tone: r.auditPassed ? 'ok' : 'err' })),
                  h('td', { className: 'txri-mono' }, r.savedAt.slice(0, 19).replace('T', ' ')),
                  h(
                    'td',
                    null,
                    h(
                      'button',
                      {
                        type: 'button',
                        className: detail?.record.runId === r.runId ? 'txri-primary' : '',
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
        : h('p', { key: 'empty', className: 'txri-note' }, t('empty')),
    ]
  }

  const evidenceView = (): ReactNode[] => {
    if (!detail) return [h('p', { key: 'ne', className: 'txri-note' }, t('noDetail'))]
    const rec = detail.record
    const res = rec.result
    const cands = res.candidates ?? []
    const nodes: ReactNode[] = [
      h('h3', { key: 'et' }, t('evidence')),
      h('p', { key: 'er', className: 'txri-note txri-mono' }, rec.runId),
      h(
        'div',
        { key: 'meta', className: 'txri-note' },
        `${t('scenario')}: ${rec.scenarioId} · ${t('package')}: ${rec.package.name}@${rec.package.version} · `,
        `${t('datasetDigest')}: ${rec.datasetDigest.slice(0, 12)} · `,
        `${t('threshold')}: ${res.reviewGate?.threshold ?? '—'} · `,
        `${t('savedAt')}: ${rec.savedAt.slice(0, 19).replace('T', ' ')} · `,
        `${t('audit')}: `,
        h(Tag, { text: res.audit?.passed ? 'PASS' : 'FAIL', tone: res.audit?.passed ? 'ok' : 'err' }),
      ),
    ]
    if (cands.length === 0) {
      nodes.push(h('p', { key: 'nc', className: 'txri-note' }, t('noCandidates')))
      return nodes
    }
    const current = cands.find((c) => c.candidateId === selectedCandidate) ?? cands[0]
    nodes.push(
      h(
        'div',
        { key: 'sel', className: 'txri-cand-row' },
        h('span', { className: 'txri-note' }, `${t('candidates')}:`),
        ...cands.map((c) =>
          h(
            'button',
            {
              key: c.candidateId,
              type: 'button',
              className: current && c.candidateId === current.candidateId ? 'txri-primary' : '',
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
          { key: 'cmeta', className: 'txri-note' },
          `${t('objectRef')}: ${current.objectRef} · `,
          `${t('riskScore')}: ${current.riskScore}`,
          current.riskLevel ? ` · ${t('riskLevel')}: ${current.riskLevel}` : '',
          ` · ${t('hitRules')}: ${current.hitRuleIds.join(', ') || '—'}`,
        ),
      )
      if (warn) {
        nodes.push(h('div', { key: 'warn', className: 'txri-warnbox' }, t('pendingChecks')))
      }
      nodes.push(h('h4', { key: 'ech' }, t('evidenceChain')))
      nodes.push(
        current.evidenceChains?.length
          ? h(
              'ul',
              { key: 'ecl' },
              ...current.evidenceChains.map((e, i) =>
                h(
                  'li',
                  { key: `${e.ruleId}-${i}` },
                  h('span', { className: 'txri-mono' }, `[${e.ruleId} score=${e.score}] `),
                  e.evidence,
                ),
              ),
            )
          : h('p', { key: 'ece', className: 'txri-note' }, t('evidenceEmpty')),
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
                  p.ruleId ? h('span', { className: 'txri-mono' }, `[${p.ruleId}] `) : null,
                  p.missing?.length ? h('span', { className: 'txri-mono' }, `missing=${p.missing.join(',')} `) : null,
                  p.note,
                ),
              ),
            )
          : h('p', { key: 'pce', className: 'txri-note' }, t('pendingChecksEmpty')),
      )
      if (current.narrative?.length) {
        nodes.push(h('h4', { key: 'nch' }, t('narrative')))
        nodes.push(
          h('ul', { key: 'ncl' }, ...current.narrative.map((n, i) => h('li', { key: i }, n))),
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
                  h('td', { className: 'txri-mono' }, hrow.ruleId),
                  h('td', { className: 'txri-mono' }, hrow.candidateId),
                  h('td', null, String(hrow.score)),
                  h('td', { className: 'txri-mono' }, hrow.ts.slice(0, 19).replace('T', ' ')),
                ),
              ),
            ),
          )
        : h('p', { key: 'rhle', className: 'txri-note' }, t('evidenceEmpty')),
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
                h('span', { className: 'txri-mono' }, `${c.check}: `),
                c.detail,
              ),
            ),
          )
        : h('p', { key: 'ace', className: 'txri-note' }, t('evidenceEmpty')),
    )
    nodes.push(
      h(
        'p',
        { key: 'fph', className: 'txri-note' },
        `${t('forbiddenHits')}: ${(res.audit?.forbiddenPhraseHits ?? []).length}`,
      ),
    )
    return nodes
  }

  const reviewFormView = (): ReactNode[] => {
    if (!detail) return []
    const cands = detail.record.result.candidates ?? []
    if (cands.length === 0) return []
    return [
      h(
        'div',
        { key: 'rf', className: 'txri-section' },
        h('h4', null, t('reviewForm')),
        h('p', { className: 'txri-note' }, t('reviewOnlyNote')),
        h(
          'div',
          { className: 'txri-cand-row' },
          h('span', { className: 'txri-note' }, `${t('selectCandidates')}:`),
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
              h('span', { className: 'txri-mono' }, c.candidateId),
            )
          }),
        ),
        h(
          'div',
          { className: 'txri-cand-row' },
          h('span', { className: 'txri-note' }, `${t('decision')}:`),
          h(
            'button',
            {
              type: 'button',
              className: decision === 'approved' ? 'txri-primary' : '',
              onClick: () => setDecision('approved'),
            },
            t('decisionApprove'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: decision === 'rejected' ? 'txri-danger' : '',
              onClick: () => setDecision('rejected'),
            },
            t('decisionReject'),
          ),
        ),
        h(
          'div',
          { className: 'txri-cand-row' },
          h('span', { className: 'txri-note' }, reasonRequired ? t('reasonRequired') : t('reasonLabel')),
          h('input', {
            type: 'text',
            value: reason,
            style: { flex: '1', minWidth: '160px' },
            onInput: (e: { target: { value: string } }) => setReason(e.target.value),
          }),
        ),
        h(
          'div',
          { className: 'txri-bar' },
          h(
            'button',
            {
              type: 'button',
              className: 'txri-primary',
              disabled: !canSubmit,
              onClick: () => submitReview(),
            },
            t('submitReview'),
          ),
          h(
            'button',
            { type: 'button', disabled: !!busy || !detail, onClick: () => exportAudit() },
            t('exportAudit'),
          ),
          !reasonOk && selectedIds.length > 0
            ? h('span', { className: 'txri-note' }, t('reasonRequired'))
            : null,
          okMsg ? h('span', { className: 'txri-ok' }, okMsg) : null,
        ),
      ),
    ]
  }

  const chainView = (): ReactNode[] => {
    if (!chain) return []
    const empty = chain.decisions.length === 0 && chain.proposals.length === 0 && chain.actions.length === 0
    const reconcileActions = chain.actions.filter(isReconcilePending)
    return [
      h('h4', { key: 'ct' }, t('chain')),
      reconcileActions.length > 0
        ? h(
            'div',
            { key: 'rq', className: 'txri-warnbox' },
            `${t('pendingReconcile')}: ${reconcileActions.map((a) => a.actionId).join(', ')} — ${t('noRetry')}`,
          )
        : null,
      empty ? h('p', { key: 'ce', className: 'txri-note' }, t('chainEmpty')) : null,
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
                h('th', null, 'decisionId'),
                h('th', null, t('reasonLabel')),
                h('th', null, t('candidates')),
                h('th', null, 'reviewer'),
              ),
            ),
            h(
              'tbody',
              null,
              ...chain.decisions.map((d) =>
                h(
                  'tr',
                  { key: d.decisionId },
                  h('td', null, h(Tag, { text: d.decision, tone: chainTone(d.decision) })),
                  h('td', { className: 'txri-mono' }, d.decisionId),
                  h('td', null, d.reason ?? '—'),
                  h('td', { className: 'txri-mono' }, d.candidateIds.join(', ')),
                  h('td', { className: 'txri-mono' }, d.reviewer),
                ),
              ),
            ),
          )
        : null,
      chain.proposals.length > 0
        ? h(
            'div',
            { key: 'pn' },
            h('p', { className: 'txri-note' }, t('proposalNotApproval')),
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
                    h('td', { className: 'txri-mono' }, p.proposalId),
                    h('td', { className: 'txri-mono' }, p.operationId),
                    h('td', { className: 'txri-mono' }, `${p.behaviorId} → ${p.objectRef}`),
                    h('td', null, h(Tag, { text: p.status, tone: chainTone(p.status) })),
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
                  h('td', { className: 'txri-mono' }, a.actionId),
                  h(
                    'td',
                    null,
                    recon
                      ? h(Tag, { text: t('pendingReconcile'), tone: 'warn' })
                      : h(Tag, { text: a.status, tone: chainTone(a.status) }),
                  ),
                  h('td', { className: 'txri-mono' }, `${a.behaviorId} → ${a.objectRef}`),
                  h('td', { className: 'txri-mono' }, a.externalRef ?? '—'),
                  h('td', { className: 'txri-mono' }, a.approvalDigest.slice(0, 12)),
                )
              }),
            ),
          )
        : null,
      h('p', { key: 'sim', className: 'txri-note' }, t('simulatedNote')),
      h('p', { key: 'hr', className: 'txri-note' }, t('humanReview')),
    ]
  }

  return h(
    'div',
    { className: 'txri-gov' },
    h('h3', null, t('reviewTitle')),
    h('p', { className: 'txri-sub' }, t('reviewSubtitle')),
    error ? h('p', { className: 'txri-err' }, `${t('error')}: ${error}`) : null,
    h(
      'div',
      { className: 'txri-layout' },
      h('div', { className: 'txri-panel' }, ...listView()),
      h(
        'div',
        { className: 'txri-panel' },
        ...evidenceView(),
        ...reviewFormView(),
        ...chainView(),
      ),
    ),
  )
}

/* ── 动作面（issue #30 WP-C）：仅获准候选 → 提案 → 系统批准卡 → 执行 → 对账 ── */

interface ProposalRow {
  proposalId: string
  decisionId: string
  candidateId: string
  behaviorId: string
  objectRef: string
  operationId: string
  status: string
  /** 提案绑定载荷（执行须与提案一致——指纹不符 fail-closed）。 */
  payload: Record<string, unknown>
}

interface ApprovalCardState {
  challengeId: string
  contextDigest: string
  expiresAt: string
  proposalId?: string
  behaviorId: string
  objectRef: string
  payload: Record<string, unknown>
  operationId?: string
  connector: { id: string; env: string; kind?: string }
}

function ActionPanel(props: { t: (k: string) => string; ctx: Ctx; prefill?: string }) {
  const { t, ctx, prefill } = props
  const api = ctx.remote['ontoRuntime']
  const [runs, setRuns] = useState<RunRow[]>([])
  const [runId, setRunId] = useState('')
  const [chain, setChain] = useState<ChainData | null>(null)
  const [decisionId, setDecisionId] = useState('')
  const [candidateId, setCandidateId] = useState('')
  const [behaviorId, setBehaviorId] = useState('')
  const [objectRef, setObjectRef] = useState('')
  const [payloadText, setPayloadText] = useState('{ "amount": 1 }')
  const [prep, setPrep] = useState<ApprovalCardState | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [okMsg, setOkMsg] = useState('')

  // 对象视图「按对象发起动作」→ 预填锚点对象
  useEffect(() => {
    if (prefill !== undefined && prefill !== '') {
      setObjectRef(prefill)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill])

  const loadRuns = () => {
    if (!api) return
    void (async () => {
      setError('')
      try {
        const out = unwrap<{ runs: RunRow[] }>(await api.listReviewQueue())
        // 仅已批准 run 可动作（仅获准候选）
        const approved = (out.runs ?? []).filter((r) => r.reviewStatus === 'approved')
        setRuns(approved)
        setRunId((prev) => (prev !== '' && approved.some((r) => r.runId === prev) ? prev : (approved[0]?.runId ?? '')))
      } catch (e) {
        setError(errText(e))
      }
    })()
  }

  const loadChain = (id: string) => {
    if (!api || id === '') return
    void (async () => {
      setError('')
      try {
        const out = unwrap<ChainData>(await api.reviewChain({ runId: id }))
        setChain(out)
        const approvedDec = [...out.decisions].reverse().find((d) => d.decision === 'approved')
        setDecisionId(approvedDec?.decisionId ?? '')
        setCandidateId(approvedDec?.candidateIds[0] ?? '')
      } catch (e) {
        setError(errText(e))
      }
    })()
  }

  useEffect(() => {
    loadRuns()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    setPrep(null)
    setOkMsg('')
    loadChain(runId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId])

  if (!api) {
    return h('div', { className: 'txri-gov' }, h('p', { className: 'txri-err' }, 'remote.ontoRuntime missing'))
  }

  const parsePayload = (): Record<string, unknown> => {
    try {
      const v = JSON.parse(payloadText) as unknown
      if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('not object')
      return v as Record<string, unknown>
    } catch {
      throw new Error(t('payloadInvalid'))
    }
  }

  const createProposal = () => {
    void (async () => {
      setError('')
      setOkMsg('')
      setBusy('propose')
      setPrep(null)
      try {
        const payload = parsePayload()
        const out = unwrap<{ proposalId: string; operationId: string }>(
          await api.createActionProposal({
            decisionId,
            runId,
            candidateId,
            name: PKG_NAME,
            version: PKG_VERSION,
            behaviorId,
            objectRef,
            payload,
          }),
        )
        setOkMsg(`${t('proposalCreated')}: ${out.proposalId} (${t('operation')}: ${out.operationId})`)
        loadChain(runId)
      } catch (e) {
        setError(errText(e))
      } finally {
        setBusy('')
      }
    })()
  }

  /** 批准卡第一步：服务端签发挑战（绑定 intent/载荷/对象/连接器目标）。 */
  const openApprovalCard = (proposal?: ProposalRow) => {
    void (async () => {
      setError('')
      setOkMsg('')
      setBusy('prepare')
      try {
        // 提案执行用提案绑定载荷（意图指纹以提案为准）；表单立新提案用表单载荷
        const payload = proposal ? proposal.payload : parsePayload()
        const out = unwrap<{
          challengeId: string
          contextDigest: string
          expiresAt: string
          approvalCard: {
            behaviorId: string
            objectRef: string
            payload: Record<string, unknown>
            operationId?: string
            connector: { id: string; env: string; kind?: string }
          }
        }>(
          await api.prepareAction({
            name: PKG_NAME,
            version: PKG_VERSION,
            behaviorId: proposal ? proposal.behaviorId : behaviorId,
            objectRef: proposal ? proposal.objectRef : objectRef,
            payload,
            ...(proposal ? { proposalId: proposal.proposalId } : {}),
          }),
        )
        setPrep({
          challengeId: out.challengeId,
          contextDigest: out.contextDigest,
          expiresAt: out.expiresAt,
          ...(proposal ? { proposalId: proposal.proposalId } : {}),
          behaviorId: out.approvalCard.behaviorId,
          objectRef: out.approvalCard.objectRef,
          payload: out.approvalCard.payload,
          ...(out.approvalCard.operationId !== undefined ? { operationId: out.approvalCard.operationId } : {}),
          connector: out.approvalCard.connector,
        })
      } catch (e) {
        setError(errText(e))
      } finally {
        setBusy('')
      }
    })()
  }

  /** 批准卡第二步：人工确认后携挑战消费执行（单次、TTL、摘要绑定 fail-closed）。 */
  const confirmExecute = () => {
    if (!prep) return
    void (async () => {
      setError('')
      setOkMsg('')
      setBusy('execute')
      try {
        const out = unwrap<{
          actionId: string
          status: string
          replayed: boolean
          externalRef?: string
          note?: string
          connectorKind: string
          simulated: boolean
        }>(
          await api.executeAction({
            name: PKG_NAME,
            version: PKG_VERSION,
            behaviorId: prep.behaviorId,
            objectRef: prep.objectRef,
            payload: prep.payload,
            ...(prep.proposalId !== undefined ? { proposalId: prep.proposalId } : {}),
            approval: { challengeId: prep.challengeId, contextDigest: prep.contextDigest },
          }),
        )
        setOkMsg(
          `${t('executed')}: ${out.actionId} · ${out.status}${out.replayed ? ' (replay)' : ''}`
            + ` · ${out.externalRef ?? '—'} · ${out.connectorKind}${out.simulated ? ` (${t('simulated')})` : ''}`,
        )
        setPrep(null)
        loadChain(runId)
      } catch (e) {
        setError(errText(e))
      } finally {
        setBusy('')
      }
    })()
  }

  const reconcile = (actionId: string) => {
    void (async () => {
      setError('')
      setOkMsg('')
      setBusy('reconcile')
      try {
        const out = unwrap<{ actionId: string; status: string; externalRef?: string; note?: string }>(
          await api.reconcileAction({ actionId }),
        )
        setOkMsg(`${t('reconcileDone')}: ${out.actionId} → ${out.status} · ${out.externalRef ?? '—'} · ${out.note ?? ''}`)
        loadChain(runId)
      } catch (e) {
        setError(errText(e))
      } finally {
        setBusy('')
      }
    })()
  }

  const decisions = chain?.decisions ?? []
  const proposals = (chain?.proposals ?? []) as ProposalRow[]
  const actions = chain?.actions ?? []
  const pendingProposals = proposals.filter((p) => p.status === 'pending')

  const formView = (): ReactNode[] => [
    h('h4', { key: 'ft' }, t('actionForm')),
    h('p', { key: 'fn', className: 'txri-note' }, t('actionOnlyApproved')),
    h(
      'div',
      { key: 'f1', className: 'txri-cand-row' },
      h('label', null, `${t('decision')}: `),
      h(
        'select',
        {
          value: decisionId,
          disabled: busy !== '',
          onChange: (e: { target: { value: string } }) => {
            setDecisionId(e.target.value)
            const d = decisions.find((x) => x.decisionId === e.target.value)
            setCandidateId(d?.candidateIds[0] ?? '')
          },
        },
        ...decisions
          .filter((d) => d.decision === 'approved')
          .map((d) => h('option', { key: d.decisionId, value: d.decisionId }, `${d.decisionId} (${d.candidateIds.join(',')})`)),
      ),
      h('label', null, `${t('selectCandidates')}: `),
      h(
        'select',
        {
          value: candidateId,
          disabled: busy !== '',
          onChange: (e: { target: { value: string } }) => setCandidateId(e.target.value),
        },
        ...(decisions.find((d) => d.decisionId === decisionId)?.candidateIds ?? []).map((c) =>
          h('option', { key: c, value: c }, c),
        ),
      ),
    ),
    h(
      'div',
      { key: 'f2', className: 'txri-cand-row' },
      h('label', null, `${t('behaviorObject')}: `),
      h('input', {
        type: 'text',
        value: behaviorId,
        placeholder: 'BHV-…',
        style: { width: '160px' },
        onInput: (e: { target: { value: string } }) => setBehaviorId(e.target.value),
      }),
      h('input', {
        type: 'text',
        value: objectRef,
        placeholder: 'TYPE:instance',
        style: { width: '200px' },
        onInput: (e: { target: { value: string } }) => setObjectRef(e.target.value),
      }),
    ),
    h('textarea', {
      key: 'f3',
      className: 'txri-mono',
      rows: 4,
      style: { width: '100%', boxSizing: 'border-box' as const },
      value: payloadText,
      disabled: busy !== '',
      onChange: (e: { target: { value: string } }) => setPayloadText(e.target.value),
    }),
    h(
      'div',
      { key: 'f4', className: 'txri-bar' },
      h(
        'button',
        {
          type: 'button',
          className: 'txri-primary',
          disabled: !!busy || !decisionId || !candidateId || behaviorId === '' || objectRef === '',
          onClick: () => createProposal(),
        },
        t('createProposal'),
      ),
    ),
  ]

  const cardView = (): ReactNode[] => {
    if (!prep) return []
    return [
      h(
        'div',
        { key: 'card', className: 'txri-card txri-callout txri-callout-warning' },
        h('h4', null, t('approvalCard')),
        h('p', { className: 'txri-note' }, t('approvalCardNote')),
        h(
          'div',
          { className: 'txri-note txri-mono' },
          `${prep.behaviorId} → ${prep.objectRef}`,
          prep.operationId !== undefined ? ` · ${t('operation')}: ${prep.operationId}` : '',
          ` · ${t('connector')}: ${prep.connector.id}/${prep.connector.env}${prep.connector.kind ? `/${prep.connector.kind}` : ''}`,
        ),
        h('pre', { className: 'txri-mono', style: { margin: '6px 0', whiteSpace: 'pre-wrap' as const } }, JSON.stringify(prep.payload, null, 2)),
        h('p', { className: 'txri-note txri-mono' }, `${t('expires')}: ${prep.expiresAt.slice(0, 19).replace('T', ' ')}`),
        h(
          'div',
          { className: 'txri-bar' },
          h(
            'button',
            { type: 'button', className: 'txri-primary', disabled: !!busy, onClick: () => confirmExecute() },
            busy === 'execute' ? t('executing') : t('confirmExecute'),
          ),
          h('button', { type: 'button', disabled: !!busy, onClick: () => setPrep(null) }, t('cancel')),
        ),
      ),
    ]
  }

  const proposalsView = (): ReactNode[] => [
    h('h4', { key: 'pt' }, t('pendingProposals')),
    pendingProposals.length === 0
      ? h('p', { key: 'pe', className: 'txri-note' }, t('pendingProposalsEmpty'))
      : h(
          'table',
          { key: 'ptbl' },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              h('th', null, t('proposal')),
              h('th', null, t('operation')),
              h('th', null, t('behaviorObject')),
              h('th', null, ''),
            ),
          ),
          h(
            'tbody',
            null,
            ...pendingProposals.map((p) =>
              h(
                'tr',
                { key: p.proposalId },
                h('td', { className: 'txri-mono' }, p.proposalId),
                h('td', { className: 'txri-mono' }, p.operationId),
                h('td', { className: 'txri-mono' }, `${p.behaviorId} → ${p.objectRef}`),
                h(
                  'td',
                  null,
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'txri-primary',
                      disabled: !!busy,
                      onClick: () => {
                        setBehaviorId(p.behaviorId)
                        setObjectRef(p.objectRef)
                        openApprovalCard(p)
                      },
                    },
                    t('approveExecute'),
                  ),
                ),
              ),
            ),
          ),
        ),
  ]

  const actionsView = (): ReactNode[] => {
    if (actions.length === 0) return []
    return [
      h('h4', { key: 'at' }, t('chain')),
      h(
        'table',
        { key: 'atbl' },
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('th', null, t('action')),
            h('th', null, t('status')),
            h('th', null, t('behaviorObject')),
            h('th', null, t('externalRef')),
            h('th', null, ''),
          ),
        ),
        h(
          'tbody',
          null,
          ...actions.map((a) => {
            const needReconcile = a.status === 'unknown' || a.status === 'dispatched' || a.phase === 'dispatched'
            return h(
              'tr',
              { key: a.actionId },
              h('td', { className: 'txri-mono' }, a.actionId),
              h(
                'td',
                null,
                needReconcile
                  ? h(Tag, { text: t('pendingReconcile'), tone: 'warn' })
                  : h(Tag, { text: a.status, tone: chainTone(a.status) }),
              ),
              h('td', { className: 'txri-mono' }, `${a.behaviorId} → ${a.objectRef}`),
              h('td', { className: 'txri-mono' }, a.externalRef ?? '—'),
              h(
                'td',
                null,
                needReconcile
                  ? h(
                      'button',
                      { type: 'button', disabled: !!busy, onClick: () => reconcile(a.actionId) },
                      t('reconcile'),
                    )
                  : null,
              ),
            )
          }),
        ),
      ),
      h('p', { key: 'hr', className: 'txri-note' }, t('humanReview')),
    ]
  }

  return h(
    'div',
    { className: 'txri-gov' },
    h('h3', null, t('actionTitle')),
    h('p', { className: 'txri-sub' }, t('actionSubtitle')),
    error ? h('p', { className: 'txri-err' }, `${t('error')}: ${error}`) : null,
    okMsg ? h('p', { className: 'txri-ok' }, okMsg) : null,
    h(
      'div',
      { className: 'txri-bar' },
      h('label', null, `${t('runId')}: `),
      h(
        'select',
        { value: runId, disabled: busy !== '', onChange: (e: { target: { value: string } }) => setRunId(e.target.value) },
        ...runs.map((r) => h('option', { key: r.runId, value: r.runId }, r.runId)),
      ),
    ),
    ...formView(),
    ...cardView(),
    ...proposalsView(),
    ...actionsView(),
  )
}

/* ── 对象视图面（issue #30 WP-D）：实体浏览 → 邻域跳转 → 按对象发起动作 ── */

interface BrowseRow {
  id: string
  type: string
  attrs?: Record<string, unknown>
}

interface ExpandView {
  seedId: string
  hops: number
  direction: string
  objects: BrowseRow[]
  relations: Array<{ id: string; type: string; from: string; to: string }>
  seedIds: string[]
  missingSeedIds: string[]
  truncated: boolean
  stats: { seeds: number; objects: number; relations: number; candidates: number }
}

function ObjectPanel(props: { t: (k: string) => string; ctx: Ctx; onActFromObject: (objectRef: string) => void }) {
  const { t, ctx, onActFromObject } = props
  const api = ctx.remote['ontoRuntime']
  const [channel, setChannel] = useState<'dataset' | 'source'>(DATA_MODE === 'dataset' ? 'dataset' : 'source')
  const [datasetText, setDatasetText] = useState('')
  const [sourceId, setSourceId] = useState(SOURCE_ID)
  const [sources, setSources] = useState<SourceRow[]>([])
  const [typeFilter, setTypeFilter] = useState('')
  const [rows, setRows] = useState<BrowseRow[]>([])
  const [types, setTypes] = useState<Array<{ type: string; count: number }>>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [expanded, setExpanded] = useState<ExpandView | null>(null)
  const [hops, setHops] = useState(1)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const pageSize = 50

  useEffect(() => {
    if (!api) return
    void (async () => {
      try {
        const out = unwrap<{ sources: SourceRow[] }>(
          await api.listSourceConfigs({ name: PKG_NAME, version: PKG_VERSION }),
        )
        const list = [...(out.sources ?? [])]
        if (SOURCE_ID !== '' && !list.some((s) => s.sourceId === SOURCE_ID)) {
          list.unshift({ sourceId: SOURCE_ID })
        }
        setSources(list)
        if (list.length > 0 && !list.some((s) => s.sourceId === sourceId)) {
          setSourceId(list[0].sourceId)
        }
      } catch {
        setSources(SOURCE_ID !== '' ? [{ sourceId: SOURCE_ID }] : [])
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!api) {
    return h('div', { className: 'txri-gov' }, h('p', { className: 'txri-err' }, 'remote.ontoRuntime missing'))
  }

  const channelRequest = (): Record<string, unknown> => {
    if (channel === 'dataset') {
      if (datasetText.trim() === '') throw new Error(t('datasetRequired'))
      try {
        return { dataset: JSON.parse(datasetText) }
      } catch {
        throw new Error(t('datasetInvalid'))
      }
    }
    if (sourceId === '') throw new Error(t('sourceRequired'))
    return { sourceId }
  }

  const browse = (nextOffset: number) => {
    void (async () => {
      setError('')
      setBusy('browse')
      setExpanded(null)
      try {
        const out = unwrap<{ objects: BrowseRow[]; types: Array<{ type: string; count: number }>; total: number }>(
          await api.browseObjects({
            name: PKG_NAME,
            version: PKG_VERSION,
            ...channelRequest(),
            ...(typeFilter !== '' ? { typeFilter } : {}),
            offset: nextOffset,
            limit: pageSize,
          }),
        )
        setRows(out.objects ?? [])
        setTypes(out.types ?? [])
        setTotal(out.total ?? 0)
        setOffset(nextOffset)
      } catch (e) {
        setError(errText(e))
      } finally {
        setBusy('')
      }
    })()
  }

  const expand = (seed: BrowseRow) => {
    void (async () => {
      setError('')
      setBusy('expand')
      try {
        const out = unwrap<{
          dataset: { objects: BrowseRow[]; relations: Array<{ id: string; type: string; from: string; to: string }> }
          seedIds: string[]
          missingSeedIds: string[]
          truncated: boolean
          stats: { seeds: number; objects: number; relations: number; candidates: number }
        }>(
          await api.expandEntity({
            name: PKG_NAME,
            version: PKG_VERSION,
            ...channelRequest(),
            seedIds: [seed.id],
            hops,
            direction: 'both',
          }),
        )
        // missingSeedIds / truncated 显式呈现（不静默吞）
        setExpanded({
          seedId: seed.id,
          hops,
          direction: 'both',
          objects: out.dataset?.objects ?? [],
          relations: out.dataset?.relations ?? [],
          seedIds: out.seedIds ?? [],
          missingSeedIds: out.missingSeedIds ?? [],
          truncated: out.truncated === true,
          stats: out.stats ?? { seeds: 0, objects: 0, relations: 0, candidates: 0 },
        })
      } catch (e) {
        setError(errText(e))
      } finally {
        setBusy('')
      }
    })()
  }

  const expandView = (): ReactNode[] => {
    if (!expanded) return []
    return [
      h(
        'div',
        { key: 'ex', className: 'txri-card' },
        h('h4', null, `${t('neighborhood')}: ${expanded.seedId} (hops=${expanded.hops})`),
        h(
          'div',
          { key: 'st', className: 'txri-bar' },
          h('span', { className: 'txri-note' },
            `${t('objects')}: ${expanded.stats.objects} · ${t('relations')}: ${expanded.stats.relations} · candidates: ${expanded.stats.candidates}`),
          expanded.truncated ? h(Tag, { text: t('truncatedBadge'), tone: 'warn' }) : null,
          expanded.missingSeedIds.length > 0
            ? h(Tag, { text: `${t('missingSeeds')}: ${expanded.missingSeedIds.join(',')}`, tone: 'err' })
            : null,
        ),
        h('h5', null, t('objects')),
        h(
          'ul',
          { key: 'ol' },
          ...expanded.objects.map((o) =>
            h(
              'li',
              { key: `${o.type}:${o.id}` },
              h('span', { className: 'txri-mono' }, `${o.type}:${o.id} `),
              h(
                'button',
                {
                  type: 'button',
                  disabled: !!busy,
                  onClick: () => onActFromObject(`${o.type}:${o.id}`),
                },
                t('actOnObject'),
              ),
            ),
          ),
        ),
        h('h5', null, t('relations')),
        expanded.relations.length === 0
          ? h('p', { className: 'txri-note' }, t('relationsEmpty'))
          : h(
              'table',
              { key: 'rl' },
              h(
                'thead',
                null,
                h('tr', null, h('th', null, 'id'), h('th', null, 'type'), h('th', null, 'from'), h('th', null, 'to')),
              ),
              h(
                'tbody',
                null,
                ...expanded.relations.map((r) =>
                  h(
                    'tr',
                    { key: r.id },
                    h('td', { className: 'txri-mono' }, r.id),
                    h('td', { className: 'txri-mono' }, r.type),
                    h('td', { className: 'txri-mono' }, r.from),
                    h('td', { className: 'txri-mono' }, r.to),
                  ),
                ),
              ),
            ),
      ),
    ]
  }

  return h(
    'div',
    { className: 'txri-gov' },
    h('h3', null, t('objectsTitle')),
    h('p', { className: 'txri-sub' }, t('objectsSubtitle')),
    error ? h('p', { className: 'txri-err' }, `${t('error')}: ${error}`) : null,
    h(
      'div',
      { className: 'txri-bar' },
      h('span', { className: 'txri-note' }, `${t('channel')}:`),
      h(
        'button',
        {
          type: 'button',
          className: channel === 'dataset' ? 'txri-primary' : '',
          disabled: busy !== '',
          onClick: () => setChannel('dataset'),
        },
        t('channelExplore'),
      ),
      h(
        'button',
        {
          type: 'button',
          className: channel === 'source' ? 'txri-primary' : '',
          disabled: busy !== '',
          onClick: () => setChannel('source'),
        },
        t('channelFormal'),
      ),
      channel === 'source' && sources.length > 0
        ? h(
            'select',
            {
              value: sourceId,
              disabled: busy !== '',
              onChange: (e: { target: { value: string } }) => setSourceId(e.target.value),
            },
            ...sources.map((s) =>
              h('option', { key: s.sourceId, value: s.sourceId }, s.sourceKind ? `${s.sourceId} · ${s.sourceKind}` : s.sourceId),
            ),
          )
        : null,
      h('label', null, `${t('entityType')}: `),
      h(
        'select',
        {
          value: typeFilter,
          disabled: busy !== '',
          onChange: (e: { target: { value: string } }) => setTypeFilter(e.target.value),
        },
        h('option', { value: '' }, '—'),
        ...types.map((x) => h('option', { key: x.type, value: x.type }, `${x.type} (${x.count})`)),
      ),
      h('label', null, `${t('hops')}: `),
      h(
        'select',
        { value: String(hops), disabled: busy !== '', onChange: (e: { target: { value: string } }) => setHops(Number(e.target.value) || 1) },
        h('option', { value: '0' }, '0'),
        h('option', { value: '1' }, '1'),
        h('option', { value: '2' }, '2'),
        h('option', { value: '3' }, '3'),
      ),
      h(
        'button',
        { type: 'button', className: 'txri-primary', disabled: !!busy, onClick: () => browse(0) },
        t('browse'),
      ),
    ),
    channel === 'dataset'
      ? h('textarea', {
          className: 'txri-mono',
          rows: 5,
          style: { width: '100%', boxSizing: 'border-box' as const },
          value: datasetText,
          disabled: busy !== '',
          placeholder: '{ "objects": [], "relations": [] }',
          onChange: (e: { target: { value: string } }) => setDatasetText(e.target.value),
        })
      : null,
    h(
      'div',
      { className: 'txri-bar' },
      h('span', { className: 'txri-note' }, `${t('objects')}: ${total}`),
      h(
        'button',
        { type: 'button', disabled: !!busy || offset === 0, onClick: () => browse(Math.max(0, offset - pageSize)) },
        t('pagePrev'),
      ),
      h('span', { className: 'txri-note' }, `${offset + 1}–${Math.min(offset + pageSize, total)}`),
      h(
        'button',
        { type: 'button', disabled: !!busy || offset + pageSize >= total, onClick: () => browse(offset + pageSize) },
        t('pageNext'),
      ),
    ),
    rows.length > 0
      ? h(
          'table',
          null,
          h(
            'thead',
            null,
            h('tr', null, h('th', null, t('objectRef')), h('th', null, t('entityType')), h('th', null, '')),
          ),
          h(
            'tbody',
            null,
            ...rows.map((o) =>
              h(
                'tr',
                { key: `${o.type}:${o.id}` },
                h('td', { className: 'txri-mono' }, `${o.type}:${o.id}`),
                h('td', { className: 'txri-mono' }, o.type),
                h(
                  'td',
                  null,
                  h(
                    'button',
                    { type: 'button', disabled: !!busy, onClick: () => expand(o) },
                    t('expand'),
                  ),
                  ' ',
                  h(
                    'button',
                    {
                      type: 'button',
                      disabled: !!busy,
                      onClick: () => onActFromObject(`${o.type}:${o.id}`),
                    },
                    t('actOnObject'),
                  ),
                ),
              ),
            ),
          ),
        )
      : h('p', { className: 'txri-note' }, t('empty')),
    ...expandView(),
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
        const [tab, setTab] = useState<'run' | 'review' | 'action' | 'objects' | 'pages'>('run')
        const [actionPrefill, setActionPrefill] = useState('')
        const tabs: Array<['run' | 'review' | 'action' | 'objects' | 'pages', string]> = [
          ['run', t('tabRun')],
          ['review', t('tabReview')],
          ['action', t('tabAction')],
          ['objects', t('tabObjects')],
          ['pages', t('tabPages')],
        ]
        return h(
          'div',
          null,
          h(
            'div',
            { className: 'txri-bar' },
            ...tabs.map(([key, label]) =>
              h(
                'button',
                {
                  key,
                  type: 'button',
                  className: tab === key ? 'txri-primary' : '',
                  onClick: () => setTab(key),
                },
                label,
              ),
            ),
          ),
          tab === 'run' ? h(RunPanel, { t, ctx }) : null,
          tab === 'review' ? h(ReviewPanel, { t, ctx }) : null,
          tab === 'action' ? h(ActionPanel, { t, ctx, prefill: actionPrefill }) : null,
          tab === 'objects'
            ? h(ObjectPanel, {
                t,
                ctx,
                onActFromObject: (objectRef: string) => {
                  setActionPrefill(objectRef)
                  setTab('action')
                },
              })
            : null,
          tab === 'pages' ? h(ReportPages, { t, ctx }) : null,
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
