/** A2UI 子集 surface 契约（spec chat-run-report S2.2）：白名单、绑定红线、配额、默认模板。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SURFACE_CATALOG_ID,
  buildDefaultReportSurface,
  validateReportSurface,
} from '../dist/index.js'

function node(id, type, props, children) {
  const n = { id, type }
  if (props !== undefined) n.props = props
  if (children !== undefined) n.children = children
  return n
}

function msg(root, over = {}) {
  return {
    version: '1.0',
    type: 'createSurface',
    surfaceId: 's1',
    catalogId: SURFACE_CATALOG_ID,
    root,
    ...over,
  }
}

function codes(v) {
  return v.errors.map((e) => e.code)
}

test('默认模板 surface 通过校验', () => {
  const v = validateReportSurface(buildDefaultReportSurface())
  assert.equal(v.ok, true)
  assert.equal(v.value.catalogId, SURFACE_CATALOG_ID)
  assert.equal(v.value.root.children[1].type, 'Table')
})

test('信封与 id：版本/目录/类型/重复 id', () => {
  const bad = msg(node('a', 'Row'))
  bad.version = '0.9'
  const v1 = validateReportSurface(bad)
  assert.equal(v1.ok, false)
  assert.ok(codes(v1).includes('SF_SHAPE'))

  const v2 = validateReportSurface({ ...msg(node('a', 'Row')), catalogId: 'x/y' })
  assert.equal(v2.ok, false)

  const v3 = validateReportSurface(
    msg(node('a', 'Row', undefined, [node('a', 'Text', { text: 'x' })])),
  )
  assert.equal(v3.ok, false)
  assert.ok(codes(v3).includes('SF_ID_DUP'))

  const v4 = validateReportSurface(msg(node('a', 'Nope')))
  assert.equal(v4.ok, false)
  assert.ok(codes(v4).includes('SF_TYPE_UNKNOWN'))
})

test('数据槽位红线：Stat/Text 绑定，拒绝字面量', () => {
  const v1 = validateReportSurface(
    msg(node('s', 'Stat', { label: '分', value: 0.94 })),
  )
  assert.equal(v1.ok, false)
  assert.ok(codes(v1).includes('SF_SLOT_LITERAL'))

  const v2 = validateReportSurface(
    msg(node('s', 'Stat', { label: '分', bind: '/summary/maxRiskScore' })),
  )
  assert.equal(v2.ok, true)

  const v3 = validateReportSurface(
    msg(node('t', 'Text', { text: '0.94', bind: '/summary/maxRiskScore' })),
  )
  assert.equal(v3.ok, false)

  const v4 = validateReportSurface(msg(node('t', 'Text', {})))
  assert.equal(v4.ok, false)

  const v5 = validateReportSurface(
    msg(node('s', 'Stat', { label: '分', bind: '/candidates/0/secret' })),
  )
  assert.equal(v5.ok, false)
  assert.ok(codes(v5).includes('SF_BIND_INVALID'))
})

test('Table：rowsBind/列字段/排序/过滤/展开全部走候选行字段', () => {
  const okTable = msg(
    node('tbl', 'Table', {
      rowsBind: '/candidates',
      columns: [{ field: 'riskScore', header: '风险分', align: 'right' }],
      expandField: 'evidenceChains',
      sort: { field: 'riskScore', dir: 'desc' },
      filter: { field: 'pendingVerification', op: 'eq', value: true },
    }),
  )
  // filter.value 只收字符串/数字——布尔值拒
  const v0 = validateReportSurface(okTable)
  assert.equal(v0.ok, false)
  assert.ok(codes(v0).includes('SF_FILTER_INVALID'))

  okTable.root.props.filter = { field: 'candidateId', op: 'contains', value: 'ALERT' }
  assert.equal(validateReportSurface(okTable).ok, true)

  const v1 = validateReportSurface(
    msg(node('tbl', 'Table', { rowsBind: '/excluded', columns: [{ field: 'candidateId', header: 'x' }] })),
  )
  assert.equal(v1.ok, false)
  assert.ok(codes(v1).includes('SF_BIND_INVALID'))

  const v2 = validateReportSurface(
    msg(node('tbl', 'Table', { rowsBind: '/candidates', columns: [{ field: 'evidence', header: 'x' }] })),
  )
  assert.equal(v2.ok, false)
  assert.ok(codes(v2).includes('SF_FIELD_INVALID'))

  const v3 = validateReportSurface(
    msg(node('tbl', 'Table', { rowsBind: '/candidates', columns: [{ field: 'riskScore', header: 'x' }], sort: { field: 'score', dir: 'up' } })),
  )
  assert.equal(v3.ok, false)
  assert.ok(codes(v3).includes('SF_SORT_INVALID'))
})

test('Accordion/Button/children 约束', () => {
  const v1 = validateReportSurface(
    msg(node('ac', 'Accordion', { title: '证据', bind: '/candidates/0/evidenceChains' })),
  )
  assert.equal(v1.ok, true)

  const v2 = validateReportSurface(msg(node('ac', 'Accordion', { title: '证据', bind: '/candidates' })))
  assert.equal(v2.ok, false)
  assert.ok(codes(v2).includes('SF_BIND_INVALID'))

  const v3 = validateReportSurface(
    msg(node('b', 'Button', { label: '去结果页', action: 'navigate', target: 'result-page' })),
  )
  assert.equal(v3.ok, true)

  const v4 = validateReportSurface(
    msg(node('b', 'Button', { label: 'x', action: 'event', target: 'agent' })),
  )
  assert.equal(v4.ok, false)
  assert.ok(codes(v4).includes('SF_ACTION_INVALID'))

  const v5 = validateReportSurface(
    msg(node('tbl', 'Table', { rowsBind: '/candidates', columns: [{ field: 'riskScore', header: 'x' }] }, [node('c', 'Text', { text: 'x' })])),
  )
  assert.equal(v5.ok, false)
  assert.ok(codes(v5).includes('SF_CHILDREN_FORBIDDEN'))
})

test('配额：节点数与深度', () => {
  let root = node('leaf', 'Text', { text: 'x' })
  for (let i = 0; i < 10; i++) root = node(`n${i}`, 'Column', undefined, [root])
  const v1 = validateReportSurface(msg(root))
  assert.equal(v1.ok, false)
  assert.ok(codes(v1).includes('SF_DEPTH_EXCEEDED'))

  const many = []
  for (let i = 0; i < 210; i++) many.push(node(`t${i}`, 'Text', { text: 'x' }))
  const v2 = validateReportSurface(msg(node('r', 'Row', undefined, many)))
  assert.equal(v2.ok, false)
  assert.ok(codes(v2).includes('SF_NODE_LIMIT'))
})

test('未知属性拒绝', () => {
  const v = validateReportSurface(
    msg(node('s', 'Stat', { label: 'x', bind: '/summary/maxRiskScore', html: '<b>' })),
  )
  assert.equal(v.ok, false)
  assert.ok(codes(v).includes('SF_PROPS_UNKNOWN'))
})
