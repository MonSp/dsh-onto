/**
 * 运维发布 CLI 验收（issue #33 缺口6）：
 * - list/status 台账可见；publish 受控导入不自动激活；
 * - activate/rollback 须人工 --by（host: 归一；agent/llm fail-closed）；
 * - 回滚保留 history、目标缺失 fail-loud。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PackageWorkspace, savePackage, derivePackage } from '@dsh-onto/core'
import { runReleaseCli, normalizeActor, parseReleaseCliArgs } from '../dist/release-cli.js'
import { minimalPkg } from '../../core/tests/helpers.mjs'

function setupDataDir() {
  // 源包与目标数据目录分离：验证真实受控导入（首次 idempotent=false，重跑 true）
  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-relcli-'))
  const srcRoot = mkdtempSync(join(tmpdir(), 'dsh-relcli-src-'))
  const ws = new PackageWorkspace(join(dataDir, 'workspace'))
  const srcWs = new PackageWorkspace(srcRoot)
  return { dataDir, ws, srcWs, srcRoot }
}

function issuePkg(srcWs, { name = 'cli-pkg', version = '1.0.0', domain = 'TST' } = {}) {
  const dir = srcWs.createPackage({ name, version, domain })
  const pkg = minimalPkg({
    meta: {
      kind: 'BusinessOntologyPackage',
      name,
      version,
      domain,
      metaFrameworkVersion: '1.0',
      status: 'DRAFT',
      issueRecord: [],
      externalRefs: [],
    },
  })
  savePackage(dir, pkg)
  srcWs.transition(name, version, 'IN_REVIEW')
  srcWs.transition(name, version, 'ISSUED', '张三（人工）', '人审通过')
  derivePackage(dir)
  return dir
}

function cli(dataDir, argv) {
  const lines = []
  const r = runReleaseCli(argv, { dataDir, log: (l) => lines.push(l) })
  return { ...r, text: lines.join('\n') }
}

test('CLI: 参数解析（--by/--check-replay/位置参数）与 actor 归一', () => {
  assert.equal(normalizeActor('张三'), 'host:张三')
  assert.equal(normalizeActor('HOST:ops1'), 'host:ops1')
  assert.equal(normalizeActor(undefined), undefined)
  assert.equal(normalizeActor('  '), undefined)
  const a = parseReleaseCliArgs(['publish', '/x', '--by', '李四', '--check-replay'])
  assert.equal(a.command, 'publish')
  assert.deepEqual(a.positional, ['/x'])
  assert.equal(a.by, '李四')
  assert.equal(a.checkReplay, true)
})

test('CLI: list 空台账与 status 无指针诚实上报', () => {
  const { dataDir, srcRoot } = setupDataDir()
  try {
    const l = cli(dataDir, ['list'])
    assert.equal(l.code, 0)
    assert.ok(l.text.includes('无发布台账'))
    const s = cli(dataDir, ['status'])
    assert.equal(s.code, 0)
    assert.ok(s.text.includes('无活动指针'))
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(srcRoot, { recursive: true, force: true })
  }
})

test('CLI: publish 受控导入不自动激活；同内容重跑幂等', () => {
  const { dataDir, srcWs, srcRoot } = setupDataDir()
  try {
    const dir = issuePkg(srcWs)
    const p = cli(dataDir, ['publish', dir])
    assert.equal(p.code, 0, p.text)
    assert.ok(p.text.includes('cli-pkg@1.0.0'))
    assert.ok(p.text.includes('idempotent=false'), p.text)
    assert.ok(p.text.includes('导入不自动激活'))
    // 导入后仍未激活
    const s = cli(dataDir, ['status', 'cli-pkg'])
    assert.ok(s.text.includes('未激活'))
    // 同内容重跑 → 幂等
    const p2 = cli(dataDir, ['publish', dir])
    assert.equal(p2.code, 0, p2.text)
    assert.ok(p2.text.includes('idempotent=true'), p2.text)
    // 台账可见
    const l = cli(dataDir, ['list'])
    assert.ok(l.text.includes('cli-pkg@1.0.0'))
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(srcRoot, { recursive: true, force: true })
  }
})

test('CLI: activate/rollback 缺 --by → 用法错误（不静默放行）', () => {
  const { dataDir, srcWs, srcRoot } = setupDataDir()
  try {
    const dir = issuePkg(srcWs)
    cli(dataDir, ['publish', dir])
    const a = cli(dataDir, ['activate', 'cli-pkg', '1.0.0'])
    assert.equal(a.code, 2)
    assert.ok(a.text.includes('用法错误'))
    const r = cli(dataDir, ['rollback', 'cli-pkg'])
    assert.equal(r.code, 2)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(srcRoot, { recursive: true, force: true })
  }
})

test('CLI: activate agent/llm 授权人 fail-closed；host: 裸名归一后放行', () => {
  const { dataDir, srcWs, srcRoot } = setupDataDir()
  try {
    const dir = issuePkg(srcWs)
    cli(dataDir, ['publish', dir])
    const bad = cli(dataDir, ['activate', 'cli-pkg', '1.0.0', '--by', 'agent'])
    assert.equal(bad.code, 1)
    assert.ok(bad.text.includes('RELEASE_UNAUTHORIZED'), bad.text)
    const ok = cli(dataDir, ['activate', 'cli-pkg', '1.0.0', '--by', '张三'])
    assert.equal(ok.code, 0, ok.text)
    assert.ok(ok.text.includes('cli-pkg@1.0.0'))
    const s = cli(dataDir, ['status', 'cli-pkg'])
    assert.ok(s.text.includes('1.0.0'))
    assert.ok(s.text.includes('activate'))
    assert.ok(s.text.includes('host:张三'))
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(srcRoot, { recursive: true, force: true })
  }
})

test('CLI: rollback 回上一活动版本且 history 保留', () => {
  const { dataDir, srcWs, srcRoot } = setupDataDir()
  try {
    const d1 = issuePkg(srcWs, { version: '1.0.0' })
    const d2 = issuePkg(srcWs, { version: '2.0.0' })
    cli(dataDir, ['publish', d1])
    cli(dataDir, ['publish', d2])
    cli(dataDir, ['activate', 'cli-pkg', '1.0.0', '--by', '张三'])
    cli(dataDir, ['activate', 'cli-pkg', '2.0.0', '--by', '张三'])
    const r = cli(dataDir, ['rollback', 'cli-pkg', '--by', '张三'])
    assert.equal(r.code, 0, r.text)
    assert.ok(r.text.includes('1.0.0'))
    const s = cli(dataDir, ['status'])
    assert.ok(s.text.includes('cli-pkg@1.0.0'))
    assert.ok(s.text.includes('rollback'), s.text)
    // history 只增不删：activate ×2 + rollback + import ×2 全在
    assert.ok(s.text.includes('2.0.0'))
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(srcRoot, { recursive: true, force: true })
  }
})

test('CLI: 回滚/激活目标不存在 fail-loud（不虚构版本）', () => {
  const { dataDir, srcRoot } = setupDataDir()
  try {
    const a = cli(dataDir, ['activate', 'no-such', '9.9.9', '--by', '张三'])
    assert.equal(a.code, 1)
    assert.ok(a.text.includes('RELEASE_NOT_FOUND'), a.text)
    const r = cli(dataDir, ['rollback', 'no-such', '--by', '张三'])
    assert.equal(r.code, 1)
    assert.ok(r.text.includes('RELEASE_NOT_FOUND'), r.text)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(srcRoot, { recursive: true, force: true })
  }
})

test('CLI: 未知命令与 help', () => {
  const { dataDir, srcRoot } = setupDataDir()
  try {
    const u = cli(dataDir, ['frobnicate'])
    assert.equal(u.code, 2)
    assert.ok(u.text.includes('用法错误'))
    const h = cli(dataDir, ['help'])
    assert.equal(h.code, 0)
    assert.ok(h.text.includes('publish'))
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(srcRoot, { recursive: true, force: true })
  }
})
