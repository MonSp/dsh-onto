/** 经验闭环验收（spec experience-loop S4.1/S4.3）：任务结构签名 + 经验记录围栏存取。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildTaskSignature,
  dataBandOf,
  saveExperienceNote,
  loadExperienceNote,
  listExperienceNotes,
  experiencesDir,
  retrieveSimilar,
  signatureFieldReasons,
  buildDiffTable,
  heuristicRevise,
  reviseDiff,
  requiresHumanReview,
  reviewFocusFrom,
  reviewExperienceNote,
  abstractSkillDrafts,
  abstractCounterexampleDrafts,
  compressExperiences,
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
    // P4-5：digest 命中也带字段级对照（全字段「同」）
    assert.ok(r.hits[0].reasons.some((x) => x.includes('digest 同构')))
    assert.ok(r.hits[0].reasons.some((x) => x.includes('ruleRefs 共有')))
    assert.ok(r.hits[0].reasons.some((x) => x.includes('scenarioId 同')))
  } finally {
    rmWorkspace(root)
  }
})

test('P4-5：signatureFieldReasons 字段级新旧对照（不止 Jaccard）', () => {
  const q = buildTaskSignature({ pkg: minimalPkg(), scenarioId: 'SCN-TST-1', datasetSummary: SUMMARY })
  const s = buildTaskSignature({ pkg: minimalPkg(), scenarioId: 'SCN-TST-1', datasetSummary: SUMMARY })
  // 同构：全字段「同」
  const same = signatureFieldReasons(q, s)
  assert.ok(same.some((r) => r.startsWith('scenarioId 同')))
  assert.ok(same.some((r) => r.startsWith('dataBand 同')))
  assert.ok(same.some((r) => r.startsWith('ruleRefs 共有')))
  assert.ok(same.some((r) => r.startsWith('skillRefs 共有')))
  assert.ok(same.some((r) => r.startsWith('inputShape 同')))
  assert.ok(same.every((r) => r.includes('同') || r.includes('共有')), `应全为结构位对照: ${same}`)

  // 变更：源→新 与集合增删
  const q2 = { ...q, scenarioId: 'SCN-OTHER', dataBand: 'L', ruleRefs: [...q.ruleRefs, 'RULE-NEW'] }
  const diff = signatureFieldReasons(q2, s)
  assert.ok(diff.some((r) => r.includes('scenarioId 源=SCN-TST-1 → 新=SCN-OTHER')))
  assert.ok(diff.some((r) => r.includes('dataBand 源=S → 新=L') || r.includes('dataBand 源=')))
  assert.ok(diff.some((r) => r.includes('新独有') && r.includes('RULE-NEW')))
  // 不得出现自由流程词
  assert.ok(!diff.some((r) => /执行流程|步骤图|自由/.test(r)))
})

test('检索：同构全中 → score=1.0 命中；reasons 含字段级对照', () => {
  const { root } = mkWorkspaceWithPkg()
  try {
    for (let i = 1; i <= 4; i++) saveExperienceNote(root, variantNote(i))
    const q = buildTaskSignature({ pkg: minimalPkg(), scenarioId: 'SCN-TST-1', datasetSummary: SUMMARY })
    q.digest = 'digest-query' // 走打分路径，不短路
    const r = retrieveSimilar(root, { signature: q })
    assert.equal(r.coldStart, false)
    assert.equal(r.hits.length, 3)
    assert.ok(r.hits.every((h) => h.score === 1))
    for (const h of r.hits) {
      assert.ok(h.reasons.some((x) => x.includes('ruleRefs 共有')), `缺字段级 ruleRefs: ${h.reasons}`)
      assert.ok(h.reasons.some((x) => x.includes('scenarioId 同')), `缺字段级 scenarioId: ${h.reasons}`)
      assert.ok(h.reasons.some((x) => x.includes('Jaccard')), `打分理由仍应在场: ${h.reasons}`)
    }
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
    // L4：name@version 全量声明形态同样命中（原 startsWith(d+'@') 死分支）
    const r2 = retrieveSimilar(root, { signature: q, externalRefs: ['other-pkg@1.0.0'] })
    assert.equal(r2.coldStart, false)
    assert.ok(Math.abs(r2.hits[0].score - 0.5) < 1e-9, `score=${r2.hits[0].score}`)
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

/* ── P2-1 人审回填 ── */

test('人审回填：改判 outcome + 写 misTransfer + reviewFocus', () => {
  const { root } = mkWorkspaceWithPkg()
  try {
    saveExperienceNote(root, makeNote({ runId: 'run-rv1', outcome: 'pending-human' }))
    const updated = reviewExperienceNote(root, 'run-rv1', {
      outcome: 'success',
      outcomeReason: '人工复核通过',
      misTransfer: { judged: true, by: '张三', note: '误迁到新域' },
      reviewFocus: ['listHitCount'],
    })
    assert.equal(updated.outcome, 'success')
    assert.equal(updated.outcomeReason, '人工复核通过')
    assert.equal(updated.misTransfer.judged, true)
    assert.equal(updated.misTransfer.by, '张三')
    assert.deepEqual(updated.reviewFocus, ['listHitCount'])
    // signature 不可被 patch 改动
    assert.equal(updated.signature.digest, makeNote({ runId: 'run-rv1', outcome: 'pending-human' }).signature.digest)
    const reloaded = loadExperienceNote(root, 'run-rv1')
    assert.equal(reloaded.outcome, 'success')
    assert.equal(reloaded.misTransfer.by, '张三')
  } finally {
    rmWorkspace(root)
  }
})

test('人审回填闸门：misTransfer.by 空 → INVALID_ARGS；非法 outcome → INVALID_ARGS', () => {
  const { root } = mkWorkspaceWithPkg()
  try {
    saveExperienceNote(root, makeNote({ runId: 'run-rv2' }))
    assert.throws(
      () => reviewExperienceNote(root, 'run-rv2', { misTransfer: { judged: true, by: '  ', note: 'x' } }),
      /INVALID_ARGS|human identity/,
    )
    assert.throws(
      () => reviewExperienceNote(root, 'run-rv2', { outcome: 'nope' }),
      /INVALID_ARGS|invalid outcome/,
    )
    assert.throws(
      () => reviewExperienceNote(root, 'run-rv2', { misTransfer: { judged: 'yes', by: '张三' } }),
      /INVALID_ARGS|boolean/,
    )
  } finally {
    rmWorkspace(root)
  }
})

/* ── P3-1 自动技能抽象 ── */

test('abstractSkillDrafts：成功同构聚簇 ≥2 → SkillTemplate 草案；反例/误迁移不参聚', () => {
  const { root } = mkWorkspaceWithPkg()
  try {
    const pkg = minimalPkg()
    // 两条成功同构
    saveExperienceNote(root, makeNote({ runId: 'run-s1', savedAt: '2026-11-07T01:00:00.000Z', reviewFocus: ['f1'] }))
    saveExperienceNote(root, makeNote({ runId: 'run-s2', savedAt: '2026-11-07T02:00:00.000Z' }))
    // 反例与误迁移不参聚
    saveExperienceNote(root, makeNote({ runId: 'run-x1', counterexample: true }))
    saveExperienceNote(root, makeNote({ runId: 'run-m1', misTransfer: { judged: true, by: '张三', note: '' } }))
    const abs = abstractSkillDrafts(root, { pkg })
    assert.equal(abs.length, 1)
    const a = abs[0]
    assert.equal(a.memberRunIds.length, 2)
    assert.ok(a.memberRunIds.includes('run-s1') && a.memberRunIds.includes('run-s2'))
    assert.equal(a.draft.targetKind, 'SkillTemplate')
    assert.equal(a.draft.layer, 'O2')
    assert.equal(a.draft.payload.id, 'SKL-TST-EXP-1')
    assert.deepEqual(a.draft.payload.weights, { 'RULE-TST-S1': 1 })
    assert.ok(a.draft.payload.steps.includes('候选 {candidateId}'))
    assert.ok(a.draft.payload.steps.includes('f1'))
    assert.equal(a.draft.confidence, 0.8)
  } finally {
    rmWorkspace(root)
  }
})

test('abstractSkillDrafts：簇员 < minCluster 不出草案', () => {
  const { root } = mkWorkspaceWithPkg()
  try {
    saveExperienceNote(root, makeNote({ runId: 'run-lonely' }))
    const abs = abstractSkillDrafts(root, { pkg: minimalPkg() })
    assert.equal(abs.length, 0)
    const abs2 = abstractSkillDrafts(root, { pkg: minimalPkg(), minCluster: 1 })
    assert.equal(abs2.length, 1)
  } finally {
    rmWorkspace(root)
  }
})

test('abstractCounterexampleDrafts：结论性反例 → RedLine；否则 → ExclusionRule', () => {
  const { root } = mkWorkspaceWithPkg()
  try {
    const pkg = minimalPkg()
    // 结论性反例 ×2 → RedLine
    saveExperienceNote(root, makeNote({ runId: 'run-c1', counterexample: true, outcomeReason: '误判为认定洗钱', savedAt: '2026-11-07T01:00:00.000Z' }))
    saveExperienceNote(root, makeNote({ runId: 'run-c2', counterexample: true, outcomeReason: '输出含确定为', savedAt: '2026-11-07T02:00:00.000Z' }))
    const rl = abstractCounterexampleDrafts(root, { pkg })
    assert.equal(rl.length, 1)
    assert.equal(rl[0].draft.targetKind, 'RedLine')
    assert.equal(rl[0].draft.layer, 'O3')
    assert.ok(rl[0].draft.payload.phrases.includes('认定洗钱'))
    assert.equal(rl[0].draft.confidence, 0.7)

    // 非结论性反例 ×2 → ExclusionRule（清空旧反例再测）
    rmSync(join(root, 'experiences'), { recursive: true, force: true })
    saveExperienceNote(root, makeNote({ runId: 'run-c3', counterexample: true, outcomeReason: '特征缺失导致误报', reviewFocus: ['listHitCount'], savedAt: '2026-11-07T03:00:00.000Z' }))
    saveExperienceNote(root, makeNote({ runId: 'run-c4', counterexample: true, outcomeReason: '数据漂移', savedAt: '2026-11-07T04:00:00.000Z' }))
    const ex = abstractCounterexampleDrafts(root, { pkg })
    assert.equal(ex.length, 1)
    assert.equal(ex[0].draft.targetKind, 'ExclusionRule')
    assert.equal(ex[0].draft.payload.action, 'downweight')
    assert.equal(ex[0].draft.payload.condition, "tag == 'listHitCount'")
    assert.equal(ex[0].draft.confidence, 0.7)
  } finally {
    rmWorkspace(root)
  }
})

/* ── P3-3 压缩/遗忘 ── */

test('compressExperiences：分层保留 + 陈旧未引用归档 + 压缩比', () => {
  const { root } = mkWorkspaceWithPkg()
  try {
    const old = '2025-01-01T00:00:00.000Z'
    const fresh = '2026-11-07T00:00:00.000Z'
    // 陈旧未引用成功 → 归档候选
    saveExperienceNote(root, makeNote({ runId: 'run-stale', savedAt: old }))
    // 反例留警示
    saveExperienceNote(root, makeNote({ runId: 'run-counter', counterexample: true, savedAt: old }))
    // 被复用过 → 高价值留
    saveExperienceNote(root, makeNote({ runId: 'run-reused', savedAt: old }))
    saveExperienceNote(root, makeNote({ runId: 'run-child', reusedFrom: { runId: 'run-reused', diff: { reusable: [], mustChange: [], unknown: [] } }, savedAt: fresh }))
    // 自身有 reusedFrom → 复用证据留
    saveExperienceNote(root, makeNote({ runId: 'run-evidence', reusedFrom: { runId: 'run-x', diff: { reusable: [], mustChange: [], unknown: [] } }, savedAt: old }))
    // 新鲜未引用 → 留
    saveExperienceNote(root, makeNote({ runId: 'run-fresh', savedAt: fresh }))

    // dryRun：只报告不移动
    const dry = compressExperiences(root, { retainDays: 30 })
    assert.equal(dry.total, 6)
    assert.equal(dry.archived, 1)
    assert.deepEqual(dry.archivedRunIds, ['run-stale'])
    assert.equal(dry.kept, 5)
    assert.ok(Math.abs(dry.compressionRatio - 1 / 6) < 1e-9)
    assert.equal(dry.tiers.counter, 1)
    assert.equal(dry.tiers.referenced, 1)
    assert.equal(dry.tiers.reuseEvidence, 2)
    assert.equal(dry.tiers.fresh, 1)
    assert.equal(dry.tiers.stale, 1)
    assert.ok(existsSync(join(root, 'experiences', 'run-stale.json')), 'dryRun 不应移动文件')

    // apply：归档落位
    const applied = compressExperiences(root, { retainDays: 30, apply: true })
    assert.equal(applied.archived, 1)
    assert.ok(!existsSync(join(root, 'experiences', 'run-stale.json')))
    assert.ok(existsSync(join(root, 'experiences', 'archive', 'run-stale.json')))
    // 归档后 list 不再返回
    const after = listExperienceNotes(root)
    assert.equal(after.length, 5)
    assert.ok(!after.some((n) => n.runId === 'run-stale'))
  } finally {
    rmWorkspace(root)
  }
})
