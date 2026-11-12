import { h, useState, useEffect, useCallback, useMemo, useRef, Fragment } from '../react'
import type { ReactNode } from '../types'
import type { Ctx } from '../types'
import { Tag, Row, Card, ErrorBanner, OkBanner, Loading, Field, PipelineView } from '../ui'
import { unwrap, errText, fmt } from '../helpers'

/* ═══════════════════════════════════════════════════════════════
 * 知识库 —— 批量上传 / 解析报告 / 草案编辑 / diff 预览 / merge
 * ═══════════════════════════════════════════════════════════════ */

export function KnowledgePanel(props: {
  t: (k: string) => string
  apis: Ctx
  selected: { name: string; version: string } | null
}) {
  const { t, apis, selected } = props
  const [sources, setSources] = useState<Array<{ id: string; name: string; sourceType: string; parseStatus: string }>>([])
  const [queue, setQueue] = useState<Array<Record<string, unknown>>>([])
  const [sourceType, setSourceType] = useState('LEGACY_SYS')
  const [sourceName, setSourceName] = useState('')
  const [content, setContent] = useState('')
  const [batchFiles, setBatchFiles] = useState<File[]>([])
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [parseReports, setParseReports] = useState<Record<string, string>>({})
  const [editId, setEditId] = useState('')
  const [editText, setEditText] = useState('')
  const [preview, setPreview] = useState<Array<Record<string, unknown>> | null>(null)
  const [previewFor, setPreviewFor] = useState('')
  const [mergeId, setMergeId] = useState('')
  const [mergeInto, setMergeInto] = useState('')
  const [elementNames, setElementNames] = useState<string[]>([])
  const api = apis.remote['ontoKnowledge']
  const modelApi = apis.remote['ontoModel']

  const packageId = selected ? selected.name : ''

  const reload = useCallback(async () => {
    if (!api || !packageId) return
    // 不在这里清 error：act/物化可能刚写入 skipped 提示，reload 成功路径不得吞掉
    try {
      const s = unwrap<{ sources: Array<{ id: string; name: string; sourceType: string; parseStatus: string }> }>(
        await api.listSources({ packageId }),
      )
      setSources(s.sources)
      const q = unwrap<{ items: Array<Record<string, unknown>> }>(await api.listCandidates({ packageId }))
      setQueue(q.items)
    } catch (e) {
      setError(errText(e))
    }
  }, [apis, packageId])

  useEffect(() => {
    void reload()
  }, [reload])

  // merge 目标：当前包已有元素名（对象/规则/场景…）
  useEffect(() => {
    if (!modelApi || !selected) return
    void (async () => {
      try {
        const p = unwrap<{ pkg: Record<string, unknown> }>(
          await modelApi.load({ name: selected.name, version: selected.version }),
        )
        const pkg = p.pkg as Record<string, Array<{ name?: string; id?: string }>>
        const names: string[] = []
        for (const key of ['objects', 'relations', 'behaviors', 'scoreRules', 'exclusionRules', 'scenarios', 'dictionaries', 'skillTemplates']) {
          for (const el of pkg[key] ?? []) {
            if (el.name) names.push(el.name)
            else if (el.id) names.push(el.id)
          }
        }
        setElementNames(names)
      } catch {
        /* 模型加载失败不阻塞人审；merge 目标退化为手输（提示可见，不吞） */
        setInfo(t('mergeFallback'))
      }
    })()
  }, [apis, selected])

  const act = async (label: string, fn: () => Promise<void>) => {
    setBusy(label)
    setError('')
    setInfo('')
    try {
      await fn()
      await reload()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy('')
    }
  }

  const formatReport = (r: { received: number; accepted: number; idempotentSkipped: number; invalidDropped: number; engine: string }): string =>
    `${t('parseReport')}: ${t('received')}=${r.received} ${t('accepted')}=${r.accepted} ` +
    `${t('idemSkip')}=${r.idempotentSkipped} ${t('invalidDrop')}=${r.invalidDropped} ${t('engine')}=${r.engine}`

  const doBatchUpload = async () => {
    if (!selected || batchFiles.length === 0) return
    setError('')
    const items: Array<{ sourceType: string; name: string; content: string }> = []
    try {
      for (const f of batchFiles) {
        items.push({ sourceType, name: f.name, content: await f.text() })
      }
    } catch (e) {
      setError(errText(e))
      return
    }
    await act('batchUpload', async () => {
      const r = unwrap<{ sources: unknown[]; skipped: number; invalid: number }>(
        await api!.uploadSources({ packageId: selected!.name, items: items as never }),
      )
      setBatchFiles([])
      setInfo(`${t('batchUpload')}: ${t('accepted')}=${r.sources.length} ${t('idemSkip')}=${r.skipped} ${t('invalidDrop')}=${r.invalid}`)
    })
  }

  const startEditDraft = (c: Record<string, unknown>) => {
    setEditId(String(c['id']))
    setEditText(JSON.stringify({
      name: c['name'],
      payload: c['payload'],
      rationale: c['rationale'],
      confidence: c['confidence'],
    }, null, 2))
    setError('')
  }

  const saveDraft = async () => {
    setError('')
    let parsed: { name?: string; payload?: Record<string, unknown>; rationale?: string; confidence?: number }
    try {
      parsed = JSON.parse(editText)
    } catch (e) {
      setError(`${t('errInvalidJson')}: ${errText(e)}`)
      return
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setError(t('errPatchShape'))
      return
    }
    await act('saveDraft', async () => {
      unwrap(await api!.updateCandidate({ id: editId, patch: parsed }))
      setEditId('')
      setInfo(`✓ ${t('saveDraft')}`)
    })
  }

  const doPreview = async (ids: string[], tag: string) => {
    if (!selected || ids.length === 0) return
    await act('preview', async () => {
      const r = unwrap<{ previews: Array<Record<string, unknown>> }>(
        await api!.previewMaterialize({ name: selected!.name, version: selected!.version, ids }),
      )
      setPreview(r.previews)
      setPreviewFor(tag)
    })
  }

  const doMerge = async () => {
    if (!mergeId || !mergeInto.trim()) return
    await act('merge', async () => {
      unwrap(await api!.reviewCandidate({ id: mergeId, action: 'merge', mergeIntoName: mergeInto.trim() }))
      setMergeId('')
      setMergeInto('')
      setInfo(`✓ ${t('merge')} → ${mergeInto.trim()}`)
    })
  }

  const doApprove = async (id: string) => {
    await act('approve', async () => {
      unwrap(await api!.reviewCandidate({ id, action: 'approve' }))
      setInfo(`✓ ${t('approve')}`)
    })
  }

  const doReject = async (id: string) => {
    await act('reject', async () => {
      unwrap(await api!.reviewCandidate({ id, action: 'reject' }))
      setInfo(`✓ ${t('reject')}`)
    })
  }

  return h(
    'div',
    { className: 'ow-card' },
    h('h3', { className: 'ow-h2' }, t('tabKnowledge')),
    h('div', { className: 'ow-row' },
      h(Loading, { text: busy ? `${t('busy')} (${busy})` : '' }),
    ),
    h(ErrorBanner, { text: error }),
    h(OkBanner, { text: info }),
    !selected ? h('p', { className: 'ow-note' }, t('none')) : null,
    h(
      Card,
      { title: t('upload') },
      h(
        Row,
        null,
        h('select', {
          className: 'ow-sel',
          value: sourceType,
          onChange: (e: { target: { value: string } }) => setSourceType(e.target.value),
        }, ...['LEGACY_SYS', 'CASE_SAMPLE', 'POLICY', 'SCHEMA_API', 'WORK_ORDER'].map((k) => h('option', { key: k, value: k }, k))),
        h('input', { className: 'ow-in', placeholder: t('sourceName'), value: sourceName, onChange: (e: { target: { value: string } }) => setSourceName(e.target.value) }),
      ),
      h('textarea', {
        className: 'ow-textarea',
        placeholder: t('content'),
        value: content,
        onChange: (e: { target: { value: string } }) => setContent(e.target.value),
      }),
      h(
        'button',
        {
          className: 'ow-btn',
          disabled: !!busy || !sourceName.trim() || !content.trim() || !selected,
          onClick: () =>
            void act('upload', async () => {
              unwrap(await api!.uploadSource({
                packageId: selected!.name,
                sourceType: sourceType as never,
                name: sourceName.trim(),
                content,
              }))
              setSourceName('')
              setContent('')
              setInfo(`✓ ${t('upload')}`)
            }),
        },
        busy === 'upload' ? t('busy') : t('upload'),
      ),
      h('div', { className: 'ow-row' },
        h('label', { className: 'ow-label', htmlFor: 'ow-batch-files' }, t('batchUpload')),
        h('input', {
          id: 'ow-batch-files',
          type: 'file',
          multiple: true,
          className: 'ow-in',
          style: { flex: 'none', minWidth: 260 },
          onChange: (e: { target: { files: FileList | null } }) =>
            setBatchFiles(e.target.files ? Array.from(e.target.files) : []),
        }),
        h('button', {
          className: 'ow-btn ghost',
          disabled: !!busy || batchFiles.length === 0 || !selected,
          title: t('pickFiles'),
          onClick: () => void doBatchUpload(),
        }, `${t('batchUpload')} (${batchFiles.length})`),
      ),
      batchFiles.length > 0
        ? h('p', { className: 'ow-note' }, batchFiles.map((f) => f.name).join(' · '))
        : null,
    ),
    h(
      Card,
      { title: t('tabKnowledge') },
      h(
        'table',
        { className: 'ow-table' },
        h('thead', null, h('tr', null,
          h('th', null, t('sourceName')), h('th', null, t('sourceType')), h('th', null, t('status')),
          h('th', null, t('parseReport')), h('th', null, t('actions'))),
        ),
        h(
          'tbody',
          null,
          sources.length === 0
            ? h('tr', null, h('td', { colSpan: 5 }, t('empty')))
            : sources.map((s) =>
                h(
                  'tr',
                  { key: s.id },
                  h('td', null, s.name),
                  h('td', null, s.sourceType),
                  h('td', null, s.parseStatus),
                  h('td', { className: 'ow-note' }, parseReports[s.id] ?? '—'),
                  h(
                    'td',
                    null,
                    h('span', { className: 'ow-actions' },
                      h('button', {
                        className: 'ow-btn ghost',
                        disabled: !!busy,
                        onClick: () =>
                          void act('parse', async () => {
                            const r = unwrap<{ engine: string; report: { received: number; accepted: number; idempotentSkipped: number; invalidDropped: number; engine: string } }>(
                              await api!.parseSource({ sourceId: s.id }),
                            )
                            setParseReports((m) => ({ ...m, [s.id]: formatReport(r.report) }))
                            setInfo(formatReport(r.report))
                          }),
                      }, t('parse')),
                      h('button', {
                        className: 'ow-btn ghost',
                        disabled: !!busy,
                        onClick: () =>
                          void act('parseApi', async () => {
                            const r = unwrap<{ engine: string; report: { received: number; accepted: number; idempotentSkipped: number; invalidDropped: number; engine: string } }>(
                              await api!.parseSource({ sourceId: s.id, useApi: true }),
                            )
                            setParseReports((m) => ({ ...m, [s.id]: formatReport(r.report) }))
                            setInfo(formatReport(r.report))
                          }),
                      }, t('parseApi')),
                    ),
                  ),
                ),
              ),
        ),
      ),
    ),
    h(
      Card,
      { title: t('queue') },
      h(
        'table',
        { className: 'ow-table' },
        h('thead', null, h('tr', null,
          h('th', null, t('layer')), h('th', null, t('kind')), h('th', null, t('name')),
          h('th', null, t('confidence')), h('th', null, t('status')), h('th', null, t('actions'))),
        ),
        h(
          'tbody',
          null,
          queue.length === 0
            ? h('tr', null, h('td', { colSpan: 6 }, t('empty')))
            : queue.map((c) => {
                const id = String(c['id'])
                const status = String(c['status'])
                const row: ReactNode[] = [
                  h('td', { key: 'l' }, String(c['layer'])),
                  h('td', { key: 'k' }, String(c['targetKind'])),
                  h('td', { key: 'n' }, String(c['name']),
                    c['conclusionLike'] ? h(Tag, { text: t('conclusion'), tone: 'warn' }) : null,
                    c['forcedReview'] ? h(Tag, { text: t('forcedReview'), tone: 'warn' }) : null),
                  h('td', { key: 'c' }, fmt(c['confidence'] as number, 2)),
                  h('td', { key: 's' }, status),
                ]
                const actions: ReactNode[] = []
                if (status === 'pending') {
                  actions.push(h('button', {
                    key: 'edit',
                    className: 'ow-btn ghost',
                    disabled: !!busy,
                    onClick: () => startEditDraft(c),
                  }, t('editDraft')))
                  actions.push(h('button', {
                    key: 'ap',
                    className: 'ow-btn ghost',
                    disabled: !!busy,
                    onClick: () => void doApprove(id),
                  }, t('approve')))
                  actions.push(h('button', {
                    key: 'rj',
                    className: 'ow-btn ghost',
                    disabled: !!busy,
                    onClick: () => void doReject(id),
                  }, t('reject')))
                  actions.push(h('button', {
                    key: 'mg',
                    className: 'ow-btn ghost',
                    disabled: !!busy,
                    onClick: () => { setMergeId(mergeId === id ? '' : id); setMergeInto('') },
                  }, t('merge')))
                }
                actions.push(h('button', {
                  key: 'pv',
                  className: 'ow-btn ghost',
                  disabled: !!busy || !selected,
                  onClick: () => void doPreview([id], id),
                }, t('preview')))
                if (status === 'approved') {
                  actions.push(h('button', {
                    key: 'pk',
                    className: 'ow-btn ghost',
                    disabled: !!busy,
                    onClick: () => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id])),
                  }, picked.includes(id) ? '✓' : '+'))
                }
                row.push(h('td', { key: 'a' }, h('span', { className: 'ow-actions' }, ...actions)))

                const extras: ReactNode[] = []
                if (editId === id) {
                  extras.push(h('tr', { key: 'edit-row' },
                    h('td', { colSpan: 6 },
                      h('div', { className: 'ow-form' },
                        h(Field, { label: t('payloadJson') },
                          h('textarea', {
                            className: 'ow-textarea',
                            style: { minHeight: 140 },
                            value: editText,
                            onChange: (e: { target: { value: string } }) => setEditText(e.target.value),
                          })),
                        h('div', { className: 'ow-row' },
                          h('button', { className: 'ow-btn', disabled: !!busy, onClick: () => void saveDraft() },
                            busy === 'saveDraft' ? t('busy') : t('saveDraft')),
                          h('button', { className: 'ow-btn ghost', onClick: () => setEditId('') }, t('cancel')),
                        ),
                      )),
                  ))
                }
                if (mergeId === id) {
                  extras.push(h('tr', { key: 'merge-row' },
                    h('td', { colSpan: 6 },
                      h('div', { className: 'ow-form' },
                        h(Field, { label: t('mergeInto') },
                          h('input', {
                            className: 'ow-in',
                            list: 'ow-elem-names',
                            placeholder: t('elementName'),
                            value: mergeInto,
                            onChange: (e: { target: { value: string } }) => setMergeInto(e.target.value),
                          }),
                          h('datalist', { id: 'ow-elem-names' },
                            ...elementNames.map((n) => h('option', { key: n, value: n }))),
                        ),
                        h('div', { className: 'ow-row' },
                          h('button', {
                            className: 'ow-btn',
                            disabled: !!busy || !mergeInto.trim(),
                            onClick: () => void doMerge(),
                          }, t('merge')),
                          h('button', { className: 'ow-btn ghost', onClick: () => setMergeId('') }, t('cancel')),
                        ),
                      )),
                  ))
                }
                if (previewFor === id && preview) {
                  extras.push(h('tr', { key: 'preview-row' },
                    h('td', { colSpan: 6 },
                      h('div', { className: 'ow-diff' },
                        h('strong', null, t('previewTitle')),
                        ...preview.map((p) =>
                          h('div', { key: String(p['id']) },
                            h('p', {
                              className: 'ow-note',
                              style: { color: p['ok'] ? '#166534' : '#b91c1c', margin: '4px 0 0' },
                            }, p['ok'] ? String(p['summary']) : `✗ ${String(p['error'] ?? '')}`),
                            p['element']
                              ? h('pre', { className: 'ow-mono' }, JSON.stringify(p['element'], null, 2))
                              : null,
                          )),
                        h('button', {
                          className: 'ow-btn ghost',
                          onClick: () => { setPreview(null); setPreviewFor('') },
                        }, t('cancel')),
                      )),
                  ))
                }
                return h(Fragment, { key: id },
                  h('tr', null, ...row),
                  ...extras,
                )
              }),
        ),
      ),
      h(
        'button',
        {
          className: 'ow-btn ghost',
          disabled: !!busy || picked.length === 0 || !selected,
          onClick: () => void doPreview(picked, 'bulk'),
        },
        `${t('preview')} (${picked.length})`,
      ),
      h(
        'button',
        {
          className: 'ow-btn',
          disabled: !!busy || picked.length === 0 || !selected,
          onClick: () =>
            void act('materialize', async () => {
              const r = unwrap<{ applied: string[]; skipped: Array<{ id: string; reason: string }> }>(
                await api!.materialize({ name: selected!.name, version: selected!.version, ids: picked }),
              )
              setPicked([])
              if (r.skipped.length > 0) setError(r.skipped.map((s) => `${s.id}: ${s.reason}`).join('; '))
              else setInfo(`✓ ${t('materialize')}: ${r.applied.length}`)
            }),
        },
        busy === 'materialize' ? t('busy') : `${t('materialize')} (${picked.length})`,
      ),
      previewFor === 'bulk' && preview
        ? h('div', { className: 'ow-diff' },
            h('strong', null, t('previewTitle')),
            ...preview.map((p) =>
              h('div', { key: String(p['id']) },
                h('p', {
                  className: 'ow-note',
                  style: { color: p['ok'] ? '#166534' : '#b91c1c', margin: '4px 0 0' },
                }, p['ok'] ? String(p['summary']) : `✗ ${String(p['error'] ?? '')}`),
                p['element']
                  ? h('pre', { className: 'ow-mono' }, JSON.stringify(p['element'], null, 2))
                  : null,
              )),
            h('button', {
              className: 'ow-btn ghost',
              onClick: () => { setPreview(null); setPreviewFor('') },
            }, t('cancel')),
          )
        : null,
    ),
  )
}
