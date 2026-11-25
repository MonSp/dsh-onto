/**
 * 反馈闭环②（断链 A/B）— 经验衔接 wire 面：
 * runScenario 运行回写经验初稿（S5.4.2）；recordReviewDecision 桥接经验卡（缺卡补建 +
 * 认定回执进 outcomeReason，桥接失败显式 skipped 不回滚决定）；annotateExperience
 * 新建/回填（宿主身份 fail-closed，misTransfer.by 不收自报）；abstractExperiences
 * 聚簇入队 + includePriorVersions（ISSUED 生产经验回流当前 DRAFT 版本）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import {
  OntoRuntime,
  actionStoreFor,
  closeActionStore,
  businessPolicy,
  runtimeContextForHost,
} from '../dist/index.js'
import {
  buildRunRecord,
  loadExperienceNote,
  loadPackage,
  saveExperienceNote,
  savePackage,
  saveRunRecord,
  experienceFromRun,
} from '@dsh-onto/core'

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const AML_SRC = join(REPO, 'packages', 'aml', '1.0.0')
const AML_RUN = JSON.parse(readFileSync(join(REPO, 'examples', 'aml-run.json'), 'utf8'))

function fixture({ withPackage = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'onto-exp-wire-'))
  const wsRoot = join(dir, 'dsh-onto', 'workspace')
  mkdirSync(wsRoot, { recursive: true })
  if (withPackage) {
    const versionDir = join(wsRoot, 'packages', 'aml-analysis', '1.0.0')
    mkdirSync(join(versionDir, '..'), { recursive: true })
    cpSync(AML_SRC, versionDir, { recursive: true })
  }
  const ctx = new Context()
  ctx.reflect.provide('profileContext', { dir })
  const service = new OntoRuntime(ctx)
  const runtime = runtimeContextForHost(ctx.root)
  runtime.run(() => {
    businessPolicy.setIdentityProvider(() => ({
      userId: 'u-exp',
      tenant: 't1',
      roles: ['analyst'],
      dataScope: { objectTypes: [] },
    }))
  })
  return {
    dir,
    wsRoot,
    service,
    setIdentity(provider) {
      runtime.run(() => businessPolicy.setIdentityProvider(provider))
    },
    dispose() {
      runtime.run(() => businessPolicy.setIdentityProvider(null))
      closeActionStore(wsRoot)
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function seedRun(wsRoot, runId = 'run-expw00001', { auditPassed = true, pendingChecks = [] } = {}) {
  const dataset = {
    objects: [{ id: 'ACC-1', type: 'OBJ-AML-ACCOUNT' }],
    relations: [],
    behaviors: [],
    candidates: [{ candidateId: 'CAND-001', objectRef: 'OBJ-AML-ACCOUNT:ACC-1' }],
  }
  const result = {
    scenarioId: 'SCN-AML-FIND-CLUES',
    runId,
    startedAt: '2026-11-19T00:00:00.000Z',
    candidates: [
      {
        candidateId: 'CAND-001',
        objectRef: 'OBJ-AML-ACCOUNT:ACC-1',
        riskScore: 0.9,
        hitRuleIds: ['RULE-X'],
        evidenceChains: [{ ruleId: 'RULE-X', score: 0.9, evidence: 'e' }],
        narrative: [],
        pendingChecks,
        pendingVerification: pendingChecks.length > 0,
      },
    ],
    excluded: [],
    humanReviewRequired: true,
    reviewGate: { threshold: 0.5, required: true, requireReviewFor: ['high'] },
    ruleHitLog: [{ ruleId: 'RULE-X', candidateId: 'CAND-001', score: 0.9, ts: '2026-11-19T00:00:00.000Z' }],
    audit: { checks: [], forbiddenPhraseHits: [], passed: auditPassed },
  }
  const rec = buildRunRecord({
    package: { name: 'aml-analysis', version: '1.0.0' },
    dataset,
    result,
    redlines: [],
    savedAt: '2026-11-19T00:00:00.000Z',
  })
  saveRunRecord(wsRoot, rec)
  return rec
}

async function expectOrigCode(fn, origCode) {
  await assert.rejects(fn, (e) => {
    const got = e.details?.origCode ?? e.code
    assert.equal(got, origCode, `expected origCode ${origCode}, got ${got} (code=${e.code})`)
    return true
  })
}

test('runScenario wire：运行回写经验初稿（S5.4.2），runId/签名/映射与结果一致', async () => {
  const f = fixture()
  try {
    const { result } = await f.service.remoteExportRunScenario({
      name: 'aml-analysis',
      version: '1.0.0',
      scenarioId: 'SCN-AML-FIND-CLUES',
      dataset: AML_RUN,
    })
    const note = loadExperienceNote(f.wsRoot, result.runId)
    assert.equal(note.runId, result.runId)
    assert.equal(note.signature.scenarioId, 'SCN-AML-FIND-CLUES')
    assert.equal(note.signature.packageScope, 'aml-analysis@1.0.0')
    assert.deepEqual(note.skillRefsUsed, note.signature.skillRefs)
    // 映射一致性（映射本体由 core 单测钉死）：审计失败→failure+反例；有 pendingChecks→partial；否则 success
    const pending = result.candidates.reduce((n, c) => n + c.pendingChecks.length, 0)
    if (!result.audit.passed) {
      assert.equal(note.outcome, 'failure')
      assert.equal(note.counterexample, true)
    } else {
      assert.equal(note.counterexample, false)
      assert.equal(note.outcome, pending > 0 ? 'partial' : 'success')
    }
  } finally {
    f.dispose()
  }
})

test('recordReviewDecision：桥接经验卡——缺卡补建 + 认定回执进 outcomeReason', async () => {
  const f = fixture()
  try {
    const rec = seedRun(f.wsRoot, 'run-bridge0001')
    const out = await f.service.remoteExportRecordReviewDecision({
      runId: rec.runId,
      candidateIds: ['CAND-001'],
      snapshotDigest: rec.datasetDigest,
      ruleFingerprint: 'aml-analysis@1.0.0',
      decision: 'approved',
      reason: '证据充分',
    })
    assert.equal(out.humanReviewRequired, true)
    assert.deepEqual(out.experience, { runId: rec.runId, outcome: 'success', created: true })
    const note = loadExperienceNote(f.wsRoot, rec.runId)
    assert.equal(note.outcome, 'success')
    assert.ok(note.outcomeReason.includes('复核决定 approved'), note.outcomeReason)
    assert.ok(note.outcomeReason.includes('证据充分'), note.outcomeReason)

    // 第二个决定：卡已存在 → 桥接（created=false），回执追加
    await new Promise((r) => setTimeout(r, 5))
    const second = await f.service.remoteExportRecordReviewDecision({
      runId: rec.runId,
      candidateIds: ['CAND-001'],
      snapshotDigest: rec.datasetDigest,
      ruleFingerprint: 'aml-analysis@1.0.0',
      decision: 'rejected',
      reason: '误报',
    })
    assert.equal(second.experience.created, false)
    const after = loadExperienceNote(f.wsRoot, rec.runId)
    assert.ok(after.outcomeReason.includes('复核决定 approved（'))
    assert.ok(after.outcomeReason.includes('复核决定 rejected'))
  } finally {
    f.dispose()
  }
})

test('recordReviewDecision：桥接失败（包缺失）→ 决定仍落 + experience 显式 skipped', async () => {
  const f = fixture({ withPackage: false })
  try {
    const rec = seedRun(f.wsRoot, 'run-skipbridg1')
    const out = await f.service.remoteExportRecordReviewDecision({
      runId: rec.runId,
      candidateIds: ['CAND-001'],
      snapshotDigest: rec.datasetDigest,
      ruleFingerprint: 'aml-analysis@1.0.0',
      decision: 'approved',
    })
    assert.ok(out.decisionId, '人审决定不得因学习层失败回滚')
    assert.ok('skipped' in out.experience, `expected skipped, got ${JSON.stringify(out.experience)}`)
    assert.equal(actionStoreFor(f.wsRoot).getDecision(out.decisionId)?.decision, 'approved')
  } finally {
    f.dispose()
  }
})

test('annotateExperience：新建缺 outcome 拒；新建/回填 + misTransfer.by=宿主身份（不收自报）', async () => {
  const f = fixture()
  try {
    const rec = seedRun(f.wsRoot, 'run-annwire0001', {
      pendingChecks: [{ ruleId: 'RULE-X', missing: ['txCount24h'], note: '缺依据' }],
    })
    // 新建缺 outcome → 拒
    await expectOrigCode(
      () => f.service.remoteExportAnnotateExperience({ runId: rec.runId, outcomeReason: 'x' }),
      'INVALID_ARGS',
    )
    // 无任何 patch → 拒
    await expectOrigCode(
      () => f.service.remoteExportAnnotateExperience({ runId: rec.runId }),
      'INVALID_ARGS',
    )
    // 新建：S5.4.2 初稿为 partial（有 pendingChecks）；人审定性改判 success
    const created = await f.service.remoteExportAnnotateExperience({
      runId: rec.runId,
      outcome: 'success',
      outcomeReason: '人工核验通过',
      reviewFocus: ['txCount24h'],
    })
    assert.equal(created.created, true)
    assert.equal(created.humanReviewRequired, true)
    assert.equal(created.note.outcome, 'success')
    assert.deepEqual(created.note.reviewFocus, ['txCount24h'])

    // 回填：误迁移 by 忽略入参自报，一律宿主身份
    const patched = await f.service.remoteExportAnnotateExperience({
      runId: rec.runId,
      misTransfer: { judged: true, note: '复用到异域' },
    })
    assert.equal(patched.created, false)
    assert.equal(patched.note.misTransfer.judged, true)
    assert.equal(patched.note.misTransfer.by, 'host:u-exp')
  } finally {
    f.dispose()
  }
})

test('annotateExperience / reviewExperience / abstractExperiences：无身份 fail-closed REVIEWER_UNCONFIRMED', async () => {
  const f = fixture()
  try {
    const rec = seedRun(f.wsRoot, 'run-noauth00001')
    f.setIdentity(null)
    await expectOrigCode(
      () => f.service.remoteExportAnnotateExperience({ runId: rec.runId, outcome: 'success' }),
      'REVIEWER_UNCONFIRMED',
    )
    await expectOrigCode(
      () => f.service.remoteExportReviewExperience({ runId: rec.runId, outcome: 'success' }),
      'REVIEWER_UNCONFIRMED',
    )
    await expectOrigCode(
      () => f.service.remoteExportAbstractExperiences({ packageId: 'aml-analysis@1.0.0' }),
      'REVIEWER_UNCONFIRMED',
    )
  } finally {
    f.dispose()
  }
})

test('reviewExperience：misTransfer.by 不收自报——覆盖为宿主可信身份', async () => {
  const f = fixture()
  try {
    const rec = seedRun(f.wsRoot, 'run-misby00001')
    await f.service.remoteExportAnnotateExperience({ runId: rec.runId, outcome: 'partial' })
    const { note } = await f.service.remoteExportReviewExperience({
      runId: rec.runId,
      misTransfer: { judged: true, by: '张三（表单自称）', note: '复用到异域' },
    })
    assert.equal(note.misTransfer.by, 'host:u-exp')
  } finally {
    f.dispose()
  }
})

test('annotateExperience / reviewExperience：counterexample 可改判——机械置位可清除（认定在人工）', async () => {
  const f = fixture()
  try {
    // S5.4.2 机械初稿：审计失败 → counterexample=true（experienceFromRun 置位）
    const rec = seedRun(f.wsRoot, 'run-cex0000001', { auditPassed: false })
    const pkg = loadPackage(join(f.wsRoot, 'packages', 'aml-analysis', '1.0.0'))
    saveExperienceNote(f.wsRoot, experienceFromRun(rec, pkg))
    assert.equal(loadExperienceNote(f.wsRoot, rec.runId).counterexample, true)

    // annotate 回填清除（不得静默丢弃该参数）
    const cleared = await f.service.remoteExportAnnotateExperience({ runId: rec.runId, counterexample: false })
    assert.equal(cleared.created, false)
    assert.equal(cleared.note.counterexample, false)
    assert.equal(loadExperienceNote(f.wsRoot, rec.runId).counterexample, false)

    // reviewExperience 同样可置回
    const { note } = await f.service.remoteExportReviewExperience({ runId: rec.runId, counterexample: true })
    assert.equal(note.counterexample, true)
  } finally {
    f.dispose()
  }
})

/** 组一个「1.0.0 生产经验 + 1.1.0 DRAFT」工作区（断链 B 复现场景）。 */
function forkWorkspace(f) {
  const dir110 = join(f.wsRoot, 'packages', 'aml-analysis', '1.1.0')
  mkdirSync(join(dir110, '..'), { recursive: true })
  cpSync(AML_SRC, dir110, { recursive: true })
  const pkg110 = loadPackage(dir110)
  pkg110.meta.version = '1.1.0'
  pkg110.meta.status = 'DRAFT'
  pkg110.meta.issueRecord = []
  savePackage(dir110, pkg110)
  // 两条 1.0.0 成功经验（同 stepShape 聚簇）
  const pkg100 = loadPackage(join(f.wsRoot, 'packages', 'aml-analysis', '1.0.0'))
  for (const runId of ['run-prd000001', 'run-prd000002']) {
    const rec = seedRun(f.wsRoot, runId)
    saveExperienceNote(f.wsRoot, experienceFromRun(rec, pkg100))
  }
}

test('abstractExperiences：聚簇入队（只入队不直写包）+ humanReviewRequired', async () => {
  const f = fixture()
  try {
    forkWorkspace(f)
    const out = await f.service.remoteExportAbstractExperiences({ packageId: 'aml-analysis@1.0.0' })
    assert.equal(out.humanReviewRequired, true)
    assert.equal(out.skills, 1)
    assert.equal(out.queued.length, 1)
    assert.equal(out.queued[0].targetKind, 'SkillTemplate')
    assert.equal(out.queued[0].members, 2)
    assert.equal(out.queued[0].status, 'pending')
  } finally {
    f.dispose()
  }
})

test('abstractExperiences：断链 B——默认精确版本匹配不到 ISSUED 经验；includePriorVersions 回流 DRAFT', async () => {
  const f = fixture()
  try {
    forkWorkspace(f)
    // 死锁复现：1.1.0 默认匹配不到绑定 1.0.0 的生产经验
    const none = await f.service.remoteExportAbstractExperiences({ packageId: 'aml-analysis@1.1.0' })
    assert.equal(none.skills, 0)
    assert.equal(none.queued.length, 0)

    // includePriorVersions：同名历史版本经验聚簇入当前 DRAFT 版本
    const abs = await f.service.remoteExportAbstractExperiences({
      packageId: 'aml-analysis@1.1.0',
      includePriorVersions: true,
    })
    assert.equal(abs.skills, 1)
    assert.equal(abs.queued.length, 1)
    assert.equal(abs.queued[0].targetKind, 'SkillTemplate')
    assert.equal(abs.queued[0].members, 2)
  } finally {
    f.dispose()
  }
})
