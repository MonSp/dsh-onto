/** 经验闭环验收（spec experience-loop S4.1/S4.3）：任务结构签名 + 经验记录围栏存取。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildTaskSignature,
  dataBandOf,
  saveExperienceNote,
  loadExperienceNote,
  listExperienceNotes,
  experiencesDir,
} from '../dist/index.js'
import { minimalPkg, mkWorkspaceWithPkg, rmWorkspace } from './helpers.mjs'

const SUMMARY = { objects: 2, relations: 1, behaviors: 1, candidates: 10 }

function makeNote(overrides = {}) {
  const signature = buildTaskSignature({
    pkg: minimalPkg(),
    scenarioId: 'SCN-TST-1',
    datasetSummary: SUMMARY,
  })
  return {
    runId: 'run-tst-1',
    signature,
    outcome: 'success',
    skillRefsUsed: ['SKL-TST-N'],
    counterexample: false,
    savedAt: '2026-11-06T00:00:00.000Z',
    ...overrides,
  }
}

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

test('ExperienceNote 落盘往返 + 形状校验', () => {
  const { root } = mkWorkspaceWithPkg()
  try {
    const note = makeNote({
      outcome: 'partial',
      outcomeReason: '缺特征',
      reviewFocus: ['listHitCount'],
      reusedFrom: { runId: 'run-src', diff: { reusable: [], mustChange: [], unknown: [] } },
    })
    const file = saveExperienceNote(root, note)
    assert.ok(file.includes('experiences'))
    const loaded = loadExperienceNote(root, 'run-tst-1')
    assert.equal(loaded.outcome, 'partial')
    assert.equal(loaded.signature.digest, note.signature.digest)
    assert.deepEqual(loaded.reviewFocus, ['listHitCount'])
    assert.equal(loaded.reusedFrom.runId, 'run-src')
  } finally {
    rmWorkspace(root)
  }
})

test('非法 runId → INVALID_ARGS（穿越/多级/空段）', () => {
  const { root } = mkWorkspaceWithPkg()
  try {
    for (const bad of ['../evil', 'a/b', '', '.', 'a:b']) {
      assert.throws(() => saveExperienceNote(root, makeNote({ runId: bad })), /INVALID_ARGS|invalid runId/)
      assert.throws(() => loadExperienceNote(root, bad), /INVALID_ARGS|invalid runId/)
    }
  } finally {
    rmWorkspace(root)
  }
})

test('缺失 → NOT_FOUND；损坏 JSON → PACKAGE_MALFORMED', () => {
  const { root } = mkWorkspaceWithPkg()
  try {
    assert.throws(() => loadExperienceNote(root, 'run-missing'), /NOT_FOUND|not found/)
    const dir = experiencesDir(root)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'run-bad.json'), '{not json', 'utf8')
    assert.throws(() => loadExperienceNote(root, 'run-bad'), /PACKAGE_MALFORMED|corrupt/)
  } finally {
    rmWorkspace(root)
  }
})

test('错形（outcome 非法 / 缺 signature）→ PACKAGE_MALFORMED', () => {
  const { root } = mkWorkspaceWithPkg()
  try {
    const dir = experiencesDir(root)
    mkdirSync(dir, { recursive: true })
    const bad = makeNote({ outcome: 'nope' })
    writeFileSync(join(dir, 'run-bad2.json'), JSON.stringify(bad), 'utf8')
    assert.throws(() => loadExperienceNote(root, 'run-bad2'), /PACKAGE_MALFORMED|corrupt/)
    const noSig = makeNote()
    delete noSig.signature
    writeFileSync(join(dir, 'run-bad3.json'), JSON.stringify(noSig), 'utf8')
    assert.throws(() => loadExperienceNote(root, 'run-bad3'), /PACKAGE_MALFORMED|corrupt/)
  } finally {
    rmWorkspace(root)
  }
})

test('listExperienceNotes：savedAt 降序、损坏条目跳过', () => {
  const { root } = mkWorkspaceWithPkg()
  try {
    saveExperienceNote(root, makeNote({ runId: 'run-a', savedAt: '2026-11-06T01:00:00.000Z' }))
    saveExperienceNote(root, makeNote({ runId: 'run-b', savedAt: '2026-11-06T02:00:00.000Z' }))
    const dir = experiencesDir(root)
    writeFileSync(join(dir, 'run-corrupt.json'), 'oops', 'utf8')
    const list = listExperienceNotes(root)
    assert.deepEqual(
      list.map((n) => n.runId),
      ['run-b', 'run-a'],
    )
  } finally {
    rmWorkspace(root)
  }
})
