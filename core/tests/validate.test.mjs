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
