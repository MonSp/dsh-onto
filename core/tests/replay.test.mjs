/** 发布前回放验收（api-to-plugin T5）：基线对照 / 缺数 / 越权 / 版本切换。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { derivePackage, runReplay, loadPackage } from '../dist/index.js'
import { mkWorkspace, rmWorkspace, REPO_ROOT } from './helpers.mjs'

const SCN = 'SCN-WST-HAZARD-MIX'

function mapsYaml() {
  return `kind: O1SourceMaps
maps:
  - id: SM-WST-BIN
    collection: bins
    objectType: OBJ-WST-BIN
    idTemplate: <binId>
    timeField: lastEmptiedAt
  - id: SM-WST-ROUTE
    collection: routes
    objectType: OBJ-WST-ROUTE
    idTemplate: <routeId>
  - id: SM-WST-COVERS
    kind: relation
    collection: routes
    relationType: REL-WST-COVERS
    from: self
    to:
      field: covers
    targetCollection: bins
  - id: SM-WST-ALERT
    kind: candidate
    collection: alerts
    idField: alertId
    objectRefField: binId
    objectType: OBJ-WST-BIN
    features:
      fillRatio: features.fillRatio
      mixCount: features.mixCount
      hazardFlag: features.hazardFlag
    tagsField: tags
  - id: SM-WST-MIX
    kind: behavior-list
    collection: bins
    behaviorType: BHV-WST-MIX
    objectRefTemplate: <binId>
    eventsPath: mixEvents
    timeField: at
  - id: SM-WST-DUMP
    kind: behavior
    collection: dumps
    behaviorType: BHV-WST-DUMP
    objectRefTemplate: <binId>
    timeField: at
`
}

function shapeYaml() {
  return `kind: O1ApiSources
sources:
  - id: SRC-WST-CORE
    name: wst
    sourceType: SCHEMA_API
    endpoint: "api://wst-snapshot"
    shape:
      mode: snapshot
      path: /api/v1/bin-snapshot
      collectionPaths:
        bins: bins
        routes: routes
        dumps: dumps
        alerts: alerts
      pagination:
        mode: none
`
}

function setupWst() {
  const ws = mkWorkspace()
  const dir = ws.versionDir('wst-ops', '1.0.0')
  cpSync(join(REPO_ROOT, 'packages', 'wst', '1.0.0'), dir, { recursive: true })
  // 示例包可能是 ISSUED（验收产物）：回置 DRAFT、清 issueRecord 锚（manifestDigest 与重派生不符）
  const metaPath = join(dir, 'package.yaml')
  let meta = readFileSync(metaPath, 'utf8')
  meta = meta.replace(/^status:.*$/m, 'status: DRAFT')
  meta = meta.replace(/^issueRecord:\s*\n(?:[ \t]+.*\n?)*/m, 'issueRecord: []\n')
  meta = meta.split('\n').filter((l) => !l.includes('manifestDigest')).join('\n')
  writeFileSync(metaPath, meta, 'utf8')
  writeFileSync(join(dir, 'bindings', 'api-sources.yaml'), shapeYaml(), 'utf8')
  writeFileSync(join(dir, 'bindings', 'source-maps.yaml'), mapsYaml(), 'utf8')
  mkdirSync(join(dir, 'fixtures'), { recursive: true })
  cpSync(
    join(REPO_ROOT, 'mock-services', 'wst-api', 'data', 'snapshot.json'),
    join(dir, 'fixtures', `replay-${SCN}.json`),
  )
  derivePackage(dir)
  return { ws, dir, root: ws.root }
}

test('回放：write-expected 基线 → --check 全绿（候选/规则/排除/人审齐全）', () => {
  const { dir, root } = setupWst()
  try {
    const boot = runReplay({ versionDir: dir, scenarioId: SCN, writeExpected: true })
    assert.equal(boot.counts.objects, 5) // 3 bin + 2 route
    assert.equal(boot.counts.candidates, 4)
    assert.equal(boot.counts.behaviors, 5) // BIN-03 混投 2 条 + dumps 3 条
    // 高风险桶命中三条打分规则；已核销白名单候选被排除
    const high = boot.result.candidates.find((c) => c.candidateId === 'ALERT-BIN-03')
    assert.ok(high !== undefined)
    assert.deepEqual(high.hitRuleIds, [
      'RULE-WST-SCORE-FILL',
      'RULE-WST-SCORE-HAZARD',
      'RULE-WST-SCORE-MIX',
    ])
    assert.ok(high.riskScore > 0.8, `score=${high.riskScore}`)
    assert.equal(boot.result.humanReviewRequired, true)
    assert.ok(boot.result.excluded.some((e) => e.candidateId === 'ALERT-BIN-02B' && e.ruleId === 'RULE-WST-EXCL-CLEARED'))
    assert.ok(boot.result.auditPassed === true, JSON.stringify(boot.result))
    // 基线落盘后 --check 全绿
    const checked = runReplay({ versionDir: dir, scenarioId: SCN, check: true })
    assert.equal(checked.comparison.ok, true, JSON.stringify(checked.comparison.diffs))
  } finally {
    rmWorkspace(root)
  }
})

test('回放：缺数夹具 → 映射诊断可见 + 基线对照出差异', () => {
  const { dir, root } = setupWst()
  try {
    runReplay({ versionDir: dir, scenarioId: SCN, writeExpected: true })
    // 缺数变体：去掉 ALERT-BIN-03 的 features、BIN-01 缺 binId
    const body = JSON.parse(readFileSync(join(dir, 'fixtures', `replay-${SCN}.json`), 'utf8'))
    body.alerts = body.alerts.map((a) =>
      a.alertId === 'ALERT-BIN-03' ? { ...a, features: undefined } : a,
    )
    body.bins = body.bins.map((b) => (b.binId === 'BIN-01' ? { ...b, binId: undefined } : b))
    const badPath = join(root, 'fixture-missing.json')
    writeFileSync(badPath, JSON.stringify(body), 'utf8')
    const report = runReplay({ versionDir: dir, scenarioId: SCN, fixturePath: badPath, check: true })
    const codes = report.diagnostics.map((d) => d.code)
    assert.ok(codes.includes('SM_ID_EMPTY'), JSON.stringify(codes)) // BIN-01 无 id
    assert.ok(report.comparison.ok === false)
    assert.ok(report.comparison.diffs.length > 0)
  } finally {
    rmWorkspace(root)
  }
})

test('回放：越权（scope 不含 OBJ-WST-BIN）→ 候选为空且 scopedOut 留痕', () => {
  const { dir, root } = setupWst()
  try {
    const report = runReplay({
      versionDir: dir,
      scenarioId: SCN,
      scopeTypes: ['OBJ-WST-ROUTE'],
    })
    assert.ok(report.scopedOut !== undefined)
    assert.deepEqual(report.scopedOut.objectTypes, ['OBJ-WST-BIN'])
    assert.equal(report.scopedOut.objectsDropped, 3)
    assert.equal(report.result.candidates.length, 0)
    assert.equal(report.counts.objects, 2) // 仅 ROUTE
  } finally {
    rmWorkspace(root)
  }
})

test('回放：--check 对照含 pendingChecks 与 dataStatus（漏项不得假绿）', () => {
  const { dir, root } = setupWst()
  try {
    runReplay({ versionDir: dir, scenarioId: SCN, writeExpected: true })
    // 篡改基线放包外（包内 fixtures 进指纹，手改会 DRIFT）——对照面必须抓到漏项
    const expPath = join(dir, 'fixtures', `replay-${SCN}.expected.json`)
    const exp = JSON.parse(readFileSync(expPath, 'utf8'))
    exp.candidates[0].pendingChecks = [{ ruleId: 'RULE-GHOST', missing: ['ghost'] }]
    exp.dataStatus = 'TAMPERED'
    const tampered = join(root, 'expected-tampered.json')
    writeFileSync(tampered, JSON.stringify(exp, null, 2), 'utf8')
    const report = runReplay({ versionDir: dir, scenarioId: SCN, check: true, expectedPath: tampered })
    assert.equal(report.comparison.ok, false)
    const wheres = report.comparison.diffs.map((d) => d.where)
    assert.ok(wheres.some((w) => w.includes('pendingChecks')), JSON.stringify(wheres))
    assert.ok(wheres.includes('dataStatus'), JSON.stringify(wheres))
  } finally {
    rmWorkspace(root)
  }
})

test('回放：版本切换（同夹具跑两版本）→ 分数/命中 diff', () => {
  const { dir, root } = setupWst()
  try {
    // v2：满溢权重 0.4→0.6，其余吸收（0.2/0.2）
    const ws2 = mkWorkspace()
    const dir2 = ws2.versionDir('wst-ops', '1.0.1')
    cpSync(dir, dir2, { recursive: true })
    const metaPath = join(dir2, 'package.yaml')
    writeFileSync(
      metaPath,
      readFileSync(metaPath, 'utf8').replace('version: 1.0.0', 'version: 1.0.1'),
      'utf8',
    )
    const rulesPath = join(dir2, 'o2-behavior-rules', 'rules', 'score-rules.yaml')
    let text = readFileSync(rulesPath, 'utf8')
    text = text.replace('weight: 0.4', 'weight: 0.6').replace('weight: 0.35', 'weight: 0.2').replace('weight: 0.25', 'weight: 0.2')
    writeFileSync(rulesPath, text, 'utf8')
    derivePackage(dir2)
    try {
      const report = runReplay({ versionDir: dir, scenarioId: SCN, againstDir: dir2 })
      assert.ok(report.against !== undefined)
      assert.equal(report.against.package.version, '1.0.1')
      assert.ok(report.against.scoreDeltas.length > 0, JSON.stringify(report.against))
      assert.ok(
        report.against.scoreDeltas.some((d) => d.candidateId === 'ALERT-BIN-03' && d.to !== d.from),
      )
    } finally {
      rmWorkspace(ws2.root)
    }
  } finally {
    rmWorkspace(root)
  }
})
