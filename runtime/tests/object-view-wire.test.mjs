/**
 * issue #30 WP-D — 对象视图 wire：实体浏览 / 邻域跳转。
 * 口径：双通道互斥（dataset XOR sourceId）；missingSeedIds / truncated 显式呈现；
 * 分页与类型过滤；扩图逐种子过 expand 面授权。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import {
  OntoRuntime,
  closeActionStore,
  businessPolicy,
  runtimeContextForHost,
} from '../dist/index.js'
import { derivePackage } from '@dsh-onto/core'

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const AML_SRC = join(REPO, 'packages', 'aml', '1.0.0')

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'onto-object-view-'))
  const wsRoot = join(dir, 'dsh-onto', 'workspace')
  const versionDir = join(wsRoot, 'packages', 'aml-analysis', '1.0.0')
  mkdirSync(join(versionDir, '..'), { recursive: true })
  cpSync(AML_SRC, versionDir, { recursive: true })
  derivePackage(versionDir)
  const ctx = new Context()
  ctx.reflect.provide('profileContext', { dir })
  const service = new OntoRuntime(ctx)
  const runtime = runtimeContextForHost(ctx.root)
  runtime.run(() => {
    businessPolicy.setIdentityProvider(() => ({
      userId: 'u-obj',
      tenant: 't1',
      roles: ['analyst'],
      dataScope: { objectTypes: [] },
    }))
  })
  return {
    service,
    runtime,
    dispose() {
      runtime.run(() => businessPolicy.setIdentityProvider(null))
      closeActionStore(wsRoot)
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** A—B—C 链（1 跳从 A 只见 B；B—C 外沿 → truncated）。 */
const DATASET = {
  objects: [
    { id: 'ACCT-001', type: 'OBJ-AML-ACCOUNT', attrs: { balance: 10 } },
    { id: 'ACCT-002', type: 'OBJ-AML-ACCOUNT' },
    { id: 'CUST-001', type: 'OBJ-AML-CUSTOMER' },
  ],
  relations: [
    { id: 'REL-1', type: 'REL-AML-OWNS', from: 'CUST-001', to: 'ACCT-001' },
    { id: 'REL-2', type: 'REL-AML-TRANSFERS', from: 'ACCT-001', to: 'ACCT-002' },
  ],
  behaviors: [],
  candidates: [],
}

const ARGS = { name: 'aml-analysis', version: '1.0.0' }

async function expectOrigCode(fn, origCode) {
  await assert.rejects(fn, (e) => {
    const got = e.details?.origCode ?? e.code
    assert.equal(got, origCode, `expected origCode ${origCode}, got ${got} (code=${e.code})`)
    return true
  })
}

test('browseObjects：类型计数 + 过滤 + 分页（dataset 通道）', async () => {
  const f = fixture()
  try {
    const all = await f.service.remoteExportBrowseObjects({ ...ARGS, dataset: DATASET })
    assert.equal(all.total, 3)
    assert.deepEqual(
      all.types.sort((a, b) => a.type.localeCompare(b.type)),
      [{ type: 'OBJ-AML-ACCOUNT', count: 2 }, { type: 'OBJ-AML-CUSTOMER', count: 1 }],
    )
    assert.equal(all.objects[0].attrs !== undefined, true, 'attrs 透传')

    const filtered = await f.service.remoteExportBrowseObjects({
      ...ARGS, dataset: DATASET, typeFilter: 'OBJ-AML-ACCOUNT',
    })
    assert.equal(filtered.total, 2)
    assert.ok(filtered.objects.every((o) => o.type === 'OBJ-AML-ACCOUNT'))

    const page = await f.service.remoteExportBrowseObjects({
      ...ARGS, dataset: DATASET, typeFilter: 'OBJ-AML-ACCOUNT', offset: 1, limit: 1,
    })
    assert.equal(page.objects.length, 1)
    assert.equal(page.total, 2)
  } finally {
    f.dispose()
  }
})

test('browseObjects / expandEntity：sourceId 与 dataset 互斥（同 runScenario 口径）', async () => {
  const f = fixture()
  try {
    await expectOrigCode(
      () => f.service.remoteExportBrowseObjects({ ...ARGS }),
      'INVALID_ARGS',
    )
    await expectOrigCode(
      () => f.service.remoteExportBrowseObjects({ ...ARGS, dataset: DATASET, sourceId: 'SRC-X' }),
      'INVALID_ARGS',
    )
    await expectOrigCode(
      () => f.service.remoteExportExpandEntity({ ...ARGS, seedIds: ['ACCT-001'] }),
      'INVALID_ARGS',
    )
  } finally {
    f.dispose()
  }
})

test('expandEntity：邻域诱导子图 + missingSeedIds / truncated 显式', async () => {
  const f = fixture()
  try {
    // hops=1 从 ACCT-001：邻域 {ACCT-001, ACCT-002, CUST-001}（无向 both），
    // 但全部三节点都可达 —— 用 hops=0 看 truncated 语义更清楚
    const zero = await f.service.remoteExportExpandEntity({
      ...ARGS, dataset: DATASET, seedIds: ['ACCT-001'], hops: 0,
    })
    assert.deepEqual(zero.seedIds, ['ACCT-001'])
    assert.equal(zero.truncated, true, 'hops=0 仍有外沿 → truncated 必置位')
    assert.equal(zero.stats.objects, 1)

    const one = await f.service.remoteExportExpandEntity({
      ...ARGS, dataset: DATASET, seedIds: ['ACCT-001'], hops: 1,
    })
    // both 方向 1 跳：CUST-001 — ACCT-001 — ACCT-002 全进（链上两点都是邻居）
    assert.equal(one.stats.objects, 3)
    assert.equal(one.truncated, false, '全图已扩尽')
    // 诱导子图：边两端 ⊆ 顶点
    const ids = new Set(one.dataset.objects.map((o) => o.id))
    for (const r of one.dataset.relations) {
      assert.ok(ids.has(r.from) && ids.has(r.to), `悬空边 ${r.id}`)
    }

    // 单向 out 1 跳：只到 ACCT-002（CUST-001 是入边，不走）
    const out = await f.service.remoteExportExpandEntity({
      ...ARGS, dataset: DATASET, seedIds: ['ACCT-001'], hops: 1, direction: 'out',
    })
    assert.deepEqual([...out.dataset.objects.map((o) => o.id)].sort(), ['ACCT-001', 'ACCT-002'])
    assert.equal(out.truncated, false, '末层 ACCT-002 无出边外沿')

    // 有身份：幽灵种子被逐种子授权拒（expand 面三查——类型/实例存在性）
    await expectOrigCode(
      () => f.service.remoteExportExpandEntity({
        ...ARGS, dataset: DATASET, seedIds: ['ACCT-001', 'GHOST-9'], hops: 1,
      }),
      'OBJECT_NOT_GRANTED',
    )
    // 探索匿名通道（read 族放行）：缺失种子显式记 missingSeedIds（不抛错、不静默）
    f.runtime.run(() => businessPolicy.setIdentityProvider(null))
    const miss = await f.service.remoteExportExpandEntity({
      ...ARGS, dataset: DATASET, seedIds: ['ACCT-001', 'GHOST-9'], hops: 1,
    })
    assert.deepEqual(miss.missingSeedIds, ['GHOST-9'])
    assert.deepEqual(miss.seedIds, ['ACCT-001'])
  } finally {
    f.dispose()
  }
})
