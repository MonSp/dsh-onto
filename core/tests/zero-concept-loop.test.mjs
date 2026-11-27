/** 零概念上手环核心验收（spec zero-concept-loop S2.1/S2.2）：DOCUMENT 原料 + 试跑沙箱。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HeuristicLlm,
  buildRunRecord,
  compareRunRecords,
  loadRunRecord,
  ruleBasisDigest,
  ruleEngineConfigOf,
  runScenario,
  saveRunRecord,
  trialRuleConfigFromDrafts,
} from '../dist/index.js'
import { mkWorkspace, mkWorkspaceWithPkg, rmWorkspace, savePackage, derivePackage } from './helpers.mjs'

function fakeResult() {
  return {
    scenarioId: 'SCN-TST-1',
    runId: 'run-abc12345',
    startedAt: '2026-11-05T00:00:00.000Z',
    candidates: [],
    excluded: [],
    humanReviewRequired: true,
    reviewGate: { threshold: 0.75, required: true, requireReviewFor: [] },
    ruleHitLog: [{ ruleId: 'RULE-TST-S1', candidateId: 'CAND-001', score: 0.5, ts: 't' }],
    audit: { checks: [], forbiddenPhraseHits: [], passed: true },
  }
}

function fakeDataset() {
  return {
    objects: [
      { id: 'OBJ-TST-A:1', type: 'OBJ-TST-A', attrs: { a1: 'x' } },
      { id: 'OBJ-TST-A:2', type: 'OBJ-TST-A', attrs: { a1: 'y' } },
    ],
    relations: [],
    behaviors: [],
    candidates: [
      { candidateId: 'CAND-001', objectRef: 'OBJ-TST-A:1', features: { f1: 1 }, tags: [] },
      { candidateId: 'CAND-002', objectRef: 'OBJ-TST-A:2', features: { f1: 0.2 }, tags: ['t'] },
    ],
    provenance: 'file',
  }
}

const DOC_TEXT = [
  '设备台账,金额,状态',
  'E-1,12000,正常',
  'E-2,300,正常',
  '单笔金额超过 10000 元的设备须重点关注',
  '严禁对未核实设备直接下处置结论',
].join('\n')

test('DOCUMENT 原料：启发解析出对象/属性/统计口径/阈值规则/红线（零概念原料→对象和规则）', async () => {
  const llm = new HeuristicLlm()
  const res = await llm.parseSource({
    sourceType: 'DOCUMENT',
    packageName: 'test-pkg',
    content: DOC_TEXT,
  })
  const kinds = res.items.map((i) => i.targetKind)
  assert.ok(kinds.includes('ObjectType'), `缺对象草案: ${JSON.stringify(kinds)}`)
  assert.ok(kinds.includes('ScoreRule'), `缺规则草案: ${JSON.stringify(kinds)}`)
  assert.ok(kinds.includes('RedLine'), `缺红线草案: ${JSON.stringify(kinds)}`)
  // 结论性/禁止性语句只落红线（不产出认定）
  const redline = res.items.find((i) => i.targetKind === 'RedLine')
  assert.ok(redline?.payload.phrases.length > 0)
})

test('trialRuleConfigFromDrafts：草案入内存配置（不落包），包盘面零改动；非规则草案显式忽略', () => {
  const { ws, dir, pkg } = mkWorkspaceWithPkg()
  try {
    const before = JSON.stringify(pkg)
    const drafts = [
      {
        layer: 'O2',
        targetKind: 'ScoreRule',
        op: 'create',
        name: '试算规则',
        payload: { name: '试算规则', weight: 3, expression: '1', threshold: 0.4 },
        confidence: 0.8,
        rationale: 'trial',
      },
      {
        layer: 'O2',
        targetKind: 'ExclusionRule',
        op: 'create',
        name: '试算排除',
        payload: { name: '试算排除', action: 'drop', condition: "tag == 't'" },
        confidence: 0.8,
        rationale: 'trial',
      },
      {
        layer: 'O3',
        targetKind: 'RedLine',
        op: 'create',
        name: '红线:严禁直判',
        payload: { phrases: ['严禁直判'] },
        confidence: 0.9,
        rationale: 'trial',
      },
    ]
    const plan = trialRuleConfigFromDrafts(pkg, 'SCN-TST-1', drafts)
    // 配置含既有规则 + 两条规则草案（场景收窄位不圈时全量）
    assert.ok(plan.ruleConfig.scoring.some((r) => r.name === '试算规则'))
    assert.ok(plan.ruleConfig.exclusion.some((r) => r.name === '试算排除'))
    // 红线草案不参与试算——显式忽略 + 警告（评审 gap-1：不得静默空转）
    assert.deepEqual(plan.ignoredDraftIds, ['红线:严禁直判'])
    assert.ok(plan.warnings.some((w) => w.includes('不参与试算') && w.includes('红线')), plan.warnings.join('；'))
    // create 差别提示（评审 gap-3：试算≠采纳）
    assert.ok(plan.warnings.some((w) => w.includes('归一') && w.includes('scoreRefs')), plan.warnings.join('；'))
    assert.equal(JSON.stringify(pkg), before, '包本体零改动（内存克隆应用）')
    // 与现盘配置对照：基线不含草案
    const base = ruleEngineConfigOf(pkg, pkg.scenarios[0])
    assert.ok(!base.scoring.some((r) => r.name === '试算规则'))
    assert.throws(() => trialRuleConfigFromDrafts(pkg, 'SCN-NOPE', []), (e) => e.code === 'NOT_FOUND')
  } finally {
    rmWorkspace(ws.root)
  }
})

test('trialRuleConfigFromDrafts：update 草案目标不在场景收窄 → 显式警告不静默（评审 gap-2）', () => {
  const { ws, dir, pkg } = mkWorkspaceWithPkg()
  try {
    // 场景收窄到 RULE-TST-S1；对收窄外规则的 update 试算不生效 → 警告
    const narrowed = structuredClone(pkg)
    // 既有第二条打分规则（在包内但不在收窄范围）——update 试算不生效须显式警告
    narrowed.scoreRules.push({ id: 'RULE-TST-S2', name: '规则二', weight: 1, expression: '1' })
    narrowed.scenarios[0].scoreRefs = ['RULE-TST-S1']
    const drafts = [
      {
        layer: 'O2',
        targetKind: 'ScoreRule',
        op: 'update',
        targetId: 'RULE-TST-S2',
        name: '改权重',
        payload: { weight: 0.9 },
        confidence: 0.8,
        rationale: 'trial',
      },
    ]
    const plan = trialRuleConfigFromDrafts(narrowed, 'SCN-TST-1', drafts)
    assert.equal(plan.ruleConfig.scoring.some((s) => s.id === 'RULE-TST-S2'), false)
    assert.ok(plan.warnings.some((w) => w.includes('RULE-TST-S2') && w.includes('不生效')), plan.warnings.join('；'))
  } finally {
    rmWorkspace(ws.root)
  }
})

test('runScenario ruleConfig 覆盖：试算命中/分数随草案变；trial 标记随 RunRecord 落盘', () => {
  const { ws, dir, pkg } = mkWorkspaceWithPkg()
  try {
    derivePackage(dir)
    const dataset = fakeDataset()
    const base = runScenario(dir, 'SCN-TST-1', dataset)
    const drafts = [
      {
        layer: 'O2',
        targetKind: 'ScoreRule',
        op: 'create',
        name: '试算加权',
        payload: { name: '试算加权', weight: 5, expression: 'min(1, f1)', threshold: 0.1 },
        confidence: 0.8,
        rationale: 'trial',
      },
    ]
    const config = trialRuleConfigFromDrafts(pkg, 'SCN-TST-1', drafts).ruleConfig
    const trial = runScenario(dir, 'SCN-TST-1', dataset, {
      ruleConfig: config,
    })
    // 试算结果与基线可区分（命中/分数变化即试错环的「对照」信号源）
    assert.notEqual(JSON.stringify(trial.ruleHitLog), JSON.stringify(base.ruleHitLog))
    assert.equal(trial.humanReviewRequired, true, '试算仍恒人审')
    // trial 标记随 RunRecord 落盘；正式运行不落键
    const rec = buildRunRecord({
      package: { name: 'test-pkg', version: '1.0.0' },
      dataset,
      result: trial,
      redlines: [],
      trial: { draftIds: ['kd-trial0001'], label: '试算' },
    })
    saveRunRecord(ws.root, rec)
    const back = loadRunRecord(ws.root, trial.runId)
    assert.deepEqual(back.trial, { draftIds: ['kd-trial0001'], label: '试算' })
    const plain = buildRunRecord({
      package: { name: 'test-pkg', version: '1.0.0' },
      dataset,
      result: base,
      redlines: [],
    })
    assert.equal('trial' in plain, false, '正式运行不落 trial 键')
  } finally {
    rmWorkspace(ws.root)
  }
})

test('ruleBasisDigest 折入 trial（试算指纹不与正式互认）；RunDiff 带 trial 标记', () => {
  const ws = mkWorkspace()
  try {
    const dataset = fakeDataset()
    const mk = (result, trial) => buildRunRecord({
      package: { name: 'test-pkg', version: '1.0.0' },
      dataset,
      result,
      redlines: [],
      savedAt: '2026-11-05T01:00:00.000Z',
      ...(trial === undefined ? {} : { trial }),
    })
    const base = fakeResult()
    // 用同一 result 骨架造正式/试算两 run（指纹只看 ruleHitLog+trial）
    const formal = mk(base, undefined)
    const trial1 = mk(base, { draftIds: ['kd-b'] })
    const trial2 = mk(base, { draftIds: ['kd-b'] })
    const trialOther = mk(base, { draftIds: ['kd-a'] })
    assert.notEqual(ruleBasisDigest(formal), ruleBasisDigest(trial1), '试算指纹不得与正式互认')
    assert.equal(ruleBasisDigest(trial1), ruleBasisDigest(trial2), '同草案集同指纹')
    assert.notEqual(ruleBasisDigest(trial1), ruleBasisDigest(trialOther), '异草案集异指纹')
    // RunDiff 试算标记上墙（对照面可区分试算/正式）
    const diff = compareRunRecords(formal, trial1)
    assert.equal(diff.trialA, undefined)
    assert.deepEqual(diff.trialB, { draftIds: ['kd-b'] })
  } finally {
    rmWorkspace(ws.root)
  }
})
