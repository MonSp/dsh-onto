/**
 * M1-E 结构化报告验收（方案 §8）：固定展示本体版本/runId/来源时效/分析模式/三状态；
 * 四态分离声明（低分/审计/人审/动作不混用）；低分与 insufficient 不混读。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderRunText } from '../dist/agent-policy.js'

const RESULT = {
  scenarioId: 'SCN-TST-1',
  runId: 'run-abc12345',
  startedAt: '2026-11-16T00:00:00Z',
  candidates: [{
    candidateId: 'C1',
    objectRef: 'A1',
    riskScore: 0,
    riskLevel: '低',
    hitRuleIds: [],
    evidenceChains: [],
    narrative: [],
    pendingChecks: [],
    pendingVerification: true,
  }],
  excluded: [],
  humanReviewRequired: true,
  reviewGate: { threshold: 0.75, required: true, requireReviewFor: [] },
  ruleHitLog: [],
  audit: { checks: [], forbiddenPhraseHits: [], passed: true },
  contractStatus: 'conformant',
  dataStatus: 'insufficient',
}

test('E1-1 报告头固定展示：本体版本 / runId / 分析模式 / 来源时效', () => {
  const text = renderRunText(RESULT, [], {
    package: { name: 'aml-analysis', version: '1.1.0' },
    analysisMode: 'formal',
  })
  assert.ok(text.includes('本体 aml-analysis@1.1.0'), text)
  assert.ok(text.includes('run-abc12345'))
  assert.ok(text.includes('分析模式: formal'))
  assert.ok(text.includes('数据来源') || text.includes('数据状态'), '来源/时效在场')
})

test('E1-2 三状态上墙且不与 audit.passed 混用；reviewStatus 独立行', () => {
  const text = renderRunText(RESULT, [], { analysisMode: 'formal' })
  assert.ok(text.includes('契约状态: conformant'), text)
  assert.ok(text.includes('数据状态: insufficient'), 'insufficient 明示')
  assert.ok(/不可处置/.test(text), 'insufficient 语义上墙')
  assert.ok(text.includes('复核状态: pending'), 'reviewStatus 独立行')
  assert.ok(text.includes('三层闭合: passed'), 'audit.passed 自己一行（与三状态分立）')
})

test('E1-3 四态分离声明：低分/审计/人审/动作不混用', () => {
  const text = renderRunText(RESULT, [], {})
  assert.ok(text.includes('四态分离'), text)
  assert.ok(/低分≠低风险结论/.test(text))
  assert.ok(/审计通过≠可信数据/.test(text))
  assert.ok(/人审恒真≠复核通过/.test(text))
  assert.ok(/不含动作执行结论/.test(text))
})

test('E1-4 低分 + insufficient 不混读：候选 0 分仍带 pendingVerification 上墙', () => {
  const text = renderRunText(RESULT, [], { analysisMode: 'formal' })
  assert.ok(text.includes('riskScore=0'), '分数如实')
  assert.ok(text.includes('pendingVerification=true'), '低分不得单独解读为低风险')
})

test('E1-5 dataStatus 各态语义行正确', () => {
  for (const [status, word] of [
    ['verified', '全过'],
    ['conditional', '条件性分数'],
    ['unverified', '仅在数据集内自洽'],
  ]) {
    const text = renderRunText({ ...RESULT, dataStatus: status }, [], {})
    assert.ok(text.includes(`数据状态: ${status}`), text)
    assert.ok(text.includes(word), `${status} 语义: ${word}`)
  }
})

/* ── M1-E 守卫强化：百分比规避闭合 / ruleId 绑定 / notes 持久化 ────────── */

import { processAnswerText, createAnswerGuard, UNVERIFIED_RULE_TOKEN } from '../dist/agent-answer-guard.js'

function factsWith(scores, hitRuleIds = []) {
  return {
    grounded: true,
    runs: [{
      runId: 'run-abc12345',
      scenarioId: 'SCN-TST-1',
      scores: new Map(Object.entries(scores)),
      thresholds: [0.75],
      evidenceScores: [0.5],
      hitRuleIds: new Set(hitRuleIds),
    }],
  }
}

test('E2-1 百分比规避闭合：风险分 95% 形声明照常核验（不再因 % 绕过）', () => {
  const facts = factsWith({ 'CAND-001': 0.92 })
  // 一致（0.92 = 92%）
  const ok = processAnswerText('CAND-001 风险分 92%', { phrases: [], facts })
  assert.equal(ok.maskedNumbers, 0, ok.text)
  // 不一致 → 核正（保持 % 形）
  const fix = processAnswerText('CAND-001 风险分 95%', { phrases: [], facts })
  assert.equal(fix.correctedNumbers, 1, fix.text)
  assert.ok(/92(\.0)?%/.test(fix.text), '核正后保持 % 形: ' + fix.text)
  // 无法绑定 → 未核验标记
  const bad = processAnswerText('CAND-9 风险分 77%', { phrases: [], facts })
  assert.equal(bad.maskedNumbers, 1)
})

test('E2-2 ruleId 绑定：无规则依据的命中声明标【未核验规则】；真实命中不标', () => {
  const facts = factsWith({ 'CAND-001': 0.9 }, ['RULE-A1'])
  const res = processAnswerText('CAND-001 命中 RULE-A1 与 RULE-FAKE', { phrases: [], facts })
  assert.ok(res.text.includes('RULE-A1') && !res.text.includes('RULE-A1' + UNVERIFIED_RULE_TOKEN), '真实命中不标: ' + res.text)
  assert.ok(res.text.includes('RULE-FAKE' + UNVERIFIED_RULE_TOKEN), '无据命中显式标: ' + res.text)
  assert.ok(res.notes.some((n) => /未核验规则/.test(n)), '核验说明留痕')
  // 负向陈述不标（RULE-X 未命中 是可为空的真负陈述）
  const neg = processAnswerText('RULE-FAKE 未命中', { phrases: [], facts })
  assert.ok(!neg.text.includes(UNVERIFIED_RULE_TOKEN), neg.text)
})

test('E2-3 notes 持久化：finish 时交 persistNotes（不只局部变量）', async () => {
  const entry = factsWith({ 'CAND-001': 0.92 }).runs[0]
  const saved = []
  const guard = createAnswerGuard({
    phrases: () => [],
    loadRunFacts: () => entry,
    persistNotes: (notes) => saved.push(...notes),
  })
  const messages = [
    { role: 'assistant', content: [{ type: 'tool-call', id: 'tc1', name: 'run_scenario' }] },
    {
      role: 'tool',
      toolCallId: 'tc1',
      content: [{ type: 'text', text: '场景 SCN-TST-1 · 运行 run-abc12345\n- CAND-001 riskScore=0.92\n命中规则: RULE-A1' }],
    },
  ]
  const options = { messages, purpose: undefined, sessionId: 's1' }
  const chunks = (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'CAND-001 风险分 95%' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'CAND-001 风险分 95%' } }
    yield { type: 'finish', reason: 'stop' }
  })()
  for await (const c of guard(options, () => chunks)) {
    void c
  }
  assert.ok(saved.length >= 1, '核验说明持久化: ' + JSON.stringify(saved))
  assert.ok(saved.some((n) => /核正/.test(n)), '核正说明进持久化: ' + JSON.stringify(saved))
})


