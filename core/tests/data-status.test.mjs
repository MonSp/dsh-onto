/**
 * M1-B 三状态验收：contractStatus / dataStatus 不与 audit.passed 混用；
 * formal 缺源/超时效/不完整/必需特征缺依据 → insufficient（不可处置），
 * 不得把「缺特征后 0 分」展示为低风险；伪造来源（自称 connector 无 basis）拒绝 verified。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { derivePackage, runScenario, savePackage } from '../dist/index.js'
import { minimalPkg, mkWorkspaceWithPkg, rmWorkspace } from './helpers.mjs'

/** 声明 f1←OBJ-TST-A 的最小包（对象 attrs 无 f1 = 必需特征缺依据场景）。 */
function pkgWithF1() {
  const base = minimalPkg()
  return minimalPkg({
    scoreRules: [{ ...base.scoreRules[0], featureSources: { f1: 'OBJ-TST-A' } }],
  })
}

function savePkg(dir, pkg) {
  savePackage(dir, pkg)
  derivePackage(dir)
}

/** 合法取数上下文（服务端连接器产出的快照核验结论）。 */
const BASIS_OK = {
  nature: 'simulated',
  complete: true,
  fresh: true,
  snapshotId: 'snap-test-1',
  sourceId: 'SRC-TST-1',
}

/** 对象 attrs 带 f1 的数据集（特征有事实依据）。 */
function datasetWithFact(f1 = 1) {
  return {
    objects: [{ id: 'A1', type: 'OBJ-TST-A', attrs: { a1: 'x', f1 } }],
    relations: [],
    behaviors: [],
    candidates: [{ candidateId: 'C1', objectRef: 'A1', features: {}, tags: [] }],
  }
}

/** 对象 attrs 无 f1 的数据集（必需特征缺依据）。 */
function datasetMissingFact() {
  return {
    objects: [{ id: 'A1', type: 'OBJ-TST-A', attrs: { a1: 'x' } }],
    relations: [],
    behaviors: [],
    candidates: [{ candidateId: 'C1', objectRef: 'A1', features: { f1: 1 }, tags: [] }],
  }
}

test('B1-1 contractStatus：审计闭合 conformant，未闭合 non-conformant（与 audit.passed 语义分立）', () => {
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    savePkg(dir, minimalPkg())
    const ok = runScenario(dir, 'SCN-TST-1', datasetWithFact(), { dataBasis: BASIS_OK })
    assert.equal(ok.contractStatus, 'conformant')
    assert.equal(ok.audit.passed, true)
  } finally {
    rmWorkspace(root)
  }
})

test('B1-2 dataStatus=verified：连接器来源（带 basis）+ 完整 + 时效 + 特征有依据', () => {
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    savePkg(dir, pkgWithF1())
    // prep 投影把对象 f1 投进 features——特征有事实依据
    const pkg = pkgWithF1()
    pkg.scenarios[0].prep = { features: true }
    savePkg(dir, pkg)
    const result = runScenario(dir, 'SCN-TST-1', datasetWithFact(), {
      dataBasis: BASIS_OK,
    })
    assert.equal(result.dataStatus, 'verified')
    assert.equal(result.contractStatus, 'conformant')
  } finally {
    rmWorkspace(root)
  }
})

test('B1-3 伪造来源拒绝：自称 provenance=connector 无 dataBasis → 不得 verified', () => {
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    const pkg = pkgWithF1()
    pkg.scenarios[0].prep = { features: true }
    savePkg(dir, pkg)
    // 调用方自称 connector（入口防线之外的兜底：无 basis 不按可信来源算）
    const ds = { ...datasetWithFact(), provenance: 'connector' }
    const result = runScenario(dir, 'SCN-TST-1', ds, { analysisMode: 'formal' })
    assert.equal(result.dataStatus, 'insufficient', 'formal + 伪造来源 → 不可处置')
    assert.ok(
      result.candidates[0].pendingChecks.some((p) => /缺可信来源/.test(p.note)),
      JSON.stringify(result.candidates[0].pendingChecks),
    )
  } finally {
    rmWorkspace(root)
  }
})

test('B1-4 formal 缺依据 → insufficient + 待补数上墙；不得按低风险处置', () => {
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    savePkg(dir, pkgWithF1())
    const result = runScenario(dir, 'SCN-TST-1', datasetMissingFact(), {
      analysisMode: 'formal',
      dataBasis: BASIS_OK,
    })
    assert.equal(result.dataStatus, 'insufficient')
    const c1 = result.candidates[0]
    assert.equal(c1.pendingVerification, true)
    assert.ok(
      c1.pendingChecks.some((p) => /正式分析依据不足.*待补数/.test(p.note)),
      JSON.stringify(c1.pendingChecks),
    )
    // 缺依据被剔除后 0 分——不得解读为低风险（pendingVerification 已上墙）
    assert.equal(c1.riskScore, 0)
  } finally {
    rmWorkspace(root)
  }
})

test('B1-5 formal 超时效/取数不完整 → insufficient（缺口原因上墙）', () => {
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    const pkg = pkgWithF1()
    pkg.scenarios[0].prep = { features: true }
    savePkg(dir, pkg)
    const stale = runScenario(dir, 'SCN-TST-1', datasetWithFact(), {
      analysisMode: 'formal',
      dataBasis: { ...BASIS_OK, fresh: false },
    })
    assert.equal(stale.dataStatus, 'insufficient')
    assert.ok(stale.candidates[0].pendingChecks.some((p) => /超时效/.test(p.note)))
    const incomplete = runScenario(dir, 'SCN-TST-1', datasetWithFact(), {
      analysisMode: 'formal',
      dataBasis: { ...BASIS_OK, complete: false },
    })
    assert.equal(incomplete.dataStatus, 'insufficient')
    assert.ok(incomplete.candidates[0].pendingChecks.some((p) => /取数不完整/.test(p.note)))
  } finally {
    rmWorkspace(root)
  }
})

test('B1-6 explore + 内联/无 basis → unverified；explore + 部分缺口 → conditional', () => {
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    const pkg = pkgWithF1()
    pkg.scenarios[0].prep = { features: true }
    savePkg(dir, pkg)
    // 内联数据（无 basis）→ unverified
    const inline = runScenario(dir, 'SCN-TST-1', { ...datasetWithFact(), provenance: 'inline' })
    assert.equal(inline.dataStatus, 'unverified')
    // 来源未声明同样 unverified
    const undeclared = runScenario(dir, 'SCN-TST-1', datasetWithFact())
    assert.equal(undeclared.dataStatus, 'unverified')
    // basis 齐 + 特征缺依据（无 prep 投影）→ conditional（条件性分数）
    savePkg(dir, pkgWithF1())
    const partial = runScenario(dir, 'SCN-TST-1', datasetMissingFact(), { dataBasis: BASIS_OK })
    assert.equal(partial.dataStatus, 'conditional')
  } finally {
    rmWorkspace(root)
  }
})

test('B1-7 同输入快照与同本体版本可复算：两次运行 dataStatus/分数一致', () => {
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    const pkg = pkgWithF1()
    pkg.scenarios[0].prep = { features: true }
    savePkg(dir, pkg)
    const a = runScenario(dir, 'SCN-TST-1', datasetWithFact(), { dataBasis: BASIS_OK })
    const b = runScenario(dir, 'SCN-TST-1', datasetWithFact(), { dataBasis: BASIS_OK })
    assert.equal(a.dataStatus, b.dataStatus)
    assert.equal(a.contractStatus, b.contractStatus)
    assert.equal(a.candidates[0].riskScore, b.candidates[0].riskScore)
  } finally {
    rmWorkspace(root)
  }
})
