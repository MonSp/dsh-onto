import { h, useState, useEffect, useCallback, useMemo, useRef } from '../react'
import type { ReactNode } from '../types'
import type { Ctx } from '../types'
import { Tag, Row, Card, ErrorBanner, OkBanner, Loading, Field, PipelineView } from '../ui'
import { unwrap, errText, fmt } from '../helpers'

export interface VersionRow {
  name: string
  version: string
  status: string
  domain: string
  dir: string
}

export function PackagesPanel(props: {
  t: (k: string) => string
  apis: Ctx
  versions: VersionRow[]
  reload: () => void
  selected: { name: string; version: string } | null
  setSelected: (s: { name: string; version: string } | null) => void
}) {
  const { t, apis, versions, reload } = props
  const [name, setName] = useState('')
  const [version, setVersion] = useState('1.0.0')
  const [domain, setDomain] = useState('')
  const [issuedBy, setIssuedBy] = useState('')
  const [forkTo, setForkTo] = useState('')
  const [importText, setImportText] = useState('')
  const [exportText, setExportText] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const api = apis.remote['ontoWorkspace']
  const call = useCallback(
    async (label: string, fn: () => Promise<unknown>) => {
      if (!api) {
        setError('remote ontoWorkspace missing')
        return
      }
      setBusy(label)
      setError('')
      try {
        await fn()
        reload()
      } catch (e) {
        setError(errText(e))
      } finally {
        setBusy('')
      }
    },
    [apis, reload],
  )

  return h(
    'div',
    { className: 'ow-card' },
    h('h3', { className: 'ow-h2' }, t('tabPackages')),
    h('p', { className: 'ow-note' }, t('readme')),
    h(ErrorBanner, { text: error }),
    h(
      Row,
      { label: t('create') },
      h('input', { className: 'ow-in', placeholder: t('name'), value: name, onChange: (e: { target: { value: string } }) => setName(e.target.value) }),
      h('input', { className: 'ow-in', placeholder: t('version'), value: version, onChange: (e: { target: { value: string } }) => setVersion(e.target.value) }),
      h('input', { className: 'ow-in', placeholder: t('domain'), value: domain, onChange: (e: { target: { value: string } }) => setDomain(e.target.value) }),
      h(
        'button',
        {
          className: 'ow-btn',
          disabled: !name || !domain || !!busy,
          onClick: () =>
            void call('create', async () => {
              unwrap(await api!.createPackage({ name, version, domain }))
            }),
        },
        busy === 'create' ? t('busy') : t('create'),
      ),
    ),
    h(
      'table',
      { className: 'ow-table' },
      h(
        'thead',
        null,
        h('tr', null,
          h('th', null, t('name')), h('th', null, t('version')), h('th', null, t('domain')),
          h('th', null, t('status')), h('th', null, t('actions'))),
      ),
      h(
        'tbody',
        null,
        versions.length === 0
          ? h('tr', null, h('td', { colSpan: 5 }, t('empty')))
          : versions.map((v) =>
              h(
                'tr',
                { key: `${v.name}@${v.version}` },
                h('td', null, v.name),
                h('td', null, v.version),
                h('td', null, v.domain),
                h('td', null,
                  h(Tag, {
                    text: v.status,
                    tone: v.status === 'ISSUED' ? 'ok' : v.status === 'IN_REVIEW' ? 'warn' : undefined,
                  }),
                  props.selected && props.selected.name === v.name && props.selected.version === v.version
                    ? h(Tag, { text: '✓', tone: 'ok' })
                    : null,
                ),
                h(
                  'td',
                  null,
                  h('button', {
                    className: 'ow-btn ghost',
                    onClick: () => props.setSelected({ name: v.name, version: v.version }),
                  }, t('select')),
                  ' ',
                  v.status === 'DRAFT'
                    ? h('button', {
                        className: 'ow-btn ghost',
                        disabled: !!busy,
                        onClick: () =>
                          void call('review', async () => {
                            unwrap(await api!.transition({ name: v.name, version: v.version, to: 'IN_REVIEW' }))
                          }),
                      }, t('toReview'))
                    : null,
                  v.status === 'IN_REVIEW'
                    ? h('button', {
                        className: 'ow-btn ghost',
                        disabled: !!busy || !issuedBy.trim(),
                        title: t('issueBy'),
                        onClick: () =>
                          void call('issue', async () => {
                            if (!window.confirm(`${t('issueConfirm')}\n${v.name}@${v.version}`)) return
                            unwrap(await api!.transition({
                              name: v.name,
                              version: v.version,
                              to: 'ISSUED',
                              issuedBy: issuedBy.trim(),
                            }))
                          }),
                      }, t('issue'))
                    : null,
                  ' ',
                  h('button', {
                    className: 'ow-btn ghost',
                    disabled: !!busy || !forkTo.trim(),
                    onClick: () =>
                      void call('fork', async () => {
                        unwrap(await api!.forkVersion({ name: v.name, fromVersion: v.version, toVersion: forkTo.trim() }))
                      }),
                  }, t('fork')),
                  ' ',
                  h('button', {
                    className: 'ow-btn ghost',
                    disabled: !!busy,
                    onClick: () =>
                      void call('export', async () => {
                        const r = unwrap<{ archive: unknown }>(await api!.exportVersion({ name: v.name, version: v.version }))
                        setExportText(JSON.stringify(r.archive, null, 2))
                      }),
                  }, t('exportBtn')),
                ),
              ),
            ),
      ),
    ),
    h(
      Row,
      { label: t('issueBy') },
      h('input', { className: 'ow-in', value: issuedBy, onChange: (e: { target: { value: string } }) => setIssuedBy(e.target.value) }),
      h('input', {
        className: 'ow-in',
        placeholder: t('fork') + ' → ' + t('version'),
        value: forkTo,
        onChange: (e: { target: { value: string } }) => setForkTo(e.target.value),
      }),
    ),
    exportText
      ? h('div', null, h('div', { className: 'ow-label' }, t('exportBtn')), h('pre', { className: 'ow-mono' }, exportText))
      : null,
    h(
      Card,
      { title: t('importBtn') },
      h('p', { className: 'ow-note' }, t('importHint')),
      h('textarea', {
        className: 'ow-textarea',
        value: importText,
        onChange: (e: { target: { value: string } }) => setImportText(e.target.value),
      }),
      h(
        'button',
        {
          className: 'ow-btn',
          disabled: !!busy || !importText.trim(),
          onClick: () =>
            void call('import', async () => {
              const archive = JSON.parse(importText) as { meta: unknown; files: Record<string, string> }
              unwrap(await api!.importVersion({ archive }))
              setImportText('')
            }),
        },
        t('importBtn'),
      ),
    ),
  )
}
