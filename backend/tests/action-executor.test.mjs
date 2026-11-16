/**
 * 业务动作执行器（T4.1 + R1 可靠幂等 + R6 幂等作用域）与全工具沙箱（T4.2）测试：
 * 业务幂等键 / 批准上下文 / 原子占位互斥 / 崩溃恢复对账 / 效应三分补偿 / 旧台账 fail-closed。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ActionExecuteError,
  ActionNoEffectError,
  approvalContextDigest,
  businessKeyOf,
  connectorNature,
  digestAction,
  dryRunConnector,
  executeBehaviorAction,
  isFormalActionEnabled,
  loadActionRecord,
  legacyRecordPath,
  parseObjectRef,
  registerActionConnector,
  setFormalActionEnabled,
  validateActionIntent,
} from '../dist/action-executor.js'
import { isDangerousGeneralTool, isOntoPreset, toolSandboxDecision } from '../dist/agent-sandbox.js'

const INTENT = { behaviorId: 'BHV-TST-X', objectRef: 'OBJ-TST-A:inst1', payload: { amount: 1 } }
const GRANT = { approvalDigest: 'ap-digest', approvedAt: '2026-11-15T00:00:00.000Z' }
const PKG = { name: 'test-pkg', version: '1.0.0' }
const BEHAVIOR = { id: 'BHV-TST-X', anchor: 'OBJ-TST-A', name: '行为X' }

function mkRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-onto-actions-'))
}

function input(root, extra = {}) {
  return {
    root,
    intent: INTENT,
    pkg: PKG,
    behavior: BEHAVIOR,
    requestGrant: async () => GRANT,
    inFlightWaitMs: 0,
    ...extra,
  }
}

test('R6-1 同环境、同业务操作、同上下文：正常重放回读，无二次动作', async () => {
  const root = mkRoot()
  let calls = 0
  let grants = 0
  registerActionConnector({
    async execute(_i, _a, key) {
      calls++
      return { externalRef: `ext-${key.slice(0, 6)}` }
    },
    async compensate() {},
  }, { id: 'billing', env: 'test', kind: 'simulated' })
  try {
    const first = await executeBehaviorAction(input(root, {
      requestGrant: async () => {
        grants++
        return GRANT
      },
    }))
    assert.equal(first.replayed, false)
    assert.equal(first.record.status, 'succeeded')
    assert.ok(first.record.externalRef?.startsWith('ext-'))
    assert.equal(first.record.approvalDigest, 'ap-digest', '台账留批准凭证摘要')
    assert.ok(existsSync(join(root, 'actions', `${first.record.businessKey}.json`)), '台账落盘 actions/')
    const again = await executeBehaviorAction(input(root, {
      requestGrant: async () => {
        grants++
        return GRANT
      },
    }))
    assert.equal(again.replayed, true)
    assert.equal(again.record.actionId, first.record.actionId, '同业务键同动作')
    assert.match(again.note ?? '', /回读业务操作 auto/, 'replayed 须说明回读的是哪次业务操作和哪种环境')
    assert.match(again.note ?? '', /环境 test/)
    assert.equal(calls, 1, '幂等重放不二次执行')
    assert.equal(grants, 1, '幂等重放不二次批准')
    // 改载荷 = 新业务内容（新键 → 新执行）
    const other = await executeBehaviorAction(input(root, { intent: { ...INTENT, payload: { amount: 2 } } }))
    assert.equal(other.replayed, false)
    assert.equal(calls, 2)
  } finally {
    registerActionConnector(null)
    rmSync(root, { recursive: true, force: true })
  }
})

test('R6-2 演练到真实环境：不回读演练回执，真实动作仍须新批准', async () => {
  const root = mkRoot()
  let realCalls = 0
  let grants = 0
  try {
    // 演练（dryrun 环境）
    const dry = await executeBehaviorAction(input(root))
    assert.equal(dry.record.status, 'succeeded')
    assert.ok(dry.record.externalRef.startsWith('dryrun:'))
    assert.deepEqual(dry.record.connector, { id: 'dryrun', env: 'dryrun', kind: 'dryrun' })
    // 真实连接器（prod 环境，formal 性质——须显式开启正式动作总开关）：业务幂等键不同 → 不回读演练回执、新批准、真实执行
    setFormalActionEnabled(true)
    registerActionConnector({
      async execute() {
        realCalls++
        return { externalRef: 'ext-real-1' }
      },
      async compensate() {},
    }, { id: 'billing', env: 'prod', kind: 'formal' })
    const real = await executeBehaviorAction(input(root, {
      requestGrant: async () => {
        grants++
        return GRANT
      },
    }))
    assert.equal(real.replayed, false, '不得回读演练回执')
    assert.equal(real.record.externalRef, 'ext-real-1')
    assert.equal(realCalls, 1)
    assert.equal(grants, 1, '真实动作仍须新批准')
  } finally {
    setFormalActionEnabled(false)
    registerActionConnector(null)
    rmSync(root, { recursive: true, force: true })
  }
})

test('R6-3 包版本/行为契约改变：显式上下文冲突，不静默回读或再次执行', async () => {
  const root = mkRoot()
  let calls = 0
  registerActionConnector({
    async execute() {
      calls++
      return { externalRef: 'ext-1' }
    },
    async compensate() {},
  }, { id: 'billing', env: 'test', kind: 'simulated' })
  try {
    await executeBehaviorAction(input(root))
    // 同业务键（同载荷同连接器），但包版本变化 → ACTION_CONTEXT_CHANGED
    await assert.rejects(
      () => executeBehaviorAction(input(root, { pkg: { name: 'test-pkg', version: '2.0.0' } })),
      (e) => e.code === 'ACTION_CONTEXT_CHANGED',
    )
    // 行为契约（锚点）变化 → 同样显式冲突
    await assert.rejects(
      () => executeBehaviorAction(input(root, { behavior: { id: 'BHV-TST-X', anchor: 'OBJ-TST-B' } })),
      (e) => e.code === 'ACTION_CONTEXT_CHANGED',
    )
    assert.equal(calls, 1, '上下文冲突不得再执行')
  } finally {
    registerActionConnector(null)
    rmSync(root, { recursive: true, force: true })
  }
})

/* ── M0-A 反例2（在途/抢占回读缺批准上下文校验）────────────────────────────
 * 同业务键（同载荷同连接器）但包版本不同：A 在途执行期间 B 等待回读，
 * 不得把 A 的旧批准结果当 B 的回读成功（跨版本请求可能回读旧结果）。
 */
test('反例2（M0-A）：跨版本在途等待不得回读旧批准结果——ACTION_CONTEXT_CHANGED', async () => {
  const root = mkRoot()
  let calls = 0
  let release = () => {}
  const gate = new Promise((resolve) => {
    release = resolve
  })
  registerActionConnector({
    async execute() {
      calls++
      await gate
      return { externalRef: 'ext-old-ctx' }
    },
    async compensate() {},
  }, { id: 'billing', env: 'test', kind: 'simulated' })
  try {
    // A（包 1.0.0）占位并派发（连接器挂起）
    const pA = executeBehaviorAction(input(root, {
      pkg: { name: 'test-pkg', version: '1.0.0' },
      inFlightWaitMs: 1000,
      requestGrant: async () => GRANT,
    }))
    await new Promise((r) => setTimeout(r, 20))
    // B（包 2.0.0，同业务键）在途等待——A 随后完成，B 不得回读 A 的 succeeded
    const pB = executeBehaviorAction(input(root, {
      pkg: { name: 'test-pkg', version: '2.0.0' },
      inFlightWaitMs: 800,
      requestGrant: async () => GRANT,
    }))
    const guard = pB.catch((e) => e)
    release()
    const a = await pA
    assert.equal(a.record.status, 'succeeded')
    const b = await guard
    assert.equal(b instanceof Error, true, '跨版本在途等待必须显式拒绝，不得回读旧批准结果')
    assert.equal(b.code, 'ACTION_CONTEXT_CHANGED', `跨版本回读旧结果即为缺陷: ${String(b)}`)
    assert.equal(calls, 1, '连接器只执行一次（A 的执行不因 B 重复）')
  } finally {
    registerActionConnector(null)
    rmSync(root, { recursive: true, force: true })
  }
})

test('反例2b（M0-A）：抢占失败回读路径同口径——跨上下文显式冲突、不触发对账', async () => {
  const root = mkRoot()
  let calls = 0
  let queries = 0
  let release = () => {}
  const gate = new Promise((resolve) => {
    release = resolve
  })
  registerActionConnector({
    async execute() {
      calls++
      await gate
      return { externalRef: 'ext-race' }
    },
    async compensate() {},
    async queryResult() {
      queries++
      return { state: 'unknown' }
    },
  }, { id: 'billing', env: 'test', kind: 'simulated' })
  try {
    const pA = executeBehaviorAction(input(root, {
      pkg: { name: 'test-pkg', version: '1.0.0' },
      inFlightWaitMs: 60,
      requestGrant: async () => GRANT,
    }))
    await new Promise((r) => setTimeout(r, 15))
    // B 同刻并发同键跨版本：占位失败/在途回读路径都要给 ACTION_CONTEXT_CHANGED
    const pB = executeBehaviorAction(input(root, {
      pkg: { name: 'test-pkg', version: '2.0.0' },
      inFlightWaitMs: 60,
      requestGrant: async () => GRANT,
    }))
    const guard = pB.catch((e) => e)
    release()
    await pA
    const b = await guard
    assert.equal(b instanceof Error, true)
    assert.equal(b.code, 'ACTION_CONTEXT_CHANGED', `抢占/在途回读缺上下文校验即为缺陷: ${String(b)}`)
    assert.equal(queries, 0, '上下文校验先于对账——跨上下文请求不触发 queryResult')
    assert.equal(calls, 1)
  } finally {
    registerActionConnector(null)
    rmSync(root, { recursive: true, force: true })
  }
})

test('R6-4 不同业务操作但同载荷：独立批准后可分别执行', async () => {
  const root = mkRoot()
  let calls = 0
  let grants = 0
  registerActionConnector({
    async execute() {
      calls++
      return { externalRef: `ext-${calls}` }
    },
    async compensate() {},
  }, { id: 'billing', env: 'test', kind: 'simulated' })
  const requestGrant = async () => {
    grants++
    return GRANT
  }
  try {
    const a = await executeBehaviorAction(input(root, { operationId: 'op-2026-11-a', requestGrant }))
    const b = await executeBehaviorAction(input(root, { operationId: 'op-2026-11-b', requestGrant }))
    assert.equal(a.replayed, false)
    assert.equal(b.replayed, false)
    assert.notEqual(a.record.businessKey, b.record.businessKey, '不同业务操作 = 不同幂等键')
    assert.equal(calls, 2, '同载荷不同业务操作各执行一次')
    assert.equal(grants, 2, '各自独立批准')
  } finally {
    registerActionConnector(null)
    rmSync(root, { recursive: true, force: true })
  }
})

test('R6-5 不同连接器目标/租户环境不串台', async () => {
  const root = mkRoot()
  let calls = 0
  try {
    registerActionConnector({
      async execute() {
        calls++
        return { externalRef: `ext-${calls}` }
      },
      async compensate() {},
    }, { id: 'billing', env: 'tenant-a', kind: 'simulated' })
    await executeBehaviorAction(input(root))
    registerActionConnector({
      async execute() {
        calls++
        return { externalRef: `ext-${calls}` }
      },
      async compensate() {},
    }, { id: 'billing', env: 'tenant-b', kind: 'simulated' })
    const other = await executeBehaviorAction(input(root))
    assert.equal(other.replayed, false, '不同租户/环境不得串台回读')
    assert.equal(calls, 2)
  } finally {
    registerActionConnector(null)
    rmSync(root, { recursive: true, force: true })
  }
})

test('R6-6 旧格式台账保留且 fail-closed，不被删除或当作「未执行」', async () => {
  const root = mkRoot()
  let calls = 0
  registerActionConnector({
    async execute() {
      calls++
      return { externalRef: 'ext-1' }
    },
    async compensate() {},
  }, { id: 'billing', env: 'test', kind: 'simulated' })
  try {
    // 注入旧格式记录（旧摘要命名、无上下文字段）
    mkdirSync(join(root, 'actions'), { recursive: true })
    const legacyPath = legacyRecordPath(root, INTENT)
    writeFileSync(legacyPath, JSON.stringify({
      actionId: 'act-legacy',
      digest: digestAction(INTENT),
      behaviorId: INTENT.behaviorId,
      objectRef: INTENT.objectRef,
      payload: INTENT.payload,
      status: 'succeeded',
      externalRef: 'dryrun:legacy',
      approvalDigest: 'x',
      approvedAt: 't',
      executedAt: 't',
    }, null, 2), 'utf8')
    await assert.rejects(
      () => executeBehaviorAction(input(root)),
      (e) => e.code === 'ACTION_LEDGER_LEGACY' && /人工核对/.test(e.message),
    )
    assert.ok(existsSync(legacyPath), '旧台账只读保留、不删除')
    assert.equal(calls, 0, '不得当作未执行重跑')
    // 显式新业务操作可以越过旧台账（新操作、新批准）
    const fresh = await executeBehaviorAction(input(root, { operationId: 'op-new-1' }))
    assert.equal(fresh.replayed, false)
    assert.equal(calls, 1)
  } finally {
    registerActionConnector(null)
    rmSync(root, { recursive: true, force: true })
  }
})

test('R1-1/R1-2 并发同键：连接器只执行一次，另一路等待或回读，不重复批准或执行', async () => {
  const root = mkRoot()
  let calls = 0
  let grantsB = 0
  let release = () => {}
  const gate = new Promise((resolve) => {
    release = resolve
  })
  registerActionConnector({
    async execute() {
      calls++
      await gate
      return { externalRef: 'ext-1' }
    },
    async compensate() {},
  }, { id: 'billing', env: 'test', kind: 'simulated' })
  try {
    // A 先占位并派发（连接器挂起）
    const pA = executeBehaviorAction(input(root, {
      requestGrant: async () => GRANT,
      inFlightWaitMs: 50,
    }))
    await new Promise((r) => setTimeout(r, 10))
    // B 同键并发：不重复批准、不重复执行
    await assert.rejects(
      () =>
        executeBehaviorAction(input(root, {
          requestGrant: async () => {
            grantsB++
            return GRANT
          },
          inFlightWaitMs: 30,
        })),
      (e) => e.code === 'ACTION_IN_FLIGHT',
    )
    assert.equal(grantsB, 0, '另一路不得重复批准')
    assert.equal(calls, 1, '连接器只执行一次')
    release()
    const a = await pA
    assert.equal(a.record.status, 'succeeded')
    assert.equal(calls, 1)
  } finally {
    registerActionConnector(null)
    rmSync(root, { recursive: true, force: true })
  }
})

test('R1-3 注入「外部成功、写终态前中断」：重启后查询并恢复原回执，不重跑', async () => {
  const root = mkRoot()
  let calls = 0
  let queries = 0
  registerActionConnector({
    async execute() {
      calls++
      return { externalRef: 'ext-should-not-happen' }
    },
    async compensate() {},
    async queryResult() {
      queries++
      return { state: 'succeeded', externalRef: 'ext-recovered' }
    },
  }, { id: 'billing', env: 'test', kind: 'simulated' })
  try {
    // 注入崩溃现场：executing + dispatched 相位（外部已成功、终态未落盘）
    mkdirSync(join(root, 'actions'), { recursive: true })
    const key = businessKeyOf(INTENT, { id: 'billing', env: 'test' })
    writeFileSync(join(root, 'actions', `${key}.json`), JSON.stringify({
      actionId: `act-${key.slice(0, 12)}`,
      businessKey: key,
      approvalContext: approvalContextDigest(INTENT, { id: 'billing', env: 'test', kind: 'simulated' }, PKG, BEHAVIOR),
      connector: { id: 'billing', env: 'test', kind: 'simulated' },
      behaviorId: INTENT.behaviorId,
      objectRef: INTENT.objectRef,
      payload: INTENT.payload,
      status: 'executing',
      phase: 'dispatched',
      approvalDigest: 'ap-digest',
      approvedAt: '2026-11-15T00:00:00.000Z',
      executedAt: '2026-11-15T00:00:01.000Z',
    }, null, 2), 'utf8')
    const res = await executeBehaviorAction(input(root))
    assert.equal(res.record.status, 'succeeded')
    assert.equal(res.record.externalRef, 'ext-recovered', '恢复原回执')
    assert.equal(calls, 0, '不重跑')
    assert.ok(queries >= 1, '先查外部结果')
    assert.match(res.note ?? '', /崩溃恢复/)
  } finally {
    registerActionConnector(null)
    rmSync(root, { recursive: true, force: true })
  }
})

test('R1-4 台账截断/非法 JSON/摘要不符：明确拒绝，连接器调用数为零', async () => {
  const root = mkRoot()
  let calls = 0
  registerActionConnector({
    async execute() {
      calls++
      return { externalRef: 'x' }
    },
    async compensate() {},
  }, { id: 'billing', env: 'test', kind: 'simulated' })
  try {
    mkdirSync(join(root, 'actions'), { recursive: true })
    const key = businessKeyOf(INTENT, { id: 'billing', env: 'test' })
    const file = join(root, 'actions', `${key}.json`)
    // 非法 JSON（截断）
    writeFileSync(file, '{ "businessKey": "trunc', 'utf8')
    await assert.rejects(() => executeBehaviorAction(input(root)), (e) => e.code === 'ACTION_LEDGER_CORRUPT')
    // 摘要不符（记录键 ≠ 文件键）
    writeFileSync(file, JSON.stringify({
      businessKey: 'another-key',
      approvalContext: 'ctx',
      connector: { id: 'billing', env: 'test' },
      status: 'succeeded',
    }), 'utf8')
    await assert.rejects(() => executeBehaviorAction(input(root)), (e) => e.code === 'ACTION_LEDGER_CORRUPT')
    assert.equal(calls, 0, '台账损坏不得当作未执行重跑')
  } finally {
    registerActionConnector(null)
    rmSync(root, { recursive: true, force: true })
  }
})

test('R1-5 连接器超时但已受理：效应待核实态，不自动重试', async () => {
  const root = mkRoot()
  let calls = 0
  registerActionConnector({
    async execute() {
      calls++
      throw new Error('ETIMEDOUT: request timed out after acceptance')
    },
    async compensate() {},
  }, { id: 'billing', env: 'test', kind: 'simulated' })
  try {
    await assert.rejects(
      () => executeBehaviorAction(input(root)),
      (e) => e.code === 'ACTION_UNKNOWN_EFFECT' && /对账/.test(e.message),
    )
    const key = businessKeyOf(INTENT, { id: 'billing', env: 'test' })
    const record = loadActionRecord(root, key)
    assert.equal(record.status, 'unknown', '超时 ≠ 无副作用——进入效应待核实')
    assert.equal(record.compensationError, undefined, '无回执不补偿')
    // 再次调用：回读待核实态，不自动重试
    const again = await executeBehaviorAction(input(root))
    assert.equal(again.record.status, 'unknown')
    assert.equal(calls, 1, '不自动重试')
  } finally {
    registerActionConnector(null)
    rmSync(root, { recursive: true, force: true })
  }
})

test('R1-6 执行/补偿/补偿失败及补偿错误详情均可回查', async () => {
  const root = mkRoot()
  // 效应已产生（带单号失败）→ 补偿 compensated
  registerActionConnector({
    async execute() {
      throw new ActionExecuteError('外部系统拒绝（已出单号）', 'ext-9')
    },
    async compensate() {},
  }, { id: 'billing', env: 'test', kind: 'simulated' })
  try {
    await assert.rejects(
      () => executeBehaviorAction(input(root)),
      (e) => e.code === 'ACTION_FAILED' && /compensated/.test(e.message),
    )
    const key = businessKeyOf(INTENT, { id: 'billing', env: 'test' })
    const record = loadActionRecord(root, key)
    assert.equal(record.status, 'compensated')
    assert.equal(record.externalRef, 'ext-9')
    assert.match(record.error, /外部系统拒绝/)
    assert.ok(record.compensatedAt, '补偿时间可回查')
    assert.equal(record.compensationError, undefined)
  } finally {
    registerActionConnector(null)
    rmSync(root, { recursive: true, force: true })
  }
  // 补偿再失败 → compensation-failed + 补偿错误详情
  const root2 = mkRoot()
  registerActionConnector({
    async execute() {
      throw new ActionExecuteError('boom', 'ext-x')
    },
    async compensate() {
      throw new Error('补偿也失败：外部拒绝回滚')
    },
  }, { id: 'billing', env: 'test', kind: 'simulated' })
  try {
    await assert.rejects(
      () => executeBehaviorAction(input(root2)),
      (e) => e.code === 'ACTION_FAILED' && /compensation-failed/.test(e.message),
    )
    const record = loadActionRecord(root2, businessKeyOf(INTENT, { id: 'billing', env: 'test' }))
    assert.equal(record.status, 'compensation-failed')
    assert.match(record.compensationError, /外部拒绝回滚/, '补偿错误详情可回查')
  } finally {
    registerActionConnector(null)
    rmSync(root2, { recursive: true, force: true })
  }
  // 显式无效应 → failed（不补偿）；效应不明 → unknown（对账）
  const root3 = mkRoot()
  let compensated = 0
  registerActionConnector({
    async execute() {
      throw new ActionNoEffectError('连接器启动失败（确认未受理）')
    },
    async compensate() {
      compensated++
    },
  }, { id: 'billing', env: 'test', kind: 'simulated' })
  try {
    await assert.rejects(
      () => executeBehaviorAction(input(root3)),
      (e) => e.code === 'ACTION_FAILED' && /failed/.test(e.message),
    )
    assert.equal(loadActionRecord(root3, businessKeyOf(INTENT, { id: 'billing', env: 'test' })).status, 'failed')
    assert.equal(compensated, 0, '无效应不补偿')
  } finally {
    registerActionConnector(null)
    rmSync(root3, { recursive: true, force: true })
  }
})

test('M0-A5 正式动作总开关缺省关闭：formal 连接器零派发；演练/模拟不受限但显式标注非真实成功', async () => {
  const root = mkRoot()
  let calls = 0
  assert.equal(isFormalActionEnabled(), false, '总开关缺省关闭')
  try {
    // 演练连接器不受总开关限制，且显式标 simulated（非真实业务成功）
    const dry = await executeBehaviorAction(input(root))
    assert.equal(dry.record.status, 'succeeded')
    assert.equal(dry.record.externalRef.startsWith('dryrun:'), true)
    assert.equal(connectorNature(dry.record.connector).simulated, true, '演练执行须标 simulated（非真实业务成功）')
    // 模拟（本地测试闭环）连接器同口径
    registerActionConnector({
      async execute() {
        calls++
        return { externalRef: 'ext-sim-1' }
      },
      async compensate() {},
    }, { id: 'mock-svc', env: 'test', kind: 'simulated' })
    const sim = await executeBehaviorAction(input(root, { operationId: 'op-m0a5-sim' }))
    assert.equal(sim.record.externalRef, 'ext-sim-1')
    assert.equal(connectorNature(sim.record.connector).simulated, true, '模拟执行同样标 simulated')
    // formal：总开关关闭 → 零派发
    registerActionConnector({
      async execute() {
        calls++
        return { externalRef: 'ext-prod-1' }
      },
      async compensate() {},
    }, { id: 'billing', env: 'prod', kind: 'formal' })
    await assert.rejects(
      () => executeBehaviorAction(input(root)),
      (e) => e.code === 'FORMAL_ACTION_DISABLED' && /总开关/.test(e.message),
    )
    assert.equal(calls, 1, 'formal 被拒时模拟连接器调用数不增')
    // 开关开启后 formal 才可派发（仍经批准卡）
    setFormalActionEnabled(true)
    try {
      const real = await executeBehaviorAction(input(root, { operationId: 'op-m0a5' }))
      assert.equal(real.record.externalRef, 'ext-prod-1')
      assert.equal(calls, 2)
      assert.equal(connectorNature(real.record.connector).simulated, false, 'formal 不标 simulated')
    } finally {
      setFormalActionEnabled(false)
    }
    assert.equal(isFormalActionEnabled(), false, '用后复位')
  } finally {
    setFormalActionEnabled(false)
    registerActionConnector(null)
    rmSync(root, { recursive: true, force: true })
  }
})

test('M0-A6 连接器注册 fail-closed：kind 未声明/伪称 dryrun 一律拒绝', () => {
  const conn = {
    async execute() {
      return { externalRef: 'x' }
    },
    async compensate() {},
  }
  assert.throws(
    () => registerActionConnector(conn, { id: 'billing', env: 'prod' }),
    (e) => e.code === 'INVALID_ARGS' && /kind/.test(e.message),
  )
  assert.throws(
    () => registerActionConnector(conn),
    (e) => e.code === 'INVALID_ARGS',
  )
  assert.throws(
    () => registerActionConnector(conn, { id: 'billing', env: 'prod', kind: 'dryrun' }),
    (e) => e.code === 'INVALID_ARGS',
    '真实连接器不得自称 dryrun',
  )
})

test('T4.1-3 行为闭合：未声明行为拒绝；演练连接器默认不触达外部', async () => {
  assert.throws(
    () =>
      validateActionIntent([{ id: 'BHV-TST-X', anchor: 'OBJ-TST-A' }], { ...INTENT, behaviorId: 'BHV-NOPE' }),
    (e) => e.code === 'INVALID_ARGS' && /O2 闭合/.test(e.message),
  )
  assert.throws(() => validateActionIntent([], INTENT), (e) => e.code === 'INVALID_ARGS')
  const root = mkRoot()
  try {
    const res = await executeBehaviorAction(input(root))
    assert.equal(res.record.externalRef, `dryrun:${res.record.businessKey}`)
    assert.equal(dryRunConnector.execute !== undefined, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('T4.2-1 沙箱判定：onto 专家会话的写入/执行类通用工具一律拒绝；本体工具/只读/交互放行', () => {
  assert.equal(isOntoPreset('onto-aml'), true)
  assert.equal(isOntoPreset('standard'), false)
  assert.equal(isOntoPreset(null), false)
  // 危险能力分类
  for (const name of ['bash', 'pwsh', 'write', 'edit', 'str_replace_editor', 'run_code', 'apply_patch', 'delete_file', 'exec_command', 'schedule_create', 'schedule_update']) {
    assert.equal(isDangerousGeneralTool(name), true, `${name} 须判危险`)
  }
  for (const name of ['read', 'glob', 'grep', 'ask_user_question', 'list_packages', 'read_image']) {
    assert.equal(isDangerousGeneralTool(name), false, `${name} 须判安全`)
  }
  // 沙箱判定
  assert.match(toolSandboxDecision('bash', 'onto-aml') ?? '', /^TOOL_SANDBOX_DENIED/)
  assert.match(toolSandboxDecision('write', 'onto-tax') ?? '', /^TOOL_SANDBOX_DENIED/)
  assert.match(toolSandboxDecision('schedule_create', 'onto-aml') ?? '', /^TOOL_SANDBOX_DENIED/)
  assert.equal(toolSandboxDecision('read', 'onto-aml'), undefined, '只读放行')
  assert.equal(toolSandboxDecision('ask_user_question', 'onto-aml'), undefined, '人审交互放行')
  assert.equal(toolSandboxDecision('run_scenario', 'onto-aml'), undefined, '本体工具走对象收权')
  assert.equal(toolSandboxDecision('bash', 'standard'), undefined, '标准会话不受沙箱约束')
  assert.equal(toolSandboxDecision('bash', null), undefined, '无 preset 不受约束')
})

test('T4.2-2 沙箱拒绝语引导受控替代路径（不静默、不说半截话）', () => {
  const denial = toolSandboxDecision('pwsh', 'onto-med')
  assert.ok(denial.includes('apply_draft') && denial.includes('run_scenario'), '拒绝语指明受控出口')
  assert.ok(denial.includes('标准会话'), '拒绝语给出放行通道')
})

test('R4 补充：parseObjectRef 完整实例引用语法', () => {
  assert.deepEqual(parseObjectRef('OBJ-AML-ACCOUNT:ACCT-001'), { type: 'OBJ-AML-ACCOUNT', instance: 'ACCT-001' })
  assert.equal(parseObjectRef('OBJ-AML-ACCOUNT'), null)
  assert.equal(parseObjectRef('OBJ-AML-ACCOUNT:'), null)
  assert.equal(parseObjectRef('OBJ-AML-ACCOUNT:a:b'), null)
})


/* ── M1-C 动作契约消费（validateActionIntent 过 ActionContract） ───────── */

const CONTRACT = {
  fields: [
    { name: 'amount', type: 'float', required: true, range: { min: 0, max: 1000000 } },
    { name: 'note', type: 'string', required: false },
    { name: 'related', type: 'ref', required: false, refTypes: ['OBJ-TST-B'] },
  ],
  requiredRoles: ['analyst'],
  connector: { capability: 'create-review-ticket', contractVersion: '1' },
  scenarioBinding: { scenarioId: 'SCN-TST-1', decisionKind: 'both' },
}

test('C3-1 载荷契约：白名单外字段拒绝；必填缺失拒绝', () => {
  const behaviors = [{ id: 'BHV-TST-X', anchor: 'OBJ-TST-A', actionContract: CONTRACT }]
  // 白名单外字段
  assert.throws(
    () => validateActionIntent(behaviors, { ...INTENT, payload: { amount: 1, evil: 'x' } }),
    (e) => e.code === 'INVALID_ARGS' && /不在动作契约字段白名单/.test(e.message),
  )
  // 必填缺失
  assert.throws(
    () => validateActionIntent(behaviors, { ...INTENT, payload: { note: 'hi' } }),
    (e) => e.code === 'INVALID_ARGS' && /必填/.test(e.message),
  )
})

test('C3-2 载荷契约：类型/范围/refTypes 校验', () => {
  const behaviors = [{ id: 'BHV-TST-X', anchor: 'OBJ-TST-A', actionContract: CONTRACT }]
  // 类型错
  assert.throws(
    () => validateActionIntent(behaviors, { ...INTENT, payload: { amount: 'lots' } }),
    (e) => /须为有限数值/.test(e.message),
  )
  // 数值超范围（金额越界拒绝）
  assert.throws(
    () => validateActionIntent(behaviors, { ...INTENT, payload: { amount: 2000000 } }),
    (e) => /超出契约范围/.test(e.message),
  )
  assert.throws(
    () => validateActionIntent(behaviors, { ...INTENT, payload: { amount: -1 } }),
    (e) => /超出契约范围/.test(e.message),
  )
  // ref 类型不在允许列表
  assert.throws(
    () => validateActionIntent(behaviors, { ...INTENT, payload: { amount: 1, related: 'OBJ-NOPE:x' } }),
    (e) => /不在契约允许类型/.test(e.message),
  )
  // 合法载荷过
  validateActionIntent(behaviors, { ...INTENT, payload: { amount: 5, note: 'ok', related: 'OBJ-TST-B:b1' } })
})
