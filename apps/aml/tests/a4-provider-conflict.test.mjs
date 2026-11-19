/**
 * M2 A4 — 同一宿主上 backend 与 AML 同时提供运行服务 → 明确 RUNTIME_PROVIDER_CONFLICT。
 * 零静默覆盖、零双工具挂载（第二个 apply 在 claim 处失败，mount 不执行）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { runtimeContextForHost } from '@dsh-onto/runtime'
import { apply as applyBackend } from '@dsh-onto/backend'
import { apply as applyAml } from '@dsh-aml/app'

function isProviderConflict(err) {
  return err?.code === 'RUNTIME_PROVIDER_CONFLICT'
    || /已有本体运行服务提供者|RUNTIME_PROVIDER_CONFLICT/.test(String(err?.message ?? err))
}

function makeHost() {
  const dir = mkdtempSync(join(tmpdir(), 'onto-a4-'))
  const ctx = new Context()
  ctx.reflect.provide('profileContext', { dir })
  return {
    ctx,
    dir,
    dispose() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('A4：backend 先装配，AML 再装配 → RUNTIME_PROVIDER_CONFLICT（fail-loud）', async () => {
  const host = makeHost()
  let backendFiber
  try {
    backendFiber = await host.ctx.plugin(applyBackend)
    const first = runtimeContextForHost(host.ctx.root)
    assert.equal(first.accepting, true)

    await assert.rejects(
      async () => { await host.ctx.plugin(applyAml) },
      (err) => isProviderConflict(err),
      'AML second must fail-loud with provider conflict',
    )

    // 后端上下文仍在；未因 AML 失败而 dispose
    assert.equal(runtimeContextForHost(host.ctx.root), first)
    assert.equal(first.disposed, false)
  } finally {
    await backendFiber?.dispose?.()
    host.dispose()
  }
})

test('A4：AML 先装配，backend 再装配 → RUNTIME_PROVIDER_CONFLICT', async () => {
  const host = makeHost()
  let amlFiber
  try {
    amlFiber = await host.ctx.plugin(applyAml)
    const first = runtimeContextForHost(host.ctx.root)
    assert.equal(first.accepting, true)

    await assert.rejects(
      async () => { await host.ctx.plugin(applyBackend) },
      (err) => isProviderConflict(err),
      'backend second must fail-loud with provider conflict',
    )

    assert.equal(runtimeContextForHost(host.ctx.root), first)
    assert.equal(first.disposed, false)
  } finally {
    await amlFiber?.dispose?.()
    host.dispose()
  }
})

test('A4：卸载首个提供者后，另一方可在同宿主装配（不继承旧状态）', async () => {
  const host = makeHost()
  let firstFiber
  try {
    firstFiber = await host.ctx.plugin(applyBackend)
    const backendCtx = runtimeContextForHost(host.ctx.root)
    await assert.rejects(
      async () => { await host.ctx.plugin(applyAml) },
      (err) => isProviderConflict(err),
    )

    // 模拟 backend 卸载
    await firstFiber.dispose()
    firstFiber = undefined
    assert.equal(backendCtx.disposed, true)

    // AML 现在可以 claim 同一 host root（runtimeContextForHost 会新建 context）
    const amlFiber = await host.ctx.plugin(applyAml)
    try {
      const amlCtx = runtimeContextForHost(host.ctx.root)
      assert.notEqual(amlCtx, backendCtx)
      assert.equal(amlCtx.accepting, true)
      assert.equal(amlCtx.disposed, false)
    } finally {
      await amlFiber.dispose()
    }
  } finally {
    await firstFiber?.dispose?.()
    host.dispose()
  }
})
