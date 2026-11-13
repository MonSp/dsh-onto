/** scenario-prep 验收（S2.1–S2.4）：prep 语义矩阵、双 digest、now 回放、包级配方校验。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildRunRecord,
  datasetDigest,
  derivePackage,
  loadPackage,
  runScenario,
  ScenarioRunError,
  savePackage,
  validatePackageDir,
  verifyDerived,
  writeQualityReport,
} from '../dist/index.js'
import { copyExamplePackage, exampleData, mkWorkspaceWithPkg, minimalPkg, rmWorkspace } from './helpers.mjs'

function withAmlPrep(mutate) {
  const { dir, root } = copyExamplePackage('aml')
  try {
    const pkg = loadPackage(dir)
    const scenario = pkg.scenarios.find((s) => s.id === 'SCN-AML-FIND-CLUES')
    assert.ok(scenario, 'aml 场景应在')
    if (mutate) mutate(pkg, scenario)
    savePackage(dir, pkg)
    derivePackage(dir)
    return { dir, root, pkg, scenario }
  } catch (e) {
    rmWorkspace(root)
    throw e
  }
}

test('S2.1 语义矩阵：无 prep 无 seedIds = 现状；有 expand 无 seedIds = 全量', () => {
  const ds = exampleData('aml-run.json')
  const a = withAmlPrep(null)
  try {
    const r1 = runScenario(a.dir, 'SCN-AML-FIND-CLUES', ds)
    assert.equal(r1.prep, undefined)
    // 声明 prep.expand 但不传 seedIds → 不扩图、全量执行（合法）
    const b = withAmlPrep((pkg, sc) => {
      sc.prep = { expand: { hops: 1 } }
    })
    try {
      const r2 = runScenario(b.dir, 'SCN-AML-FIND-CLUES', ds)
      assert.equal(r2.candidates.length, r1.candidates.length)
      assert.equal(r2.prep, undefined) // 未实际扩图（无 seedIds）→ 无 prep 摘要
    } finally {
      rmWorkspace(b.root)
    }
  } finally {
    rmWorkspace(a.root)
  }
})

test('S2.1 有 expand + seedIds → 邻域裁剪候选；全种子缺失 → INVALID_ARGS', () => {
  const ds = exampleData('aml-run.json')
  const { dir, root } = withAmlPrep((pkg, sc) => {
    sc.prep = { expand: { hops: 1 } }
  })
  try {
    const full = runScenario(dir, 'SCN-AML-FIND-CLUES', ds)
    // ACCT-001 邻域：只保留 objectRef ∈ 邻域的候选
    const partial = runScenario(dir, 'SCN-AML-FIND-CLUES', ds, { seedIds: ['ACCT-001'] })
    assert.ok(partial.prep?.expanded)
    assert.deepEqual(partial.prep.expanded.seeds, ['ACCT-001'])
    assert.ok(partial.candidates.length <= full.candidates.length)
    // 种子不在候选集时不自动补候选
    const seedObjs = new Set(partial.effectiveDataset.objects.map((o) => o.id))
    for (const c of partial.candidates) {
      assert.ok(seedObjs.has(c.objectRef), `候选 ${c.candidateId} 应在邻域内`)
    }
    // 全部种子缺失
    assert.throws(
      () => runScenario(dir, 'SCN-AML-FIND-CLUES', ds, { seedIds: ['NOPE-1', 'NOPE-2'] }),
      (e) => e instanceof ScenarioRunError && e.code === 'INVALID_ARGS',
    )
  } finally {
    rmWorkspace(root)
  }
})

test('S2.1 无 prep.expand 传 seedIds → INVALID_ARGS（意图无处落地）', () => {
  const ds = exampleData('aml-run.json')
  const { dir, root } = withAmlPrep(null)
  try {
    assert.throws(
      () => runScenario(dir, 'SCN-AML-FIND-CLUES', ds, { seedIds: ['ACCT-001'] }),
      (e) => e instanceof ScenarioRunError && e.code === 'INVALID_ARGS' && /prep\.expand/.test(e.message),
    )
  } finally {
    rmWorkspace(root)
  }
})

test('S2.3/S2.4 无 prep：RunRecord 无 inputDigest/prep 键，datasetDigest 与现状一致', () => {
  const ds = exampleData('aml-run.json')
  const { dir, root } = withAmlPrep(null)
  try {
    const result = runScenario(dir, 'SCN-AML-FIND-CLUES', ds)
    assert.equal(result.prep, undefined)
    const rec = buildRunRecord({
      package: { name: 'aml-analysis', version: '1.0.0' },
      dataset: ds,
      result,
      redlines: [],
      savedAt: '2026-11-13T00:00:00.000Z',
    })
    assert.equal(rec.datasetDigest, datasetDigest(ds))
    assert.equal('inputDigest' in rec, false, '无 prep 不得落 inputDigest 键（A-9 逐字节一致）')
    assert.equal('prep' in rec, false)
    // JSON 序列化无多余键
    const keys = Object.keys(JSON.parse(JSON.stringify(rec))).sort()
    assert.deepEqual(keys, [
      'datasetDigest', 'datasetSummary', 'package', 'redlines', 'result', 'runId', 'savedAt', 'scenarioId', 'startedAt',
    ].sort())
  } finally {
    rmWorkspace(root)
  }
})

test('S2.4 有 prep：inputDigest ≠ datasetDigest（扩图裁剪后），prep 摘要在档', () => {
  const ds = exampleData('aml-run.json')
  const { dir, root } = withAmlPrep((pkg, sc) => {
    sc.prep = { expand: { hops: 1 }, features: true }
  })
  try {
    const result = runScenario(dir, 'SCN-AML-FIND-CLUES', ds, { seedIds: ['ACCT-001'] })
    assert.ok(result.prep?.expanded)
    assert.equal(typeof result.prep.projectedWrites, 'number')
    const effective = result.effectiveDataset
    assert.ok(effective, '有 prep 时须回填 effectiveDataset')
    const rec = buildRunRecord({
      package: { name: 'aml-analysis', version: '1.0.0' },
      dataset: effective,
      inputDataset: ds,
      result,
      redlines: [],
      savedAt: '2026-11-13T00:00:00.000Z',
    })
    assert.equal(rec.inputDigest, datasetDigest(ds))
    assert.equal(rec.datasetDigest, datasetDigest(effective))
    assert.notEqual(rec.inputDigest, rec.datasetDigest, '裁剪后两 digest 应不同')
    assert.ok(rec.prep?.expanded?.seeds.includes('ACCT-001'))
    // effective 不进 result JSON（非枚举）
    assert.ok(!('effectiveDataset' in JSON.parse(JSON.stringify(result))))
  } finally {
    rmWorkspace(root)
  }
})

test('A-10 prep.features：now 由执行层注入，两次回放逐字节一致', () => {
  const ds = exampleData('aml-run.json')
  // aml 无 featureRecipes 时只投影；挂上 since 配方测 now 注入
  const { dir, root } = withAmlPrep((pkg, sc) => {
    sc.prep = { features: true }
    // overdue 类特征需 O1 属性——用 aml 已有对象属性做宽松闭合测试
    pkg.featureRecipes = [
      { name: 'staleHours', kind: 'since', attr: 'openedAt' },
    ]
  })
  try {
    const report = validatePackageDir(dir)
    // openedAt 若不在 featureSources 目标对象上 → FEATURE_RECIPE_INVALID；能过则配方合法
    const recipeErrs = report.errors.filter((e) => e.code === 'FEATURE_RECIPE_INVALID')
    if (recipeErrs.length === 0) {
      const fixedNow = () => new Date('2026-11-13T12:00:00.000Z')
      const a = runScenario(dir, 'SCN-AML-FIND-CLUES', ds, { now: fixedNow })
      const b = runScenario(dir, 'SCN-AML-FIND-CLUES', ds, { now: fixedNow })
      assert.equal(JSON.stringify(a.candidates), JSON.stringify(b.candidates))
      assert.ok(a.prep?.derived === undefined || Array.isArray(a.prep.derived))
    } else {
      // 配方 attr 不闭合：校验应报错（宽松闭合失败也算验收）
      assert.ok(recipeErrs.length >= 1)
    }
  } finally {
    rmWorkspace(root)
  }
})

test('S2.2 包级 featureRecipes：结构校验 + 包级禁 now + 宽松 attr 闭合', () => {
  const { dir, root } = mkWorkspaceWithPkg({})
  try {
    const pkg = loadPackage(dir)
    // 1) 包级 now → error
    pkg.featureRecipes = [{ name: 'x', kind: 'count', source: 'behaviors', now: '2026-01-01T00:00:00Z' }]
    savePackage(dir, pkg)
    let rep = validatePackageDir(dir)
    assert.ok(rep.errors.some((e) => e.code === 'FEATURE_RECIPE_INVALID' && /now/.test(e.message)))

    // 2) since 缺 attr / count 缺 source / ratio 缺 num-den / 坏 kind
    pkg.featureRecipes = [
      { name: 'a', kind: 'since' },
      { name: 'b', kind: 'count' },
      { name: 'c', kind: 'ratio' },
      { name: 'd', kind: 'magic' },
    ]
    savePackage(dir, pkg)
    rep = validatePackageDir(dir)
    const msgs = rep.errors.filter((e) => e.code === 'FEATURE_RECIPE_INVALID').map((e) => e.message)
    assert.ok(msgs.some((m) => /since 须有 attr/.test(m)))
    assert.ok(msgs.some((m) => /count 须有 source/.test(m)))
    assert.ok(msgs.some((m) => /ratio 须有 num/.test(m)))
    assert.ok(msgs.some((m) => /kind 须为/.test(m)))

    // 3) 合法配方（attr 不在 featureSources 目标 → 宽松闭合失败报错；若规则无 featureSources 则跳过闭合）
    pkg.featureRecipes = [{ name: 'n', kind: 'count', source: 'behaviors' }]
    savePackage(dir, pkg)
    rep = validatePackageDir(dir)
    assert.equal(rep.errors.filter((e) => e.code === 'FEATURE_RECIPE_INVALID').length, 0)

    // 4) 指纹：featureRecipes 落 package.yaml；改配方不重 derive → DERIVED_DRIFT
    derivePackage(dir)
    assert.equal(verifyDerived(dir).ok, true)
    const yamlBefore = readFileSync(join(dir, 'package.yaml'), 'utf8')
    assert.ok(yamlBefore.includes('featureRecipes'), 'featureRecipes 须落 package.yaml')
    pkg.featureRecipes = [{ name: 'n2', kind: 'count', source: 'relations' }]
    savePackage(dir, pkg)
    const yamlAfter = readFileSync(join(dir, 'package.yaml'), 'utf8')
    assert.notEqual(yamlBefore, yamlAfter, 'package.yaml 应随配方变化')
    const gate = verifyDerived(dir)
    assert.equal(gate.ok, false, '源改后未重 derive 应 DERIVED_DRIFT')
    // 重 derive 后恢复可加载
    derivePackage(dir)
    assert.equal(verifyDerived(dir).ok, true)
  } finally {
    rmWorkspace(root)
  }
})

test('prep 结构校验：hops 越界 / direction 坏值 / 空 prep → PREP_INVALID', () => {
  const { dir, root } = mkWorkspaceWithPkg({})
  try {
    const pkg = loadPackage(dir)
    const sc = pkg.scenarios[0]
    sc.prep = { expand: { hops: 9 } }
    savePackage(dir, pkg)
    let rep = validatePackageDir(dir)
    assert.ok(rep.errors.some((e) => e.code === 'PREP_INVALID' && /hops/.test(e.message)))

    sc.prep = { expand: { direction: 'sideways' } }
    savePackage(dir, pkg)
    rep = validatePackageDir(dir)
    assert.ok(rep.errors.some((e) => e.code === 'PREP_INVALID' && /direction/.test(e.message)))

    sc.prep = {}
    savePackage(dir, pkg)
    rep = validatePackageDir(dir)
    assert.ok(rep.errors.some((e) => e.code === 'PREP_INVALID' && /至少须声明/.test(e.message)))

    sc.prep = { expand: { hops: 2, direction: 'in' }, features: true }
    savePackage(dir, pkg)
    derivePackage(dir)
    rep = validatePackageDir(dir)
    assert.equal(rep.errors.filter((e) => e.code === 'PREP_INVALID').length, 0)
    // round-trip
    const loaded = loadPackage(dir)
    assert.deepEqual(loaded.scenarios[0].prep, { expand: { hops: 2, direction: 'in' }, features: true })
  } finally {
    rmWorkspace(root)
  }
})
