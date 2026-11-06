/** 经验闭环验收（spec experience-loop S4.1）：任务结构签名机械导出与 digest 稳定。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTaskSignature, dataBandOf } from '../dist/index.js'
import { minimalPkg } from './helpers.mjs'

const SUMMARY = { objects: 2, relations: 1, behaviors: 1, candidates: 10 }

test('签名机械导出：stepShape / ruleRefs 缺省=全量 / skillRefs / inputShape / dataBand', () => {
  const sig = buildTaskSignature({ pkg: minimalPkg(), scenarioId: 'SCN-TST-1', datasetSummary: SUMMARY })
  assert.equal(sig.scenarioId, 'SCN-TST-1')
  assert.equal(sig.packageScope, 'test-pkg@1.0.0')
  assert.equal(sig.goalClass, '测试')
  assert.equal(
    sig.stepShape,
    'DATA_INGEST>BEHAVIOR_CALL>RULE_EVALUATE(before-scoring)>RULE_EVALUATE>SKILL_RUN>AUDIT_CHECK>HUMAN_REVIEW',
  )
  assert.deepEqual(sig.ruleRefs, ['RULE-TST-E1', 'RULE-TST-S1'])
  assert.deepEqual(sig.skillRefs, ['SKL-TST-N'])
  assert.deepEqual(sig.inputShape, ['p1:string'])
  assert.equal(sig.dataBand, 'S')
  assert.match(sig.digest, /^[0-9a-f]{64}$/)
})

test('digest 稳定：同结构同 digest；结构变则 digest 变', () => {
  const a = buildTaskSignature({ pkg: minimalPkg(), scenarioId: 'SCN-TST-1', datasetSummary: SUMMARY })
  const b = buildTaskSignature({ pkg: minimalPkg(), scenarioId: 'SCN-TST-1', datasetSummary: SUMMARY })
  assert.equal(a.digest, b.digest)
  const pkg2 = minimalPkg()
  pkg2.scenarios[0].goal = '换个目标'
  const c = buildTaskSignature({ pkg: pkg2, scenarioId: 'SCN-TST-1', datasetSummary: SUMMARY })
  assert.notEqual(a.digest, c.digest)
})

test('scoreRefs/exclusionRefs 显式圈定 → ruleRefs 只含圈内', () => {
  const pkg = minimalPkg()
  pkg.scenarios[0].scoreRefs = ['RULE-TST-S1']
  pkg.scenarios[0].exclusionRefs = []
  const sig = buildTaskSignature({ pkg, scenarioId: 'SCN-TST-1', datasetSummary: SUMMARY })
  assert.deepEqual(sig.ruleRefs, ['RULE-TST-S1'])
})

test('dataBand 分档', () => {
  assert.equal(dataBandOf(49), 'S')
  assert.equal(dataBandOf(50), 'M')
  assert.equal(dataBandOf(499), 'M')
  assert.equal(dataBandOf(500), 'L')
  assert.equal(dataBandOf(501), 'L')
})

test('场景不存在 → NOT_FOUND', () => {
  assert.throws(
    () => buildTaskSignature({ pkg: minimalPkg(), scenarioId: 'SCN-NOPE', datasetSummary: SUMMARY }),
    /scenario not found/,
  )
})
