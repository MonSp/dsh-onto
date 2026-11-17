/**
 * R5 无事实特征显式降级验收：来源状态记录 / 正式-探索模式 / prep 开关双入口 /
 * 配方派生可复算 / 依赖链传播 / 供数身份不得自称 connector。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveFeatures,
  derivePackage,
  inferFeatureSources,
  projectFeatures,
  runScenario,
  savePackage,
} from '../dist/index.js'
import { minimalPkg, mkWorkspaceWithPkg, rmWorkspace } from './helpers.mjs'

/** 声明 f1←OBJ-TST-A 的最小包（对象 attrs 无 f1 时 = R5 复现场景）。 */
function pkgWithF1(extra = {}) {
  const base = minimalPkg()
  return minimalPkg({
    scoreRules: [{ ...base.scoreRules[0], featureSources: { f1: 'OBJ-TST-A' }, ...extra }],
  })
}

/** 落盘包并派生（runScenario 过派生门禁）。 */
function savePkg(dir, pkg) {
  savePackage(dir, pkg)
  derivePackage(dir)
}

test('R5-1 复现场景（prep 关）：声明源缺失的预置值 → 探索模式明确 pending、不显示复算通过', () => {
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    savePkg(dir, pkgWithF1())
    const dataset = {
      objects: [{ id: 'A1', type: 'OBJ-TST-A', attrs: { a1: 'x' } }],
      relations: [],
      behaviors: [],
      candidates: [{ candidateId: 'C1', objectRef: 'A1', features: { f1: 1 }, tags: [] }],
    }
    const result = runScenario(dir, 'SCN-TST-1', dataset)
    // 探索分析保留条件性计算（不改打分公式）
    assert.equal(result.candidates[0].riskScore, 1)
    // 但逐候选降级 + 复算状态不得显示通过
    const c1 = result.candidates[0]
    assert.equal(c1.pendingVerification, true, '候选待核实面须显式降级')
    assert.ok(
      c1.pendingChecks.some((p) => /特征 f1 无事实依据/.test(p.note)),
      JSON.stringify(c1.pendingChecks),
    )
    const feat = result.audit.checks.find((c) => c.check === 'FEATURE_RECOMPUTED')
    assert.equal(feat.closed, false, '缺事实依据不得显示复算通过')
    assert.equal(feat.blocking, false, '依据缺失是提示轴，不阻断三层闭合')
    assert.match(feat.detail, /不可复算/)
    // 复现表两行：f1=0 → 0；f1=1 → 1（条件性计算保留，降级口径不变）
    const zero = runScenario(dir, 'SCN-TST-1', {
      ...dataset,
      candidates: [{ candidateId: 'C1', objectRef: 'A1', features: { f1: 0 }, tags: [] }],
    })
    assert.equal(zero.candidates[0].riskScore, 0)
    assert.equal(zero.candidates[0].pendingVerification, true)
  } finally {
    rmWorkspace(root)
  }
})

test('R5-2 复现场景（prep 开）：同一降级口径；投影缺口不得伪装为可复算事实', () => {
  const pkg = pkgWithF1()
  pkg.scenarios[0].prep = { features: true }
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    savePkg(dir, pkg)
    const dataset = {
      objects: [{ id: 'A1', type: 'OBJ-TST-A', attrs: { a1: 'x' } }],
      relations: [],
      behaviors: [],
      candidates: [{ candidateId: 'C1', objectRef: 'A1', features: { f1: 1 }, tags: [] }],
    }
    const result = runScenario(dir, 'SCN-TST-1', dataset)
    assert.equal(result.candidates[0].riskScore, 1)
    assert.equal(result.candidates[0].pendingVerification, true)
    const feat = result.audit.checks.find((c) => c.check === 'FEATURE_RECOMPUTED')
    assert.equal(feat.closed, false)
    assert.match(feat.detail, /声明契约缺事实/)
  } finally {
    rmWorkspace(root)
  }
})

test('R5-3 正式可信分析：无依据特征不参与计算（拒绝或不使用）', () => {
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    savePkg(dir, pkgWithF1())
    const dataset = {
      objects: [{ id: 'A1', type: 'OBJ-TST-A', attrs: { a1: 'x' } }],
      relations: [],
      behaviors: [],
      candidates: [{ candidateId: 'C1', objectRef: 'A1', features: { f1: 1 }, tags: [] }],
    }
    const result = runScenario(dir, 'SCN-TST-1', dataset, { analysisMode: 'formal' })
    // f1 被剔除 → 规则按缺失特征待核实，不硬判
    const c1 = result.candidates[0]
    assert.equal(c1.riskScore, 0, '无依据值不参与评分')
    assert.ok(c1.pendingChecks.some((p) => Array.isArray(p.missing) && p.missing.includes('f1')))
    assert.ok(c1.pendingChecks.some((p) => /正式可信分析：已剔除/.test(p.note)))
    assert.equal(c1.pendingVerification, true)
  } finally {
    rmWorkspace(root)
  }
})

test('R5-4 正常对象投影与合法配方派生 → 复算通过（closed=true）', () => {
  const base = minimalPkg()
  const pkg = minimalPkg({
    scoreRules: [{
      ...base.scoreRules[0],
      expression: 'min(1, f1)',
      featureSources: { f1: 'OBJ-TST-A' },
    }],
    featureRecipes: [
      { name: 'n', kind: 'count', source: 'behaviors' },
      { name: 'half', kind: 'ratio', num: 'f1', den: 'f1' },
    ],
  })
  pkg.scenarios[0].prep = { features: true }
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    savePkg(dir, pkg)
    const dataset = {
      objects: [{ id: 'A1', type: 'OBJ-TST-A', attrs: { a1: 'x', f1: 0.7 } }],
      relations: [],
      behaviors: [
        { id: 'b1', type: 'BHV-TST-X', anchorRef: 'A1', objectRef: 'A1', occurredAt: '2026-01-01T00:00:00Z' },
      ],
      candidates: [{ candidateId: 'C1', objectRef: 'A1', features: {}, tags: [] }],
    }
    const result = runScenario(dir, 'SCN-TST-1', dataset)
    const feat = result.audit.checks.find((c) => c.check === 'FEATURE_RECOMPUTED')
    assert.equal(feat.closed, true, `对象投影/合法配方可复算：${feat.detail}`)
    assert.equal(feat.detail, '特征均可由对象事实/合法配方复算')
    assert.equal(result.candidates[0].pendingVerification !== true, true, '无冲突无缺口不降级')
  } finally {
    rmWorkspace(root)
  }
})

test('R5-5 配方依赖链：ratio 上游未核实 / 配方缺输入保留预置值 → 状态传播 + 逐候选降级', () => {
  const base = minimalPkg()
  const pkg = minimalPkg({
    scoreRules: [{
      ...base.scoreRules[0],
      expression: 'min(1, r)',
      featureSources: { num: 'OBJ-TST-A', den: 'OBJ-TST-A' },
    }],
    featureRecipes: [
      { name: 'r', kind: 'ratio', num: 'num', den: 'den' },
      { name: 's', kind: 'ratio', num: 'num', den: 'den2' },
    ],
  })
  pkg.scenarios[0].prep = { features: true }
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    savePkg(dir, pkg)
    // den 有对象事实；num 声明源缺失（调用方 8）→ r=8/4 算得出但上游未核实
    // s 的 den2 缺输入 → SKIP，调用方 99 不得伪装为派生事实
    const dataset = {
      objects: [{ id: 'A1', type: 'OBJ-TST-A', attrs: { a1: 'x', den: 4 } }],
      relations: [],
      behaviors: [],
      candidates: [{
        candidateId: 'C1',
        objectRef: 'A1',
        features: { num: 8, den: 4, s: 99 },
        tags: [],
      }],
    }
    const result = runScenario(dir, 'SCN-TST-1', dataset)
    const c1 = result.candidates[0]
    // ratio 保留条件性计算（explore）：8/4=2 → clamp 后 min(1,2)=1
    assert.equal(c1.riskScore, 1)
    assert.equal(c1.pendingVerification, true)
    assert.ok(
      c1.pendingChecks.some((p) => /特征 r 无事实依据.*ratio.*上游未核实/.test(p.note)),
      JSON.stringify(c1.pendingChecks),
    )
    assert.ok(
      c1.pendingChecks.some((p) => /特征 s 无事实依据.*保留调用方值/.test(p.note)),
      '配方缺输入而保留预置值同样不得伪装为派生事实',
    )
    assert.ok(c1.pendingChecks.some((p) => /特征 num 无事实依据/.test(p.note)))
    const feat = result.audit.checks.find((c) => c.check === 'FEATURE_RECOMPUTED')
    assert.equal(feat.closed, false)
  } finally {
    rmWorkspace(root)
  }
})

test('R5-6 供数身份：connector 才是可信供数；file/inline/未声明不得冒充', () => {
  const pkg = pkgWithF1()
  const ds = (provenance) => ({
    objects: [{ id: 'A1', type: 'OBJ-TST-A', attrs: { a1: 'x', f1: 0.5 } }],
    relations: [],
    behaviors: [],
    candidates: [{ candidateId: 'C1', objectRef: 'A1', features: { f1: 0.5 }, tags: [] }],
    ...(provenance !== undefined ? { provenance } : {}),
  })
  // projectFeatures：provenance=connector → connector；否则 object-fact（不冒充）
  const d0 = ds('connector')
  const pConnector = projectFeatures(pkg, d0, d0.candidates)
  assert.equal(pConnector.sources.find((s) => s.key === 'f1')?.source, 'connector')
  for (const prov of ['file', 'inline', undefined]) {
    const d = ds(prov)
    const p = projectFeatures(pkg, d, d.candidates)
    assert.equal(p.sources.find((s) => s.key === 'f1')?.source, 'object-fact', `provenance=${String(prov)}`)
  }
  // inferFeatureSources 同口径
  const d1 = ds('connector')
  const inferred = inferFeatureSources(pkg, d1, d1.candidates)
  assert.equal(inferred.find((s) => s.key === 'f1')?.source, 'connector')
  // 声明源缺失时即使 provenance=connector 也只是调用方值（不得因 connector 身份放行）
  const missing = {
    objects: [{ id: 'A1', type: 'OBJ-TST-A', attrs: { a1: 'x' } }],
    relations: [],
    behaviors: [],
    candidates: [{ candidateId: 'C1', objectRef: 'A1', features: { f1: 0.5 }, tags: [] }],
    provenance: 'connector',
  }
  const rec = inferFeatureSources(pkg, missing, missing.candidates).find((s) => s.key === 'f1')
  assert.equal(rec?.source, 'unverified-caller')
  assert.equal(rec?.declared, true)
})

test('R5-7 deriveFeatures：来源状态含实际输入与计算条件；未核实预置值保留时显式降级', () => {
  const ds = {
    objects: [{ id: 'i1', type: 'OBJ-TST-A', attrs: { a1: 'x', lastEmptiedAt: '2026-11-01T00:00:00Z' } }],
    relations: [],
    behaviors: [],
    candidates: [{ candidateId: 'c1', objectRef: 'i1', features: { x: 5 }, tags: [] }],
  }
  const ok = deriveFeatures(ds.candidates, ds, [
    { name: 'overdueHours', kind: 'since', attr: 'lastEmptiedAt', now: '2026-11-01T12:00:00Z' },
  ])
  const rec = ok.sources.find((s) => s.key === 'overdueHours')
  assert.equal(rec?.source, 'derived')
  assert.match(rec?.detail ?? '', /since\(attr=lastEmptiedAt,now=2026-11-01T12:00:00Z\)/, '记录实际输入与计算条件')
  // 上游缺失（缺 now）→ SKIP，调用方预置值不得伪装为派生事实
  const skipped = deriveFeatures(ds.candidates, ds, [{ name: 'x', kind: 'since', attr: 'lastEmptiedAt' }])
  const skipRec = skipped.sources.find((s) => s.key === 'x')
  assert.equal(skipRec?.source, 'unverified-caller')
  assert.equal(skipRec?.declared, true)
})

test('R5-8 正式剔除后 FEATURE_RECOMPUTED 须按来源记录全集计数（不得假报「复算通过」）', () => {
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    savePkg(dir, pkgWithF1())
    const dataset = {
      objects: [{ id: 'A1', type: 'OBJ-TST-A', attrs: { a1: 'x' } }],
      relations: [],
      behaviors: [],
      candidates: [{ candidateId: 'C1', objectRef: 'A1', features: { f1: 1 }, tags: [] }],
    }
    const result = runScenario(dir, 'SCN-TST-1', dataset, { analysisMode: 'formal' })
    // f1 已被 formal 剔除（不入分）——审计仍须按 provenance 记录数到它
    assert.equal(result.candidates[0].riskScore, 0, '无依据值不参与评分')
    const feat = result.audit.checks.find((c) => c.check === 'FEATURE_RECOMPUTED')
    assert.equal(feat.closed, false, '被剔除键不得消失于核对面而假报复算通过')
    assert.match(feat.detail, /不可复算/)
  } finally {
    rmWorkspace(root)
  }
})

test('R5-9 ratio 上游无来源记录（直调 prior 缺省）→ 不得误标 derived', () => {
  const ds = {
    objects: [{ id: 'i1', type: 'OBJ-TST-A', attrs: { a1: 'x' } }],
    relations: [],
    behaviors: [],
    candidates: [{ candidateId: 'c1', objectRef: 'i1', features: { num: 8, den: 4 }, tags: [] }],
  }
  // prior 缺省 []：num/den 只有调用方值、无来源记录 → ratio 不可复算（fail-closed）
  const r = deriveFeatures(ds.candidates, ds, [{ name: 'ratio', kind: 'ratio', num: 'num', den: 'den' }])
  const rec = r.sources.find((s) => s.key === 'ratio')
  assert.equal(rec?.source, 'unverified-caller', '上游无来源记录不得视为可复算')
  assert.match(rec?.detail ?? '', /上游未核实/)
})
