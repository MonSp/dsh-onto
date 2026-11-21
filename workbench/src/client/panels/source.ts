import { h, useState, useEffect } from '../react'
import type { ReactNode } from '../types'
import type { Ctx } from '../types'
import { Tag, ErrorBanner, OkBanner, Loading, Field } from '../ui'
import { unwrap, errText } from '../helpers'

/* ═══════════════════════════════════════════════════════════════════════════
 * 接入（api-to-plugin S2.6 薄面板）：采样表 / 映射预览诊断表 / 生成 / 回放
 * 只读展示 + 按钮转发 ontoSource wire，不实现第二套业务逻辑。
 * ═══════════════════════════════════════════════════════════════════════════ */

interface VersionRow {
  name: string
  version: string
  status: string
  dir: string
}

type ProbeField = { types: string[]; nonNull: number; samples: unknown[] }
type ProbeReport = Record<string, { rows: number; fields: Record<string, ProbeField> }>
type Issue = { level?: string; code?: string; where?: string; message?: string }
type Evidence = { feature: string; verdict: string; basis: string }

export function SourcePanel(props: {
  t: (k: string) => string
  apis: Ctx
  selected: { name: string; version: string } | null
}) {
  const { t, apis, selected } = props
  const [versions, setVersions] = useState<VersionRow[]>([])
  const [pick, setPick] = useState('')
  const [dir, setDir] = useState('')
  const [apiSources, setApiSources] = useState<Array<{ id: string; name: string; hasShape: boolean }>>([])
  const [scenarios, setScenarios] = useState<Array<{ id: string; name: string }>>([])
  const [sourceId, setSourceId] = useState('')
  const [scenarioId, setScenarioId] = useState('')
  const [url, setUrl] = useState('')
  const [jsonText, setJsonText] = useState('')
  const [samples, setSamples] = useState('50')
  const [collectionsText, setCollectionsText] = useState('')
  const [outDir, setOutDir] = useState('gen/plugin')
  const [force, setForce] = useState(false)
  const [fixturePath, setFixturePath] = useState('')
  const [check, setCheck] = useState(true)
  const [scopeTypesText, setScopeTypesText] = useState('')
  const [againstDir, setAgainstDir] = useState('')
  const [writeExpected, setWriteExpected] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [probe, setProbe] = useState<{ origin: string; probe: ProbeReport } | null>(null)
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null)
  const [gen, setGen] = useState<{ outDir: string; files: string[]; warnings: string[] } | null>(null)
  const [replay, setReplay] = useState<Record<string, unknown> | null>(null)

  // 包列表；共享选中同步进本面板（选包：列表行的 dir 即工作区版本目录）
  useEffect(() => {
    const api = apis.remote['ontoWorkspace']
    if (!api) return
    void (async () => {
      try {
        const rows = unwrap<VersionRow[]>(await api.listVersions())
        const list = Array.isArray(rows) ? rows : []
        setVersions(list)
        setPick((cur) => {
          if (cur !== '') return cur
          const s = selected ? `${selected.name}@${selected.version}` : ''
          const hit = list.some((v) => `${v.name}@${v.version}` === s)
          return hit ? s : list.length > 0 ? `${list[0].name}@${list[0].version}` : ''
        })
      } catch (e) {
        setError(errText(e))
      }
    })()
  }, [apis, selected])

  // 选包 → 版本目录 + apiSources / scenarios（源模型只读）
  useEffect(() => {
    const api = apis.remote['ontoModel']
    const row = versions.find((v) => `${v.name}@${v.version}` === pick)
    if (!api || !row) return
    setDir(row.dir)
    void (async () => {
      try {
        const out = unwrap<{ pkg: Record<string, unknown> }>(await api.load({ name: row.name, version: row.version }))
        const pkg = (out.pkg ?? {}) as {
          apiSources?: Array<{ id: string; name?: string; shape?: unknown }>
          scenarios?: Array<{ id: string; name?: string }>
        }
        const srcs = (pkg.apiSources ?? []).map((s) => ({ id: s.id, name: s.name ?? s.id, hasShape: s.shape !== undefined }))
        setApiSources(srcs)
        setScenarios((pkg.scenarios ?? []).map((s) => ({ id: s.id, name: s.name ?? s.id })))
        setSourceId((cur) => (srcs.some((s) => s.id === cur) ? cur : (srcs.find((s) => s.hasShape) ?? srcs[0])?.id ?? ''))
        setScenarioId((cur) =>
          (pkg.scenarios ?? []).some((s) => s.id === cur) ? cur : ((pkg.scenarios ?? [])[0]?.id ?? ''),
        )
      } catch (e) {
        setApiSources([])
        setScenarios([])
        setError(errText(e))
      }
    })()
  }, [apis, versions, pick])

  const act = async (label: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(label)
    setError('')
    setInfo('')
    try {
      await fn()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy('')
    }
  }

  /** 取数载荷：url 与粘贴 JSON 二选一（其余参数直通 wire，校验在后端同口径）。 */
  const samplePayload = (): Record<string, unknown> => {
    const payload: Record<string, unknown> = { dir, sourceId }
    const u = url.trim()
    const j = jsonText.trim()
    if (u !== '' && j !== '') throw new Error(t('srcUrlOrJson'))
    if (u !== '') payload['url'] = u
    else if (j !== '') payload['data'] = JSON.parse(j)
    else throw new Error(t('srcNeedInput'))
    const n = Number(samples)
    if (samples.trim() !== '' && Number.isFinite(n)) payload['samples'] = n
    const cs = collectionsText.split(',').map((s) => s.trim()).filter((s) => s !== '')
    if (cs.length > 0) payload['collections'] = cs
    return payload
  }

  const doProbe = (): void => {
    const api = apis.remote['ontoSource']
    if (!api) return
    void act('probe', async () => {
      setProbe(unwrap(await api.probe(samplePayload())))
    })
  }

  const doPreview = (): void => {
    const api = apis.remote['ontoSource']
    if (!api) return
    void act('preview', async () => {
      setPreview(unwrap(await api.preview(samplePayload())))
    })
  }

  const doGenerate = (): void => {
    const api = apis.remote['ontoSource']
    if (!api) return
    void act('generate', async () => {
      setGen(unwrap(await api.generate({ dir, scenarioId, sourceId, outDir: outDir.trim(), force })))
    })
  }

  const doReplay = (): void => {
    const api = apis.remote['ontoSource']
    if (!api) return
    void act('replay', async () => {
      const request: Record<string, unknown> = { dir, scenarioId, check, writeExpected }
      if (fixturePath.trim() !== '') request['fixturePath'] = fixturePath.trim()
      if (againstDir.trim() !== '') request['againstDir'] = againstDir.trim()
      const st = scopeTypesText.split(',').map((s) => s.trim()).filter((s) => s !== '')
      if (st.length > 0) request['scopeTypes'] = st
      const out = unwrap<{ report: Record<string, unknown> }>(await api.replay(request))
      setReplay(out.report)
    })
  }

  const sel = { padding: '5px 8px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 12.5, background: '#fff', color: 'inherit' }

  const issueTable = (issues: Issue[]): ReactNode =>
    h(
      'table',
      { className: 'ow-table' },
      h('thead', null, h('tr', null,
        h('th', null, 'code'),
        h('th', null, 'where'),
        h('th', null, 'message'))),
      h('tbody', null, ...issues.map((i, k) =>
        h('tr', { key: k },
          h('td', null, h(Tag, { text: i.code ?? '', tone: i.level === 'error' ? 'err' : i.level === 'warn' ? 'warn' : undefined })),
          h('td', { className: 'ow-mono' }, i.where ?? ''),
          h('td', null, i.message ?? '')))),
    )

  const probeNode = probe
    ? h(
        'div',
        { key: 'probe' },
        h('div', { className: 'ow-label' }, t('srcProbeBtn')),
        h('p', { className: 'ow-note' }, `${t('srcOrigin')}: ${probe.origin}`),
        ...Object.entries(probe.probe).map(([c, rep]) =>
          h(
            'div',
            { key: c },
            h('div', { className: 'ow-row' },
              h('b', null, c),
              h('span', { className: 'ow-stat' }, `${t('srcRows')}: ${rep.rows}`)),
            h(
              'table',
              { className: 'ow-table' },
              h('thead', null, h('tr', null,
                h('th', null, t('srcField')),
                h('th', null, t('srcTypes')),
                h('th', null, t('srcNonNull')),
                h('th', null, t('srcSampleVals')))),
              h('tbody', null, ...Object.entries(rep.fields).map(([f, fr]) =>
                h('tr', { key: f },
                  h('td', { className: 'ow-mono' }, f),
                  h('td', null, fr.types.join(' | ')),
                  h('td', null, String(fr.nonNull)),
                  h('td', { className: 'ow-mono' }, fr.samples.map((s) => truncate(s)).join(' , '))))),
            ),
          ),
        ),
      )
    : null

  const pv = preview as {
    origin?: string
    counts?: { objects?: number; relations?: number; candidates?: number; behaviors?: number; byCollection?: Record<string, number> }
    diagnostics?: Issue[]
    evidence?: Evidence[]
    businessWindow?: { from: string; to: string }
  } | null

  const previewNode = pv
    ? h(
        'div',
        { key: 'preview' },
        h('div', { className: 'ow-label' }, t('srcPreviewBtn')),
        h('p', { className: 'ow-note' }, `${t('srcOrigin')}: ${pv.origin ?? ''}`),
        h('div', { className: 'ow-row' },
          h('span', { className: 'ow-stat' }, `${t('srcCounts')}: O ${pv.counts?.objects ?? 0} / R ${pv.counts?.relations ?? 0} / C ${pv.counts?.candidates ?? 0} / B ${pv.counts?.behaviors ?? 0}`),
          h('span', { className: 'ow-stat' }, `${t('srcWindow')}: ${pv.businessWindow?.from ?? ''} ~ ${pv.businessWindow?.to ?? ''}`)),
        h('div', { className: 'ow-label' }, t('srcDiagnostics')),
        (pv.diagnostics ?? []).length === 0
          ? h('p', { className: 'ow-note' }, '—')
          : issueTable(pv.diagnostics ?? []),
        h('div', { className: 'ow-label' }, t('srcEvidence')),
        (pv.evidence ?? []).length === 0
          ? h('p', { className: 'ow-note' }, '—')
          : h(
              'table',
              { className: 'ow-table' },
              h('thead', null, h('tr', null,
                h('th', null, t('srcFeature')),
                h('th', null, t('srcVerdict')),
                h('th', null, t('srcBasis')))),
              h('tbody', null, ...(pv.evidence ?? []).map((e, k) =>
                h('tr', { key: k },
                  h('td', { className: 'ow-mono' }, e.feature),
                  h('td', null, h(Tag, { text: e.verdict, tone: e.verdict === 'ready' ? 'ok' : 'warn' })),
                  h('td', null, e.basis)))),
            ),
      )
    : null

  const genNode = gen
    ? h(
        'div',
        { key: 'gen' },
        h('div', { className: 'ow-label' }, t('srcGenerateBtn')),
        h('p', { className: 'ow-note' }, gen.outDir),
        h('div', { className: 'ow-label' }, t('srcFiles')),
        h('div', { className: 'ow-mono' }, gen.files.join('  ')),
        gen.warnings.length > 0
          ? h('div', null, h('div', { className: 'ow-label' }, t('srcWarnings')), ...gen.warnings.map((w, k) => h('p', { key: k, className: 'ow-note' }, w)))
          : null,
      )
    : null

  const rp = replay as {
    scenarioId?: string
    counts?: Record<string, number>
    diagnostics?: Issue[]
    result?: { candidates?: unknown[]; excluded?: unknown[]; auditPassed?: boolean }
    comparison?: { ok: boolean; diffs: Array<{ where: string; expected: string; actual: string }> }
    scopedOut?: { objectTypes: string[]; objectsDropped: number; candidatesDropped: number }
    against?: Record<string, unknown>
  } | null

  const replayNode = rp
    ? h(
        'div',
        { key: 'replay' },
        h('div', { className: 'ow-label' }, t('srcReplayBtn')),
        h('div', { className: 'ow-row' },
          h('span', { className: 'ow-stat' }, `${t('srcCounts')}: ${JSON.stringify(rp.counts ?? {})}`),
          rp.result ? h('span', { className: 'ow-stat' }, `audit=${String(rp.result.auditPassed)} / humanReviewRequired=true`) : null,
          rp.scopedOut
            ? h('span', { className: 'ow-stat' }, `${t('srcScopedOut')}: ${rp.scopedOut.objectTypes.join(',')} (-${rp.scopedOut.objectsDropped}/-${rp.scopedOut.candidatesDropped})`)
            : null),
        rp.comparison
          ? h('div', null,
              h(Tag, { text: rp.comparison.ok ? t('srcCheckOk') : t('srcCheckFail'), tone: rp.comparison.ok ? 'ok' : 'err' }),
              rp.comparison.diffs.length > 0
                ? h(
                    'table',
                    { className: 'ow-table' },
                    h('thead', null, h('tr', null,
                      h('th', null, t('srcDiffs')),
                      h('th', null, 'expected'),
                      h('th', null, 'actual'))),
                    h('tbody', null, ...rp.comparison.diffs.map((d, k) =>
                      h('tr', { key: k },
                        h('td', { className: 'ow-mono' }, d.where),
                        h('td', { className: 'ow-mono' }, d.expected),
                        h('td', { className: 'ow-mono' }, d.actual)))),
                  )
                : null)
          : null,
        (rp.diagnostics ?? []).length > 0
          ? h('div', null, h('div', { className: 'ow-label' }, t('srcDiagnostics')), issueTable(rp.diagnostics ?? []))
          : null,
        rp.against
          ? h('div', null,
              h('div', { className: 'ow-label' }, t('srcAgainst')),
              h('p', { className: 'ow-mono' }, JSON.stringify(rp.against)))
          : null,
      )
    : null

  return h(
    'div',
    { className: 'ow-card' },
    h('h3', { className: 'ow-h2' }, t('srcTitle')),
    h('p', { className: 'ow-note' }, t('srcHint')),
    h('div', { className: 'ow-row' }, h(Loading, { text: busy ? `${t('busy')} (${busy})` : '' })),
    h(ErrorBanner, { text: error }),
    h(OkBanner, { text: info }),
    // 选包 / 数据源 / 场景
    h(
      'div',
      { className: 'ow-row' },
      h(Field, { label: t('srcPackage') },
        h('select', { className: 'ow-sel', value: pick, onChange: (e: { target: { value: string } }) => setPick(e.target.value), style: sel },
          ...versions.map((v) => h('option', { key: `${v.name}@${v.version}`, value: `${v.name}@${v.version}` }, `${v.name}@${v.version}（${v.status}）`)))),
      h(Field, { label: t('srcSource') },
        h('select', { className: 'ow-sel', value: sourceId, onChange: (e: { target: { value: string } }) => setSourceId(e.target.value), style: sel },
          ...apiSources.map((s) => h('option', { key: s.id, value: s.id }, s.hasShape ? s.name : `${s.name}（no shape）`)))),
      h(Field, { label: t('srcScenario') },
        h('select', { className: 'ow-sel', value: scenarioId, onChange: (e: { target: { value: string } }) => setScenarioId(e.target.value), style: sel },
          ...scenarios.map((s) => h('option', { key: s.id, value: s.id }, s.name)))),
    ),
    // 样本输入
    h(
      'div',
      { className: 'ow-row' },
      h(Field, { label: t('srcUrl') },
        h('input', { className: 'ow-in', value: url, placeholder: 'http://…', onChange: (e: { target: { value: string } }) => setUrl(e.target.value) })),
      h(Field, { label: t('srcSamples') },
        h('input', { className: 'ow-in', value: samples, onChange: (e: { target: { value: string } }) => setSamples(e.target.value) })),
      h(Field, { label: t('srcCollections') },
        h('input', { className: 'ow-in', value: collectionsText, placeholder: 'bins,alerts', onChange: (e: { target: { value: string } }) => setCollectionsText(e.target.value) })),
    ),
    h(Field, { label: t('srcJson') },
      h('textarea', {
        className: 'ow-textarea',
        style: { minHeight: 72 },
        value: jsonText,
        placeholder: '{ "bins": [ … ] }',
        onChange: (e: { target: { value: string } }) => setJsonText(e.target.value),
      })),
    h(
      'div',
      { className: 'ow-row' },
      h('button', { className: 'ow-btn', disabled: !!busy, onClick: doProbe }, busy === 'probe' ? t('busy') : t('srcProbeBtn')),
      h('button', { className: 'ow-btn', disabled: !!busy, onClick: doPreview }, busy === 'preview' ? t('busy') : t('srcPreviewBtn')),
    ),
    // 生成 / 回放选项 + 按钮
    h(
      'div',
      { className: 'ow-row' },
      h(Field, { label: t('srcOutDir') },
        h('input', { className: 'ow-in', value: outDir, onChange: (e: { target: { value: string } }) => setOutDir(e.target.value) })),
      h('label', { className: 'ow-note', style: { display: 'flex', gap: 6, alignItems: 'center' } },
        h('input', { type: 'checkbox', checked: force, onChange: (e: { target: { checked: boolean } }) => setForce(e.target.checked) }),
        t('srcForce')),
    ),
    h(
      'div',
      { className: 'ow-row' },
      h(Field, { label: t('srcFixturePath') },
        h('input', { className: 'ow-in', value: fixturePath, onChange: (e: { target: { value: string } }) => setFixturePath(e.target.value) })),
      h(Field, { label: t('srcScopeTypes') },
        h('input', { className: 'ow-in', value: scopeTypesText, onChange: (e: { target: { value: string } }) => setScopeTypesText(e.target.value) })),
      h(Field, { label: t('srcAgainstDir') },
        h('input', { className: 'ow-in', value: againstDir, onChange: (e: { target: { value: string } }) => setAgainstDir(e.target.value) })),
    ),
    h(
      'div',
      { className: 'ow-row' },
      h('label', { className: 'ow-note', style: { display: 'flex', gap: 6, alignItems: 'center' } },
        h('input', { type: 'checkbox', checked: check, onChange: (e: { target: { checked: boolean } }) => setCheck(e.target.checked) }),
        t('srcCheck')),
      h('label', { className: 'ow-note', style: { display: 'flex', gap: 6, alignItems: 'center' } },
        h('input', { type: 'checkbox', checked: writeExpected, onChange: (e: { target: { checked: boolean } }) => setWriteExpected(e.target.checked) }),
        t('srcWriteExpected')),
      h('button', { className: 'ow-btn', disabled: !!busy, onClick: doGenerate }, busy === 'generate' ? t('busy') : t('srcGenerateBtn')),
      h('button', { className: 'ow-btn', disabled: !!busy, onClick: doReplay }, busy === 'replay' ? t('busy') : t('srcReplayBtn')),
    ),
    probeNode,
    previewNode,
    genNode,
    replayNode,
  )
}

/** 样例值截断展示（JSON 序列化后限长）。 */
function truncate(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s === undefined ? '' : s.length > 48 ? `${s.slice(0, 48)}…` : s
}
