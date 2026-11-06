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
  retrieveSimilar,
  buildDiffTable,
  heuristicRevise,
  reviseDiff,
  requiresHumanReview,
  reviewFocusFrom,
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

/* ── P1-3 结构检索 ── */

function variantNote(i, sigOverrides = {}, noteOverrides = {}) {
  const n = makeNote({ runId: `run-v${i}`, savedAt: `2026-11-06T0${i}:00:00.000Z`, ...noteOverrides })
  n.signature = { ...n.signature, ...sigOverrides, digest: `digest-v${i}` }
  return n
}

test('检索：digest 同构短路', () => {
  const { root } = mkWorkspaceWithPkg()
  try {
    const note = makeNote({ runId: 'run-d1' })
    saveExperienceNote(root, note)
    const r = retrieveSimilar(root, { signature: note.signature })
    assert.equal(r.coldStart, false)
    assert.equal(r.digestMatch.runId, 'run-d1')
    assert.equal(r.hits[0].score, 1)
  } finally {
    rmWorkspace(root)
  }
})

test('检索：同构全中 → score=1.0 命中；top-k 截断', () => {
  const { root } = mkWorkspaceWithPkg()
  try {
    for (let i = 1; i <= 4; i++) saveExperienceNote(root, variantNote(i))
    const q = buildTaskSignature({ pkg: minimalPkg(), scenarioId: 'SCN-TST-1', datasetSummary: SUMMARY })
    q.digest = 'digest-query' // 走打分路径，不短路
    const r = retrieveSimilar(root, { signature: q })
    assert.equal(r.coldStart, false)
    assert.equal(r.hits.length, 3)
    assert.ok(r.hits.every((h) => h.score === 1))
  } finally {
    rmWorkspace(root)
  }
})

test('检索：结构全不同 → 冷启动（不硬迁）', () => {
  const { root } = mkWorkspaceWithPkg()
  try {
    saveExperienceNote(
      root,
      variantNote(1, {
        scenarioId: 'SCN-OTHER',
        stepShape: 'DATA_INGEST',
        ruleRefs: ['RULE-X'],
        skillRefs: [],
        inputShape: ['z:string'],
        dataBand: 'L',
      }),
    )
    const q = buildTaskSignature({ pkg: minimalPkg(), scenarioId: 'SCN-TST-1', datasetSummary: SUMMARY })
    q.digest = 'digest-query'
    const r = retrieveSimilar(root, { signature: q })
    assert.equal(r.coldStart, true)
    assert.equal(r.hits.length, 0)
  } finally {
    rmWorkspace(root)
  }
})

test('检索：反例与已判误迁移不参赛', () => {
  const { root } = mkWorkspaceWithPkg()
  try {
    saveExperienceNote(root, variantNote(1, {}, { counterexample: true }))
    saveExperienceNote(root, variantNote(2, {}, { misTransfer: { judged: true, by: '张三', note: '误' } }))
    const q = buildTaskSignature({ pkg: minimalPkg(), scenarioId: 'SCN-TST-1', datasetSummary: SUMMARY })
    q.digest = 'digest-query'
    const r = retrieveSimilar(root, { signature: q })
    assert.equal(r.coldStart, true)
  } finally {
    rmWorkspace(root)
  }
})

test('检索：跨包须 externalRefs 声明，命中降权', () => {
  const { root } = mkWorkspaceWithPkg()
  try {
    saveExperienceNote(root, variantNote(1, { packageScope: 'other-pkg@1.0.0' }))
    const q = buildTaskSignature({ pkg: minimalPkg(), scenarioId: 'SCN-TST-1', datasetSummary: SUMMARY })
    q.digest = 'digest-query'
    assert.equal(retrieveSimilar(root, { signature: q }).coldStart, true)
    const r = retrieveSimilar(root, { signature: q, externalRefs: ['other-pkg'] })
    assert.equal(r.coldStart, false)
    assert.ok(Math.abs(r.hits[0].score - 0.5) < 1e-9, `score=${r.hits[0].score}`)
  } finally {
    rmWorkspace(root)
  }
})

/* ── P1-4 DiffTable 机械生成 + 差异修正双路 ── */

function sigVariant(overrides = {}) {
  const s = buildTaskSignature({ pkg: minimalPkg(), scenarioId: 'SCN-TST-1', datasetSummary: SUMMARY })
  return { ...s, ...overrides, digest: `digest-${JSON.stringify(overrides).length}-${Math.random()}` }
}

test('机械差异：同构 → reusable 全中、mustChange 空、unknown 空', () => {
  const q = sigVariant()
  const s = sigVariant()
  const d = buildDiffTable(q, s)
  assert.equal(d.mustChange.length, 0)
  assert.equal(d.unknown.length, 0)
  assert.ok(d.reusable.some((r) => r.item === 'stepShape'))
  assert.ok(d.reusable.some((r) => r.item === 'dataBand'))
})

test('机械差异：场景/规模档/规则增删 → mustChange 正确', () => {
  const q = sigVariant({ scenarioId: 'SCN-NEW', dataBand: 'L', ruleRefs: ['RULE-A', 'RULE-B'] })
  const s = sigVariant({ ruleRefs: ['RULE-B', 'RULE-C'] })
  const d = buildDiffTable(q, s)
  assert.ok(d.mustChange.some((m) => m.item === 'scenarioId'))
  assert.ok(d.mustChange.some((m) => m.item === 'dataBand'))
  const ruleChanges = d.mustChange.filter((m) => m.item === 'ruleRefs')
  assert.ok(ruleChanges.length >= 2, 'ruleRefs 新增/源有差异应分列')
  assert.ok(ruleChanges.some((m) => m.why.includes('RULE-A')))
  assert.ok(ruleChanges.some((m) => m.why.includes('RULE-C')))
})

test('启发式修正：reusable 空、mustChange 保留、unknown=原 reusable、confidence 0.5 → 强制转人工', () => {
  const d = buildDiffTable(sigVariant(), sigVariant({ dataBand: 'L' }))
  const rev = heuristicRevise(d)
  assert.equal(rev.engine, 'heuristic')
  assert.equal(rev.confidence, 0.5)
  assert.equal(rev.diff.reusable.length, 0)
  assert.equal(rev.diff.mustChange.length, d.mustChange.length)
  assert.equal(rev.diff.unknown.length, d.reusable.length)
  assert.ok(requiresHumanReview(rev))
  assert.deepEqual(reviewFocusFrom(rev), rev.diff.unknown.map((u) => u.item))
})

test('差异修正双路：LLM 成功 → engine=llm；失败/非法输出 → 回落启发式', async () => {
  const draft = buildDiffTable(sigVariant(), sigVariant({ dataBand: 'L' }))
  const input = { query: sigVariant(), source: sigVariant({ dataBand: 'L' }), draft }

  const okLlm = {
    complete: async () =>
      JSON.stringify({
        reusable: [{ item: 'stepShape', note: '同构' }],
        mustChange: draft.mustChange,
        unknown: [],
        confidence: 0.9,
      }),
  }
  const ok = await reviseDiff(okLlm, input)
  assert.equal(ok.engine, 'llm')
  assert.equal(ok.confidence, 0.9)
  assert.equal(ok.diff.unknown.length, 0)
  assert.equal(requiresHumanReview(ok), false)

  const badLlm = { complete: async () => 'not json at all' }
  const bad = await reviseDiff(badLlm, input)
  assert.equal(bad.engine, 'heuristic')
  assert.ok(requiresHumanReview(bad))

  const nullLlm = await reviseDiff(null, input)
  assert.equal(nullLlm.engine, 'heuristic')
})
