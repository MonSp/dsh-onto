/** A2UI 子集 surface 契约（spec chat-run-report S2.2）：白名单、绑定红线、配额、默认模板。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LIST_ITEM_FIELDS,
  LIST_NUMERIC_FIELDS,
  SURFACE_CATALOG_ID,
  buildDefaultReportSurface,
  resolveReportSurface,
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
  assert.ok(v.value.root.children.some((c) => c.type === 'Table'))
  assert.ok(v.value.root.children.some((c) => c.type === 'KeyValue'))
  assert.ok(v.value.root.children.some((c) => c.type === 'Badge'))
  assert.ok(v.value.root.children.some((c) => c.type === 'Chart'))
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

test('绑定信封：@path 形态与裸指针等价，数据字面量/残缺信封拒', () => {
  const v1 = validateReportSurface(
    msg(node('s', 'Stat', { label: '分', bind: { '@path': '/summary/maxRiskScore' } })),
  )
  assert.equal(v1.ok, true)

  const v2 = validateReportSurface(msg(node('s', 'Stat', { label: '分', bind: 0.94 })))
  assert.equal(v2.ok, false)
  assert.ok(codes(v2).includes('SF_SLOT_LITERAL'))

  const v3 = validateReportSurface(
    msg(node('s', 'Stat', { label: '分', bind: { '@path': '/summary/maxRiskScore', extra: 1 } })),
  )
  assert.equal(v3.ok, false)

  const v4 = validateReportSurface(
    msg(node('t', 'Table', { rowsBind: { '@path': '/candidates' }, columns: [{ field: 'riskScore', header: 'x' }] })),
  )
  assert.equal(v4.ok, true)

  const v5 = validateReportSurface(
    msg(node('a', 'Accordion', { title: '证据', bind: { '@path': '/candidates/0/evidenceChains' } })),
  )
  assert.equal(v5.ok, true)

  const v6 = validateReportSurface(
    msg(node('x', 'Text', { bind: { '@path': '/summary/maxRiskScore' } })),
  )
  assert.equal(v6.ok, true)
})

test('批次 1：KeyValue / Badge / Callout', () => {
  const kv = msg(
    node('kv', 'KeyValue', { pairs: [{ key: 'runId', bind: '/runRef/runId' }, { key: '状态', bind: { '@path': '/summary/dataStatus' } }] }),
  )
  assert.equal(validateReportSurface(kv).ok, true)

  const kvBad = msg(node('kv', 'KeyValue', { pairs: [{ key: '分', bind: 0.94 }] }))
  const v1 = validateReportSurface(kvBad)
  assert.equal(v1.ok, false)
  assert.ok(codes(v1).includes('SF_SLOT_LITERAL'))

  assert.equal(validateReportSurface(msg(node('b1', 'Badge', { label: 'humanReviewRequired', tone: 'warn' }))).ok, true)
  assert.equal(validateReportSurface(msg(node('b2', 'Badge', { bind: '/summary/dataStatus', tone: 'danger' }))).ok, true)
  assert.equal(validateReportSurface(msg(node('b3', 'Badge', {}))).ok, false)
  const v2 = validateReportSurface(msg(node('b4', 'Badge', { bind: true })))
  assert.equal(v2.ok, false)
  assert.ok(codes(v2).includes('SF_SLOT_LITERAL'))
  assert.equal(validateReportSurface(msg(node('b5', 'Badge', { label: 'x', tone: 'neon' }))).ok, false)

  assert.equal(validateReportSurface(msg(node('c1', 'Callout', { tone: 'warning', title: '注意', content: '数据不完整' }))).ok, true)
  assert.equal(validateReportSurface(msg(node('c2', 'Callout', { content: 'x', bind: '/summary/dataStatus' }))).ok, false)
  assert.equal(validateReportSurface(msg(node('c3', 'Callout', {}))).ok, false)
  assert.equal(validateReportSurface(msg(node('c4', 'Callout', { content: 'x', tone: 'neon' }))).ok, false)
})

test('批次 1：Progress / Timeline / Tabs', () => {
  const p1 = msg(node('p', 'Progress', { label: '风险水位', bind: '/summary/maxRiskScore', max: 1, display: 'ring' }))
  assert.equal(validateReportSurface(p1).ok, true)
  const p2 = validateReportSurface(msg(node('p', 'Progress', { label: 'x', value: 50, bind: '/summary/maxRiskScore' })))
  assert.equal(p2.ok, false)
  assert.ok(codes(p2).includes('SF_SLOT_LITERAL'))
  assert.equal(validateReportSurface(msg(node('p', 'Progress', { bind: '/summary/maxRiskScore', max: -1 }))).ok, false)

  const t1 = msg(
    node('tl', 'Timeline', {
      title: '打分流水',
      bind: '/ruleHitLog',
      titleField: 'ruleId',
      descField: 'candidateId',
      timeField: 'ts',
    }),
  )
  assert.equal(validateReportSurface(t1).ok, true)
  const t2 = validateReportSurface(
    msg(node('tl', 'Timeline', { bind: '/ruleHitLog', titleField: 'nope' })),
  )
  assert.equal(t2.ok, false)
  assert.ok(codes(t2).includes('SF_FIELD_INVALID'))
  const t3 = validateReportSurface(msg(node('tl', 'Timeline', { bind: '/summary/maxRiskScore' })))
  assert.equal(t3.ok, false)
  assert.ok(codes(t3).includes('SF_BIND_INVALID'))
  // 纯字符串列表不接受字段映射
  const t4 = validateReportSurface(
    msg(node('tl', 'Timeline', { bind: '/candidates/0/narrative', titleField: 'ruleId' })),
  )
  assert.equal(t4.ok, false)
  assert.ok(codes(t4).includes('SF_FIELD_INVALID'))

  const tabs = msg(
    node('tb', 'Tabs', {
      tabs: [
        { label: '候选', items: [node('t1', 'Text', { text: 'a' })] },
        { label: '审计', items: [] },
      ],
    }),
  )
  assert.equal(validateReportSurface(tabs).ok, true)
  const tabsBad = msg(node('tb', 'Tabs', { tabs: [{ label: 'x', items: [node('z', 'Nope')] }] }))
  const v5 = validateReportSurface(tabsBad)
  assert.equal(v5.ok, false)
  assert.ok(codes(v5).includes('SF_TYPE_UNKNOWN'))
  const many = { tabs: [] }
  for (let i = 0; i < 11; i++) many.tabs.push({ label: `t${i}`, items: [] })
  const v6 = validateReportSurface(msg(node('tb', 'Tabs', many)))
  assert.equal(v6.ok, false)

  // 字面量绑定红线对 Callout/Timeline 同样成立
  const v7 = validateReportSurface(msg(node('c', 'Callout', { bind: 0.94 })))
  assert.equal(v7.ok, false)
  assert.ok(codes(v7).includes('SF_SLOT_LITERAL'))
  const v8 = validateReportSurface(msg(node('tl', 'Timeline', { bind: 42 })))
  assert.equal(v8.ok, false)
  assert.ok(codes(v8).includes('SF_SLOT_LITERAL'))

  // pairs / tabs 配额
  const manyPairs = []
  for (let i = 0; i < 21; i++) manyPairs.push({ key: `k${i}`, bind: '/runRef/runId' })
  const v9 = validateReportSurface(msg(node('kv', 'KeyValue', { pairs: manyPairs })))
  assert.equal(v9.ok, false)

  // Tabs 嵌套吃同一深度配额
  let nested = node('leaf', 'Text', { text: 'x' })
  for (let i = 0; i < 8; i++) {
    nested = node(`tb${i}`, 'Tabs', { tabs: [{ label: 'x', items: [nested] }] })
  }
  const v10 = validateReportSurface(msg(nested))
  assert.equal(v10.ok, false)
  assert.ok(codes(v10).includes('SF_DEPTH_EXCEEDED'))
})

test('批次 2：Chart 序列绑定（数据数组字面量拒、字段白名单）', () => {
  const ok = msg(
    node('ch', 'Chart', {
      kind: 'bars',
      title: '风险分布',
      rowsBind: '/candidates',
      labelField: 'candidateId',
      valueField: 'riskScore',
      horizontal: true,
      height: 200,
    }),
  )
  assert.equal(validateReportSurface(ok).ok, true)

  for (const kind of ['line', 'donut']) {
    const v = validateReportSurface(
      msg(node('ch', 'Chart', { kind, rowsBind: '/ruleHitLog', labelField: 'ruleId', valueField: 'score' })),
    )
    assert.equal(v.ok, true, kind)
  }

  // 字面量数据数组整体拒（红线）
  const lit = msg(
    node('ch', 'Chart', {
      kind: 'bars',
      rowsBind: '/candidates',
      labelField: 'candidateId',
      valueField: 'riskScore',
      data: [{ label: 'x', value: 1 }],
    }),
  )
  const v1 = validateReportSurface(lit)
  assert.equal(v1.ok, false)
  assert.ok(codes(v1).includes('SF_SLOT_LITERAL'))

  // valueField 非数值字段拒
  const v2 = validateReportSurface(
    msg(node('ch', 'Chart', { kind: 'bars', rowsBind: '/candidates', labelField: 'candidateId', valueField: 'objectRef' })),
  )
  assert.equal(v2.ok, false)
  assert.ok(codes(v2).includes('SF_FIELD_INVALID'))

  // labelField 非该列表字段拒
  const v3 = validateReportSurface(
    msg(node('ch', 'Chart', { kind: 'bars', rowsBind: '/ruleHitLog', labelField: 'nope', valueField: 'score' })),
  )
  assert.equal(v3.ok, false)
  assert.ok(codes(v3).includes('SF_FIELD_INVALID'))

  // rowsBind 非列表拒
  const v4 = validateReportSurface(
    msg(node('ch', 'Chart', { kind: 'bars', rowsBind: '/summary/maxRiskScore', labelField: 'ruleId', valueField: 'score' })),
  )
  assert.equal(v4.ok, false)
  assert.ok(codes(v4).includes('SF_BIND_INVALID'))

  // horizontal 仅 bars；height 边界
  const v5 = validateReportSurface(
    msg(node('ch', 'Chart', { kind: 'donut', rowsBind: '/candidates', labelField: 'candidateId', valueField: 'riskScore', horizontal: true })),
  )
  assert.equal(v5.ok, false)
  assert.equal(
    validateReportSurface(
      msg(node('ch', 'Chart', { kind: 'bars', rowsBind: '/candidates', labelField: 'candidateId', valueField: 'riskScore', height: 50 })),
    ).ok,
    false,
  )

  // 无数值字段的列表做图拒
  const v6 = validateReportSurface(
    msg(node('ch', 'Chart', { kind: 'bars', rowsBind: '/candidates/0/pendingChecks', labelField: 'note', valueField: 'score' })),
  )
  assert.equal(v6.ok, false)
  assert.ok(codes(v6).includes('SF_FIELD_INVALID'))
})

test('字段表不变量：LIST_NUMERIC_FIELDS 恒为 LIST_ITEM_FIELDS 子集（防两表漂移）', () => {
  for (const [ref, numeric] of Object.entries(LIST_NUMERIC_FIELDS)) {
    const items = LIST_ITEM_FIELDS[ref]
    assert.ok(items, `LIST_ITEM_FIELDS 缺 ${ref}`)
    for (const f of numeric) {
      assert.ok(items.includes(f), `${ref}.${f} 须同时在 LIST_ITEM_FIELDS`)
    }
  }
})

test('批次 3：when 谓词槽（全组件通用）', () => {
  const ok = msg(
    node('c', 'Callout', {
      content: '数据不完整',
      tone: 'warning',
      when: { bind: '/summary/dataStatus', op: 'eq', value: 'insufficient' },
    }),
  )
  assert.equal(validateReportSurface(ok).ok, true)

  const okEnvelope = msg(
    node('b', 'Badge', {
      label: 'x',
      when: { bind: { '@path': '/summary/auditPassed' }, op: 'eq', value: false },
    }),
  )
  assert.equal(validateReportSurface(okEnvelope).ok, true)

  const v1 = validateReportSurface(
    msg(node('c', 'Callout', { content: 'x', when: { bind: 42, op: 'eq', value: 1 } })),
  )
  assert.equal(v1.ok, false)
  assert.ok(codes(v1).includes('SF_SLOT_LITERAL'))

  const v2 = validateReportSurface(
    msg(node('c', 'Callout', { content: 'x', when: { bind: '/summary/dataStatus', op: 'explode', value: 1 } })),
  )
  assert.equal(v2.ok, false)

  const v3 = validateReportSurface(
    msg(node('c', 'Callout', { content: 'x', when: { bind: '/summary/dataStatus', op: 'in', value: 'x' } })),
  )
  assert.equal(v3.ok, false)

  const v4 = validateReportSurface(
    msg(node('c', 'Callout', { content: 'x', when: { bind: '/summary/dataStatus', op: 'gt' } })),
  )
  assert.equal(v4.ok, false)

  // empty/not-empty 不接受多余 value
  const v5 = validateReportSurface(
    msg(node('c', 'Callout', { content: 'x', when: { bind: '/summary/dataStatus', op: 'empty', value: 1 } })),
  )
  assert.equal(v5.ok, false)

  // 嵌套对象（pair/column/spark/tab）不接受 when——防静默无效
  const v6 = validateReportSurface(
    msg(node('kv', 'KeyValue', { pairs: [{ key: 'x', bind: '/runRef/runId', when: { bind: '/summary/dataStatus', op: 'empty' } }] })),
  )
  assert.equal(v6.ok, false)
  assert.ok(codes(v6).includes('SF_PROPS_UNKNOWN'))

  // empty/not-empty 放行列表指针（数组空/非空语义）；比较族仍限元素字段
  const okList = msg(
    node('c', 'Callout', {
      content: '有缺失项',
      when: { bind: '/candidates/0/pendingChecks/0/missing', op: 'not-empty' },
    }),
  )
  assert.equal(validateReportSurface(okList).ok, true)
  const okList2 = msg(
    node('c', 'Callout', {
      content: '无命中',
      when: { bind: '/candidates/0/hitRuleIds', op: 'empty' },
    }),
  )
  assert.equal(validateReportSurface(okList2).ok, true)
  const v7 = validateReportSurface(
    msg(
      node('c', 'Callout', {
        content: 'x',
        when: { bind: '/candidates/0/pendingChecks/0/missing', op: 'eq', value: 'fillLevel' },
      }),
    ),
  )
  assert.equal(v7.ok, false)
  assert.ok(codes(v7).includes('SF_BIND_INVALID'))
})

test('批次 3：Table 列类型 / Stat.spark / Chart.palette', () => {
  const tbl = msg(
    node('t', 'Table', {
      rowsBind: '/candidates',
      columns: [
        { field: 'riskScore', header: '分', type: 'bar' },
        { field: 'riskLevel', header: '级', type: 'badge' },
        { field: 'candidateId', header: 'ID', type: 'delta' },
        { field: 'objectRef', header: '对象', type: 'num' },
      ],
    }),
  )
  assert.equal(validateReportSurface(tbl).ok, true)

  const v1 = validateReportSurface(
    msg(node('t', 'Table', { rowsBind: '/candidates', columns: [{ field: 'riskScore', header: 'x', type: 'sparkline' }] })),
  )
  assert.equal(v1.ok, false)

  const spark = msg(
    node('s', 'Stat', {
      label: '最高风险',
      bind: '/summary/maxRiskScore',
      spark: { rowsBind: '/ruleHitLog', valueField: 'score' },
    }),
  )
  assert.equal(validateReportSurface(spark).ok, true)

  const v2 = validateReportSurface(
    msg(node('s', 'Stat', { label: 'x', bind: '/summary/maxRiskScore', spark: { rowsBind: '/ruleHitLog', valueField: 'ruleId' } })),
  )
  assert.equal(v2.ok, false)
  assert.ok(codes(v2).includes('SF_FIELD_INVALID'))

  const pal = msg(
    node('ch', 'Chart', {
      kind: 'donut',
      rowsBind: '/candidates',
      labelField: 'candidateId',
      valueField: 'riskScore',
      palette: ['#f00', '#0f0'],
    }),
  )
  assert.equal(validateReportSurface(pal).ok, true)

  const v3 = validateReportSurface(
    msg(node('ch', 'Chart', {
      kind: 'donut',
      rowsBind: '/candidates',
      labelField: 'candidateId',
      valueField: 'riskScore',
      palette: ['red'],
    })),
  )
  assert.equal(v3.ok, false)

  const v4 = validateReportSurface(
    msg(node('ch', 'Chart', {
      kind: 'donut',
      rowsBind: '/candidates',
      labelField: 'candidateId',
      valueField: 'riskScore',
      palette: ['#fff', '#fff', '#fff', '#fff', '#fff', '#fff', '#fff', '#fff', '#fff'],
    })),
  )
  assert.equal(v4.ok, false)
})

test('批次 4：Chart 分组/堆叠/多系列槽位', () => {
  const grouped = msg(
    node('ch', 'Chart', {
      kind: 'bars',
      mode: 'grouped',
      rowsBind: '/candidates',
      labelField: 'candidateId',
      valueFields: ['riskScore', 'hitRuleCount'],
    }),
  )
  assert.equal(validateReportSurface(grouped).ok, true)

  const stacked = msg(
    node('ch', 'Chart', {
      kind: 'bars',
      mode: 'stacked',
      rowsBind: '/candidates',
      labelField: 'candidateId',
      stackFrom: { listField: 'evidenceChains', labelField: 'ruleId', valueField: 'score' },
    }),
  )
  assert.equal(validateReportSurface(stacked).ok, true)

  const multiLine = msg(
    node('ch', 'Chart', {
      kind: 'line',
      rowsBind: '/ruleHitLog',
      labelField: 'ts',
      valueField: 'score',
      seriesField: 'candidateId',
    }),
  )
  assert.equal(validateReportSurface(multiLine).ok, true)

  // grouped 须 2–4 个数值字段且不接受 valueField
  const v1 = validateReportSurface(
    msg(node('ch', 'Chart', { kind: 'bars', mode: 'grouped', rowsBind: '/candidates', labelField: 'candidateId', valueFields: ['riskScore'] })),
  )
  assert.equal(v1.ok, false)
  const v2 = validateReportSurface(
    msg(node('ch', 'Chart', { kind: 'bars', mode: 'grouped', rowsBind: '/candidates', labelField: 'candidateId', valueField: 'riskScore', valueFields: ['riskScore', 'hitRuleCount'] })),
  )
  assert.equal(v2.ok, false)

  // stacked 的嵌套字段闸
  const v3 = validateReportSurface(
    msg(node('ch', 'Chart', {
      kind: 'bars',
      mode: 'stacked',
      rowsBind: '/candidates',
      labelField: 'candidateId',
      stackFrom: { listField: 'narrative', labelField: 'ruleId', valueField: 'score' },
    })),
  )
  assert.equal(v3.ok, false)

  // seriesField 仅 line；字段须元素字段
  const v5 = validateReportSurface(
    msg(node('ch', 'Chart', { kind: 'bars', rowsBind: '/candidates', labelField: 'candidateId', valueField: 'riskScore', seriesField: 'candidateId' })),
  )
  assert.equal(v5.ok, false)
  const v6 = validateReportSurface(
    msg(node('ch', 'Chart', { kind: 'line', rowsBind: '/ruleHitLog', labelField: 'ts', valueField: 'score', seriesField: 'nope' })),
  )
  assert.equal(v6.ok, false)

  // mode 仅 bars
  const v7 = validateReportSurface(
    msg(node('ch', 'Chart', { kind: 'line', mode: 'grouped', rowsBind: '/candidates', labelField: 'candidateId', valueFields: ['riskScore', 'hitRuleCount'] })),
  )
  assert.equal(v7.ok, false)
})

test('批次 4：Input/Select / when.field / Table.filterBy', () => {
  const ok = msg(
    node('r', 'Row', undefined, [
      node('q', 'Input', { id: 'q', label: '筛选', placeholder: '候选 id' }),
      node('v', 'Select', { id: 'view', options: ['全部', '高风险'], value: '全部' }),
      node('t', 'Table', {
        rowsBind: '/candidates',
        filterBy: 'q',
        columns: [{ field: 'candidateId', header: 'ID' }],
        when: { field: 'view', op: 'eq', value: '高风险' },
      }),
    ]),
  )
  assert.equal(validateReportSurface(ok).ok, true)

  // when 双源互斥
  const v1 = validateReportSurface(
    msg(node('c', 'Callout', { content: 'x', when: { bind: '/summary/dataStatus', field: 'q', op: 'empty' } })),
  )
  assert.equal(v1.ok, false)
  const v2 = validateReportSurface(msg(node('c', 'Callout', { content: 'x', when: { op: 'empty' } })))
  assert.equal(v2.ok, false)

  // 交互 id 查重
  const v3 = validateReportSurface(
    msg(node('r', 'Row', undefined, [
      node('a', 'Input', { id: 'dup' }),
      node('b', 'Select', { id: 'dup', options: ['x', 'y'] }),
    ])),
  )
  assert.equal(v3.ok, false)
  assert.ok(codes(v3).includes('SF_ID_DUP'))

  // select options 形态
  const v4 = validateReportSurface(msg(node('s', 'Select', { id: 's', options: ['only-one'] })))
  assert.equal(v4.ok, false)
  const v5 = validateReportSurface(msg(node('s', 'Select', { id: 's', options: ['a', 'b'], value: 'c' })))
  assert.equal(v5.ok, false)

  // filterBy 形态
  const v6 = validateReportSurface(
    msg(node('t', 'Table', { rowsBind: '/candidates', filterBy: 42, columns: [{ field: 'candidateId', header: 'x' }] })),
  )
  assert.equal(v6.ok, false)

  // 保留 id（原型链读取面）拒
  for (const bad of ['__proto__', 'constructor', 'prototype']) {
    const v = validateReportSurface(msg(node('i', 'Input', { id: bad })))
    assert.equal(v.ok, false, bad)
    const w = validateReportSurface(msg(node('c', 'Callout', { content: 'x', when: { field: bad, op: 'empty' } })))
    assert.equal(w.ok, false, `when.field ${bad}`)
  }

  // valueFields 重复拒
  const v7 = validateReportSurface(
    msg(node('ch', 'Chart', {
      kind: 'bars',
      mode: 'grouped',
      rowsBind: '/candidates',
      labelField: 'candidateId',
      valueFields: ['riskScore', 'riskScore'],
    })),
  )
  assert.equal(v7.ok, false)
})

test('批次 5：Compare 组件与 Table export', () => {
  const ok = msg(node('cmp', 'Compare', { title: 'A/B 对比' }))
  assert.equal(validateReportSurface(ok).ok, true)
  assert.equal(validateReportSurface(msg(node('cmp', 'Compare', {}))).ok, true)

  // Compare 固定布局：不接受 bind 等数据槽
  const v1 = validateReportSurface(msg(node('cmp', 'Compare', { bind: '/diff' })))
  assert.equal(v1.ok, false)
  assert.ok(codes(v1).includes('SF_PROPS_UNKNOWN'))

  const v2 = validateReportSurface(
    msg(node('t', 'Table', { rowsBind: '/candidates', export: true, columns: [{ field: 'candidateId', header: 'ID' }] })),
  )
  assert.equal(v2.ok, true)

  const v3 = validateReportSurface(
    msg(node('t', 'Table', { rowsBind: '/candidates', export: 'yes', columns: [{ field: 'candidateId', header: 'ID' }] })),
  )
  assert.equal(v3.ok, false)
})

test('resolveReportSurface 四级回退（issue #33 缺口5）：model → package → workspace → default', () => {
  // 显式 model 短路
  const explicit = buildDefaultReportSurface({ surfaceId: 's-model' })
  const r1 = resolveReportSurface({
    explicit,
    packageSurface: buildDefaultReportSurface({ surfaceId: 's-pkg' }),
  })
  assert.equal(r1.source, 'model')
  assert.equal(r1.surface.surfaceId, 's-model')
  assert.deepEqual(r1.fallbackNotes, [])

  // 随包契约命中
  const r2 = resolveReportSurface({ packageSurface: buildDefaultReportSurface({ surfaceId: 's-pkg' }) })
  assert.equal(r2.source, 'package')
  assert.equal(r2.surface.surfaceId, 's-pkg')

  // 随包非法 → 工作区降级 + 回退留痕
  const bad = buildDefaultReportSurface({ surfaceId: 's-bad' })
  bad.root = { id: 'cheat', type: 'Stat', props: { label: 'x', value: 0.01 } }
  const r3 = resolveReportSurface({
    packageSurface: bad,
    workspaceSurface: buildDefaultReportSurface({ surfaceId: 's-ws' }),
  })
  assert.equal(r3.source, 'workspace')
  assert.equal(r3.surface.surfaceId, 's-ws')
  assert.equal(r3.fallbackNotes.length, 1)
  assert.ok(r3.fallbackNotes[0].includes('随包'))

  // 全缺/全非法 → 默认模板，notes 显式
  const r4 = resolveReportSurface({})
  assert.equal(r4.source, 'default')
  assert.equal(r4.surface.surfaceId, 'run-report-default')
  assert.ok(r4.fallbackNotes.length >= 1)
  const r5 = resolveReportSurface({ packageSurface: bad, workspaceSurface: bad })
  assert.equal(r5.source, 'default')
  assert.equal(r5.fallbackNotes.length, 2)
})
