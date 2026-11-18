/**
 * 最终回答守卫测试（可信回答 T3 + R2 字段级核验）：
 * 权威事实提取（按 run/candidate/字段） / 禁语遮蔽 / 字段级核正 / 无运行支撑降级 / 流式闸。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ANSWER_MASK_TOKEN,
  UNGROUNDED_FOOTER,
  UNVERIFIED_NUMBER_TOKEN,
  createAnswerGuard,
  extractAnswerFacts,
  processAnswerText,
} from '../dist/agent-answer-guard.js'

/** 构造一次「run_scenario 已跑」的请求消息面。 */
function messagesWithRun(runText) {
  return [
    { role: 'user', content: [{ type: 'text', text: '跑一下 AML' }] },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'call1', name: 'run_scenario', arguments: '{}' }],
    },
    { role: 'tool', toolCallId: 'call1', content: [{ type: 'text', text: runText }] },
  ]
}

/** 两轮运行（同候选不同分）的请求消息面。 */
function messagesWithTwoRuns(textA, textB) {
  return [
    { role: 'user', content: [{ type: 'text', text: '跑两轮' }] },
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', id: 'call1', name: 'run_scenario', arguments: '{}' },
        { type: 'tool-call', id: 'call2', name: 'run_scenario', arguments: '{}' },
      ],
    },
    { role: 'tool', toolCallId: 'call1', content: [{ type: 'text', text: textA }] },
    { role: 'tool', toolCallId: 'call2', content: [{ type: 'text', text: textB }] },
  ]
}

const RUN_TEXT = [
  '场景 SCN-AML-FIND-CLUES · 运行 run-abc12345',
  '- CAND-001（ACCT-001）riskScore=0.897 riskLevel=高',
  '  命中规则: RULE-AML-SCORE-FANOUT',
  '  证据[RULE-AML-SCORE-FANOUT] 近 7 日转入 12 笔、转出 250000 元 (score=0.5)',
  '—— 合规 ——',
  'humanReviewRequired=true（认定出口只在人工复核）',
  'review≤0.75: CAND-001',
].join('\n')

const RUN_TEXT_TWO = [
  '场景 SCN-AML-FIND-CLUES · 运行 run-abc12345',
  '- CAND-001（ACCT-001）riskScore=0.9 riskLevel=高',
  '- CAND-002（ACCT-002）riskScore=0.2 riskLevel=低',
  '  证据[RULE-X] 近 7 日转入 3 笔 (score=0.25)',
  'review≤0.75: CAND-001',
].join('\n')

test('extractAnswerFacts：按 run/candidate/字段提取 grounded / 风险分 / 阈值与证据分', () => {
  const facts = extractAnswerFacts(messagesWithRun(RUN_TEXT))
  assert.equal(facts.grounded, true)
  assert.equal(facts.runs.length, 1)
  const run = facts.runs[0]
  assert.equal(run.runId, 'run-abc12345')
  assert.equal(run.scenarioId, 'SCN-AML-FIND-CLUES')
  assert.equal(run.scores.get('CAND-001'), 0.897)
  assert.ok(run.thresholds.includes(0.75), 'review 阈值在阈值字段（不与分数混池）')
  assert.ok(run.evidenceScores.includes(0.5), '证据分在证据字段')
  assert.ok(!run.thresholds.includes(0.897) && !run.evidenceScores.includes(0.897), '字段面不互混')
  // 无 run 工具 / 工具报错 → 不算运行证据
  assert.equal(extractAnswerFacts([]).grounded, false)
  assert.equal(extractAnswerFacts([]).runs.length, 0)
  const failed = messagesWithRun(RUN_TEXT).map((m) => (m.role === 'tool' ? { ...m, isError: true } : m))
  assert.equal(extractAnswerFacts(failed).grounded, false)
})

test('extractAnswerFacts：优先可信结构化运行结果（loadRunFacts），不依赖渲染文本正则', () => {
  const structured = {
    runId: 'run-abc12345',
    scenarioId: 'SCN-AML-FIND-CLUES',
    scores: new Map([['CAND-001', 0.897]]),
    thresholds: [0.75],
    evidenceScores: [0.5],
  }
  // 文本里的 0.9 是被改写的渲染面——结构化事实须覆盖它
  const tampered = RUN_TEXT.replace('riskScore=0.897', 'riskScore=0.1')
  const facts = extractAnswerFacts(messagesWithRun(tampered), {
    loadRunFacts: (runId) => (runId === 'run-abc12345' ? structured : undefined),
  })
  assert.equal(facts.runs[0].scores.get('CAND-001'), 0.897, '结构化事实优先于渲染文本')
})

test('processAnswerText 禁语遮蔽：红线短语整值替换，多处命中都遮', () => {
  const out = processAnswerText('结论：认定洗钱成立。补充：认定洗钱证据不足。', {
    phrases: ['认定洗钱'],
    facts: extractAnswerFacts([]),
  })
  assert.ok(!out.text.includes('认定洗钱'))
  assert.equal(out.maskedPhrases, 2)
  assert.ok(out.text.includes(ANSWER_MASK_TOKEN))
})

test('R2-1 正确双候选回答逐字保留（不被邻域小数替换污染）', () => {
  const facts = extractAnswerFacts(messagesWithRun(RUN_TEXT_TWO))
  const input = 'CAND-001 riskScore=0.9; CAND-002 riskScore=0.2.'
  const out = processAnswerText(input, { phrases: [], facts })
  assert.equal(out.text, input, '正确多候选声明一字不改')
  assert.equal(out.correctedNumbers, 0)
  assert.equal(out.maskedNumbers, 0)
  assert.deepEqual(out.notes, [])
})

test('R2-2 相邻风险分、阈值、证据分互不污染', () => {
  const facts = extractAnswerFacts(messagesWithRun(RUN_TEXT_TWO))
  // 阈值 0.75 紧邻候选——不得被当成候选风险分核正
  const input = 'CAND-001 riskScore=0.9，review threshold=0.75，证据分 score=0.25。'
  const out = processAnswerText(input, { phrases: [], facts })
  assert.equal(out.text, input, '阈值/证据分不得被邻近候选分数改写')
  assert.equal(out.correctedNumbers, 0)
  // 风险分错误 + 阈值正确：只改风险分
  const mixed = processAnswerText('CAND-001 riskScore=0.42，review threshold=0.75。', { phrases: [], facts })
  assert.ok(mixed.text.includes('CAND-001 riskScore=0.9'), '错误风险分按字段核正')
  assert.ok(mixed.text.includes('threshold=0.75'), '阈值保持 0.75 不动')
  assert.equal(mixed.correctedNumbers, 1)
  // 阈值错误 → 按阈值字段核正，不用候选分
  const badThreshold = processAnswerText('CAND-001 riskScore=0.9，review threshold=0.9。', { phrases: [], facts })
  assert.ok(badThreshold.text.includes('threshold=0.75'), '阈值核正为 0.75（不是 0.9）')
})

test('R2-3 候选邻域数字不再整窗替换：证据分/叙述数字不受牵连', () => {
  const facts = extractAnswerFacts(messagesWithRun(RUN_TEXT))
  // 旧算法会把 40 字符窗内全部小数改成候选分——叙述里的 0.12 不得动
  const input = 'CAND-001 的风险分是 0.95（误写），均值 0.12，阈值 0.75。'
  const out = processAnswerText(input, { phrases: [], facts })
  assert.ok(out.text.includes('风险分是 0.897'), '风险分声明核正为权威值')
  assert.ok(out.text.includes('均值 0.12'), '无声明语义的叙述数字不得改写')
  assert.ok(out.text.includes('阈值 0.75'), '阈值数字不被拉进候选窗口')
  assert.equal(out.correctedNumbers, 1)
})

test('R2-4 未知候选用另一候选的合法分数：不得因数字在事实池而放行', () => {
  const facts = extractAnswerFacts(messagesWithRun(RUN_TEXT_TWO))
  const out = processAnswerText('CAND-999 riskScore=0.9，建议关注。', { phrases: [], facts })
  assert.ok(!out.text.includes('0.9'), '未知候选的声明数字不得放行')
  assert.ok(out.text.includes(UNVERIFIED_NUMBER_TOKEN))
  assert.equal(out.maskedNumbers, 1)
  // 无候选绑定的裸风险分声明同样不放行
  const unbound = processAnswerText('风险分=0.9，应当警惕。', { phrases: [], facts })
  assert.ok(unbound.text.includes(UNVERIFIED_NUMBER_TOKEN), '无法绑定候选/字段的数字标记待核验')
})

test('R2-5 同候选跨两轮：引用 run 可消歧；无 run 消歧则降级不擅自改值', () => {
  const textA = RUN_TEXT_TWO
  const textB = [
    '场景 SCN-AML-FIND-CLUES · 运行 run-zzz99999',
    '- CAND-001（ACCT-001）riskScore=0.3 riskLevel=低',
    'review≤0.75: CAND-001',
  ].join('\n')
  const facts = extractAnswerFacts(messagesWithTwoRuns(textA, textB))
  assert.equal(facts.runs.length, 2)
  // 无 run 引用：同候选两轮不同分 → 不自动核正，标记待核验
  const ambiguous = processAnswerText('CAND-001 riskScore=0.5。', { phrases: [], facts })
  assert.ok(!ambiguous.text.includes('0.5'), '歧义时不采用最后遍历值，标记待核验')
  assert.ok(ambiguous.text.includes(UNVERIFIED_NUMBER_TOKEN))
  // 引用 run-abc12345 → 按该轮 0.9 核正
  const hinted = processAnswerText('按 run-abc12345：CAND-001 riskScore=0.5。', { phrases: [], facts })
  assert.ok(hinted.text.includes('riskScore=0.9'), 'run 消歧后按该轮事实核正')
  // 引用 run-zzz99999 → 按该轮 0.3 核正
  const hinted2 = processAnswerText('按 run-zzz99999：CAND-001 riskScore=0.5。', { phrases: [], facts })
  assert.ok(hinted2.text.includes('riskScore=0.3'))
})

test('R2-6 表格 / 中文叙述 / 百分比 / 整数边界 0/1 / 跨文本块', () => {
  const facts = extractAnswerFacts(messagesWithRun(RUN_TEXT_TWO))
  // Markdown 表格：表头语义列 → 逐字段核验；正确表逐字保留
  const table = [
    '| 候选 | 风险分 | 阈值 |',
    '| --- | --- | --- |',
    '| CAND-001 | 0.9 | 0.75 |',
    '| CAND-002 | 0.2 | 0.75 |',
  ].join('\n')
  const outTable = processAnswerText(table, { phrases: [], facts })
  assert.equal(outTable.text, table, '正确表格逐字保留')
  const badTable = processAnswerText(table.replace('| CAND-001 | 0.9 |', '| CAND-001 | 0.95 |'), {
    phrases: [],
    facts,
  })
  assert.ok(badTable.text.includes('| CAND-001 | 0.9 |'), '表格单元里的风险分按字段核正')
  assert.ok(badTable.text.includes('| 0.75 |'), '同列阈值不受牵连')
  // 中文叙述
  const zh = processAnswerText('CAND-002 的风险分为 0.2，低于阈值 0.75。', { phrases: [], facts })
  assert.equal(zh.text, 'CAND-002 的风险分为 0.2，低于阈值 0.75。', '正确中文叙述逐字保留')
  // 百分比不按分数处理
  const pct = processAnswerText('CAND-001 风险分 0.9，环比 89.7%，占比 0.5%。', { phrases: [], facts })
  assert.ok(pct.text.includes('89.7%') && pct.text.includes('0.5%'), '百分比表达不得改写/遮蔽')
  // 整数边界 0/1
  const facts1 = extractAnswerFacts(
    messagesWithRun('场景 SCN-X · 运行 run-abc12345\n- CAND-001（A1）riskScore=1 riskLevel=高'),
  )
  const intOk = processAnswerText('CAND-001 riskScore=1。', { phrases: [], facts: facts1 })
  assert.equal(intOk.text, 'CAND-001 riskScore=1。', '整数边界 1 逐字保留')
  const intBad = processAnswerText('CAND-001 riskScore=0。', { phrases: [], facts: facts1 })
  assert.ok(intBad.text.includes('riskScore=1'), '整数 0 错误声明按字段核正为 1')
})

test('R2-7 错误声明可审计：notes 记录核正/待核验说明（不含遮蔽原文）', () => {
  const facts = extractAnswerFacts(messagesWithRun(RUN_TEXT_TWO))
  const corrected = processAnswerText('CAND-001 riskScore=0.42。', { phrases: [], facts })
  assert.equal(corrected.notes.length, 1)
  assert.match(corrected.notes[0], /CAND-001/)
  assert.match(corrected.notes[0], /核正/)
  const masked = processAnswerText('CAND-777 riskScore=0.42。', { phrases: [], facts })
  assert.equal(masked.notes.length, 1)
  assert.match(masked.notes[0], /待核验/)
  assert.ok(!masked.notes[0].includes('0.42'), '核验说明不回显被遮蔽数值')
})

test('processAnswerText 关键数字：风险分= 无据 → 【未核验数字】；有据（阈值/证据分）放行', () => {
  const facts = extractAnswerFacts(messagesWithRun(RUN_TEXT))
  const bad = processAnswerText('风险分=0.42，应当警惕。', { phrases: [], facts })
  assert.ok(bad.text.includes(UNVERIFIED_NUMBER_TOKEN))
  assert.equal(bad.maskedNumbers, 1)
  const ok = processAnswerText('review 阈值 0.75，证据分 score=0.5。', { phrases: [], facts })
  assert.equal(ok.maskedNumbers, 0)
  assert.equal(ok.text, 'review 阈值 0.75，证据分 score=0.5。', '正确阈值/证据分逐字保留')
})

test('processAnswerText 无运行支撑（T3.2）：分数类数字整体降级 + claimSeen 驱动页脚', () => {
  const out = processAnswerText('CAND-099 风险分 0.88，建议上报。', {
    phrases: [],
    facts: extractAnswerFacts([]),
  })
  assert.equal(out.claimSeen, true)
  assert.ok(!out.text.includes('0.88'), '未运行核验的分数样式数字不得放行')
  assert.ok(out.text.includes(UNVERIFIED_NUMBER_TOKEN))
  // 无分数/结论引用的普通回答不触发降级
  const plain = processAnswerText('平台支持 O1/O2/O3 建模。', { phrases: [], facts: extractAnswerFacts([]) })
  assert.equal(plain.claimSeen, false)
  assert.equal(plain.text, '平台支持 O1/O2/O3 建模。')
})

/** 收集守卫输出流。 */
async function collect(listener, options, chunks) {
  const out = []
  const next = async function* () {
    for (const c of chunks) yield c
  }
  for await (const c of listener(options, next)) out.push(c)
  return out
}

const SESSION_OPTS = { provider: 'p', model: 'm', messages: [], sessionId: 's1' }

test('createAnswerGuard 流式闸：delta 扣留至 block-end，汇编块覆写为处理后文本', async () => {
  const listener = createAnswerGuard({ phrases: () => ['认定洗钱'] })
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '认定洗钱，' },
    { type: 'text-delta', index: 0, text: 'CAND-001 风险分 0.95。' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '认定洗钱，CAND-001 风险分 0.95。' } },
    { type: 'finish', reason: 'stop' },
  ]
  const opts = { ...SESSION_OPTS, messages: messagesWithRun(RUN_TEXT) }
  const out = await collect(listener, opts, chunks)
  const deltas = out.filter((c) => c.type === 'text-delta')
  // 原始 delta 不透出；block-end 处理后一次放出
  assert.equal(deltas.length, 1)
  assert.ok(!deltas[0].text.includes('认定洗钱'))
  assert.ok(!deltas[0].text.includes('0.95'))
  const end = out.find((c) => c.type === 'block-end' && c.block.type === 'text')
  assert.ok(!end.block.text.includes('认定洗钱'))
  assert.ok(end.block.text.includes('0.897'))
  assert.ok(!end.block.text.includes(UNGROUNDED_FOOTER), '已运行支撑不加页脚')
})

test('R2-8 跨文本块：声明拆在两个块里也能绑定核验', async () => {
  const listener = createAnswerGuard({ phrases: () => [] })
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'CAND-001 风险分' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'CAND-001 风险分' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: ' 0.95，已复核。' },
    { type: 'block-end', index: 1, block: { type: 'text', text: ' 0.95，已复核。' } },
    { type: 'finish', reason: 'stop' },
  ]
  const opts = { ...SESSION_OPTS, messages: messagesWithRun(RUN_TEXT) }
  const out = await collect(listener, opts, chunks)
  const ends = out.filter((c) => c.type === 'block-end' && c.block.type === 'text')
  const joined = ends.map((c) => c.block.text).join('')
  assert.ok(joined.includes('0.897'), '跨块声明按权威值核正')
  assert.ok(!joined.includes('0.95'), '跨块错误数字不得残留')
})

test('createAnswerGuard 无运行支撑（T3.2）：分数降级 + 页脚内联进声明块（不另起尾块）', async () => {
  const listener = createAnswerGuard({ phrases: () => [] })
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'CAND-001 风险分 0.88。' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'CAND-001 风险分 0.88。' } },
    { type: 'finish', reason: 'stop' },
  ]
  const out = await collect(listener, SESSION_OPTS, chunks)
  const end = out.find((c) => c.type === 'block-end' && c.index === 0)
  assert.ok(end.block.text.includes(UNVERIFIED_NUMBER_TOKEN))
  assert.ok(end.block.text.includes(UNGROUNDED_FOOTER), '页脚内联进触发声明的文本块')
  const finishAt = out.findIndex((c) => c.type === 'finish')
  const stray = out.slice(0, finishAt).filter((c) => c.type === 'block-end' && c.index !== 0)
  assert.equal(stray.length, 0, '不得另起页脚尾块')
})

test('createAnswerGuard 工具调用回合：页脚不得落在 tool-call 之后（API tool_use/tool_result 配对）', async () => {
  const listener = createAnswerGuard({ phrases: () => [] })
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'CAND-001 风险分 0.88，现在调用工具。' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'CAND-001 风险分 0.88，现在调用工具。' } },
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'call_1', name: 'record_review_decision', arguments: '{}' } },
    { type: 'finish', reason: 'stop' },
  ]
  const out = await collect(listener, SESSION_OPTS, chunks)
  const finishAt = out.findIndex((c) => c.type === 'finish')
  const afterTool = out.slice(0, finishAt).filter((c) => c.type === 'block-start' || c.type === 'block-end')
  const last = afterTool[afterTool.length - 1]
  assert.equal(last.index, 1, '最后一个块必须是 tool-call——其后不得再有文本块')
  const textEnd = out.find((c) => c.type === 'block-end' && c.index === 0)
  assert.ok(textEnd.block.text.includes(UNGROUNDED_FOOTER), '页脚随声明块内联（在 tool-call 之前）')
})

test('createAnswerGuard 辅助调用不过闸：purpose 非空 / 无 sessionId 直通', async () => {
  const listener = createAnswerGuard({ phrases: () => ['认定洗钱'] })
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '认定洗钱' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '认定洗钱' } },
    { type: 'finish', reason: 'stop' },
  ]
  const titled = await collect(listener, { ...SESSION_OPTS, purpose: 'session-title' }, chunks)
  assert.deepEqual(titled, chunks, 'session-title 调用原样通过')
  const oneShot = await collect(listener, { provider: 'p', model: 'm', messages: [] }, chunks)
  assert.deepEqual(oneShot, chunks, '一次性调用原样通过')
})

test('createAnswerGuard 结构化事实：loadRunFacts 供数时按运行记录核正', async () => {
  const listener = createAnswerGuard({
    phrases: () => [],
    loadRunFacts: () => ({
      runId: 'run-abc12345',
      scenarioId: 'SCN-AML-FIND-CLUES',
      scores: new Map([['CAND-001', 0.897]]),
      thresholds: [0.75],
      evidenceScores: [0.5],
      hitRuleIds: new Set(),
    }),
  })
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'CAND-001 风险分 0.5。' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'CAND-001 风险分 0.5。' } },
    { type: 'finish', reason: 'stop' },
  ]
  const opts = { ...SESSION_OPTS, messages: messagesWithRun('运行 run-abc12345') }
  const out = await collect(listener, opts, chunks)
  const end = out.find((c) => c.type === 'block-end' && c.index === 0)
  assert.ok(end.block.text.includes('0.897'), '结构化运行记录是权威事实源')
})
