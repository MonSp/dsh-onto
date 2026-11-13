/** 特征投影与派生验收（subgraph-expansion S4.1/S4.2 / S5 A-6、A-7）：类型匹配、不覆盖、now 注入、三类配方。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectFeatures, deriveFeatures, runScenario } from '../dist/index.js'
import { derivePackage, minimalPkg, mkWorkspaceWithPkg, rmWorkspace } from './helpers.mjs'

const pkgWithSources = (featureSources) =>
  minimalPkg({
    scoreRules: [{ ...minimalPkg().scoreRules[0], featureSources }],
    exclusionRules: [{ ...minimalPkg().exclusionRules[0], featureSources }],
  })

const dataset = () => ({
  objects: [
    { id: 'i1', type: 'OBJ-TST-A', attrs: { f1: 0.7, a1: 'x', lastEmptiedAt: '2026-11-01T00:00:00Z', num: 8, den: 4 } },
    { id: 'i2', type: 'OBJ-TST-B', attrs: { b1: 1.5, den: 1 } },
  ],
  relations: [{ id: 'r1', type: 'REL-TST-AB', from: 'i1', to: 'i2', attrs: { r1: 'z' } }],
  behaviors: [
    { id: 'bh1', type: 'BHV-TST-X', anchorRef: 'i1', objectRef: 'i1', occurredAt: '2026-01-01T00:00:00Z' },
    { id: 'bh2', type: 'BHV-TST-X', anchorRef: 'i2', objectRef: 'i2', occurredAt: '2026-01-02T00:00:00Z' },
    { id: 'bh3', type: 'BHV-TST-Y', anchorRef: 'i1', objectRef: 'i1', occurredAt: '2026-01-03T00:00:00Z' },
  ],
  candidates: [
    { candidateId: 'c1', objectRef: 'i1', features: {}, tags: [] },
    { candidateId: 'c2', objectRef: 'i2', features: { b1: 9 }, tags: [] },
  ],
})

test('projectFeatures：featureSources 类型匹配才投影；已有键默认不覆盖（A-6）', () => {
  const pkg = pkgWithSources({ f1: 'OBJ-TST-A', b1: 'OBJ-TST-B' })
  const ds = dataset()
  const { candidates, projected } = projectFeatures(pkg, ds, ds.candidates)
  const c1 = candidates.find((c) => c.candidateId === 'c1')
  const c2 = candidates.find((c) => c.candidateId === 'c2')
  // c1：i1 是 OBJ-TST-A → f1=0.7 投影；b1 声明给 OBJ-TST-B，类型不匹配不投
  assert.equal(c1.features.f1, 0.7)
  assert.ok(!('b1' in c1.features))
  // c2：b1 已有显式值 9 → 默认不覆盖
  assert.equal(c2.features.b1, 9)
  const p1 = projected.find((p) => p.candidateId === 'c1')
  assert.deepEqual(p1.keys, ['f1'])
  const p2 = projected.find((p) => p.candidateId === 'c2')
  assert.deepEqual(p2.keys, [], '类型匹配但键已存在（不覆盖）→ keys 空即缺口记录')
  // 入参不改写
  assert.deepEqual(ds.candidates[0].features, {})
})

test('projectFeatures：overwrite=true 才覆盖；score+exclusion featureSources 并集', () => {
  const pkg = pkgWithSources({ b1: 'OBJ-TST-B' })
  const ds = dataset()
  const { candidates } = projectFeatures(pkg, ds, ds.candidates, { overwrite: true })
  const c2 = candidates.find((c) => c.candidateId === 'c2')
  assert.equal(c2.features.b1, 1.5, 'overwrite=true 用对象 attrs 覆盖显式值')
  // 并集：score 声明 f1、exclusion 声明 b1 → 两者都投
  const pkg2 = minimalPkg({
    scoreRules: [{ ...minimalPkg().scoreRules[0], featureSources: { f1: 'OBJ-TST-A' } }],
    exclusionRules: [{ ...minimalPkg().exclusionRules[0], featureSources: { b1: 'OBJ-TST-B' } }],
  })
  const ds2 = dataset()
  const r2 = projectFeatures(pkg2, ds2, ds2.candidates)
  assert.equal(r2.candidates.find((c) => c.candidateId === 'c1').features.f1, 0.7)
  assert.equal(r2.candidates.find((c) => c.candidateId === 'c2').features.b1, 9, '默认仍不覆盖')
})

test('projectFeatures：属性缺失/非 number|string 值不投影；无 featureSources 零改动', () => {
  const pkg = pkgWithSources({ nope: 'OBJ-TST-A', a1: 'OBJ-TST-A' })
  const ds = dataset()
  ds.objects[0].attrs.boolAttr = true
  const pkgBool = pkgWithSources({ boolAttr: 'OBJ-TST-A' })
  const r = projectFeatures(pkgBool, ds, ds.candidates)
  assert.ok(!('boolAttr' in r.candidates[0].features), 'boolean 不是合法特征值类型')
  const r2 = projectFeatures(pkg, ds, ds.candidates)
  // nope 属性不存在 → 不写；a1 是 string 合法 → 投影
  assert.ok(!('nope' in r2.candidates[0].features))
  assert.equal(r2.candidates[0].features.a1, 'x')
  // 无任何 featureSources 声明：零改动
  const bare = minimalPkg()
  const r3 = projectFeatures(bare, ds, ds.candidates)
  assert.deepEqual(r3.candidates[0].features, {})
  assert.deepEqual(r3.projected.map((p) => p.keys), [[], []])
})

test('deriveFeatures since：now 注入两次逐字节一致；缺 now/负值/坏日期跳过（A-7）', () => {
  const ds = dataset()
  const recipes = [
    { name: 'overdueHours', kind: 'since', attr: 'lastEmptiedAt', now: '2026-11-01T12:00:00Z' },
  ]
  const a = deriveFeatures(ds.candidates, ds, recipes)
  const b = deriveFeatures(ds.candidates, ds, recipes)
  assert.equal(JSON.stringify(a), JSON.stringify(b), '同输入两次派生逐字节一致')
  const c1 = a.candidates.find((c) => c.candidateId === 'c1')
  assert.equal(c1.features.overdueHours, 12)
  const c2 = a.candidates.find((c) => c.candidateId === 'c2')
  assert.ok(!('overdueHours' in c2.features), 'i2 无 lastEmptiedAt → 跳过不写')
  assert.deepEqual(a.derived, ['overdueHours'])
  // 缺 now：不调用 new Date()，确定性跳过
  const noNow = deriveFeatures(ds.candidates, ds, [{ name: 'x', kind: 'since', attr: 'lastEmptiedAt' }])
  assert.ok(!('x' in noNow.candidates[0].features))
  assert.deepEqual(noNow.derived, [])
  // 负值（attr 在 now 之后）→ 跳过
  const neg = deriveFeatures(ds.candidates, ds, [
    { name: 'x', kind: 'since', attr: 'lastEmptiedAt', now: '2026-10-01T00:00:00Z' },
  ])
  assert.ok(!('x' in neg.candidates[0].features))
  // 坏日期 → 跳过
  const bad = dataset()
  bad.objects[0].attrs.lastEmptiedAt = 'not-a-date'
  const badR = deriveFeatures(bad.candidates, bad, recipes)
  assert.ok(!('overdueHours' in badR.candidates[0].features))
})

test('deriveFeatures count：按 candidate objectRef 关联实例 + type 过滤', () => {
  const ds = dataset()
  const filtered = deriveFeatures(ds.candidates, ds, [
    { name: 'xCount', kind: 'count', source: 'behaviors', filter: { type: 'BHV-TST-X' } },
  ])
  assert.equal(filtered.candidates.find((c) => c.candidateId === 'c1').features.xCount, 1, 'i1 关联 BHV-TST-X 仅 bh1')
  assert.equal(filtered.candidates.find((c) => c.candidateId === 'c2').features.xCount, 1, 'i2 关联 bh2')
  // 无 filter：i1 关联 bh1+bh3 = 2
  const all = deriveFeatures(ds.candidates, ds, [{ name: 'n', kind: 'count', source: 'behaviors' }])
  assert.equal(all.candidates.find((c) => c.candidateId === 'c1').features.n, 2)
  // relations 源：from/to 关联
  const rel = deriveFeatures(ds.candidates, ds, [{ name: 'deg', kind: 'count', source: 'relations' }])
  assert.equal(rel.candidates.find((c) => c.candidateId === 'c1').features.deg, 1)
  assert.equal(rel.candidates.find((c) => c.candidateId === 'c2').features.deg, 1)
  // 无关联 → 写 0（0 是合法特征值）
  const zero = deriveFeatures(ds.candidates, ds, [
    { name: 'z', kind: 'count', source: 'behaviors', filter: { type: 'BHV-TST-NOPE' } },
  ])
  assert.equal(zero.candidates.find((c) => c.candidateId === 'c1').features.z, 0)
  // core 裸调：count 缺 source（工具面已拦）→ 跳过不写，不静默落 0
  const badSrc = deriveFeatures(ds.candidates, ds, [{ name: 'z', kind: 'count' }])
  assert.ok(!('z' in badSrc.candidates[0].features))
  assert.deepEqual(badSrc.derived, [])
})

test('deriveFeatures ratio：num/den；minDen 不足或 0 分母跳过；可消费先前派生值', () => {
  const ds = dataset()
  ds.candidates[0].features = { num: 8, den: 4 }
  const r = deriveFeatures(ds.candidates, ds, [{ name: 'r', kind: 'ratio', num: 'num', den: 'den' }])
  assert.equal(r.candidates.find((c) => c.candidateId === 'c1').features.r, 2, '8/4=2')
  const c2 = r.candidates.find((c) => c.candidateId === 'c2')
  assert.ok(!('r' in c2.features), 'i2 候选无 num → 跳过')
  // minDen：den=1 < 5 → 跳过
  const md = dataset()
  md.candidates[1].features = { b1: 9, den: 1 }
  const minDen = deriveFeatures(md.candidates, md, [
    { name: 'r', kind: 'ratio', num: 'b1', den: 'den', minDen: 5 },
  ])
  assert.ok(!('r' in minDen.candidates.find((c) => c.candidateId === 'c2').features))
  // 0 分母（无 minDen）→ 跳过防除零
  const zeroDen = dataset()
  zeroDen.candidates[0].features = { num: 8, den: 0 }
  const z = deriveFeatures(zeroDen.candidates, zeroDen, [{ name: 'r', kind: 'ratio', num: 'num', den: 'den' }])
  assert.ok(!('r' in z.candidates[0].features))
  // 配方顺序：ratio 消费先前 since/count 写入的键
  const seq = deriveFeatures(ds.candidates, ds, [
    { name: 'n', kind: 'count', source: 'behaviors', filter: { type: 'BHV-TST-X' } },
    { name: 'half', kind: 'ratio', num: 'n', den: 'n' },
  ])
  const c1 = seq.candidates.find((c) => c.candidateId === 'c1')
  assert.equal(c1.features.n, 1)
  assert.equal(c1.features.half, 1)
  assert.deepEqual(seq.derived, ['n', 'half'])
})

test('deriveFeatures：入参 candidates/dataset 不被改写（纯函数）', () => {
  const ds = dataset()
  const before = JSON.stringify(ds)
  deriveFeatures(ds.candidates, ds, [
    { name: 'overdueHours', kind: 'since', attr: 'lastEmptiedAt', now: '2026-11-01T12:00:00Z' },
    { name: 'xCount', kind: 'count', source: 'behaviors' },
  ])
  assert.equal(JSON.stringify(ds), before)
})

test('验收 S2.2：投影后排除特征缺口收敛（exclusionFeatureGaps → 0，排除规则生效）', () => {
  const { dir, root, pkg } = mkWorkspaceWithPkg({
    exclusionRules: [
      {
        id: 'RULE-TST-E1',
        name: '实验室专线',
        action: 'drop',
        condition: "zone == 'lab'",
        featureSources: { zone: 'OBJ-TST-A' },
      },
    ],
  })
  try {
    derivePackage(dir)
    const ds = {
      objects: [
        { id: 'i1', type: 'OBJ-TST-A', attrs: { zone: 'lab', f1: 0.9 } },
        { id: 'i2', type: 'OBJ-TST-A', attrs: { zone: 'dorm', f1: 0.8 } },
      ],
      relations: [],
      candidates: [
        { candidateId: 'c1', objectRef: 'i1', features: { f1: 0.9 }, tags: [] },
        { candidateId: 'c2', objectRef: 'i2', features: { f1: 0.8 }, tags: [] },
      ],
    }
    // 投影前：zone 未进 features → 排除条件缺口显式上墙
    const before = runScenario(dir, 'SCN-TST-1', ds)
    assert.ok(
      (before.exclusionFeatureGaps ?? []).some((g) => g.missing.includes('zone')),
      '投影前应有 zone 缺口',
    )
    // 投影后：缺口清零，zone=='lab' 的 c1 被 drop
    const proj = projectFeatures(pkg, ds, ds.candidates)
    assert.equal(proj.candidates.find((c) => c.candidateId === 'c1').features.zone, 'lab')
    const after = runScenario(dir, 'SCN-TST-1', { ...ds, candidates: proj.candidates })
    assert.deepEqual(after.exclusionFeatureGaps ?? [], [], '投影后缺口应清零')
    assert.deepEqual(after.excluded.map((e) => e.candidateId), ['c1'])
    assert.ok(after.candidates.some((c) => c.candidateId === 'c2'), '非 lab 候选存活')
  } finally {
    rmWorkspace(root)
  }
})
