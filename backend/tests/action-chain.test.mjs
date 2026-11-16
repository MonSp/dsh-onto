/**
 * C 包（R3 沙箱治理 + R4 动作契约闭合）执行链验收：
 * 真实 apply() 注册面 + 真实 guard 收口 + 真实 execute_behavior_action 工具执行——
 * 不是源码关键词断言（交付要求：防线改动须行为测试）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../dist/agent-tools.js'
import {
  parseObjectRef,
  registerActionConnector,
  validateActionIntent,
} from '../dist/action-executor.js'
import {
  classifyToolCapability,
  createPresetResolver,
  isDangerousGeneralTool,
  toolSandboxDecision,
  UNRESOLVED_PRESET,
} from '../dist/agent-sandbox.js'
import {
  grantGuardDecision,
  readToolContracts,
  checkGrant,
} from '../dist/agent-grants.js'
import { derivePackage } from '@dsh-onto/core'

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const AML_SRC = join(REPO, 'packages', 'aml', '1.0.0')

/**
 * 最小假 ctx（只实现 apply() 用到的面）：捕获 guard / 工具注册面，
 * 并把 aml 包放进工作区（派生重跑，过加载门禁）。
 */
function setupChain(opts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-onto-chain-'))
  const versionDir = join(root, 'dsh-onto', 'workspace', 'packages', 'aml-analysis', '1.0.0')
  mkdirSync(join(versionDir, '..'), { recursive: true })
  cpSync(AML_SRC, versionDir, { recursive: true })
  derivePackage(versionDir)

  const services = new Map()
  services.set('profileContext', { dir: root })
  if (opts.presetForSession !== undefined) services.set('agentPresets', { presetForSession: opts.presetForSession })
  let approvalRequests = 0
  services.set('approval', {
    request: async () => {
      approvalRequests++
      return 'allowed-once'
    },
  })
  const guards = []
  const tools = new Map()
  const ctx = {
    on: () => undefined,
    root: { get: (k) => services.get(k) },
    tools: {
      guard: (g) => {
        guards.push(g)
        return () => undefined
      },
      register: (d) => {
        tools.set(d.name, d)
      },
    },
  }
  apply(ctx)
  return {
    root,
    guards,
    tools,
    services,
    approvalCount: () => approvalRequests,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  }
}

/** 走真实 guard 收口（宿主管线：guards 先于 dispatch）。 */
function chainGuard(chain, { name, args, session }) {
  const agent = session === undefined ? undefined : { session }
  for (const g of chain.guards) {
    const denial = g({ name, arguments: args, agent })
    if (denial !== undefined) return denial
  }
  return undefined
}

const SESSION = { id: 's-chain' }

test('R3-1 顶层 onto 专家：定时创建/更新/删除均拒；只读查询与本体工具正常', () => {
  // 每个顶层专家 preset 各自实测（M0-A4：onto-aml / onto-tax / onto-med 实际注册链）
  for (const preset of ['onto-aml', 'onto-tax', 'onto-med']) {
    const chain = setupChain({
      presetForSession: (session) => (session === SESSION ? preset : null),
    })
    try {
      for (const name of ['schedule_create', 'schedule_update', 'schedule_delete']) {
        const denial = chainGuard(chain, { name, args: { name: 'x' }, session: SESSION })
        assert.ok(
          typeof denial === 'string' && denial.startsWith('TOOL_SANDBOX_DENIED'),
          `${preset} 会话 ${name} 应拒: ${String(denial)}`,
        )
      }
      for (const name of ['read', 'glob', 'grep', 'ask_user_question', 'run_scenario', 'list_packages']) {
        assert.equal(chainGuard(chain, { name, args: {}, session: SESSION }), undefined, `${preset} ${name} 应放行`)
      }
    } finally {
      chain.dispose()
    }
  }
})

test('R3-2 未登记能力 fail-closed：动态工具 / MCP / 别名 / 编程执行入口', () => {
  const chain = setupChain({
    presetForSession: (session) => (session === SESSION ? 'onto-aml' : null),
  })
  try {
    for (const name of ['frobnicate', 'mcp_tool_do_thing', 'ns:tool', 'v2-write', 'run_code', 'apply_patch', 'exec_command']) {
      const denial = chainGuard(chain, { name, args: {}, session: SESSION })
      assert.ok(
        typeof denial === 'string' && denial.startsWith('TOOL_SANDBOX_DENIED'),
        `未登记/危险能力 ${name} 应 fail-closed: ${String(denial)}`,
      )
    }
    assert.equal(classifyToolCapability('frobnicate'), 'unclassified')
    assert.equal(classifyToolCapability('schedule_create'), 'write')
    assert.equal(classifyToolCapability('run_scenario'), 'onto')
    assert.equal(isDangerousGeneralTool('schedule_create'), true)
    assert.equal(isDangerousGeneralTool('schedule_update'), true)
  } finally {
    chain.dispose()
  }
})

test('R3-3 标准及无 preset 会话不受本体沙箱误伤', () => {
  const chain = setupChain({
    presetForSession: (session) => (session === SESSION ? 'onto-aml' : null),
  })
  try {
    const other = { id: 's-std' }
    for (const session of [other, undefined]) {
      for (const name of ['schedule_create', 'bash', 'write', 'frobnicate']) {
        assert.equal(
          chainGuard(chain, { name, args: {}, session }),
          undefined,
          `标准/无 preset 会话 ${String(session?.id)} 的 ${name} 不受沙箱约束`,
        )
      }
    }
  } finally {
    chain.dispose()
  }
})

test('R3-4 子专家继承限制：子 agent 会话持 onto-* preset 即同口径收口', () => {
  const child = { id: 's-child' }
  const chain = setupChain({
    // 子 agent 以专家 preset 起（expert_agent allowedAgentPresets 只放 onto-*；无参继承父 preset）
    presetForSession: (session) => {
      if (session === SESSION || session === child) return 'onto-med'
      return null
    },
  })
  try {
    for (const session of [SESSION, child]) {
      const denial = chainGuard(chain, { name: 'schedule_create', args: {}, session })
      assert.ok(typeof denial === 'string' && denial.startsWith('TOOL_SANDBOX_DENIED'), '子专家同样拒定时创建')
      assert.equal(chainGuard(chain, { name: 'run_scenario', args: {}, session }), undefined, '子专家本体工具照常')
    }
  } finally {
    chain.dispose()
  }
})

test('R3-5 preset 读取异常：已知受控身份不丢失（不退化为标准会话）', () => {
  let calls = 0
  const chain = setupChain({
    presetForSession: (session) => {
      calls++
      if (calls > 1) throw new Error('preset service exploded')
      return session === SESSION ? 'onto-aml' : null
    },
  })
  try {
    // 首次解析成功（缓存身份）；之后服务抛错 → 仍按 onto-aml 收口
    const first = chainGuard(chain, { name: 'schedule_create', args: {}, session: SESSION })
    assert.ok(typeof first === 'string' && first.startsWith('TOOL_SANDBOX_DENIED'))
    const second = chainGuard(chain, { name: 'bash', args: {}, session: SESSION })
    assert.ok(
      typeof second === 'string' && second.startsWith('TOOL_SANDBOX_DENIED'),
      `preset 服务异常不得放行受控专家: ${String(second)}`,
    )
  } finally {
    chain.dispose()
  }
  // 纯函数面：服务异常回退缓存；未确认身份 fail-closed（未知身份不漏拦，
  // 不把「无 preset 标准会话」边界偷偷扩大给身份不可确认的会话）
  const session = { id: 's1' }
  let boom = false
  const resolve = createPresetResolver(() => {
    if (boom) throw new Error('boom')
    return { presetForSession: (s) => (s === session ? 'onto-aml' : null) }
  })
  assert.equal(resolve({ session }), 'onto-aml')
  boom = true
  assert.equal(resolve({ session }), 'onto-aml', '缓存命中照常收口')
  assert.equal(resolve({ session: { id: 's2' } }), UNRESOLVED_PRESET, '身份不可确认 → fail-closed 哨兵（不误当标准会话）')
  // 已确认标准/无 preset 会话照旧不受沙箱约束（标准会话边界不被偷偷扩大/误伤）
  assert.equal(toolSandboxDecision('bash', null), undefined)
  assert.equal(toolSandboxDecision('bash', 'standard'), undefined)
  // 未知身份：受控业务/危险/未登记能力拒；只读/交互放行
  assert.match(toolSandboxDecision('run_scenario', UNRESOLVED_PRESET) ?? '', /^TOOL_SANDBOX_DENIED/)
  assert.match(toolSandboxDecision('bash', UNRESOLVED_PRESET) ?? '', /^TOOL_SANDBOX_DENIED/)
  assert.match(toolSandboxDecision('frobnicate', UNRESOLVED_PRESET) ?? '', /^TOOL_SANDBOX_DENIED/)
  assert.equal(toolSandboxDecision('read', UNRESOLVED_PRESET), undefined, '只读放行')
  assert.equal(toolSandboxDecision('ask_user_question', UNRESOLVED_PRESET), undefined, '人审交互放行')
})

/* ── M0-A 反例1（专家身份 receiver 丢失）────────────────────────────────
 * 宿主 AgentPresetRegistry.presetForSession 是依赖 this 的原型方法。
 * 裸取方法后调用丢 receiver → 解析抛错被吞 → onto 专家误判「无 preset」→ pwsh 放行。
 * 本反例用真实宿主方法形态（非箭头函数替身）经 apply()+guard 全链验证。
 */
test('反例1（M0-A）：真实宿主原型方法保留 receiver——onto 专家不得退化为无 preset', () => {
  class FakePresetRegistry {
    #map
    constructor(map) {
      this.#map = map
    }

    // 与 harness AgentPresetRegistry.presetForSession 同构：原型方法 + 依赖 this
    presetForSession(session) {
      return this.#map.get(session) ?? null
    }
  }
  const registry = new FakePresetRegistry(new Map([[SESSION, 'onto-aml']]))
  const chain = setupChain()
  chain.services.set('agentPresets', registry) // Cordis 读取路径：ctx.root.get('agentPresets') 返回服务实例
  try {
    const denial = chainGuard(chain, { name: 'pwsh', args: {}, session: SESSION })
    assert.ok(
      typeof denial === 'string' && denial.startsWith('TOOL_SANDBOX_DENIED'),
      `真实宿主方法解析出的 onto-aml 专家必须拒 pwsh（丢 receiver 会退化为无 preset）: ${String(denial)}`,
    )
    assert.equal(chainGuard(chain, { name: 'read', args: {}, session: SESSION }), undefined, '只读照常')
  } finally {
    chain.dispose()
  }
})

test('反例1b（M0-A）：服务临时缺席——已知受控身份不退化为标准会话', () => {
  const chain = setupChain({
    presetForSession: (session) => (session === SESSION ? 'onto-aml' : null),
  })
  try {
    const first = chainGuard(chain, { name: 'bash', args: {}, session: SESSION })
    assert.ok(typeof first === 'string' && first.startsWith('TOOL_SANDBOX_DENIED'))
    chain.services.delete('agentPresets') // 临时缺席（可晚注册）
    const second = chainGuard(chain, { name: 'pwsh', args: {}, session: SESSION })
    assert.ok(
      typeof second === 'string' && second.startsWith('TOOL_SANDBOX_DENIED'),
      `服务缺席不得把已知受控专家退化为标准会话: ${String(second)}`,
    )
  } finally {
    chain.dispose()
  }
})

test('R3-6 沙箱拒绝语引导受控替代路径（不静默、不说半截话）', () => {
  const denial = toolSandboxDecision('schedule_update', 'onto-med')
  assert.ok(denial.includes('apply_draft') && denial.includes('run_scenario'), '拒绝语指明受控出口')
  assert.ok(denial.includes('标准会话'), '拒绝语给出放行通道')
  const unknown = toolSandboxDecision('frobnicate', 'onto-med')
  assert.ok(unknown.includes('fail-closed'), '未登记能力显式说明 fail-closed')
})

/* ── R4 动作契约闭合（锚点/引用/载荷） ─────────────────────────────── */

const BEHAVIORS = [{ id: 'BHV-AML-TRANSFER', anchor: 'OBJ-AML-ACCOUNT' }]

test('R4-1 锚点类型闭合：已收权但错误锚点类型拒绝（不弹批准卡、连接器零调用）', () => {
  assert.throws(
    () => validateActionIntent(BEHAVIORS, {
      behaviorId: 'BHV-AML-TRANSFER',
      objectRef: 'OBJ-AML-CUSTOMER:CUST-001', // 已收权类型，但不是该行为的锚点
      payload: { amount: 1 },
    }),
    (e) => e.code === 'INVALID_ARGS' && /锚点/.test(e.message),
  )
  assert.throws(
    () => validateActionIntent(BEHAVIORS, {
      behaviorId: 'BHV-NOPE',
      objectRef: 'OBJ-AML-ACCOUNT:ACCT-001',
      payload: {},
    }),
    (e) => e.code === 'INVALID_ARGS' && /O2 闭合/.test(e.message),
  )
})

test('R4-2 完整实例引用：裸类型 / 空实例段 / 歧义 / 伪造形态均有明确结果', () => {
  const bad = [
    'OBJ-AML-ACCOUNT', // 裸类型
    'OBJ-AML-ACCOUNT:', // 空实例段
    'OBJ-AML-ACCOUNT:a:b', // 歧义引用
    ':x', // 空类型段
    'obj-aml-account:x', // 伪造（大小写伪托）
    'OBJ-AML-ACCOUNT :x', // 伪造（空白）
  ]
  for (const objectRef of bad) {
    assert.equal(parseObjectRef(objectRef), null, `${objectRef} 不是完整实例引用`)
    assert.throws(
      () => validateActionIntent(BEHAVIORS, { behaviorId: 'BHV-AML-TRANSFER', objectRef, payload: {} }),
      (e) => e.code === 'INVALID_ARGS' && /完整实例引用/.test(e.message),
      `${objectRef} 应拒绝`,
    )
  }
  assert.deepEqual(parseObjectRef('OBJ-AML-ACCOUNT:ACCT-001'), { type: 'OBJ-AML-ACCOUNT', instance: 'ACCT-001' })
})

test('R4-3 正确锚点但未收权：拒绝且不执行（对象授权独立闸）', () => {
  const contracts = readToolContracts(join(AML_SRC))
  // 正确锚点形态，但收权清单为空 → OBJECT_NOT_GRANTED（deny-by-default）
  assert.equal(checkGrant([], 'OBJ-AML-ACCOUNT:ACCT-001'), 'OBJECT_NOT_GRANTED: OBJ-AML-ACCOUNT:ACCT-001')
  const denial = grantGuardDecision(
    'execute_behavior_action',
    { name: 'aml-analysis', version: '1.0.0', objectRef: 'OBJ-AML-ACCOUNT:ACCT-001' },
    () => [],
  )
  assert.match(String(denial), /OBJECT_NOT_GRANTED/)
  // 已收权对照
  assert.equal(checkGrant(contracts, 'OBJ-AML-ACCOUNT:ACCT-001'), undefined)
})

test('R4-4 载荷显式 schema：类型错误 / 深度 / 原型键 / 未授权对象引用拒绝', () => {
  const ok = { behaviorId: 'BHV-AML-TRANSFER', objectRef: 'OBJ-AML-ACCOUNT:ACCT-001', payload: { amount: 1, note: 'a', nested: { a: [1, 2] } } }
  validateActionIntent(BEHAVIORS, ok)
  assert.throws(
    () => validateActionIntent(BEHAVIORS, { ...ok, payload: [1, 2] }),
    (e) => e.code === 'INVALID_ARGS',
    'payload 非对象',
  )
  assert.throws(
    () => validateActionIntent(BEHAVIORS, { ...ok, payload: { n: Number.NaN } }),
    (e) => e.code === 'INVALID_ARGS' && /有限值/.test(e.message),
  )
  let deep = 1
  for (let i = 0; i < 6; i++) deep = { d: deep }
  assert.throws(
    () => validateActionIntent(BEHAVIORS, { ...ok, payload: deep }),
    (e) => e.code === 'INVALID_ARGS' && /嵌套过深/.test(e.message),
  )
  assert.throws(
    () => validateActionIntent(BEHAVIORS, { ...ok, payload: JSON.parse('{"__proto__": {"x": 1}}') }),
    (e) => e.code === 'INVALID_ARGS',
  )
  // 额外业务对象引用：未收权拒绝（不能只检查顶层锚点）
  assert.throws(
    () =>
      validateActionIntent(BEHAVIORS, { ...ok, payload: { related: 'OBJ-NOPE:inst' } }, { isGranted: () => false }),
    (e) => e.code === 'OBJECT_NOT_GRANTED' && /OBJ-NOPE:inst/.test(e.message),
  )
  validateActionIntent(BEHAVIORS, { ...ok, payload: { related: 'OBJ-AML-CUSTOMER:C1' } }, { isGranted: () => true })
})

test('R4-5 执行链：合法动作正常批准、执行、留痕；错误锚点在批准卡前拒绝', async () => {
  const chain = setupChain({
    presetForSession: (session) => (session === SESSION ? 'onto-aml' : null),
  })
  let connectorCalls = 0
  registerActionConnector({
    async execute() {
      connectorCalls++
      return { externalRef: 'ext-chain-1' }
    },
    async compensate() {},
  }, { id: 'chain-mock', env: 'test', kind: 'simulated' })
  try {
    const tool = chain.tools.get('execute_behavior_action')
    assert.ok(tool, 'execute_behavior_action 须经真实注册面在场')
    const args = {
      name: 'aml-analysis',
      version: '1.0.0',
      behaviorId: 'BHV-AML-TRANSFER',
      objectRef: 'OBJ-AML-ACCOUNT:ACCT-001',
      payload: { amount: 1 },
      humanApproved: true,
    }
    // 1) 错误锚点（已收权类型）：guard 放行（收权在清单内），工具体在批准卡前拒绝
    const wrongAnchor = { ...args, objectRef: 'OBJ-AML-CUSTOMER:CUST-001' }
    assert.equal(chainGuard(chain, { name: 'execute_behavior_action', args: wrongAnchor, session: SESSION }), undefined)
    await assert.rejects(
      () => tool.execute(wrongAnchor, { agent: { session: SESSION }, callId: 'c1' }),
      (e) => /锚点/.test(e.message),
    )
    assert.equal(chain.approvalCount(), 0, '错误锚点不得弹批准卡')
    assert.equal(connectorCalls, 0, '连接器调用数为零')

    // 2) 未收权对象：guard 直接拒（不进工具体）
    const ungranted = { ...args, objectRef: 'OBJ-NOPE:x' }
    const denial = chainGuard(chain, { name: 'execute_behavior_action', args: ungranted, session: SESSION })
    assert.match(String(denial), /OBJECT_NOT_GRANTED/)
    assert.equal(connectorCalls, 0)

    // 3) 合法动作：批准 → 执行 → 留痕
    assert.equal(chainGuard(chain, { name: 'execute_behavior_action', args, session: SESSION }), undefined)
    const out = await tool.execute(args, { agent: { session: SESSION }, callId: 'c2' })
    const text = JSON.stringify(out)
    assert.ok(text.includes('ext-chain-1'), `执行回执须上墙: ${text}`)
    assert.equal(chain.approvalCount(), 1, '合法动作弹一次批准卡')
    assert.equal(connectorCalls, 1)
  } finally {
    registerActionConnector(null)
    chain.dispose()
  }
})


/* ── M1-B 正式取数通道 × run_scenario（同一入口策略，真实注册链） ────────── */

test('B2-7 run_scenario sourceId 通道：服务端取数 + dataStatus；与 dataset 内联互斥', async () => {
  const chain = setupChain()
  const { registerDataSourceForTest, clearDataSourcesForTest } = await import('../dist/data-sources.js')
  const example = JSON.parse(readFileSync(join(REPO, 'examples', 'aml-run.json'), 'utf8'))
  let fetchCalls = 0
  registerDataSourceForTest('SRC-AML-1', {
    version: 'mock-1.0',
    nature: 'simulated',
    async fetch() {
      fetchCalls++
      return {
        dataset: example,
        complete: true,
        businessWindow: { from: '2026-11-01T00:00:00Z', to: new Date(Date.now() - 3600_000).toISOString() },
      }
    },
  })
  try {
    const tool = chain.tools.get('run_scenario')
    assert.ok(tool, 'run_scenario 须经真实注册面在场')
    const base = { name: 'aml-analysis', version: '1.0.0', scenarioId: 'SCN-AML-FIND-CLUES' }
    // 正式通道：sourceId 取数 → 运行 → dataStatus 回填。
    // aml 示例特征为调用方预置值（无事实依据）→ formal 严格口径 = insufficient（待补数，
    // 「缺特征 0 分」不得当低风险处置——正是 M1-B 要的可信语义）
    const out = await tool.execute(
      { ...base, sourceId: 'SRC-AML-1', analysisMode: 'formal', query: { objectTypes: ['OBJ-AML-ACCOUNT'] } },
      { agent: { session: SESSION }, callId: 'b2a' },
    )
    assert.equal(fetchCalls, 1, '经服务端连接器取数')
    assert.equal(out.dataStatus, 'insufficient', 'formal + 特征缺依据 → insufficient: ' + out.dataStatus)
    assert.ok(out.candidates.every((c) => c.pendingVerification === true), 'formal 缺依据逐候选待补数')
    assert.equal(out.contractStatus, 'conformant')
    assert.equal(out.dataTrust.provenance, 'connector')
    // 探索通道同数据 → conditional（来源可信但特征缺依据 = 条件性分数）
    const explored = await tool.execute(
      { ...base, sourceId: 'SRC-AML-1' },
      { agent: { session: SESSION }, callId: 'b2a2' },
    )
    assert.equal(explored.dataStatus, 'conditional', 'explore + 部分缺口 → conditional: ' + explored.dataStatus)
    assert.equal(fetchCalls, 2)
    // 三通道互斥：sourceId + dataset 同给拒绝
    await assert.rejects(
      () => tool.execute({ ...base, sourceId: 'SRC-AML-1', dataset: example }, { agent: { session: SESSION }, callId: 'b2b' }),
      (e) => /互斥/.test(e.message),
    )
    // 未登记源拒绝
    await assert.rejects(
      () => tool.execute({ ...base, sourceId: 'SRC-NOPE' }, { agent: { session: SESSION }, callId: 'b2c' }),
      (e) => /未登记/.test(e.message),
    )
  } finally {
    clearDataSourcesForTest()
    chain.dispose()
  }
})
