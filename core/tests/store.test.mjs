/** 签发状态机与包存储验收（规范 §3.4 / §11.3）：ISSUED 只读、fork、人审签发。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  PackageStoreError,
  loadPackage,
  savePackage,
  readPackageMeta,
} from '../dist/index.js'
import { minimalPkg, mkWorkspaceWithPkg, mkWorkspace, rmWorkspace } from './helpers.mjs'

function throwsCode(fn, code) {
  try {
    fn()
  } catch (e) {
    assert.ok(e instanceof PackageStoreError, String(e))
    assert.equal(e.code, code, `expect ${code}, got ${e.code}: ${e.message}`)
    return
  }
  assert.fail(`expected ${code} to be thrown`)
}

test('状态机：DRAFT → IN_REVIEW → ISSUED', () => {
  const { ws, dir, root } = mkWorkspaceWithPkg()
  try {
    assert.equal(readPackageMeta(dir).status, 'DRAFT')
    ws.transition('test-pkg', '1.0.0', 'IN_REVIEW')
    assert.equal(readPackageMeta(dir).status, 'IN_REVIEW')
    ws.transition('test-pkg', '1.0.0', 'ISSUED', '张三', '人审通过')
    const meta = readPackageMeta(dir)
    assert.equal(meta.status, 'ISSUED')
    assert.equal(meta.issueRecord.length, 1)
    assert.equal(meta.issueRecord[0].issuedBy, '张三')
    assert.equal(meta.issueRecord[0].version, '1.0.0')
  } finally {
    rmWorkspace(root)
  }
})

test('禁止跳过状态：DRAFT → ISSUED 直接签发被拒', () => {
  const { ws, root } = mkWorkspaceWithPkg()
  try {
    throwsCode(() => ws.transition('test-pkg', '1.0.0', 'ISSUED', '张三'), 'PACKAGE_BAD_TRANSITION')
  } finally {
    rmWorkspace(root)
  }
})

test('签发必须人工身份：agent/llm 不能签发', () => {
  const { ws, root } = mkWorkspaceWithPkg()
  try {
    ws.transition('test-pkg', '1.0.0', 'IN_REVIEW')
    throwsCode(() => ws.transition('test-pkg', '1.0.0', 'ISSUED', 'agent'), 'PACKAGE_ISSUE_REQUIRES_HUMAN')
    throwsCode(() => ws.transition('test-pkg', '1.0.0', 'ISSUED', 'LLM'), 'PACKAGE_ISSUE_REQUIRES_HUMAN')
    throwsCode(() => ws.transition('test-pkg', '1.0.0', 'ISSUED', ''), 'PACKAGE_ISSUE_REQUIRES_HUMAN')
  } finally {
    rmWorkspace(root)
  }
})

test('ISSUED 后只读：savePackage 拒绝', () => {
  const { ws, dir, root } = mkWorkspaceWithPkg()
  try {
    ws.transition('test-pkg', '1.0.0', 'IN_REVIEW')
    ws.transition('test-pkg', '1.0.0', 'ISSUED', '张三')
    const pkg = loadPackage(dir)
    pkg.objects.push({ id: 'OBJ-TST-NEW', name: '新', attributes: [] })
    throwsCode(() => savePackage(dir, pkg), 'PACKAGE_READONLY')
  } finally {
    rmWorkspace(root)
  }
})

test('ISSUED 后须 fork 出新版本才能改', () => {
  const { ws, dir, root } = mkWorkspaceWithPkg()
  try {
    ws.transition('test-pkg', '1.0.0', 'IN_REVIEW')
    ws.transition('test-pkg', '1.0.0', 'ISSUED', '张三')
    const forkDir = ws.forkVersion('test-pkg', '1.0.0', '1.1.0')
    const meta = readPackageMeta(forkDir)
    assert.equal(meta.status, 'DRAFT')
    assert.equal(meta.version, '1.1.0')
    // 新版本可写
    const pkg = loadPackage(forkDir)
    pkg.objects.push({ id: 'OBJ-TST-NEW', name: '新', attributes: [] })
    savePackage(forkDir, pkg)
    assert.equal(loadPackage(forkDir).objects.length, 3)
    // 旧版本仍只读
    throwsCode(() => savePackage(dir, loadPackage(dir)), 'PACKAGE_READONLY')
  } finally {
    rmWorkspace(root)
  }
})

test('fork 保留签发记录沿革', () => {
  const { ws, root } = mkWorkspaceWithPkg()
  try {
    ws.transition('test-pkg', '1.0.0', 'IN_REVIEW')
    ws.transition('test-pkg', '1.0.0', 'ISSUED', '张三', '首签')
    const forkDir = ws.forkVersion('test-pkg', '1.0.0', '1.1.0')
    assert.equal(readPackageMeta(forkDir).issueRecord.length, 1)
  } finally {
    rmWorkspace(root)
  }
})

test('导出/导入归档往返', () => {
  const { ws, root } = mkWorkspaceWithPkg()
  const second = mkWorkspace()
  try {
    const archive = ws.exportVersion('test-pkg', '1.0.0')
    assert.equal(archive.format, 'dsh-onto-package/1')
    assert.ok(archive.files['package.yaml'])
    const dir2 = second.importVersion(archive)
    assert.ok(dir2.includes('test-pkg'))
    const pkg = loadPackage(dir2)
    assert.equal(pkg.objects.length, 2)
    // 同名同版本重复导入拒绝（幂等）
    throwsCode(() => second.importVersion(archive), 'PACKAGE_EXISTS')
  } finally {
    rmWorkspace(root)
    rmWorkspace(second.root)
  }
})

test('版本不存在时报 PACKAGE_NOT_FOUND', () => {
  const { ws, root } = mkWorkspaceWithPkg()
  try {
    throwsCode(() => ws.exportVersion('test-pkg', '9.9.9'), 'PACKAGE_NOT_FOUND')
  } finally {
    rmWorkspace(root)
  }
})

test('versionDir 目录穿越：name/version 逃出 packagesDir 即 PACKAGE_MALFORMED', () => {
  const ws = mkWorkspace()
  const root = ws.root
  try {
    throwsCode(() => ws.versionDir('..', '..'), 'PACKAGE_MALFORMED')
    throwsCode(() => ws.versionDir('../..', '1.0.0'), 'PACKAGE_MALFORMED')
    throwsCode(() => ws.versionDir('pkg', '../..'), 'PACKAGE_MALFORMED')
    throwsCode(() => ws.versionDir('pkg', '..'), 'PACKAGE_MALFORMED')
    // 拒绝原因不回显服务端绝对路径
    try {
      ws.versionDir('..', '..')
      assert.fail('expected PACKAGE_MALFORMED')
    } catch (e) {
      assert.ok(e instanceof PackageStoreError)
      assert.equal(e.code, 'PACKAGE_MALFORMED')
      assert.ok(!e.message.includes(root), `不应泄露工作区路径: ${e.message}`)
    }
    // 合法但尚不存在的版本仍返回包内直拼路径（create/fork 依赖此行为）
    const p = ws.versionDir('new-pkg', '2.0.0')
    assert.ok(p.endsWith(join('new-pkg', '2.0.0')), p)
    assert.ok(p.startsWith(root), p)
  } finally {
    rmWorkspace(root)
  }
})
