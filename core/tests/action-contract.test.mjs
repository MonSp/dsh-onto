/**
 * M1-C 动作契约验收（方案 §6）：载荷字段白名单/必填/类型/范围、refTypes 闭合、
 * 受限条件表达（不嵌任意代码）、requiredRoles、connector 能力与契约版本、场景绑定闭合。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { derivePackage, validatePackage } from '../dist/index.js'
import { minimalPkg, mkWorkspaceWithPkg, rmWorkspace } from './helpers.mjs'

/** 带合法 actionContract 的包。 */
function pkgWithContract(over = {}) {
  const base = minimalPkg()
  return minimalPkg({
    behaviors: [{
      ...base.behaviors[0],
      actionContract: {
        fields: [
          { name: 'amount', type: 'float', required: true, range: { min: 0, max: 1000000 } },
          { name: 'note', type: 'string', required: false },
          { name: 'related', type: 'ref', required: false, refTypes: ['OBJ-TST-B'] },
        ],
        requires: {
          relations: ['REL-TST-AB'],
          states: [{ attr: 'a1', op: '=', value: 'x' }],
        },
        precondition: [{ attr: 'b1', op: '>=', value: 0 }],
        requiredRoles: ['analyst'],
        connector: { capability: 'create-review-ticket', contractVersion: '1' },
        scenarioBinding: { scenarioId: 'SCN-TST-1', decisionKind: 'both' },
      },
    }],
  })
}

function issuesOf(pkg) {
  return validatePackage(pkg).errors
}

test('C2-1 合法动作契约：0 error', () => {
  const pkg = pkgWithContract()
  assert.deepEqual(issuesOf(pkg), [])
})

test('C2-2 字段白名单：非法字段名/类型/重复/range 误用拒绝', () => {
  const base = pkgWithContract()
  const bad1 = pkgWithContract()
  bad1.behaviors[0].actionContract.fields = [{ name: '1bad', type: 'string', required: true }]
  assert.ok(issuesOf(bad1).some((i) => /字段名非法/.test(i.message)))

  const bad2 = pkgWithContract()
  bad2.behaviors[0].actionContract.fields = [{ name: 'x', type: 'object', required: true }]
  assert.ok(issuesOf(bad2).some((i) => /类型非法/.test(i.message)))

  const bad3 = pkgWithContract()
  bad3.behaviors[0].actionContract.fields = [
    { name: 'x', type: 'string', required: true },
    { name: 'x', type: 'int', required: false },
  ]
  assert.ok(issuesOf(bad3).some((i) => /字段重复/.test(i.message)))

  const bad4 = pkgWithContract()
  bad4.behaviors[0].actionContract.fields = [{ name: 'x', type: 'string', required: true, range: { min: 0 } }]
  assert.ok(issuesOf(bad4).some((i) => /仅 int\/float 可有 range/.test(i.message)))

  // fields 空数组拒绝（白名单不得为空）
  const bad5 = pkgWithContract()
  bad5.behaviors[0].actionContract.fields = []
  assert.ok(issuesOf(bad5).some((i) => /非空数组/.test(i.message)))
})

test('C2-3 引用闭合：refTypes / requires.relations / scenarioBinding 未闭合拒绝', () => {
  const bad1 = pkgWithContract()
  bad1.behaviors[0].actionContract.fields[2].refTypes = ['OBJ-NOPE']
  assert.ok(issuesOf(bad1).some((i) => /refTypes 引用未闭合/.test(i.message)))

  const bad2 = pkgWithContract()
  bad2.behaviors[0].actionContract.requires.relations = ['REL-NOPE']
  assert.ok(issuesOf(bad2).some((i) => /requires.relations 引用未闭合/.test(i.message)))

  const bad3 = pkgWithContract()
  bad3.behaviors[0].actionContract.scenarioBinding.scenarioId = 'SCN-NOPE'
  assert.ok(issuesOf(bad3).some((i) => /scenarioId 引用未闭合/.test(i.message)))
})

test('C2-4 受限条件：非受限形式（缺 op / 非法 value / 非对象）拒绝——不嵌任意代码', () => {
  for (const cond of [
    { attr: 'a1', op: 'in', value: 'x' },
    { attr: '', op: '=', value: 'x' },
    { attr: 'a1', op: '=', value: { evil: true } },
    'a1=x',
  ]) {
    const bad = pkgWithContract()
    bad.behaviors[0].actionContract.precondition = [cond]
    assert.ok(
      issuesOf(bad).some((i) => /条件须为受限形式/.test(i.message)),
      `非受限条件应拒绝: ${JSON.stringify(cond)}`,
    )
  }
})

test('C2-5 requiredRoles 与 connector 声明必填；decisionKind 合法值', () => {
  const bad1 = pkgWithContract()
  bad1.behaviors[0].actionContract.requiredRoles = []
  assert.ok(issuesOf(bad1).some((i) => /requiredRoles 须为非空/.test(i.message)))

  const bad2 = pkgWithContract()
  bad2.behaviors[0].actionContract.connector = { capability: '', contractVersion: '' }
  assert.ok(issuesOf(bad2).some((i) => /connector 须声明/.test(i.message)))

  const bad3 = pkgWithContract()
  bad3.behaviors[0].actionContract.scenarioBinding.decisionKind = 'auto'
  assert.ok(issuesOf(bad3).some((i) => /decisionKind 非法/.test(i.message)))
})


test('C2-6 契约进派生链：tool-contracts 落 actionContracts；手改派生物 → DERIVED_DRIFT 拒载', async () => {
  const { mkWorkspaceWithPkg, rmWorkspace, savePackage, derivePackage } = await import('./helpers.mjs')
  const { readFileSync, writeFileSync, mkdirSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { loadYaml } = await import('../dist/index.js')
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    savePackage(dir, pkgWithContract())
    derivePackage(dir)
    const raw = loadYaml(readFileSync(join(dir, 'derived/tool-contracts/tool-contracts.yaml'), 'utf8'))
    assert.ok(Array.isArray(raw.actionContracts) && raw.actionContracts.length === 1, '契约须落派生物')
    assert.equal(raw.actionContracts[0].behaviorId, 'BHV-TST-X')
    assert.equal(raw.actionContracts[0].requiredRoles[0], 'analyst')
    // 无契约包不落 actionContracts 键（零回归）
    const { dir: dir2, root: root2 } = mkWorkspaceWithPkg()
    try {
      savePackage(dir2, minimalPkg())
      derivePackage(dir2)
      const raw2 = loadYaml(readFileSync(join(dir2, 'derived/tool-contracts/tool-contracts.yaml'), 'utf8'))
      assert.equal(raw2.actionContracts, undefined, '无契约包不落键')
    } finally {
      rmWorkspace(root2)
    }
    // 手改派生物（改契约内容）→ 指纹不符 → DERIVED_DRIFT
    const file = join(dir, 'derived/tool-contracts/tool-contracts.yaml')
    const doc = readFileSync(file, 'utf8').replace('analyst', 'hacker')
    writeFileSync(file, doc, 'utf8')
    const { runScenario } = await import('../dist/index.js')
    assert.throws(
      () => runScenario(dir, 'SCN-TST-1', {
        objects: [{ id: 'A1', type: 'OBJ-TST-A', attrs: { a1: 'x' } }],
        relations: [],
        candidates: [{ candidateId: 'C1', objectRef: 'A1', features: { f1: 1 }, tags: [] }],
      }),
      (e) => e.code === 'DERIVED_DRIFT',
    )
  } finally {
    rmWorkspace(root)
  }
})

test('C2-7 弱字段不得 0 error 放行：required 非布尔 / range 颠倒或非数值 / requiredRoles 非串 / refTypes 空（评审 P6）', () => {
  // required 非布尔
  const bad1 = pkgWithContract()
  bad1.behaviors[0].actionContract.fields = [{ name: 'x', type: 'string', required: 'yes' }]
  assert.ok(issuesOf(bad1).some((i) => /required 须为布尔/.test(i.message)), JSON.stringify(issuesOf(bad1)))

  // range min>max
  const bad2 = pkgWithContract()
  bad2.behaviors[0].actionContract.fields = [{ name: 'x', type: 'float', required: true, range: { min: 10, max: 1 } }]
  assert.ok(issuesOf(bad2).some((i) => /range min\(10\) > max\(1\)/.test(i.message)))

  // range 非数值
  const bad3 = pkgWithContract()
  bad3.behaviors[0].actionContract.fields = [{ name: 'x', type: 'int', required: true, range: { min: '0' } }]
  assert.ok(issuesOf(bad3).some((i) => /range 须为有限数值/.test(i.message)))

  // requiredRoles 元素非字符串
  const bad4 = pkgWithContract()
  bad4.behaviors[0].actionContract.requiredRoles = [1]
  assert.ok(issuesOf(bad4).some((i) => /requiredRoles 元素须为非空字符串/.test(i.message)))

  // ref 字段 refTypes 空/缺失
  const bad5 = pkgWithContract()
  bad5.behaviors[0].actionContract.fields = [{ name: 'r', type: 'ref', required: true, refTypes: [] }]
  assert.ok(issuesOf(bad5).some((i) => /须声明非空 refTypes/.test(i.message)))
  const bad6 = pkgWithContract()
  bad6.behaviors[0].actionContract.fields = [{ name: 'r', type: 'ref', required: true }]
  assert.ok(issuesOf(bad6).some((i) => /须声明非空 refTypes/.test(i.message)))
})
