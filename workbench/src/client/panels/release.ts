/* ─────────────────────────────────────────────────────────────────────────
 * 发布台账（交付线双轨对称）：平台轨 UI 面——发布（纯内容/连接器两式）/ 激活 / 回滚。
 * 与客户轨 seed-release.mjs、Agent 工具面共用同一 ReleaseStore；
 * 人审口径：本人点击即人审事件（宿主可信身份留痕），激活/回滚只动自身活动指针。
 * ───────────────────────────────────────────────────────────────────────── */
import { h, useState, useEffect } from '../react'
import type { Ctx } from '../types'
import { Tag, ErrorBanner } from '../ui'
import { unwrap, errText } from '../helpers'

interface ReleaseView {
  packages: Array<{
    name: string
    activeVersion: string | null
    versions: Array<{ version: string; status: string; hasManifest: boolean }>
  }>
  history: Array<{
    action: string
    package: { name: string; version: string }
    from: string | null
    to: string | null
    at: string
    by: string
  }>
}

export function ReleasePanel(props: {
  t: (k: string) => string
  apis: Ctx
}) {
  const { t, apis } = props
  const [view, setView] = useState<ReleaseView | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [okMsg, setOkMsg] = useState('')
  // 发布表单：name@version；连接器式填 sourceId/sourceKind/apiBaseUrl（缺省 = 纯内容包）
  const [pubName, setPubName] = useState('')
  const [pubVersion, setPubVersion] = useState('')
  const [pubSourceId, setPubSourceId] = useState('')
  const [pubSourceKind, setPubSourceKind] = useState<'simulated' | 'formal'>('simulated')
  const [pubBaseUrl, setPubBaseUrl] = useState('')
  const [pubReplay, setPubReplay] = useState(false)
  const api = apis.remote['ontoRuntime']

  const load = () => {
    if (!api) return
    void (async () => {
      setError('')
      try {
        const out = unwrap<ReleaseView>(await api.listReleases())
        setView(out)
      } catch (e) {
        setError(errText(e))
      }
    })()
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apis])

  const act = (label: string, fn: () => Promise<unknown>, done: string | ((res: unknown) => string)) => {
    if (!api) return
    void (async () => {
      setBusy(label)
      setError('')
      setOkMsg('')
      try {
        const res = unwrap(await fn())
        setOkMsg(typeof done === 'function' ? done(res) : done)
        load()
      } catch (e) {
        setError(errText(e))
      } finally {
        setBusy('')
      }
    })()
  }

  const publish = () => {
    const hasSource = pubSourceId.trim() !== ''
    const target = `${pubName.trim()}@${pubVersion.trim()}`
    if (!window.confirm(`${t('relConfirmPublish')}\n${target}${hasSource ? ` · ${pubSourceId.trim()}` : ''}`)) return
    act(
      'publish',
      () =>
        api!.publishRelease({
          name: pubName.trim(),
          version: pubVersion.trim(),
          ...(hasSource
            ? {
                sourceId: pubSourceId.trim(),
                sourceKind: pubSourceKind,
                apiBaseUrl: pubBaseUrl.trim(),
              }
            : {}),
          checkReplay: pubReplay,
        }),
      t('relPublished'),
    )
  }

  return h(
    'div',
    { className: 'ow-card' },
    h('h3', { className: 'ow-h2' }, t('relTitle')),
    h('p', { className: 'ow-note' }, t('relHint')),
    h(ErrorBanner, { text: error }),
    okMsg ? h('p', { className: 'ow-note' }, okMsg) : null,
    h(
      'div',
      { className: 'ow-row' },
      h('button', { className: 'ow-btn ghost', disabled: !!busy, onClick: () => load() }, t('refresh')),
    ),
    h(
      'div',
      { className: 'ow-row' },
      h('input', {
        className: 'ow-in',
        placeholder: t('name'),
        value: pubName,
        onChange: (e: { target: { value: string } }) => setPubName(e.target.value),
      }),
      h('input', {
        className: 'ow-in',
        placeholder: t('version'),
        value: pubVersion,
        onChange: (e: { target: { value: string } }) => setPubVersion(e.target.value),
      }),
      h('input', {
        className: 'ow-in',
        placeholder: t('relSourceId'),
        value: pubSourceId,
        onChange: (e: { target: { value: string } }) => setPubSourceId(e.target.value),
      }),
      pubSourceId.trim() !== ''
        ? h('select', {
            className: 'ow-sel',
            value: pubSourceKind,
            onChange: (e: { target: { value: string } }) =>
              setPubSourceKind(e.target.value as 'simulated' | 'formal'),
          },
            h('option', { value: 'simulated' }, 'simulated'),
            h('option', { value: 'formal' }, 'formal'))
        : null,
      pubSourceId.trim() !== ''
        ? h('input', {
            className: 'ow-in',
            placeholder: t('relBaseUrl'),
            value: pubBaseUrl,
            onChange: (e: { target: { value: string } }) => setPubBaseUrl(e.target.value),
          })
        : null,
      h('label', { className: 'ow-note', style: { display: 'inline-flex', gap: '4px', alignItems: 'center' } },
        h('input', {
          type: 'checkbox',
          checked: pubReplay,
          onChange: (e: { target: { checked: boolean } }) => setPubReplay(e.target.checked),
        }),
        t('relCheckReplay')),
      h('button', {
        className: 'ow-btn',
        disabled: !!busy || !pubName.trim() || !pubVersion.trim()
          || (pubSourceId.trim() !== '' && !pubBaseUrl.trim()),
        onClick: () => publish(),
      }, t('relPublish')),
    ),
    h('p', { className: 'ow-note' }, t('relPublishModes')),
    view && view.packages.length > 0
      ? h(
          'table',
          { className: 'ow-table' },
          h(
            'thead',
            null,
            h('tr', null,
              h('th', null, t('name')), h('th', null, t('relActive')),
              h('th', null, t('version')), h('th', null, t('status')),
              h('th', null, t('actions'))),
          ),
          h(
            'tbody',
            null,
            ...view.packages.flatMap((p) =>
              p.versions.map((v, i) =>
                h(
                  'tr',
                  { key: `${p.name}@${v.version}` },
                  i === 0 ? h('td', { className: 'ow-mono', rowSpan: p.versions.length }, p.name) : null,
                  i === 0
                    ? h('td', { rowSpan: p.versions.length },
                        p.activeVersion ? h(Tag, { text: p.activeVersion, tone: 'ok' }) : '—')
                    : null,
                  h('td', { className: 'ow-mono' }, v.version),
                  h('td', null,
                    h(Tag, { text: v.status, tone: v.status === 'ISSUED' ? 'ok' : 'warn' }),
                    v.hasManifest ? h(Tag, { text: t('relManaged'), tone: 'ok' }) : null),
                  h('td', null,
                    h('button', {
                      className: 'ow-btn ghost',
                      disabled: !!busy || !v.hasManifest || p.activeVersion === v.version,
                      onClick: () => {
                        if (!window.confirm(`${t('relConfirmActivate')}\n${p.name}@${v.version}`)) return
                        act('activate', () => api!.activateRelease({ name: p.name, version: v.version }), t('relActivated'))
                      },
                    }, t('relActivateBtn')),
                    // 回滚作用于包级活动指针（非本行版本）——只在首行渲染一次，确认框写明语义
                    i === 0
                      ? h('button', {
                          className: 'ow-btn ghost',
                          disabled: !!busy || p.activeVersion === null,
                          onClick: () => {
                            if (!window.confirm(`${t('relConfirmRollback')}\n${p.name}（${t('relActive')}: ${p.activeVersion ?? '—'}）`)) return
                            act('rollback', () => api!.rollbackRelease({ name: p.name }), (res) => {
                              const r = res as { rolledBackTo: string; previous: string | null }
                              return `${t('relRolledBack')}: ${p.name} ${r.previous ?? '—'} → ${r.rolledBackTo} · humanReviewRequired=true`
                            })
                          },
                        }, t('relRollbackBtn'))
                      : null),
                ),
              ),
            ),
          ),
        )
      : h('p', { className: 'ow-note' }, t('empty')),
    view && view.history.length > 0
      ? h(
          'div',
          null,
          h('h4', { className: 'ow-h2' }, t('relHistory')),
          h(
            'table',
            { className: 'ow-table' },
            h('thead', null, h('tr', null,
              h('th', null, t('relAction')), h('th', null, t('name')),
              h('th', null, t('relFrom')), h('th', null, t('relTo')),
              h('th', null, t('savedAt')), h('th', null, t('relBy')))),
            h('tbody', null,
              ...view.history.slice(0, 12).map((hst, i) =>
                h('tr', { key: i },
                  h('td', null, hst.action),
                  h('td', { className: 'ow-mono' }, `${hst.package.name}@${hst.package.version}`),
                  h('td', { className: 'ow-mono' }, hst.from ?? '—'),
                  h('td', { className: 'ow-mono' }, hst.to ?? '—'),
                  h('td', null, hst.at.slice(0, 19).replace('T', ' ')),
                  h('td', { className: 'ow-mono' }, hst.by)))),
          ),
        )
      : null,
    h('p', { className: 'ow-note' }, t('humanReview')),
  )
}
