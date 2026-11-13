/** 校验器验收（规范 §7 / §11.3）：引用闭合 / 权重 / 字典 / 事件口径 / 质量分。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildQualityReport, validatePackage, validatePackageDir, savePackage } from '../dist/index.js'
import { minimalPkg, mkWorkspaceWithPkg, writeRaw, rmWorkspace } from './helpers.mjs'

test('合法包：0 error', () => {
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    const { errors } = validatePackageDir(dir)
    assert.equal(errors.length, 0, JSON.stringify(errors))
  } finally {
    rmWorkspace(root)
  }
})

test('权重合计 ≠ 1.0 → WEIGHT_SUM error', () => {
  const pkg = minimalPkg()
  pkg.scoreRules[0].weight = 0.5
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    savePackage(dir, pkg)
    const { errors } = validatePackageDir(dir)
    assert.ok(errors.some((e) => e.code === 'WEIGHT_SUM'))
  } finally {
    rmWorkspace(root)
  }
})

test('悬空引用（关系 to 不存在）→ REF_UNCLOSED error', () => {
  const pkg = minimalPkg()
  pkg.relations[0].to = 'OBJ-TST-MISSING'
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    savePackage(dir, pkg)
    const { errors } = validatePackageDir(dir)
    assert.ok(errors.some((e) => e.code === 'REF_UNCLOSED' && e.message.includes('OBJ-TST-MISSING')))
  } finally {
    rmWorkspace(root)
  }
})

test('方法论模板权重集合与规则集合不一致 → WEIGHT_SET_MISMATCH error', () => {
  const pkg = minimalPkg()
  pkg.skillTemplates[0].weights = { 'RULE-TST-S1': 0.7 }
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    savePackage(dir, pkg)
    const { errors } = validatePackageDir(dir)
    assert.ok(errors.some((e) => e.code === 'WEIGHT_SET_MISMATCH'))
  } finally {
    rmWorkspace(root)
  }
})

test('字典不可解析（enumValuesRef 悬空）→ DICT_UNRESOLVED error', () => {
  const pkg = minimalPkg()
  pkg.objects[0].attributes[1].enumValuesRef = 'dict-missing'
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    savePackage(dir, pkg)
    const { errors } = validatePackageDir(dir)
    assert.ok(errors.some((e) => e.code === 'DICT_UNRESOLVED'))
  } finally {
    rmWorkspace(root)
  }
})

test('事件不进 Schema：源文件出现 events 建模元素 → EVENTS_IN_SCHEMA error', () => {
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    writeRaw(dir, 'o1-objects/object-types.yaml', 'kind: O1ObjectTypes\nobjects: []\nevents:\n  - id: EV-1\n    name: 伪事件\n')
    const { errors } = validatePackageDir(dir)
    assert.ok(errors.some((e) => e.code === 'EVENTS_IN_SCHEMA'))
  } finally {
    rmWorkspace(root)
  }
})

test('属性引用不可解析（OBJ.attr）→ ATTR_UNRESOLVED error', () => {
  const pkg = minimalPkg()
  pkg.fieldMaps[0].target = 'OBJ-TST-A.noSuchAttr'
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    savePackage(dir, pkg)
    const { errors } = validatePackageDir(dir)
    assert.ok(errors.some((e) => e.code === 'ATTR_UNRESOLVED'))
  } finally {
    rmWorkspace(root)
  }
})

test('场景 skillRefs 悬空 → REF_UNCLOSED error', () => {
  const pkg = minimalPkg()
  pkg.scenarios[0].pipeline[4].skillRefs = ['SKL-MISSING']
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    savePackage(dir, pkg)
    const { errors } = validatePackageDir(dir)
    assert.ok(errors.some((e) => e.code === 'REF_UNCLOSED' && e.message.includes('SKL-MISSING')))
  } finally {
    rmWorkspace(root)
  }
})

test('质量分 = clamp(0,100, 100-10E-2W)', () => {
  const pkg = minimalPkg()
  pkg.scoreRules[0].weight = 0.5 // 1 error
  pkg.scenarios[0].pipeline[4].skillRefs = ['SKL-MISSING'] // 1 more error
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    savePackage(dir, pkg)
    const report = buildQualityReport(dir)
    assert.equal(report.passed, false)
    // score = 100 - 10×errors - 2×warnings，clamp [0,100]
    const expect = Math.max(0, Math.min(100, 100 - 10 * report.errors.length - 2 * report.warnings.length))
    assert.equal(report.score, expect)
    assert.ok(report.score < 100)
  } finally {
    rmWorkspace(root)
  }
})

test('info 覆盖统计不扣分', () => {
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    const report = buildQualityReport(dir)
    assert.ok(report.info.some((i) => i.code === 'COVERAGE'))
    const expect = Math.max(0, Math.min(100, 100 - 10 * report.errors.length - 2 * report.warnings.length))
    assert.equal(report.score, expect)
  } finally {
    rmWorkspace(root)
  }
})

test('DUP_ID：同类与跨类（score/exclusion 共用 RULE-*）ID 重复均报 error', () => {
  const pkg = minimalPkg()
  // 同类重复：两个对象同 ID
  pkg.objects.push({ id: 'OBJ-TST-A', name: '重复对象', attributes: [] })
  // 跨类重复：exclusionRules 与 scoreRules 撞 RULE-TST-S1
  pkg.exclusionRules[0].id = 'RULE-TST-S1'
  const { errors } = validatePackage(pkg)
  const dups = errors.filter((e) => e.code === 'DUP_ID')
  assert.equal(dups.length, 2, JSON.stringify(dups))
  assert.ok(dups.some((e) => e.message.includes('OBJ-TST-A')))
  assert.ok(dups.some((e) => e.message.includes('RULE-TST-S1')))
})

test('ID_EMPTY：空 ID 元素报 error，不再静默逃过检查', () => {
  const pkg = minimalPkg()
  pkg.objects.push({ id: '', name: '空 ID 对象', attributes: [] })
  const { errors } = validatePackage(pkg)
  const empties = errors.filter((e) => e.code === 'ID_EMPTY')
  assert.equal(empties.length, 1, JSON.stringify(empties))
  assert.ok(empties[0].message.includes('为空'))
})

test('表达式语法错误 → EXPR_INVALID（round-13：门禁拦截，不漏到运行时）', () => {
  const pkg = minimalPkg()
  pkg.scoreRules[0].expression = 'min(1, f1'  // 括号未闭合
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    savePackage(dir, pkg)
    const { errors } = validatePackageDir(dir)
    const hits = errors.filter((e) => e.code === 'EXPR_INVALID')
    assert.ok(hits.length >= 1, JSON.stringify(errors))
    assert.ok(hits.some((e) => e.message.includes('打分表达式')), JSON.stringify(hits))
  } finally {
    rmWorkspace(root)
  }
})

test('排除条件语法错误 → EXPR_INVALID（round-13：不再静默漏到运行时）', () => {
  const pkg = minimalPkg()
  pkg.exclusionRules[0].condition = 'tag =='  // 操作数缺失
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    savePackage(dir, pkg)
    const { errors } = validatePackageDir(dir)
    const hits = errors.filter((e) => e.code === 'EXPR_INVALID')
    assert.ok(hits.length >= 1, JSON.stringify(errors))
    assert.ok(hits.some((e) => e.message.includes('排除条件')), JSON.stringify(hits))
  } finally {
    rmWorkspace(root)
  }
})

test('SCN-* 入口豁免 ID_UNREFERENCED；behaviorRefs/exclusionRefs 引用位闭合（v1.1）', () => {
  // 1) 场景入口天然无上游 → 不再报 ID_UNREFERENCED
  const vb = validatePackage(minimalPkg())
  assert.ok(!vb.warnings.some((w) => w.code === 'ID_UNREFERENCED' && w.where === 'SCN-TST-1'), 'SCN 入口豁免')
  // 基线：行为/排除此时未被引用（为下一步对照）
  assert.ok(vb.warnings.some((w) => w.where === 'BHV-TST-X'))
  assert.ok(vb.warnings.some((w) => w.where === 'RULE-TST-E1'))

  // 2) 显式引用位：闭合通过，且消掉行为/排除的 ID_UNREFERENCED
  const p2 = minimalPkg({
    scenarios: [{
      ...minimalPkg().scenarios[0],
      behaviorRefs: ['BHV-TST-X'],
      exclusionRefs: ['RULE-TST-E1'],
    }],
  })
  const v2 = validatePackage(p2)
  assert.ok(!v2.errors.some((e) => e.code === 'REF_UNCLOSED'), JSON.stringify(v2.errors))
  assert.ok(!v2.warnings.some((w) => w.code === 'ID_UNREFERENCED' && (w.where === 'BHV-TST-X' || w.where === 'RULE-TST-E1')))

  // 3) 悬空 / 错类型 → REF_UNCLOSED
  const p3 = minimalPkg({
    scenarios: [{
      ...minimalPkg().scenarios[0],
      behaviorRefs: ['BHV-TST-GONE'],
      exclusionRefs: ['OBJ-TST-A'],
    }],
  })
  const v3 = validatePackage(p3)
  assert.ok(v3.errors.some((e) => e.code === 'REF_UNCLOSED' && e.message.includes('behaviorRefs')))
  assert.ok(v3.errors.some((e) => e.code === 'REF_UNCLOSED' && e.message.includes('exclusionRefs')))
})

test('scoreRefs 引用位：闭合校验 + 悬空/错类型 → REF_UNCLOSED', () => {
  const base = minimalPkg()
  // 有效：scoreRefs 指向打分规则
  const ok = minimalPkg({
    scenarios: [{ ...base.scenarios[0], scoreRefs: ['RULE-TST-S1'] }],
  })
  const v1 = validatePackage(ok)
  assert.ok(!v1.errors.some((e) => e.code === 'REF_UNCLOSED' && e.message.includes('scoreRefs')), JSON.stringify(v1.errors))
  // 悬空 / 错类型
  const bad = minimalPkg({
    scenarios: [{ ...base.scenarios[0], scoreRefs: ['RULE-TST-GONE', 'RULE-TST-E1'] }],
  })
  const v2 = validatePackage(bad)
  assert.ok(v2.errors.some((e) => e.code === 'REF_UNCLOSED' && e.message.includes('scoreRefs') && e.message.includes('RULE-TST-GONE')))
  assert.ok(v2.errors.some((e) => e.code === 'REF_UNCLOSED' && e.message.includes('scoreRefs') && e.message.includes('RULE-TST-E1')), '排除规则不能进 scoreRefs')
  // 显式空数组：运行侧会收窄到 0 条规则 → 校验即拒
  const empty = minimalPkg({
    scenarios: [{ ...base.scenarios[0], scoreRefs: [] }],
  })
  const v3 = validatePackage(empty)
  assert.ok(
    v3.errors.some((e) => e.code === 'REF_UNCLOSED' && e.message.includes('scoreRefs') && e.message.includes('空数组')),
    'scoreRefs 空数组必须报错: ' + JSON.stringify(v3.errors),
  )
})

test('D14：场景阈值超过 scoreRefs 圈内权重和 → REVIEW_GATE_UNREACHABLE（闸值不可达）', () => {
  const base = minimalPkg()
  const rules = [
    { id: 'RULE-TST-S1', name: '规则一', weight: 0.6, expression: 'min(1, f1)', threshold: 0.5, evidenceTemplate: 'f1 = {f1}' },
    { id: 'RULE-TST-S2', name: '规则二', weight: 0.4, expression: 'min(1, f2)', threshold: 0.5, evidenceTemplate: 'f2 = {f2}' },
  ]
  const skills = [
    { id: 'SKL-TST-N', name: '叙述', weights: { 'RULE-TST-S1': 0.6, 'RULE-TST-S2': 0.4 }, steps: [], outputTemplate: '' },
  ]
  // 圈内和 0.6、阈值 0.75 → 不可达
  const bad = minimalPkg({
    scoreRules: rules,
    skillTemplates: skills,
    scenarios: [{
      ...base.scenarios[0],
      scoreRefs: ['RULE-TST-S1'],
      reviewGate: { required: true, threshold: 0.75 },
    }],
  })
  const v1 = validatePackage(bad)
  assert.ok(
    v1.errors.some((e) => e.code === 'REVIEW_GATE_UNREACHABLE' && e.message.includes('0.75')),
    '阈值>圈内和必须报错: ' + JSON.stringify(v1.errors),
  )
  // 阈值 == 圈内和 → 允许（理论可达）
  const edge = minimalPkg({
    scoreRules: rules,
    skillTemplates: skills,
    scenarios: [{
      ...base.scenarios[0],
      scoreRefs: ['RULE-TST-S1'],
      reviewGate: { required: true, threshold: 0.6 },
    }],
  })
  const v2 = validatePackage(edge)
  assert.ok(!v2.errors.some((e) => e.code === 'REVIEW_GATE_UNREACHABLE'), '阈值=圈内和应通过')
  // 无 scoreRefs（包级和=1.0）阈值 0.75 → 不受影响
  const noRefs = minimalPkg({
    scoreRules: rules,
    skillTemplates: skills,
    scenarios: [{ ...base.scenarios[0], reviewGate: { required: true, threshold: 0.75 } }],
  })
  const v3 = validatePackage(noRefs)
  assert.ok(!v3.errors.some((e) => e.code === 'REVIEW_GATE_UNREACHABLE'), '缺省场景不受此检查影响')
})

test('D14-warn：阈值超过圈内权重和 90% → REVIEW_GATE_TIGHT（仅近满分可触发）', () => {
  const base = minimalPkg()
  const rules = [
    { id: 'RULE-TST-S1', name: '规则一', weight: 0.6, expression: 'min(1, f1)', threshold: 0.5, evidenceTemplate: 'f1 = {f1}' },
    { id: 'RULE-TST-S2', name: '规则二', weight: 0.4, expression: 'min(1, f2)', threshold: 0.5, evidenceTemplate: 'f2 = {f2}' },
  ]
  const skills = [
    { id: 'SKL-TST-N', name: '叙述', weights: { 'RULE-TST-S1': 0.6, 'RULE-TST-S2': 0.4 }, steps: [], outputTemplate: '' },
  ]
  // 圈内和 0.6：阈值 0.56（>0.54 且 ≤0.6）→ tight warn，不 error
  const pkg = minimalPkg({
    scoreRules: rules,
    skillTemplates: skills,
    scenarios: [{
      ...base.scenarios[0],
      scoreRefs: ['RULE-TST-S1'],
      reviewGate: { required: true, threshold: 0.56 },
    }],
  })
  const v = validatePackage(pkg)
  assert.ok(!v.errors.some((e) => e.code === 'REVIEW_GATE_UNREACHABLE'))
  assert.ok(
    v.warnings.some((w) => w.code === 'REVIEW_GATE_TIGHT' && w.message.includes('0.56')),
    '阈值>圈内和90% 须 warn: ' + JSON.stringify(v.warnings),
  )
  // 阈值 0.50（≤0.54）→ 无 tight warn
  const okPkg = minimalPkg({
    scoreRules: rules,
    skillTemplates: skills,
    scenarios: [{
      ...base.scenarios[0],
      scoreRefs: ['RULE-TST-S1'],
      reviewGate: { required: true, threshold: 0.5 },
    }],
  })
  const v2 = validatePackage(okPkg)
  assert.ok(!v2.warnings.some((w) => w.code === 'REVIEW_GATE_TIGHT'), '阈值≤90% 不应 warn')
})

/* ── 签发门禁 assertIssueReady（实测 P0：空壳可签发 / 坏包可签发） ── */

test('assertIssueReady：合法包通过并完成派生（签完即可加载）', async () => {
  const { assertIssueReady, verifyDerived } = await import('../dist/index.js')
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    // P0-2：有排除规则须显式 exclusionRefs 才能签发
    savePackage(dir, minimalPkg({
      scenarios: [{ ...minimalPkg().scenarios[0], exclusionRefs: ['RULE-TST-E1'] }],
    }))
    const r = assertIssueReady(dir)
    assert.ok(r.score > 0)
    assert.ok(r.scenarios >= 1 && r.scoreRules >= 1)
    assert.ok(r.sources >= 1 && r.derived >= 1)
    const gate = verifyDerived(dir)
    assert.equal(gate.ok, true, `门禁须过: ${gate.reason}`)
  } finally {
    rmWorkspace(root)
  }
})

test('assertIssueReady：有排除规则但场景缺 exclusionRefs → ISSUE_GATE_EXCL_REFS', async () => {
  const { assertIssueReady, PackageStoreError } = await import('../dist/index.js')
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    try {
      assertIssueReady(dir)
      assert.fail('缺 exclusionRefs 不得过签发门禁')
    } catch (e) {
      assert.ok(e instanceof PackageStoreError, String(e))
      assert.equal(e.code, 'ISSUE_GATE_EXCL_REFS')
      assert.match(e.message, /exclusionRefs/)
    }
  } finally {
    rmWorkspace(root)
  }
})

test('assertIssueReady：无场景空壳 → ISSUE_GATE_EMPTY', async () => {
  const { assertIssueReady, PackageStoreError } = await import('../dist/index.js')
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    const pkg = minimalPkg()
    pkg.scenarios = []
    savePackage(dir, pkg)
    try {
      assertIssueReady(dir)
      assert.fail('无场景包不得过签发门禁')
    } catch (e) {
      assert.ok(e instanceof PackageStoreError, String(e))
      assert.equal(e.code, 'ISSUE_GATE_EMPTY')
      assert.match(e.message, /场景/)
    }
  } finally {
    rmWorkspace(root)
  }
})

test('assertIssueReady：校验错误 → ISSUE_GATE_VALIDATION（先于派生）', async () => {
  const { assertIssueReady, PackageStoreError } = await import('../dist/index.js')
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    const pkg = minimalPkg()
    pkg.relations[0].to = 'OBJ-TST-MISSING'
    savePackage(dir, pkg)
    try {
      assertIssueReady(dir)
      assert.fail('带 error 的包不得过签发门禁')
    } catch (e) {
      assert.ok(e instanceof PackageStoreError, String(e))
      assert.equal(e.code, 'ISSUE_GATE_VALIDATION')
      assert.match(e.message, /REF_UNCLOSED/)
    }
  } finally {
    rmWorkspace(root)
  }
})

test('featureSources：规则→O1 引用闭合（v0.2.1）', () => {
  const ok = minimalPkg({
    scoreRules: [{ ...minimalPkg().scoreRules[0], featureSources: { f1: 'OBJ-TST-A' } }],
    exclusionRules: [{ ...minimalPkg().exclusionRules[0], featureSources: { tag: 'REL-TST-AB' } }],
  })
  const v1 = validatePackage(ok)
  assert.ok(!v1.errors.some((e) => e.code === 'REF_UNCLOSED' && e.message.includes('featureSources')), JSON.stringify(v1.errors))

  const bad = minimalPkg({
    scoreRules: [{ ...minimalPkg().scoreRules[0], featureSources: { f1: 'OBJ-TST-GONE', f2: 'not-an-id' } }],
  })
  const v2 = validatePackage(bad)
  assert.ok(v2.errors.some((e) => e.code === 'REF_UNCLOSED' && e.message.includes('OBJ-TST-GONE')), 'dangling OBJ')
  assert.ok(v2.errors.some((e) => e.code === 'REF_UNCLOSED' && e.message.includes('not-an-id')), 'non OBJ/REL form')
})


test('P0-2 validate：有排除规则但场景缺 exclusionRefs → EXCL_REFS_MISSING warn', () => {
  const pkg = minimalPkg() // 默认场景无 exclusionRefs
  const v = validatePackage(pkg)
  assert.ok(v.warnings.some((w) => w.code === 'EXCL_REFS_MISSING'), JSON.stringify(v.warnings))
  const ok = minimalPkg({
    scenarios: [{ ...minimalPkg().scenarios[0], exclusionRefs: ['RULE-TST-E1'] }],
  })
  const v2 = validatePackage(ok)
  assert.ok(!v2.warnings.some((w) => w.code === 'EXCL_REFS_MISSING'))
})

test('P0-1 方案A：排除条件特征未进 featureSources → COND_FEATURE_UNDECLARED warn', () => {
  const pkg = minimalPkg({
    exclusionRules: [
      { id: 'RULE-TST-EX-ZONE', name: ' zone', action: 'downweight', factor: 0.5, condition: "zone == 'lab'" },
    ],
    scenarios: [{ ...minimalPkg().scenarios[0], exclusionRefs: ['RULE-TST-EX-ZONE'] }],
  })
  const v = validatePackage(pkg)
  assert.ok(
    v.warnings.some((w) => w.code === 'COND_FEATURE_UNDECLARED' && w.where === 'RULE-TST-EX-ZONE'),
    JSON.stringify(v.warnings),
  )
  // featureSources 声明后消 warn
  const ok = minimalPkg({
    exclusionRules: [
      {
        id: 'RULE-TST-EX-ZONE', name: 'zone', action: 'downweight', factor: 0.5,
        condition: "zone == 'lab'", featureSources: { zone: 'OBJ-TST-A' },
      },
    ],
    scenarios: [{ ...minimalPkg().scenarios[0], exclusionRefs: ['RULE-TST-EX-ZONE'] }],
  })
  const v2 = validatePackage(ok)
  assert.ok(!v2.warnings.some((w) => w.code === 'COND_FEATURE_UNDECLARED'))
  // tag 条件不告警
  const tagOnly = minimalPkg()
  const v3 = validatePackage(tagOnly)
  assert.ok(!v3.warnings.some((w) => w.code === 'COND_FEATURE_UNDECLARED'))
})
