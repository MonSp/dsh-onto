/**
 * 交付线双轨对称（issue #30 差量 P2）— 发布台账 wire 面：
 * publishRelease（纯内容/连接器两式 + 可选回放验收门槛）、activateRelease、rollbackRelease
 * （版本回滚同机制，history 保留）、listReleases（活动指针 + 受管状态 + 历史）。
 * 人审口径：宿主可信身份 fail-closed；本人点击即人审事件（与客户轨 seed-release 同信任级）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  OntoRuntime,
  closeActionStore,
  businessPolicy,
  runtimeContextForHost,
} from '../dist/index.js'
import { PackageWorkspace, derivePackage, savePackage } from '@dsh-onto/core'
import { minimalPkg } from '../../core/tests/helpers.mjs'

function issuePkg(ws, name, version) {
  const dir = ws.createPackage({ name, version, domain: 'TST' })
  const pkg = minimalPkg({
    meta: {
      kind: 'BusinessOntologyPackage',
      name,
      version,
      domain: 'TST',
      metaFrameworkVersion: '1.0',
      status: 'DRAFT',
      issueRecord: [],
      externalRefs: [],
    },
  })
  savePackage(dir, pkg)
  ws.transition(name, version, 'IN_REVIEW')
  ws.transition(name, version, 'ISSUED', '授权部署人（人工）')
  derivePackage(dir)
  return dir
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'onto-rel-wire-'))
  const wsRoot = join(dir, 'dsh-onto', 'workspace')
  mkdirSync(wsRoot, { recursive: true })
  const ws = new PackageWorkspace(wsRoot)
  issuePkg(ws, 'test-pkg', '1.0.0')
  const ctx = new Context()
  ctx.reflect.provide('profileContext', { dir })
  const service = new OntoRuntime(ctx)
  const runtime = runtimeContextForHost(ctx.root)
  runtime.run(() => {
    businessPolicy.setIdentityProvider(() => ({
      userId: 'u-rel',
      tenant: 't1',
      roles: ['deployer'],
      dataScope: { objectTypes: [] },
    }))
  })
  return {
    dir,
    ws,
    wsRoot,
    service,
    setIdentity(provider) {
      runtime.run(() => businessPolicy.setIdentityProvider(provider))
    },
    dispose() {
      runtime.run(() => businessPolicy.setIdentityProvider(null))
      closeActionStore(wsRoot)
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

async function expectOrigCode(fn, origCode) {
  await assert.rejects(fn, (e) => {
    const got = e.details?.origCode ?? e.code
    assert.equal(got, origCode, `expected origCode ${origCode}, got ${got} (code=${e.code})`)
    return true
  })
}

test('发布台账：纯内容发布 → 激活 → 第二版激活 → 回滚（history 保留）', async () => {
  const f = fixture()
  try {
    const pub = await f.service.remoteExportPublishRelease({ name: 'test-pkg', version: '1.0.0' })
    assert.equal(pub.mode, 'content')
    assert.equal(pub.activated, false)
    assert.equal(pub.humanReviewRequired, true)
    assert.equal(pub.replayChecked, 0)

    let view = await f.service.remoteExportListReleases()
    let row = view.packages.find((p) => p.name === 'test-pkg')
    assert.equal(row.activeVersion, null, '发布不激活')
    assert.equal(row.versions.find((v) => v.version === '1.0.0').hasManifest, true)

    const act = await f.service.remoteExportActivateRelease({ name: 'test-pkg', version: '1.0.0' })
    assert.equal(act.previous, null)
    view = await f.service.remoteExportListReleases()
    row = view.packages.find((p) => p.name === 'test-pkg')
    assert.equal(row.activeVersion, '1.0.0')

    // 第二版：发布 + 激活
    issuePkg(f.ws, 'test-pkg', '1.1.0')
    await f.service.remoteExportPublishRelease({ name: 'test-pkg', version: '1.1.0' })
    const act2 = await f.service.remoteExportActivateRelease({ name: 'test-pkg', version: '1.1.0' })
    assert.equal(act2.previous, '1.0.0')

    // 回滚：活动指针回 1.0.0；history 全保留
    const rolled = await f.service.remoteExportRollbackRelease({ name: 'test-pkg' })
    assert.equal(rolled.rolledBackTo, '1.0.0')
    view = await f.service.remoteExportListReleases()
    row = view.packages.find((p) => p.name === 'test-pkg')
    assert.equal(row.activeVersion, '1.0.0')
    const actions = view.history.map((h) => h.action)
    assert.ok(actions.includes('import'))
    assert.ok(actions.includes('activate'))
    assert.ok(actions.includes('rollback'))
    assert.equal(view.history.filter((h) => h.action === 'rollback').at(-1).by, 'host:u-rel')
  } finally {
    f.dispose()
  }
})

test('发布台账：双回滚取「最近一次成为 to 的前驱」——不跳版（findPreviousVersion 末次匹配）', async () => {
  const f = fixture()
  try {
    for (const v of ['1.0.0', '1.1.0', '1.2.0']) {
      if (v !== '1.0.0') issuePkg(f.ws, 'test-pkg', v)
      await f.service.remoteExportPublishRelease({ name: 'test-pkg', version: v })
      await f.service.remoteExportActivateRelease({ name: 'test-pkg', version: v })
    }
    // 回滚 1：1.2.0 → 1.1.0
    const r1 = await f.service.remoteExportRollbackRelease({ name: 'test-pkg' })
    assert.equal(r1.rolledBackTo, '1.1.0')
    // 回滚 2：1.1.0 → 1.2.0（还原被回滚的那一步；不得跳回 1.0.0）
    const r2 = await f.service.remoteExportRollbackRelease({ name: 'test-pkg' })
    assert.equal(r2.rolledBackTo, '1.2.0')
    // 回滚 3：1.2.0 → 1.1.0（在最近两个活动版本间往复）
    const r3 = await f.service.remoteExportRollbackRelease({ name: 'test-pkg' })
    assert.equal(r3.rolledBackTo, '1.1.0')
    const view = await f.service.remoteExportListReleases()
    assert.equal(view.packages.find((p) => p.name === 'test-pkg').activeVersion, '1.1.0')
    assert.equal(view.history.filter((h) => h.action === 'rollback').length, 3, 'history 保留全部回滚记录')
  } finally {
    f.dispose()
  }
})

test('publishRelease：连接器式校验——缺 sourceKind/基址/shape/source-maps 拒；回放验收无夹具拒', async () => {
  const f = fixture()
  try {
    await expectOrigCode(
      () => f.service.remoteExportPublishRelease({ name: 'test-pkg', version: '1.0.0', sourceId: 'SRC-TST-1' }),
      'INVALID_ARGS',
    )
    await expectOrigCode(
      () =>
        f.service.remoteExportPublishRelease({
          name: 'test-pkg',
          version: '1.0.0',
          sourceId: 'SRC-TST-1',
          sourceKind: 'simulated',
          apiBaseUrl: 'https://api.example.com',
        }),
      'INVALID_ARGS', // minimalPkg 的 apiSources 无 shape
    )
    await expectOrigCode(
      () =>
        f.service.remoteExportPublishRelease({
          name: 'test-pkg',
          version: '1.0.0',
          checkReplay: true,
        }),
      'INVALID_ARGS', // 纯内容包无 apiSources shape 无法回放验收——显式拒、不静默空验收
    )
    // 校验失败不得落台账（工作区版本可见，但未受管 = 无 manifest）
    const view = await f.service.remoteExportListReleases()
    const row = view.packages.find((p) => p.name === 'test-pkg')
    assert.equal(row.activeVersion, null)
    assert.equal(row.versions.every((v) => v.hasManifest === false), true)
    assert.equal(view.history.filter((h) => h.action === 'import').length, 0)
  } finally {
    f.dispose()
  }
})

test('发布台账 wire：无身份 fail-closed REVIEWER_UNCONFIRMED', async () => {
  const f = fixture()
  try {
    f.setIdentity(null)
    await expectOrigCode(
      () => f.service.remoteExportPublishRelease({ name: 'test-pkg', version: '1.0.0' }),
      'REVIEWER_UNCONFIRMED',
    )
    await expectOrigCode(
      () => f.service.remoteExportActivateRelease({ name: 'test-pkg', version: '1.0.0' }),
      'REVIEWER_UNCONFIRMED',
    )
    await expectOrigCode(
      () => f.service.remoteExportRollbackRelease({ name: 'test-pkg' }),
      'REVIEWER_UNCONFIRMED',
    )
    await expectOrigCode(() => f.service.remoteExportListReleases(), 'REVIEWER_UNCONFIRMED')
  } finally {
    f.dispose()
  }
})
