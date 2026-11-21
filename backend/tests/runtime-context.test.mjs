import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import {
  runtimeContextForHost, businessPolicy, dataSources,
  registerActionConnector, currentConnectorIdentity, isFormalActionEnabled,
} from '@dsh-onto/runtime'
import { derivePackage } from '@dsh-onto/core'
import { apply as applyBackend } from '../dist/index.js'
import { apply as applyTools } from '../dist/agent-tools.js'
import { OntoRuntime } from '../dist/services.js'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const identity = name => ({ userId: name, tenant: name, roles: ['analyst'], dataScope: { objectTypes: [] } })

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'onto-context-'))
  const versionDir = join(dir, 'dsh-onto', 'workspace', 'packages', 'aml-analysis', '1.0.0')
  mkdirSync(join(versionDir, '..'), { recursive: true })
  cpSync(join(repo, 'packages', 'aml', '1.0.0'), versionDir, { recursive: true })
  derivePackage(versionDir)
  const root = { get: key => key === 'profileContext' ? { dir } : undefined }
  const tools = new Map()
  const ctx = {
    root, on() {},
    tools: { register: tool => tools.set(tool.name, tool), guard() {} },
  }
  const runtime = runtimeContextForHost(root)
  return { ctx, root, dir, tools, runtime, dispose() {
    runtime.dispose()
    rmSync(dir, { recursive: true, force: true })
  } }
}

test('真实工具 apply：两个宿主同 sourceId 不串连接器，render 回调独立', async () => {
  const a = fixture()
  const b = fixture()
  const dataset = JSON.parse(readFileSync(join(repo, 'examples', 'aml-run.json'), 'utf8'))
  const fetches = []
  try {
    for (const [host, name] of [[a, 'A'], [b, 'B']]) {
      host.runtime.run(() => {
        businessPolicy.setIdentityProvider(() => identity(name))
        dataSources.register('same-source', {
          version: name, nature: 'simulated',
          async fetch() {
            fetches.push(name)
            await Promise.resolve()
            return { dataset, complete: true, businessWindow: { from: '2026-11-01', to: new Date().toISOString() } }
          },
        })
      })
      applyTools(host.ctx)
    }
    const args = {
      name: 'aml-analysis', version: '1.0.0', scenarioId: 'SCN-AML-FIND-CLUES',
      sourceId: 'same-source', analysisMode: 'formal',
    }
    const [outA, outB] = await Promise.all([
      a.tools.get('run_scenario').execute(args, {}),
      b.tools.get('run_scenario').execute(args, {}),
    ])
    assert.deepEqual(fetches.sort(), ['A', 'B'])
    assert.equal(outA.humanReviewRequired, true)
    assert.equal(outB.humanReviewRequired, true)
    assert.ok(a.tools.get('run_scenario').output.render(args, outA))
    assert.ok(b.tools.get('run_scenario').output.render(args, outB))
  } finally { a.dispose(); b.dispose() }
})

test('真实 wire 实例：保留 Remote 标记，调用绑定到所属宿主', async () => {
  const rootA = mkdtempSync(join(tmpdir(), 'onto-wire-a-'))
  const rootB = mkdtempSync(join(tmpdir(), 'onto-wire-b-'))
  const roots = [rootA, rootB]
  const contexts = []
  try {
    for (const [index, dir] of roots.entries()) {
      const source = fixture()
      cpSync(join(source.dir, 'dsh-onto'), join(dir, 'dsh-onto'), { recursive: true })
      source.dispose()
      const ctx = new Context()
      ctx.reflect.provide('profileContext', { dir })
      const runtime = runtimeContextForHost(ctx.root)
      contexts.push(runtime)
      runtime.run(() => dataSources.register('wire-source', {
        version: String(index), nature: 'simulated',
        async fetch() { throw new Error(`wire-host-${index}`) },
      }))
      const service = new OntoRuntime(ctx)
      assert.equal(remoteMethods(service).length, 15)
      await assert.rejects(
        () => service.remoteExportRunScenario({
          name: 'aml-analysis', version: '1.0.0',
          scenarioId: 'SCN-AML-FIND-CLUES', sourceId: 'wire-source',
        }),
        error => error.message === `wire-host-${index}`,
      )
    }
  } finally {
    for (const context of contexts) context.dispose()
    for (const dir of roots) rmSync(dir, { recursive: true, force: true })
  }
})

test('backend apply 重复装配拒绝，卸载重装恢复默认身份/连接器/开关', () => {
  const envNames = ['DSH_TICKET_SIM_URL', 'DSH_EXT_API_URL', 'DSH_FORMAL_ACTION_ENABLED']
  const previous = new Map(envNames.map(name => [name, process.env[name]]))
  const disposers = []
  const ctx = {
    root: { get() {} }, plugin() {},
    effect(factory) { disposers.push(factory()) },
  }
  try {
    for (const name of envNames) delete process.env[name]
    process.env.DSH_FORMAL_ACTION_ENABLED = '1'
    applyBackend(ctx)
    const first = runtimeContextForHost(ctx.root)
    first.run(() => {
      assert.equal(isFormalActionEnabled(), true)
      businessPolicy.setIdentityProvider(() => identity('first'))
      registerActionConnector({ execute: async () => ({ externalRef: 'simulated' }) },
        { id: 'first', env: 'test', kind: 'simulated' })
    })
    assert.throws(() => applyBackend(ctx), { code: 'RUNTIME_PROVIDER_CONFLICT' })
    disposers.pop()()
    delete process.env.DSH_FORMAL_ACTION_ENABLED
    applyBackend(ctx)
    const second = runtimeContextForHost(ctx.root)
    assert.notEqual(first, second)
    second.run(() => {
      assert.equal(isFormalActionEnabled(), false)
      assert.equal(currentConnectorIdentity().kind, 'dryrun')
      assert.notEqual(businessPolicy.resolveIdentity()?.userId, 'first')
    })
  } finally {
    for (const dispose of disposers) dispose()
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test('真实 Cordis restart：旧操作未完成时也能重装，旧状态只用于原操作收尾', async () => {
  const source = fixture()
  const envNames = ['DSH_TICKET_SIM_URL', 'DSH_EXT_API_URL', 'DSH_FORMAL_ACTION_ENABLED']
  const previous = new Map(envNames.map(name => [name, process.env[name]]))
  let fiber
  let resume
  let pending
  const ctx = new Context()
  ctx.reflect.provide('profileContext', { dir: source.dir })
  try {
    for (const name of envNames) delete process.env[name]
    fiber = await ctx.plugin(applyBackend)
    const old = runtimeContextForHost(ctx.root)
    old.run(() => businessPolicy.setIdentityProvider(() => identity('old')))
    const gate = new Promise(resolve => { resume = resolve })
    pending = old.run(async () => {
      await gate
      return businessPolicy.resolveIdentity().userId
    })
    await fiber.restart()
    const replacement = runtimeContextForHost(ctx.root)
    assert.notEqual(old, replacement)
    assert.equal(old.accepting, false)
    replacement.run(() => {
      assert.equal(isFormalActionEnabled(), false)
      assert.notEqual(businessPolicy.resolveIdentity()?.userId, 'old')
    })
    resume()
    assert.equal(await pending, 'old')
    assert.equal(old.disposed, true)
  } finally {
    resume?.()
    await pending
    await fiber?.dispose()
    source.dispose()
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})
