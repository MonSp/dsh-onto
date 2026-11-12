import { h, useState, useEffect, useCallback, useMemo, useRef } from '../react'
import type { ReactNode } from '../types'
import type { Ctx } from '../types'
import { Tag, Row, Card, ErrorBanner, OkBanner, Loading, Field, PipelineView } from '../ui'
import { unwrap, errText, fmt } from '../helpers'
import { GraphWorkbench } from '../workbench'
import {
  type ElemKind, ELEM_LABEL, type ElemEdit,
  emptyFormData, collectAllIds, toFormData, fromFormData,
} from '../form'

export function ModelPanel(props: {
  t: (k: string) => string
  apis: Ctx
  selected: { name: string; version: string } | null
}) {
  const { t, apis, selected } = props
  const [pkg, setPkg] = useState<Record<string, unknown> | null>(null)
  const [files, setFiles] = useState<Record<string, string>>({})
  const [yamlPath, setYamlPath] = useState('o1-objects/object-types.yaml')
  const [yamlText, setYamlText] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [edit, setEdit] = useState<ElemEdit | null>(null)
  const api = apis.remote['ontoModel']
  // 画布状态与动作在 GraphWorkbench（主区视图与右栏 tab 共用；P1 修正）
  const [view, setView] = useState<'canvas' | 'list'>('canvas')
  // D4：清单视图的待审草案可见性——此前只有画布有虚线态与计数，
  // 走清单人审会误以为没有草案（压测 C1 观察）。
  const [pendingDrafts, setPendingDrafts] = useState<Array<Record<string, unknown>>>([])
  const [draftTick, setDraftTick] = useState(0)

  const reload = useCallback(async () => {
    if (!api || !selected) return
    setBusy('load')
    setError('')
    try {
      const p = unwrap<{ pkg: Record<string, unknown> }>(await api.load({ name: selected.name, version: selected.version }))
      setPkg(p.pkg)
      const f = unwrap<{ files: Record<string, string> }>(await api.readSources({ name: selected.name, version: selected.version }))
      setFiles(f.files)
      setDraftTick((n) => n + 1)
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy('')
    }
  }, [apis, selected])

  useEffect(() => {
    void reload()
  }, [reload])

  // 清单视图挂载/切换/包变更时拉取待审草案（画布态由 GraphWorkbench 自取，互不耦合）。
  useEffect(() => {
    const kApi = apis.remote['ontoKnowledge']
    if (view !== 'list' || !selected || !kApi) {
      setPendingDrafts([])
      return
    }
    let alive = true
    void kApi
      .listCandidates({ packageId: selected.name })
      .then((q) => {
        if (!alive) return
        const items = unwrap<{ items: Array<Record<string, unknown>> }>(q).items ?? []
        setPendingDrafts(items.filter((d) => d.status === 'pending'))
      })
      .catch(() => {
        if (alive) setPendingDrafts([])
      })
    return () => {
      alive = false
    }
  }, [apis, view, selected, draftTick])

  const savePkg = async (mutate: (p: Record<string, unknown>) => void, label: string): Promise<boolean> => {
    if (!api || !selected || !pkg) return false
    setBusy(label)
    setError('')
    setInfo('')
    try {
      const next = JSON.parse(JSON.stringify(pkg)) as Record<string, unknown>
      mutate(next)
      unwrap(await api.save({ name: selected.name, version: selected.version, pkg: next }))
      await reload()
      setInfo(`✓ ${label}`)
      return true
    } catch (e) {
      setError(errText(e))
      return false
    } finally {
      setBusy('')
    }
  }

  if (!selected) return h('div', { className: 'ow-card' }, h('p', { className: 'ow-note' }, t('none')))
  const model = (pkg ?? {}) as Record<string, Array<Record<string, unknown>>>
  const pkgStatus = String((pkg as { meta?: { status?: string } } | null)?.meta?.status ?? '')
  const readOnly = pkgStatus === 'ISSUED'
  // 与服务端 writeSource 同一守卫口径：..、绝对路径、反斜杠
  const badRelPath = yamlPath.includes('..') || yamlPath.startsWith('/') || yamlPath.includes('\\')

  const objIds = (model['objects'] ?? []).map((o) => String(o['id']))

  const startAdd = (kind: ElemKind) => {
    if (readOnly) return
    setEdit({ kind, idx: -1, data: emptyFormData(kind, collectAllIds(model)) })
    setInfo('')
    setError('')
  }

  const startEdit = (kind: ElemKind, idx: number) => {
    if (readOnly) return
    const el = (model[kind] ?? [])[idx]
    if (!el) return
    setEdit({ kind, idx, data: toFormData(kind, el) })
    setInfo('')
    setError('')
  }

  const doDelete = (kind: ElemKind, idx: number) => {
    if (readOnly) return
    const el = (model[kind] ?? [])[idx]
    if (!el) return
    if (!window.confirm(`${t('confirmDelete')}\n${String(el['id'])}「${String(el['name'])}」`)) return
    void savePkg((p) => {
      const arr = (p[kind] as Array<Record<string, unknown>>) ?? []
      arr.splice(idx, 1)
      p[kind] = arr
    }, 'delete')
  }

  const doSaveEdit = () => {
    if (!edit || readOnly) return
    setError('')
    let el: Record<string, unknown>
    try {
      el = fromFormData(edit.kind, edit.data)
    } catch (e) {
      setError(errText(e))
      return
    }
    if (!el['id'] || !el['name']) {
      setError(t('errIdName'))
      return
    }
    const idx = edit.idx
    // 跨类查重（score/exclusion 共用 RULE-*）；编辑时排除自身原位
    const taken = collectAllIds(model)
    if (idx >= 0) {
      const cur = (model[edit.kind] ?? [])[idx]
      if (cur && String(cur['id']) === String(el['id'])) taken.delete(String(el['id']))
    }
    if (taken.has(String(el['id']))) {
      setError(`${t('errDuplicateId')}: ${String(el['id'])}`)
      return
    }
    void savePkg((p) => {
      const arr = (p[edit.kind] as Array<Record<string, unknown>>) ?? []
      if (idx < 0) {
        arr.push(el)
      } else {
        // 保留 id 不变时原地替换；改 id 已在上方跨类查重；引用闭合交给校验器
        arr[idx] = el
      }
      p[edit.kind] = arr
    }, idx < 0 ? `add ${edit.kind}` : `edit ${edit.kind}`).then((ok) => {
      if (ok) setEdit(null)
    })
  }

  function elemTable(kind: ElemKind) {
    const arr = (model[kind] ?? []) as Array<Record<string, unknown>>
    const title = t(ELEM_LABEL[kind])
    return h(
      Card,
      { key: kind, title },
      h(
        'div',
        { className: 'ow-row' },
        h('span', { className: 'ow-stat' }, `${arr.length}`),
        readOnly ? null : h('button', {
          className: 'ow-btn ghost',
          disabled: !!busy,
          onClick: () => startAdd(kind),
        }, `+ ${t('addElement')}`),
      ),
      arr.length === 0
        ? h('p', { className: 'ow-note' }, t('empty'))
        : h(
            'table',
            { className: 'ow-table' },
            h('thead', null, h('tr', null,
              h('th', null, 'ID'), h('th', null, t('name')), h('th', null, t('kind')), h('th', null, t('actions')))),
            h('tbody', null, ...arr.map((el, i) => {
              let extra = ''
              if (kind === 'relations') extra = `${String(el['from'] ?? '?')} → ${String(el['to'] ?? '?')}`
              else if (kind === 'behaviors') extra = `⚓ ${String(el['anchor'] ?? '?')}`
              else if (kind === 'scoreRules') extra = `w=${String(el['weight'] ?? 0)} ${String(el['expression'] ?? '').slice(0, 30)}`
              else if (kind === 'exclusionRules') extra = `${String(el['action'] ?? '')} ${String(el['condition'] ?? '').slice(0, 30)}`
              else if (kind === 'scenarios') extra = String(el['goal'] ?? '').slice(0, 40)
              else if (kind === 'objects') {
                const attrs = (el['attributes'] as unknown[]) ?? []
                extra = `${attrs.length} attrs`
              }
              return h('tr', { key: String(el['id']) + i },
                h('td', { className: 'ow-mono' }, String(el['id'])),
                h('td', null, String(el['name'])),
                h('td', { className: 'ow-note' }, extra),
                h('td', null,
                  h('span', { className: 'ow-actions' },
                    readOnly ? null : h('button', {
                      className: 'ow-btn ghost',
                      disabled: !!busy,
                      onClick: () => startEdit(kind, i),
                    }, t('edit')),
                    readOnly ? null : h('button', {
                      className: 'ow-btn ghost',
                      disabled: !!busy,
                      onClick: () => doDelete(kind, i),
                    }, t('delete')),
                  ),
                ),
              )
            })),
          ),
      edit && edit.kind === kind ? elemForm(kind) : null,
    )
  }

  function elemForm(kind: ElemKind) {
    if (!edit) return null
    const d = edit.data
    const set = (k: string) => (e: { target: { value: string } }) =>
      setEdit({ ...edit!, data: { ...edit!.data, [k]: e.target.value } })
    const textField = (k: string, label: string, ph = '') =>
      h(Field, { label },
        h('input', { className: 'ow-in', placeholder: ph, value: d[k] ?? '', onChange: set(k) }))
    const areaField = (k: string, label: string, ph = '', minH = 70) =>
      h(Field, { label },
        h('textarea', {
          className: 'ow-textarea', placeholder: ph,
          style: { minHeight: minH }, value: d[k] ?? '', onChange: set(k),
        }))
    const selectField = (k: string, label: string, opts: string[]) =>
      h(Field, { label },
        h('select', { className: 'ow-sel', value: d[k] ?? '', onChange: set(k) },
          ...opts.map((o) => h('option', { key: o, value: o }, o))))

    const isEdit = edit!.idx >= 0
    const children: ReactNode[] = [
      h('div', { className: 'ow-row' },
        h(Tag, { text: isEdit ? t('edit') : t('addElement'), tone: 'warn' }),
        h('span', { className: 'ow-note' }, t(ELEM_LABEL[kind])),
      ),
      h(Field, { label: 'ID' },
        h('input', { className: 'ow-in', value: d['id'] ?? '', onChange: set('id'), disabled: false })),
      textField('name', t('name')),
    ]

    if (kind === 'objects') {
      children.push(textField('idRule', t('idRule'), '<bank_code>:<acct_no>'))
      children.push(areaField('attributes', t('attrs'), 'acctType:enum\nopenDate:date'))
      children.push(areaField('lifecycle', t('lifecycle'), 'active\nclosed', 50))
      children.push(areaField('description', t('info'), '', 50))
    } else if (kind === 'relations') {
      children.push(selectField('from', t('from'), ['', ...objIds]))
      children.push(selectField('to', t('to'), ['', ...objIds]))
      children.push(areaField('attributes', t('attrs'), 'relKind:enum', 50))
      children.push(areaField('description', t('info'), '', 50))
    } else if (kind === 'behaviors') {
      children.push(selectField('anchor', t('anchor'), ['', ...objIds]))
      children.push(areaField('relations', t('behaviorRelations'), 'REL-GEN-1'))
      children.push(areaField('states', t('states'), 'init\nactive\nclosed', 50))
      children.push(textField('trigger', t('trigger')))
      children.push(areaField('description', t('info'), '', 50))
    } else if (kind === 'scoreRules') {
      children.push(h(Field, { label: t('weight') },
        h('input', { className: 'ow-in', style: { maxWidth: 110 }, value: d['weight'] ?? '', onChange: set('weight') })))
      children.push(textField('expression', t('expression'), 'min(1, inboundCount/10)'))
      children.push(h(Field, { label: t('threshold') },
        h('input', { className: 'ow-in', style: { maxWidth: 110 }, value: d['threshold'] ?? '', onChange: set('threshold') })))
      children.push(areaField('evidenceTemplate', t('evidence'), '近 {windowDays} 日转入 {inboundCount} 笔', 50))
      children.push(areaField('description', t('info'), '', 50))
    } else if (kind === 'exclusionRules') {
      children.push(selectField('action', t('ruleAction'), ['drop', 'downweight']))
      children.push(h(Field, { label: t('factor') },
        h('input', { className: 'ow-in', style: { maxWidth: 110 }, value: d['factor'] ?? '', onChange: set('factor') })))
      children.push(textField('condition', t('condition'), "tag == 'salary'"))
      children.push(areaField('description', t('info'), '', 50))
    } else if (kind === 'scenarios') {
      children.push(areaField('goal', t('goal'), '从客户/账户出发识别可疑交易线索', 50))
      children.push(areaField('boundary', t('boundary'), '仅输出候选线索；报送与否人工决定', 50))
      children.push(areaField('inputs', t('inputs'), '[{"name":"customerId","type":"string","required":true}]', 70))
      children.push(areaField('outputs', t('outputs'), 'candidateId\nriskScore', 50))
      children.push(areaField('mustInclude', t('mustInclude'), 'candidateList\nriskScore\nevidenceChains\npendingChecks', 60))
      children.push(areaField('forbiddenPhrases', t('forbiddenList'), '认定洗钱\n确定为地下钱庄', 60))
      children.push(selectField('reviewRequired', t('reviewRequired'), ['yes', 'no']))
      children.push(h(Field, { label: t('reviewGate') + ' ≤' },
        h('input', { className: 'ow-in', style: { maxWidth: 110 }, value: d['reviewThreshold'] ?? '', onChange: set('reviewThreshold') })))
      children.push(areaField('auditChecks', t('auditChecks'), 'O1_CLOSED\nO2_CLOSED\nO3_CLOSED', 50))
      // pipeline：JSON 可编辑 + 只读可视化
      children.push(areaField('pipeline', t('pipeline'), '[]', 90))
      let pipeSteps: Array<{ stepId?: string; stepType?: string; order?: string; skillRefs?: string[] }> = []
      try {
        pipeSteps = JSON.parse(d['pipeline'] || '[]')
      } catch {
        pipeSteps = []
      }
      children.push(
        h(Field, { label: t('pipelineViz') },
          h('div', { className: 'ow-diff', style: { flex: 1 } },
            h(PipelineView, { steps: pipeSteps, emptyText: t('emptyPipeline') }))),
      )
    }

    children.push(
      h('div', { className: 'ow-row' },
        h('button', {
          className: 'ow-btn',
          disabled: !!busy,
          onClick: doSaveEdit,
        }, busy ? t('busy') : t('save')),
        h('button', {
          className: 'ow-btn ghost',
          onClick: () => { setEdit(null); setError(''); setInfo('') },
        }, t('cancel')),
      ),
    )
    return h('div', { className: 'ow-form' }, ...children)
  }

  if (view === 'canvas') {
    return h(
      'div',
      { className: 'ow-main canvas', style: { height: '100%' } },
      h(ErrorBanner, { text: error }),
      h(OkBanner, { text: info }),
      readOnly
        ? h('p', { className: 'ow-note', style: { padding: '8px 12px' }, }, `${t('issue')}: ISSUED — ${t('readme')}`)
        : null,
      h(GraphWorkbench, { key: 'gw', t, apis, selected, onChanged: reload }),
    )
  }

  return h(
    'div',
    { className: 'ow-card' },
    h('h3', { className: 'ow-h2' }, t('tabModel')),
    h('div', { className: 'ow-row' },
      h(Loading, { text: busy === 'load' ? t('loading') : '' }),
      busy && busy !== 'load' ? h('span', { className: 'ow-loading' }, `${t('busy')} (${busy})`) : null,
    ),
    h(ErrorBanner, { text: error }),
    h(OkBanner, { text: info }),
    readOnly
      ? h('p', { className: 'ow-note' }, `${t('issue')}: ISSUED — ${t('readme')}`)
      : null,
    h(
      'div',
      { className: 'ow-row' },
      h('span', { className: 'ow-stat' }, `${t('objects')} ${(model['objects'] ?? []).length}`),
      h('span', { className: 'ow-stat' }, `${t('relations')} ${(model['relations'] ?? []).length}`),
      h('span', { className: 'ow-stat' }, `${t('dictionaries')} ${(model['dictionaries'] ?? []).length}`),
      h('span', { className: 'ow-stat' }, `${t('behaviors')} ${(model['behaviors'] ?? []).length}`),
      h('span', { className: 'ow-stat' }, `${t('scoreRules')} ${(model['scoreRules'] ?? []).length}`),
      h('span', { className: 'ow-stat' }, `${t('exclusionRules')} ${(model['exclusionRules'] ?? []).length}`),
      h('span', { className: 'ow-stat' }, `${t('skillTemplates')} ${(model['skillTemplates'] ?? []).length}`),
      h('span', { className: 'ow-stat' }, `${t('scenarios')} ${(model['scenarios'] ?? []).length}`),
    ),
    h(
      'div',
      { className: 'ogc-toolbar', style: { marginTop: 10 } },
      h('button', {
        className: 'ow-btn ghost',
        onClick: () => setView('canvas'),
      }, t('canvasView')),
      h('button', {
        className: 'ow-btn',
        onClick: () => setView('list'),
      }, t('listView')),
    ),
    // list branch only below (canvas returned above)
    h(
      'div',
      { key: 'pending-drafts', className: 'ow-row', style: { flexDirection: 'column', alignItems: 'stretch', gap: 4, marginBottom: 8 } },
      h('b', { className: 'ow-note' }, `${t('draftCount')}：${pendingDrafts.length}`),
      h('span', { className: 'ow-note' }, t('draftHint')),
      ...pendingDrafts.slice(0, 40).map((d, i) =>
        h(
          'div',
          { key: `pd-${i}`, className: 'ow-note' },
          `${String(d.name ?? d.id ?? '')} · ${String(d.targetKind ?? '')} · ${String(d.layer ?? '')} · conf ${String(d.confidence ?? '')}${d.conclusionLike === true ? ' · 结论性→RedLine' : ''}${typeof (d.provenance as { runId?: string } | undefined)?.runId === 'string' ? ` · run:${(d.provenance as { runId: string }).runId}` : ''}`,
        )),
      pendingDrafts.length > 40
        ? h('span', { className: 'ow-note' }, `… +${pendingDrafts.length - 40}`)
        : null,
    ),
    ...(['objects', 'relations', 'behaviors', 'scoreRules', 'exclusionRules', 'scenarios'] as ElemKind[]).map(elemTable),
    h(
      Card,
      { title: t('yamlImport') },
      h('p', { className: 'ow-note' }, t('yamlNewHint')),
      h(
        Row,
        null,
        h('input', {
          className: 'ow-in',
          list: 'ow-yaml-files',
          placeholder: t('yamlPath'),
          value: yamlPath,
          onChange: (e: { target: { value: string } }) => {
            setYamlPath(e.target.value)
            if (files[e.target.value] !== undefined) setYamlText(files[e.target.value])
          },
        }),
        h('datalist', { id: 'ow-yaml-files' },
          ...Object.keys(files).map((k) => h('option', { key: k, value: k }))),
        h('button', { className: 'ow-btn ghost', onClick: () => setYamlText(files[yamlPath] ?? '') }, t('refresh')),
      ),
      h('textarea', {
        className: 'ow-textarea',
        value: yamlText,
        onChange: (e: { target: { value: string } }) => setYamlText(e.target.value),
      }),
      h(
        'button',
        {
          className: 'ow-btn',
          disabled: !!busy || readOnly || !yamlPath.trim() || badRelPath,
          title: readOnly
            ? t('issuedReadonly')
            : badRelPath
              ? t('illegalRelPath')
              : undefined,
          onClick: () =>
            void (async () => {
              if (!api || !selected || readOnly) return
              setBusy('yaml')
              setError('')
              setInfo('')
              try {
                unwrap(await api.writeSource({ name: selected.name, version: selected.version, relPath: yamlPath, text: yamlText }))
                await reload()
                setInfo(`✓ ${t('yamlWrite')}: ${yamlPath}`)
              } catch (e) {
                setError(errText(e))
              } finally {
                setBusy('')
              }
            })(),
        },
        busy === 'yaml' ? t('busy') : t('yamlWrite'),
      ),
    ),
    // P-2：包根 backlog.md（附属文件）只读展示——读面由 exportVersion 携带
    ...(files['backlog.md']
      ? [
          h(
            Card,
            { key: 'backlog', title: t('backlogTitle') },
            h('pre', {
              className: 'ow-note',
              style: { whiteSpace: 'pre-wrap', margin: 0, maxHeight: 200, overflow: 'auto' },
            }, files['backlog.md']),
            h('p', { className: 'ow-note' }, t('backlogHint')),
          ),
        ]
      : []),
  )
}
