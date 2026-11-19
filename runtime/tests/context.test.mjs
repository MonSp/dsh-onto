import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createRuntimeContext, runtimeContextForHost, provideRuntimeContext, bindRuntimeHost,
  businessPolicy, dataSources, registerActionConnector, currentConnectorIdentity,
  setFormalActionEnabled, isFormalActionEnabled,
  configurePhraseStore, recallPhrases, rememberPhrases, recalledAnswerPhrases,
  registerSkillInvalidator, invalidateSkillCatalog,
  executeBehaviorAction, ActionStore,
} from '../dist/index.js'

const identity = tenant => ({
  userId: `${tenant}-user`, tenant, roles: ['analyst'], dataScope: { objectTypes: [] },
})
const connector = name => ({ execute: async () => ({ externalRef: name }) })
const configure = (context, name) => context.run(() => {
  businessPolicy.setIdentityProvider(() => identity(name))
  registerActionConnector(connector(name), { id: name, env: 'test', kind: 'formal' })
})

test('两个上下文：身份、连接器、正式开关独立，未配置宿主保持关闭', () => {
  const a = createRuntimeContext()
  const b = createRuntimeContext()
  configure(a, 'A')
  a.run(() => setFormalActionEnabled(true))
  configure(b, 'B')
  a.run(() => {
    assert.equal(businessPolicy.resolveIdentity().tenant, 'A')
    assert.equal(currentConnectorIdentity().id, 'A')
    assert.equal(isFormalActionEnabled(), true)
  })
  b.run(() => {
    assert.equal(businessPolicy.resolveIdentity().tenant, 'B')
    assert.equal(currentConnectorIdentity().id, 'B')
    assert.equal(isFormalActionEnabled(), false)
  })
  a.dispose()
  b.dispose()
})

test('异步交错：await 后仍使用自己的身份与连接器', async () => {
  const a = createRuntimeContext()
  const b = createRuntimeContext()
  configure(a, 'A')
  configure(b, 'B')
  let resume
  const gate = new Promise(resolve => { resume = resolve })
  const first = a.run(async () => {
    await gate
    return [businessPolicy.resolveIdentity().tenant, currentConnectorIdentity().id]
  })
  const second = b.run(async () => {
    await Promise.resolve()
    resume()
    return [businessPolicy.resolveIdentity().tenant, currentConnectorIdentity().id]
  })
  assert.deepEqual(await first, ['A', 'A'])
  assert.deepEqual(await second, ['B', 'B'])
  a.dispose()
  b.dispose()
})

test('数据源同名可在不同宿主登记，同一宿主重复仍拒绝', () => {
  const a = createRuntimeContext()
  const b = createRuntimeContext()
  for (const [context, version] of [[a, 'A'], [b, 'B']]) {
    context.run(() => dataSources.register('shared-id', { version, nature: 'simulated', fetch: async () => ({}) }))
  }
  a.run(() => {
    assert.equal(dataSources.list()[0].version, 'A')
    assert.throws(() => dataSources.register('shared-id', {}), /已登记/)
    dataSources.unregister('shared-id')
  })
  b.run(() => assert.equal(dataSources.list()[0].version, 'B'))
  a.dispose()
  b.dispose()
})

test('短语回读、运行缓存、回答红线与技能失效均按上下文隔离', () => {
  const a = createRuntimeContext()
  const b = createRuntimeContext()
  let callsA = 0
  let callsB = 0
  a.run(() => {
    configurePhraseStore(() => ['persisted-A'])
    rememberPhrases('same-run', ['A'])
    registerSkillInvalidator(() => callsA++)
  })
  b.run(() => {
    configurePhraseStore(() => ['persisted-B'])
    rememberPhrases('same-run', ['B'])
    registerSkillInvalidator(() => callsB++)
  })
  a.run(() => {
    assert.deepEqual(recallPhrases('same-run'), ['A'])
    assert.deepEqual(recallPhrases('missing'), ['persisted-A'])
    assert.deepEqual(recalledAnswerPhrases(), ['A'])
    invalidateSkillCatalog()
  })
  assert.equal(callsA, 1)
  assert.equal(callsB, 0)
  b.run(() => assert.deepEqual(recallPhrases('same-run'), ['B']))
  a.dispose()
  b.dispose()
})

test('同宿主重复提供者拒绝；停用后重新装配不继承旧权限和开关', () => {
  const host = {}
  const a = runtimeContextForHost(host)
  a.claim()
  configure(a, 'A')
  a.run(() => setFormalActionEnabled(true))
  assert.throws(() => a.claim(), { code: 'RUNTIME_PROVIDER_CONFLICT' })
  assert.throws(() => provideRuntimeContext(host, createRuntimeContext()), { code: 'RUNTIME_PROVIDER_CONFLICT' })
  a.dispose()
  assert.throws(() => a.run(() => {}), { code: 'RUNTIME_DISPOSED' })
  const b = runtimeContextForHost(host)
  assert.notEqual(a, b)
  b.claim()
  b.run(() => {
    assert.equal(businessPolicy.resolveIdentity(), null)
    assert.equal(isFormalActionEnabled(), false)
    assert.equal(currentConnectorIdentity().kind, 'dryrun')
    assert.deepEqual(dataSources.list(), [])
  })
  b.dispose()
})

test('在途工作停用：拒绝新操作，已派发工作保留状态直至完成记账', async () => {
  const context = createRuntimeContext()
  configure(context, 'A')
  let resume
  const gate = new Promise(resolve => { resume = resolve })
  const pending = context.run(async () => {
    await gate
    assert.equal(businessPolicy.resolveIdentity().tenant, 'A')
    assert.equal(isFormalActionEnabled(), false)
  })
  context.dispose()
  assert.equal(context.disposed, false)
  assert.throws(() => context.run(() => {}), { code: 'RUNTIME_DISPOSED' })
  resume()
  await pending
  assert.equal(context.disposed, true)
})

test('host 工具 execute/render、guard 和技能工厂保留各自运行上下文及 receiver', async () => {
  const makeHost = () => {
    const host = { root: {}, tools: {}, skills: {} }
    host.tools.register = function (tool) { assert.equal(this, host.tools); host.tool = tool }
    host.tools.guard = function (guard) { host.guard = guard }
    host.skills.registerProvider = function (factory) { host.factory = factory }
    return host
  }
  const a = makeHost()
  const b = makeHost()
  for (const [host, name] of [[a, 'A'], [b, 'B']]) {
    const context = runtimeContextForHost(host.root)
    configure(context, name)
    const scoped = bindRuntimeHost(host)
    scoped.tools.register({
      execute: async function () { await Promise.resolve(); return businessPolicy.resolveIdentity().tenant },
      output: { render() { return businessPolicy.resolveIdentity().tenant } },
    })
    scoped.tools.guard(() => businessPolicy.resolveIdentity().tenant)
    scoped.skills.registerProvider(() => ({
      list: async () => [businessPolicy.resolveIdentity().tenant],
    }))
  }
  assert.deepEqual(await Promise.all([a.tool.execute(), b.tool.execute()]), ['A', 'B'])
  assert.equal(a.tool.output.render(), 'A')
  assert.equal(b.guard(), 'B')
  assert.deepEqual(await a.factory().list(), ['A'])
  runtimeContextForHost(a.root).dispose()
  runtimeContextForHost(b.root).dispose()
})

test('延迟消费 llm/stream：每轮 iterator.next 都保留上下文', async () => {
  const context = createRuntimeContext()
  configure(context, 'A')
  let listener
  const scoped = bindRuntimeHost({ root: {}, on(_name, fn) { listener = fn } }, context)
  scoped.on('llm/stream', () => (async function* () {
    yield businessPolicy.resolveIdentity().tenant
    await Promise.resolve()
    yield businessPolicy.resolveIdentity().tenant
  })())
  const stream = listener()
  const results = []
  for await (const item of stream) results.push(item)
  assert.deepEqual(results, ['A', 'A'])
  context.dispose()
  assert.equal(context.disposed, true)
})

test('未开始消费的流可取消；停用不会永久保留运行状态', async () => {
  const context = createRuntimeContext()
  const stream = context.run(() => (async function* () { yield 'never-consumed' })())
  context.dispose()
  await stream.return()
  assert.equal(context.disposed, true)
})

test('旧宿主尚有在途工作也能重装，新上下文不继承旧状态', async () => {
  const host = {}
  const old = runtimeContextForHost(host)
  old.claim()
  configure(old, 'A')
  let resume
  const gate = new Promise(resolve => { resume = resolve })
  const pending = old.run(async () => {
    await gate
    return businessPolicy.resolveIdentity().tenant
  })
  old.dispose()
  assert.equal(old.disposed, false)
  const replacement = runtimeContextForHost(host)
  assert.notEqual(old, replacement)
  replacement.claim()
  replacement.run(() => {
    assert.equal(businessPolicy.resolveIdentity(), null)
    assert.equal(isFormalActionEnabled(), false)
  })
  configure(replacement, 'B')
  resume()
  assert.equal(await pending, 'A')
  assert.equal(old.disposed, true)
  replacement.run(() => assert.equal(businessPolicy.resolveIdentity().tenant, 'B'))
  replacement.dispose()
})

test('流取消等待上游 finally 完成才释放状态，下一次 next 不提前清理', async () => {
  const context = createRuntimeContext()
  configure(context, 'A')
  let finishCleanup
  const gate = new Promise(resolve => { finishCleanup = resolve })
  let cleaned = false
  const stream = context.run(() => (async function* () {
    try { yield 'first' }
    finally {
      await gate
      assert.equal(businessPolicy.resolveIdentity().tenant, 'A')
      cleaned = true
    }
  })())
  await stream.next()
  context.dispose()
  const next = stream.next()
  assert.equal(context.disposed, false)
  assert.equal(cleaned, false)
  finishCleanup()
  assert.equal((await next).done, true)
  assert.equal(cleaned, true)
  assert.equal(context.disposed, true)
})

function actionInput(root, requestGrant) {
  return {
    root,
    intent: { behaviorId: 'BHV-TST-X', objectRef: 'OBJ-TST-A:inst1', payload: { amount: 1 } },
    pkg: { name: 'test-pkg', version: '1.0.0' },
    behavior: { id: 'BHV-TST-X', anchor: 'OBJ-TST-A', name: 'test action' },
    requestGrant,
  }
}

const grant = { approvalDigest: 'test-approval', approvedAt: '2026-11-18T00:00:00Z' }

test('批准等待中停用：批准返回后仍拒绝派发，回收无效应占位', async () => {
  const root = mkdtempSync(join(tmpdir(), 'onto-stop-approval-'))
  const context = createRuntimeContext()
  let allow
  let entered
  const enteredPromise = new Promise(resolve => { entered = resolve })
  let calls = 0
  context.run(() => registerActionConnector({
    execute: async () => { calls++; return { externalRef: 'unexpected' } },
  }, { id: 'test', env: 'test', kind: 'simulated' }))
  const pending = context.run(() => executeBehaviorAction(actionInput(root, () => {
    entered()
    return new Promise(resolve => { allow = resolve })
  })))
  try {
    await enteredPromise
    context.dispose()
    allow(grant)
    await assert.rejects(pending, { code: 'RUNTIME_DISPOSED' })
    assert.equal(calls, 0)
    assert.equal(context.disposed, true)
    assert.deepEqual(new ActionStore(join(root, 'actions', 'ledger.db')).listActions(), [])
  } finally { context.dispose(); rmSync(root, { recursive: true, force: true }) }
})

test('已派发后停用：外部回执仍写入原台账，不删除在途记录', async () => {
  const root = mkdtempSync(join(tmpdir(), 'onto-stop-dispatched-'))
  const context = createRuntimeContext()
  let finish
  let entered
  const enteredPromise = new Promise(resolve => { entered = resolve })
  context.run(() => registerActionConnector({
    execute: async () => {
      entered()
      return new Promise(resolve => { finish = resolve })
    },
  }, { id: 'test', env: 'test', kind: 'simulated' }))
  const pending = context.run(() => executeBehaviorAction(actionInput(root, async () => grant)))
  try {
    await enteredPromise
    context.dispose()
    finish({ externalRef: 'external-receipt' })
    const result = await pending
    assert.equal(result.record.status, 'succeeded')
    assert.equal(result.record.externalRef, 'external-receipt')
    assert.equal(context.disposed, true)
    const actions = new ActionStore(join(root, 'actions', 'ledger.db')).listActions()
    assert.equal(actions.length, 1)
    assert.equal(actions[0].externalRef, 'external-receipt')
  } finally { context.dispose(); rmSync(root, { recursive: true, force: true }) }
})
