import { h } from './react'
import type { ReactNode } from './types'
import { Tag } from './ui'
import type { OgGraph, OgNode, OgEdge } from './graph'

/** issue.where → 当前节点（graph.issues.where 已在 core 归一为「节点 ID | 'package'」；PREFIX 形态为兼容保留）。 */
export function matchIssueWhere(where: string, id: string): boolean {
  if (where === id || where.startsWith(`${id}.`)) return true
  const m = /^([A-Z]{2,4}) ([A-Z]+-[A-Z0-9-]+)(?:\.[A-Za-z0-9_-]+)?$/.exec(where)
  return m !== null && m[2] === id
}

export function findElement(
  pkg: Record<string, unknown> | null,
  id: string,
): { key: string; el: Record<string, unknown> } | null {
  if (!pkg) return null
  for (const key of [
    'objects',
    'relations',
    'dictionaries',
    'behaviors',
    'scoreRules',
    'exclusionRules',
    'skillTemplates',
    'scenarios',
    'fieldMaps',
    'apiSources',
  ]) {
    const arr = pkg[key] as Array<Record<string, unknown>> | undefined
    const hit = arr?.find((x) => String(x['id']) === id)
    if (hit) return { key, el: hit }
  }
  return null
}

export function InspectorView(props: {
  t: (k: string) => string
  graph: OgGraph
  node: OgNode | null
  edge: OgEdge | null
  pkg: Record<string, unknown> | null
  candidates: Array<Record<string, unknown>>
  busy: string
  readOnly: boolean
  onDraftAction: (id: string, action: 'approve' | 'reject') => void
  onClear?: () => void
  stepDetail?: { stepId: string; stepType: string; order?: string; label?: string; refs: string[] } | null
}) {
  const { t, graph, node, edge, pkg, candidates, busy, readOnly, onDraftAction, onClear, stepDetail } = props
  if (!node && !edge && props.stepDetail) {
    const sd = props.stepDetail
    return h(
      'div',
      { className: 'ogc-insp' },
      h('div', { className: 'ow-row' },
        h(Tag, { text: t('stepDetail'), tone: 'warn' }),
        h(Tag, { text: sd.stepType })),
      h('h4', null, `${sd.stepId} · ${sd.stepType}`),
      h('div', { className: 'ogc-step-card' },
        h('div', null, h('span', { className: 'tag' }, sd.stepType),
          sd.order ? h('span', { className: 'tag' }, sd.order) : null),
        sd.label ? h('div', { style: { marginTop: 6 } }, sd.label) : null,
        sd.refs && sd.refs.length
          ? h('div', { style: { marginTop: 6 } },
              h('b', null, 'Refs: '),
              sd.refs.join(', '))
          : null,
      ),
      h('p', { className: 'ow-note' }, t('scenarioFocusHint')),
    )
  }
  if (!node && edge) {
    const kv = (label: string, value: unknown): ReactNode =>
      h('div', { className: 'ogc-kv' }, h('b', null, label), h('span', null, String(value ?? '—')))
    const nameOf = (id: string): string => graph.nodes.find((n) => n.id === id)?.name ?? id
    const fromNode = graph.nodes.find((n) => n.id === edge.from)
    const toNode = graph.nodes.find((n) => n.id === edge.to)
    return h(
      'div',
      { className: 'ogc-insp' },
      h('div', { className: 'ow-row' },
        h(Tag, { text: t('edgeDetail'), tone: 'warn' }),
        h(Tag, { text: edge.kind }),
        onClear ? h('button', { className: 'ow-btn ghost', onClick: onClear }, t('clearSel')) : null),
      h('h4', null, `${nameOf(edge.from)} → ${nameOf(edge.to)}`),
      kv(t('edgeKind'), edge.kind),
      kv('From', edge.from),
      kv('To', edge.to),
      edge.label ? kv(t('name'), edge.label) : null,
      kv(t('edgeEndpoints'), `${fromNode?.layer ?? '?'} → ${toNode?.layer ?? '?'}`),
      h('p', { className: 'ow-note' }, t('zoomHint')),
    )
  }
  if (!node) {
    return h(
      'div',
      { className: 'ogc-insp' },
      h('p', { className: 'ow-note', style: { textAlign: 'center', padding: '28px 12px', lineHeight: 1.7 } },
        h('b', { style: { display: 'block', color: '#1c2333', marginBottom: 6 } }, t('noSelection')),
        t('zoomHint')),
    )
  }
  const issues = graph.issues.filter((i) => i.level !== 'info' && matchIssueWhere(i.where, node.id))
  const found = node.draft ? null : findElement(pkg, node.id)
  const cand = node.draft ? candidates.find((c) => String(c['id']) === node.id) ?? null : null
  const kv = (label: string, value: unknown): ReactNode =>
    h('div', { className: 'ogc-kv' }, h('b', null, label), h('span', null, String(value ?? '—')))
  const rows: ReactNode[] = [
    h('div', { key: 'tags', className: 'ow-row' },
      h(Tag, { text: `${node.layer} · ${node.kind}` }),
      node.draft ? h(Tag, { text: t('queue'), tone: 'warn' }) : null,
      node.forcedReview ? h(Tag, { text: t('forcedReview'), tone: 'warn' }) : null,
      node.issueLevel ? h(Tag, { text: node.issueLevel, tone: node.issueLevel === 'error' ? 'err' : 'warn' }) : null,
      node.runHit ? h(Tag, { text: 'run-hit', tone: 'ok' }) : null,
    ),
    kv(t('name'), node.name),
  ]
  if (node.provenance?.turnId || node.provenance?.sourceId || node.provenance?.runId) {
    rows.push(kv(t('prov'), [node.provenance.turnId, node.provenance.sourceId, node.provenance.runId].filter(Boolean).join(' · ')))
  }
  if (found) {
    const el = found.el
    if (el['idRule']) rows.push(kv(t('idRule'), el['idRule']))
    if (el['from'] !== undefined && el['to'] !== undefined) rows.push(kv(t('from'), `${el['from']} → ${el['to']}`))
    if (el['anchor'] !== undefined) rows.push(kv(t('anchor'), el['anchor']))
    if (el['weight'] !== undefined) rows.push(kv(t('weight'), `${el['weight']}  ${String(el['expression'] ?? '')}`))
    if (el['condition'] !== undefined) rows.push(kv(t('condition'), el['condition']))
    if (el['goal'] !== undefined) rows.push(kv(t('goal'), el['goal']))
    if (el['boundary'] !== undefined) rows.push(kv(t('boundary'), el['boundary']))
    const attrs = el['attributes'] as unknown[] | undefined
    if (Array.isArray(attrs)) rows.push(kv(t('attrCount'), attrs.length))
    const values = el['values'] as unknown[] | undefined
    if (Array.isArray(values)) rows.push(kv(t('dictionaries'), values.join(', ')))
  }
  if (issues.length > 0) {
    rows.push(
      h('div', { key: 'issues' },
        h('b', { className: 'ow-note' }, t('nodeIssues')),
        ...issues.map((i, k) =>
          h('div', { key: k, className: i.level === 'warn' ? 'ogc-issue warn' : 'ogc-issue' },
            h('b', null, `${i.code} @ ${i.where}`), ' ', i.message))),
    )
  }
  if (cand) {
    rows.push(kv(t('confidence'), cand['confidence']))
    if (cand['rationale']) rows.push(kv(t('rationale'), cand['rationale']))
    rows.push(
      h('pre', { key: 'payload', className: 'ow-mono', style: { maxHeight: 140, overflow: 'auto', margin: 0 } },
        JSON.stringify(cand['payload'] ?? {}, null, 2)),
    )
    rows.push(
      h('div', { key: 'act', className: 'ow-row' },
        readOnly
          ? null
          : h('button', {
              className: 'ow-btn',
              disabled: !!busy,
              onClick: () => onDraftAction(node.id, 'approve'),
            }, busy ? t('busy') : t('approveMat')),
        readOnly
          ? null
          : h('button', {
              className: 'ow-btn ghost',
              disabled: !!busy,
              onClick: () => onDraftAction(node.id, 'reject'),
            }, t('reject'))),
    )
  }
  return h('div', { className: 'ogc-insp' }, h('h4', null, node.id), ...rows)
}
