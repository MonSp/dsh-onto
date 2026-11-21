/** 源映射转换与预览验收（api-to-plugin S2.1）：纯转换 / 诊断 / 静态闭合 / 证据就绪度。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import {
  transformSourceRows,
  previewSourceMaps,
  checkSourceMapsStatic,
  renderIdTemplate,
  parseIdTemplate,
  listSourceFiles,
  loadPackage,
  savePackage,
} from '../dist/index.js'
import { minimalPkg, mkWorkspaceWithPkg, rmWorkspace } from './helpers.mjs'

/** wst 形态：单端点多集合 + 嵌套事件 + 数组 FK。 */
function wstRows() {
  return {
    bins: [
      {
        binId: 'BIN-01',
        binNo: 'B01',
        zone: 'canteen',
        fillLevel: 0.92,
        lastEmptiedAt: '2026-11-11T10:00:00+08:00',
        mixEvents: [{ at: '2026-11-12T11:20:00+08:00', kind: 'hazardous-mix' }],
      },
      {
        binId: 'BIN-02',
        binNo: 'B02',
        zone: 'dorm',
        fillLevel: 0.35,
        lastEmptiedAt: '2026-11-12T14:00:00+08:00',
        mixEvents: [],
      },
    ],
    routes: [{ routeId: 'ROUTE-1', routeNo: 'R01', covers: ['BIN-01', 'BIN-02', 'BIN-GONE'] }],
    alerts: [
      { alertId: 'ALERT-1', binId: 'BIN-01', features: { fillRatio: 0.92 }, tags: ['urgent'] },
      { alertId: 'ALERT-2', binId: 'BIN-X9', features: { fillRatio: 0.1 }, tags: [] },
    ],
    dumps: [{ binId: 'BIN-01', at: '2026-11-11T08:00:00+08:00' }],
  }
}

function wstMaps() {
  return [
    {
      id: 'SM-WST-BIN',
      collection: 'bins',
      objectType: 'OBJ-WST-BIN',
      idTemplate: '<binId>',
      timeField: 'lastEmptiedAt',
    },
    {
      id: 'SM-WST-ROUTE',
      collection: 'routes',
      objectType: 'OBJ-WST-ROUTE',
      idTemplate: '<routeId>',
    },
    {
      id: 'SM-WST-COVERS',
      kind: 'relation',
      collection: 'routes',
      relationType: 'REL-WST-COVERS',
      from: 'self',
      to: { field: 'covers' },
      targetCollection: 'bins',
    },
    {
      id: 'SM-WST-ALERT',
      kind: 'candidate',
      collection: 'alerts',
      idField: 'alertId',
      objectRefField: 'binId',
      objectType: 'OBJ-WST-BIN',
      features: { fillRatio: 'features.fillRatio' },
      tagsField: 'tags',
    },
    {
      id: 'SM-WST-MIX',
      kind: 'behavior-list',
      collection: 'bins',
      behaviorType: 'BHV-WST-MIX',
      objectRefTemplate: '<binId>',
      eventsPath: 'mixEvents',
      timeField: 'at',
    },
    {
      id: 'SM-WST-DUMP',
      kind: 'behavior',
      collection: 'dumps',
      behaviorType: 'BHV-WST-DUMP',
      objectRefTemplate: '<binId>',
      timeField: 'at',
    },
  ]
}

test('idTemplate：解析与渲染（空段/缺字段 → null）', () => {
  assert.equal(renderIdTemplate('<tin>', { tin: '9111' }), '9111')
  assert.equal(renderIdTemplate('<invoiceCode>:<invoiceNo>', { invoiceCode: 'A', invoiceNo: '1' }), 'A:1')
  assert.equal(renderIdTemplate('<a>:<b>', { a: 'x' }), null)
  assert.equal(renderIdTemplate('<a>', { a: '' }), null)
  assert.equal(parseIdTemplate('<a>:<b>').length, 3)
})

test('转换：对象/关系/候选/行为 + 数组 FK 逐条展开', () => {
  const { dataset, diagnostics } = transformSourceRows({ rows: wstRows(), maps: wstMaps() })
  assert.equal(dataset.objects.length, 3) // 2 bin + 1 route
  assert.deepEqual(
    dataset.objects.map((o) => o.id).sort(),
    ['BIN-01', 'BIN-02', 'ROUTE-1'],
  )
  // covers 数组 FK：BIN-GONE 断引用（数组里的第三条），两条闭合
  const rels = dataset.relations.filter((r) => r.type === 'REL-WST-COVERS')
  assert.equal(rels.length, 2)
  assert.ok(diagnostics.some((d) => d.code === 'SM_REF_BROKEN' && d.message.includes('BIN-GONE')))
  // 候选：ALERT-2 断引用被剔；ALERT-1 保留
  assert.equal(dataset.candidates.length, 1)
  assert.equal(dataset.candidates[0].candidateId, 'ALERT-1')
  assert.equal(dataset.candidates[0].features.fillRatio, 0.92)
  assert.deepEqual(dataset.candidates[0].tags, ['urgent'])
  // 行为：mixEvents 嵌套 1 条 + dumps 1 条
  const behs = dataset.behaviors ?? []
  assert.equal(behs.length, 2)
  assert.ok(behs.every((b) => b.objectRef === 'BIN-01'))
  assert.ok(diagnostics.some((d) => d.code === 'SM_REF_BROKEN' && d.message.includes('BIN-X9')))
})

test('转换：对端集合未取数 → SM_REF_PENDING 而非断引用', () => {
  const rows = { routes: [{ routeId: 'ROUTE-1', covers: ['BIN-01'] }] } // bins 未取
  const maps = wstMaps().filter((m) => m.collection === 'routes' || m.kind === 'relation')
  const { dataset, diagnostics } = transformSourceRows({ rows, maps })
  assert.equal(dataset.relations.length, 0)
  assert.ok(diagnostics.some((d) => d.code === 'SM_REF_PENDING'))
  assert.ok(!diagnostics.some((d) => d.code === 'SM_REF_BROKEN'))
})

test('转换：时间窗过滤与业务窗（窗外对象剔除、维表保留）', () => {
  const rows = wstRows()
  const { dataset, businessWindow } = transformSourceRows({
    rows,
    maps: wstMaps(),
    timeWindow: { from: '2026-11-12T00:00:00Z', to: '2026-11-13T00:00:00Z' },
  })
  // BIN-01 lastEmptiedAt=11-11 窗外剔除；BIN-02=11-12 保留；ROUTE-1 无时间字段保留
  const ids = dataset.objects.map((o) => o.id)
  assert.ok(!ids.includes('BIN-01'))
  assert.ok(ids.includes('BIN-02'))
  assert.ok(ids.includes('ROUTE-1'))
  // 归属 BIN-01 的候选/行为随窗剔除；covers 里仅 ROUTE-1→BIN-02 两端存活
  assert.equal(dataset.candidates.length, 0)
  assert.equal((dataset.behaviors ?? []).length, 0)
  assert.equal(dataset.relations.length, 1)
  assert.equal(dataset.relations[0].to, 'BIN-02')
  assert.equal(businessWindow.from, new Date(Date.parse('2026-11-12T14:00:00+08:00')).toISOString())
})

test('转换：id 重复保留首条 + SM_ID_CONFLICT；空 id → SM_ID_EMPTY', () => {
  const rows = {
    bins: [
      { binId: 'BIN-01', fillLevel: 1 },
      { binId: 'BIN-01', fillLevel: 2 },
      { binNo: 'no-id' },
    ],
  }
  const maps = wstMaps().filter((m) => m.kind === undefined || m.kind === 'object')
  const { dataset, diagnostics } = transformSourceRows({ rows, maps })
  assert.equal(dataset.objects.length, 1)
  assert.equal(dataset.objects[0].attrs.fillLevel, 1)
  assert.ok(diagnostics.some((d) => d.code === 'SM_ID_CONFLICT'))
  assert.ok(diagnostics.some((d) => d.code === 'SM_ID_EMPTY'))
})

test('静态闭合：objectType/属性/idRule 不符 → SM_* error', () => {
  const pkg = minimalPkg()
  pkg.sourceMaps = [
    {
      id: 'SM-TST-1',
      collection: 'rows',
      objectType: 'OBJ-TST-A',
      idTemplate: '<x>',
      fields: [{ source: 'x', target: 'a1' }, { source: 'y', target: 'nope' }],
    },
  ]
  const issues = checkSourceMapsStatic(pkg)
  assert.ok(issues.some((i) => i.code === 'SM_FIELD_UNKNOWN' && i.message.includes('nope')))
  // idRule 是 `<c>:<a>`，idTemplate `<x>` 未映射出同构占位 → SM_IDRULE_MISMATCH
  assert.ok(issues.some((i) => i.code === 'SM_IDRULE_MISMATCH'))
})

test('静态闭合：idTemplate 经 fields 归一后与 idRule 同构 → 无 SM_IDRULE_MISMATCH', () => {
  const pkg = minimalPkg()
  pkg.sourceMaps = [
    {
      id: 'SM-TST-1',
      collection: 'rows',
      objectType: 'OBJ-TST-A',
      idTemplate: '<c_code>:<a1src>',
      fields: [
        { source: 'c_code', target: 'c' },
        { source: 'a1src', target: 'a1' },
      ],
    },
  ]
  // idRule `<c>:<a>` ↔ 目标属性序列 c/a1 —— a1 与 a 不同，仍报不一致
  const issues = checkSourceMapsStatic(pkg)
  assert.ok(issues.some((i) => i.code === 'SM_IDRULE_MISMATCH'))
  // 修正为与 idRule 一致（目标属性 c 与 a——a 不是属性，但 idRule 占位对的是属性名序列）
  pkg.objects[0].idRule = '<c>:<a1>'
  const issues2 = checkSourceMapsStatic(pkg)
  assert.ok(!issues2.some((i) => i.code === 'SM_IDRULE_MISMATCH'))
})

test('预览：缺字段 / 类型不符 / 必填未覆盖 + 计数', () => {
  const pkg = minimalPkg()
  pkg.objects[0].attributes.push({ name: 'a3', type: 'float', required: true })
  pkg.sourceMaps = [
    {
      id: 'SM-TST-1',
      collection: 'rows',
      objectType: 'OBJ-TST-A',
      idTemplate: '<c>:<a1>',
      fields: [
        { source: 'c', target: 'c' },
        { source: 'a1', target: 'a1' },
        { source: 'a2', target: 'a2' },
      ],
    },
  ]
  pkg.apiSources = [
    {
      id: 'SRC-TST-1',
      name: '源',
      sourceType: 'SCHEMA_API',
      shape: {
        mode: 'snapshot',
        path: '/api/v1/x',
        collectionPaths: { rows: 'rows' },
        pagination: { mode: 'none' },
      },
    },
  ]
  const rows = { rows: [{ c: '1', a1: 'x', a2: 'y', ghost: 1 }] }
  const preview = previewSourceMaps(pkg, rows)
  // a3 required 未映射且样本无同名 → SM_REQUIRED_UNMAPPED
  assert.ok(preview.diagnostics.some((d) => d.code === 'SM_REQUIRED_UNMAPPED' && d.message.includes('a3')))
  assert.equal(preview.counts.objects, 1)
  // 类型不符：把 a2（enum）灌入非法值
  const rows2 = { rows: [{ c: '1', a1: 'x', a2: 'not-in-dict' }] }
  const preview2 = previewSourceMaps(pkg, rows2)
  assert.ok(preview2.diagnostics.some((d) => d.code === 'SM_TYPE_MISMATCH'))
  // 缺字段：映射引用的源字段样本里没有
  const preview3 = previewSourceMaps(pkg, { rows: [{ c: '1' }] })
  assert.ok(preview3.diagnostics.some((d) => d.code === 'SM_FIELD_MISSING'))
})

test('预览：证据就绪度（声明投影→ready；未声明→pending）', () => {
  const pkg = minimalPkg()
  pkg.sourceMaps = [
    {
      id: 'SM-TST-C',
      kind: 'candidate',
      collection: 'cands',
      idField: 'cid',
      objectRefField: 'ref',
      objectType: 'OBJ-TST-A',
      features: { f1: 'f1', f2: 'v2' },
    },
    {
      id: 'SM-TST-A',
      collection: 'rows',
      objectType: 'OBJ-TST-A',
      idTemplate: '<ref>',
    },
  ]
  pkg.scoreRules[0].featureSources = { f1: 'OBJ-TST-A' }
  const rows = {
    // f1 走对象投影（行字段 f1=候选特征值，可复算）；f2 仅是候选上游值（来源未声明）
    rows: [{ ref: 'A1', f1: 0.5 }],
    cands: [{ cid: 'C1', ref: 'A1', f1: 0.5, v2: 0.5 }],
  }
  const preview = previewSourceMaps(pkg, rows)
  const f1 = preview.evidence.find((e) => e.feature === 'f1')
  const f2 = preview.evidence.find((e) => e.feature === 'f2')
  assert.ok(f1 !== undefined && f1.verdict === 'ready')
  assert.ok(f2 !== undefined && f2.verdict === 'pending')
})

test('store：source-maps/api shape/回放夹具 round-trip 且夹具进源清单', () => {
  const { dir, root, pkg } = mkWorkspaceWithPkg()
  try {
    pkg.sourceMaps = wstMaps()
    pkg.apiSources = [
      {
        id: 'SRC-TST-1',
        name: '源',
        sourceType: 'SCHEMA_API',
        shape: {
          mode: 'snapshot',
          path: '/api/v1/bin-snapshot',
          collectionPaths: { bins: 'bins' },
          pagination: { mode: 'none' },
        },
      },
    ]
    savePackage(dir, pkg)
    const loaded = loadPackage(dir)
    assert.equal(loaded.sourceMaps.length, 6)
    assert.equal(loaded.apiSources[0].shape.mode, 'snapshot')
    // 回放夹具进源清单（派生指纹覆盖）
    const fixDir = `${dir}/fixtures`
    mkdirSync(fixDir, { recursive: true })
    writeFileSync(`${fixDir}/replay-SCN-TST-1.json`, '{}', 'utf8')
    const files = listSourceFiles(dir)
    assert.ok(files.includes('bindings/source-maps.yaml'))
    assert.ok(files.includes('fixtures/replay-SCN-TST-1.json'))
  } finally {
    rmWorkspace(root)
  }
})
