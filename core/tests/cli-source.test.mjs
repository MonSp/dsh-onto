/** CLI source 命令组验收（api-to-plugin T4）：probe / map init / map preview 与三类缺陷定位。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { savePackage, loadPackage } from '../dist/index.js'
import { minimalPkg, mkWorkspaceWithPkg, rmWorkspace, REPO_ROOT } from './helpers.mjs'

const CLI = join(REPO_ROOT, 'core', 'dist', 'cli.js')
const NODE = process.execPath

function runCli(argv, opts = {}) {
  try {
    const stdout = execFileSync(NODE, [CLI, ...argv], { encoding: 'utf8', ...opts })
    return { code: 0, out: JSON.parse(stdout) }
  } catch (e) {
    return { code: e.status ?? 1, out: e.stdout ? JSON.parse(e.stdout) : null, err: String(e.stderr ?? e.message) }
  }
}

/** wst 形态包（对象/字典/行为/场景齐全）+ snapshot shape；source-maps 留给命令生成/测试写入。 */
function makeWstPkg(pkg) {
  pkg.meta.name = 'wst-ops'
  pkg.meta.domain = 'WST'
  pkg.objects = [
    {
      id: 'OBJ-WST-BIN',
      name: '桶',
      idRule: '<binId>',
      attributes: [
        { name: 'binId', type: 'string', required: true },
        { name: 'binNo', type: 'string' },
        { name: 'zone', type: 'enum', enumValuesRef: 'dict-wst-zone' },
        { name: 'fillLevel', type: 'float' },
      ],
    },
  ]
  pkg.dictionaries = [{ id: 'dict-wst-zone', name: '区', values: ['canteen', 'dorm'] }]
  pkg.behaviors = [{ id: 'BHV-WST-MIX', name: '混投', anchor: 'OBJ-WST-BIN', relations: [] }]
  pkg.relations = []
  pkg.fieldMaps = []
  pkg.apiSources = [
    {
      id: 'SRC-WST-CORE',
      name: 'wst',
      sourceType: 'SCHEMA_API',
      shape: {
        mode: 'snapshot',
        path: '/api/v1/bin-snapshot',
        collectionPaths: { bins: 'bins', alerts: 'alerts' },
        pagination: { mode: 'none' },
      },
    },
  ]
  pkg.sourceMaps = [
    {
      id: 'SM-WST-BIN',
      collection: 'bins',
      objectType: 'OBJ-WST-BIN',
      idTemplate: '<binId>',
      fields: [
        { source: 'binId', target: 'binId' },
        { source: 'binNo', target: 'binNo' },
        { source: 'zone', target: 'zone' },
        { source: 'fillLevel', target: 'fillLevel' },
      ],
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
  ]
  return pkg
}

/** 含人为缺陷的样本：缺 binNo、zone 枚举值非法、候选断引用。 */
function sampleBody() {
  return {
    bins: [{ binId: 'BIN-01', zone: 'rooftop', fillLevel: 0.9, mixEvents: [] }],
    alerts: [
      { alertId: 'A1', binId: 'BIN-01', features: { fillRatio: 0.9 }, tags: [] },
      { alertId: 'A2', binId: 'BIN-404', features: { fillRatio: 0.1 }, tags: [] },
    ],
  }
}

test('source probe：按 shape 解析样本并报字段类型', () => {
  const { dir, root, pkg } = mkWorkspaceWithPkg()
  try {
    savePackage(dir, makeWstPkg(pkg))
    const dataPath = join(root, 'sample.json')
    writeFileSync(dataPath, JSON.stringify(sampleBody()), 'utf8')
    const { code, out } = runCli(['source', 'probe', '--dir', dir, '--data', dataPath])
    assert.equal(code, 0)
    assert.equal(out.shape, 'snapshot')
    assert.equal(out.probe.bins.rows, 1)
    assert.ok(out.probe.bins.fields.binId.types.includes('string'))
    assert.ok(out.probe.alerts.rows, 2)
  } finally {
    rmWorkspace(root)
  }
})

test('source map init：生成 source-maps 草稿（idTemplate/timeField 启发）', () => {
  const { dir, root, pkg } = mkWorkspaceWithPkg()
  try {
    const p = makeWstPkg(pkg)
    p.sourceMaps = []
    savePackage(dir, p)
    const dataPath = join(root, 'sample.json')
    writeFileSync(dataPath, JSON.stringify(sampleBody()), 'utf8')
    const { code, out } = runCli(['source', 'map', 'init', '--dir', dir, '--data', dataPath, '--force'])
    assert.equal(code, 0)
    const loaded = loadPackage(dir)
    const binMap = loaded.sourceMaps.find((m) => m.collection === 'bins')
    assert.ok(binMap !== undefined)
    assert.equal(binMap.objectType, 'OBJ-WST-BIN')
    assert.equal(binMap.idTemplate, '<binId>')
    // alerts 无同名对象类型 → 未匹配上报
    assert.ok(out.unmatchedCollections.includes('alerts'))
  } finally {
    rmWorkspace(root)
  }
})

test('source map preview --json：定位缺字段/类型不符/断引用三类缺陷', () => {
  const { dir, root, pkg } = mkWorkspaceWithPkg()
  try {
    savePackage(dir, makeWstPkg(pkg))
    const dataPath = join(root, 'sample.json')
    writeFileSync(dataPath, JSON.stringify(sampleBody()), 'utf8')
    const { code, out } = runCli(['source', 'map', 'preview', '--dir', dir, '--data', dataPath, '--json'])
    assert.equal(code, 0)
    const codes = out.diagnostics.map((d) => d.code)
    // 三类缺陷：
    assert.ok(codes.includes('SM_TYPE_MISMATCH'), JSON.stringify(out.diagnostics)) // zone=rooftop 不在字典
    assert.ok(codes.includes('SM_REF_BROKEN')) // A2 → BIN-404
    assert.ok(codes.includes('SM_FIELD_MISSING')) // 映射引用 binNo，样本行没有
    // 计数与结构稳定
    assert.equal(out.counts.objects, 1)
    assert.equal(out.counts.candidates, 1)
    assert.ok(Array.isArray(out.evidence))
    assert.ok(out.businessWindow !== undefined)
  } finally {
    rmWorkspace(root)
  }
})

test('source map preview --strict：error 级诊断退出 2', () => {
  const { dir, root, pkg } = mkWorkspaceWithPkg()
  try {
    const p = makeWstPkg(pkg)
    p.sourceMaps[0].fields.push({ source: 'ghost', target: 'ghostAttr' }) // 目标属性不存在 → error
    savePackage(dir, p)
    const dataPath = join(root, 'sample.json')
    writeFileSync(dataPath, JSON.stringify(sampleBody()), 'utf8')
    const { code } = runCli(['source', 'map', 'preview', '--dir', dir, '--data', dataPath, '--strict'])
    assert.equal(code, 2)
  } finally {
    rmWorkspace(root)
  }
})
