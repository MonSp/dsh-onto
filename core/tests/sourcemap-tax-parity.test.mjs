/**
 * TAX 映射对照（api-to-plugin T1 验收）：同一 mock 行输入下，
 * source-maps DSL 转换与 apps/tax 手写 tax-connector 的语义等价。
 *
 * 期望值按 `apps/tax/src/tax-connector.ts` 的组装规则编码：
 * id 拼装（<tin> / <invoiceCode>:<invoiceNo> / <bankCode>:<flowNo> / <taxpayerTin>:<returnType>:<period>）、
 * FK 关系（开票/受票/申报）、候选过滤（objectRef 命中纳税人 + 特征值过滤 + tags）。
 * 行业基准值连接关系不在 v1 DSL 范围（spec S3），故期望中不含 REL-TAX-BENCHMARK-MATCH。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { transformSourceRows } from '../dist/index.js'

function taxRows() {
  return {
    taxpayers: [
      { tin: '9111T001', name: '甲公司', industryCode: 'C1', registrationDate: '2019-03-01' },
      { tin: '9111T002', name: '乙公司', industryCode: 'C2', registrationDate: '2021-07-15' },
    ],
    invoices: [
      {
        invoiceCode: 'INV',
        invoiceNo: '0001',
        sellerTin: '9111T001',
        buyerTin: '9111T002',
        issueDate: '2026-10-05',
        totalAmount: 100,
      },
    ],
    bankFlows: [
      { bankCode: 'B1', flowNo: 'F001', acctNo: 'A1', occurAt: '2026-10-06', amount: 50 },
    ],
    taxReturns: [
      {
        taxpayerTin: '9111T001',
        returnType: 'VAT',
        period: '2026-09',
        filingDate: '2026-10-10',
        revenue: 10,
      },
    ],
    riskCandidates: [
      {
        candidateId: 'TAX-CAND-001',
        objectRef: '9111T001',
        features: { burden: 0.9, label: 'high', bad: null, nan: Number.NaN },
        tags: ['r1', 7, 'r2'],
      },
      { candidateId: 'TAX-CAND-002', objectRef: 'NO-SUCH', features: {}, tags: [] },
    ],
  }
}

function taxMaps() {
  return [
    {
      id: 'SM-TAX-TAXPAYER',
      collection: 'taxpayers',
      objectType: 'OBJ-TAX-TAXPAYER',
      idTemplate: '<tin>',
      timeField: 'registrationDate',
    },
    {
      id: 'SM-TAX-INVOICE',
      collection: 'invoices',
      objectType: 'OBJ-TAX-INVOICE',
      idTemplate: '<invoiceCode>:<invoiceNo>',
      timeField: 'issueDate',
    },
    {
      id: 'SM-TAX-FLOW',
      collection: 'bankFlows',
      objectType: 'OBJ-TAX-BANK-FLOW',
      idTemplate: '<bankCode>:<flowNo>',
      timeField: 'occurAt',
    },
    {
      id: 'SM-TAX-RETURN',
      collection: 'taxReturns',
      objectType: 'OBJ-TAX-TAX-RETURN',
      idTemplate: '<taxpayerTin>:<returnType>:<period>',
      timeField: 'filingDate',
    },
    {
      id: 'SM-TAX-ISSUES',
      kind: 'relation',
      collection: 'invoices',
      relationType: 'REL-TAX-ISSUES-INVOICE',
      from: { field: 'sellerTin' },
      to: 'self',
      targetCollection: 'taxpayers',
    },
    {
      id: 'SM-TAX-RECEIVES',
      kind: 'relation',
      collection: 'invoices',
      relationType: 'REL-TAX-RECEIVES-INVOICE',
      from: { field: 'buyerTin' },
      to: 'self',
      targetCollection: 'taxpayers',
    },
    {
      id: 'SM-TAX-FILES',
      kind: 'relation',
      collection: 'taxReturns',
      relationType: 'REL-TAX-FILES-RETURN',
      from: { field: 'taxpayerTin' },
      to: 'self',
      targetCollection: 'taxpayers',
    },
    {
      id: 'SM-TAX-CAND',
      kind: 'candidate',
      collection: 'riskCandidates',
      idField: 'candidateId',
      objectRefField: 'objectRef',
      objectType: 'OBJ-TAX-TAXPAYER',
      // tax-api 候选特征在行内嵌套 features 对象下（tax-connector 读 r.features）→ 点路径
      features: {
        burden: 'features.burden',
        label: 'features.label',
        bad: 'features.bad',
        nan: 'features.nan',
      },
      tagsField: 'tags',
    },
  ]
}

test('TAX 对照：对象 id/attrs 与 tax-connector 同构', () => {
  const { dataset } = transformSourceRows({ rows: taxRows(), maps: taxMaps() })
  const byId = new Map(dataset.objects.map((o) => [o.id, o]))
  assert.equal(dataset.objects.length, 5)
  assert.deepEqual(byId.get('9111T001'), {
    id: '9111T001',
    type: 'OBJ-TAX-TAXPAYER',
    attrs: { tin: '9111T001', name: '甲公司', industryCode: 'C1', registrationDate: '2019-03-01' },
  })
  assert.deepEqual(byId.get('INV:0001'), {
    id: 'INV:0001',
    type: 'OBJ-TAX-INVOICE',
    attrs: {
      invoiceCode: 'INV',
      invoiceNo: '0001',
      sellerTin: '9111T001',
      buyerTin: '9111T002',
      issueDate: '2026-10-05',
      totalAmount: 100,
    },
  })
  assert.ok(byId.has('B1:F001'))
  assert.ok(byId.has('9111T001:VAT:2026-09'))
})

test('TAX 对照：FK 关系 id 与方向同 tax-connector', () => {
  const { dataset } = transformSourceRows({ rows: taxRows(), maps: taxMaps() })
  const rels = [...dataset.relations].sort((a, b) => a.id.localeCompare(b.id))
  assert.deepEqual(rels, [
    {
      id: 'R-REL-TAX-FILES-RETURN-9111T001-9111T001:VAT:2026-09',
      type: 'REL-TAX-FILES-RETURN',
      from: '9111T001',
      to: '9111T001:VAT:2026-09',
    },
    {
      id: 'R-REL-TAX-ISSUES-INVOICE-9111T001-INV:0001',
      type: 'REL-TAX-ISSUES-INVOICE',
      from: '9111T001',
      to: 'INV:0001',
    },
    {
      id: 'R-REL-TAX-RECEIVES-INVOICE-9111T002-INV:0001',
      type: 'REL-TAX-RECEIVES-INVOICE',
      from: '9111T002',
      to: 'INV:0001',
    },
  ])
})

test('TAX 对照：候选过滤与特征值口径同 tax-connector', () => {
  const { dataset, diagnostics } = transformSourceRows({ rows: taxRows(), maps: taxMaps() })
  assert.deepEqual(dataset.candidates, [
    {
      candidateId: 'TAX-CAND-001',
      objectRef: '9111T001',
      // null/NaN 特征被剔；数字与非空字符串保留
      features: { burden: 0.9, label: 'high' },
      tags: ['r1', 'r2'], // 非字符串标签被剔
    },
  ])
  assert.ok(diagnostics.some((d) => d.code === 'SM_REF_BROKEN' && d.message.includes('NO-SUCH')))
  assert.deepEqual(dataset.behaviors, [])
  assert.equal(dataset.provenance, 'connector')
})

test('TAX 对照：业务窗 = 各集合 timeField 的记录时间范围', () => {
  const { businessWindow } = transformSourceRows({ rows: taxRows(), maps: taxMaps() })
  assert.equal(businessWindow.from, new Date(Date.parse('2019-03-01')).toISOString())
  assert.equal(businessWindow.to, new Date(Date.parse('2026-10-10')).toISOString())
})
