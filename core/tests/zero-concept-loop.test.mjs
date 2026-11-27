/** 零概念上手环核心验收（spec zero-concept-loop S2.1/S2.2）：DOCUMENT 原料 + 试跑沙箱。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HeuristicLlm,
  buildRunRecord,
  loadRunRecord,
  ruleEngineConfigOf,
  runScenario,
  saveRunRecord,
  trialRuleConfigFromDrafts,
} from '../dist/index.js'
import { mkWorkspaceWithPkg, rmWorkspace, savePackage, derivePackage } from './helpers.mjs'

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

test('trialRuleConfigFromDrafts：草案入内存配置（不落包），包盘面零改动', () => {
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
    ]
    const config = trialRuleConfigFromDrafts(pkg, 'SCN-TST-1', drafts)
    // 配置含既有规则 + 两条草案（场景收窄位不圈时全量）
    assert.ok(config.scoring.some((r) => r.name === '试算规则'))
    assert.ok(config.exclusion.some((r) => r.name === '试算排除'))
    assert.equal(JSON.stringify(pkg), before, '包本体零改动（内存克隆应用）')
    // 与现盘配置对照：基线不含草案
    const base = ruleEngineConfigOf(pkg, pkg.scenarios[0])
    assert.ok(!base.scoring.some((r) => r.name === '试算规则'))
    assert.throws(() => trialRuleConfigFromDrafts(pkg, 'SCN-NOPE', []), (e) => e.code === 'NOT_FOUND')
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
    const config = trialRuleConfigFromDrafts(pkg, 'SCN-TST-1', drafts)
    const trial = runScenario(dir, 'SCN-TST-1', dataset, {
      ruleConfig: config,
      trial: { draftIds: ['kd-trial0001'], label: '试算' },
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
