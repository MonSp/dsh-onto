/** 签发状态机与包存储验收（规范 §3.4 / §11.3）：ISSUED 只读、fork、人审签发。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PackageStoreError,
  PackageWorkspace,
  loadPackage,
  readSourceFile,
  savePackage,
  readPackageMeta,
  writeSourceFile,
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

test('versionDir 目录穿越：packages 内 junction 指向外部即 PACKAGE_MALFORMED', () => {
  const ws = mkWorkspace()
  const root = ws.root
  const outside = mkdtempSync(join(tmpdir(), 'dsh-onto-outside-'))
  try {
    // 直拼路径逃逸：junction 挂进 packages/，目标存在 → realpath 解出外部即拒绝
    mkdirSync(join(outside, 'evil', '1.0.0'), { recursive: true })
    symlinkSync(join(outside, 'evil'), join(ws.packagesDir, 'evil'), 'junction')
    throwsCode(() => ws.versionDir('evil', '1.0.0'), 'PACKAGE_MALFORMED')

    // 扫描回退逃逸：目录键 ≠ meta.name 时按 meta.name 命中 junction 拼出的 dir，同样拒绝
    const inner = join(outside, 'inner', '1.0.0')
    mkdirSync(inner, { recursive: true })
    const ghost = minimalPkg()
    ghost.meta.name = 'ghost-pkg'
    savePackage(inner, ghost)
    symlinkSync(join(outside, 'inner'), join(ws.packagesDir, 'dirkey'), 'junction')
    throwsCode(() => ws.versionDir('ghost-pkg', '1.0.0'), 'PACKAGE_MALFORMED')
  } finally {
    rmWorkspace(root)
    rmWorkspace(outside)
  }
})

test('versionDir 单段校验：空/多级下钻即 PACKAGE_MALFORMED（防越界不只防逃出）', () => {
  const ws = mkWorkspace()
  const root = ws.root
  try {
    throwsCode(() => ws.versionDir('', '1.0.0'), 'PACKAGE_MALFORMED')
    throwsCode(() => ws.versionDir('pkg', ''), 'PACKAGE_MALFORMED')
    throwsCode(() => ws.versionDir('foo/bar', '1.0.0'), 'PACKAGE_MALFORMED')
    throwsCode(() => ws.versionDir('pkg', '1.0/0'), 'PACKAGE_MALFORMED')
    throwsCode(() => ws.versionDir('.', '1.0.0'), 'PACKAGE_MALFORMED')
    // 合法单段（含尚不存在的版本、预发布/build 形态）仍可解析
    assert.ok(ws.versionDir('new-pkg', '2.0.0').endsWith(join('new-pkg', '2.0.0')))
    assert.ok(ws.versionDir('new-pkg', '2.0.0-rc.1').endsWith(join('new-pkg', '2.0.0-rc.1')))
    assert.ok(ws.versionDir('new-pkg', '2.0.0+build.1').endsWith(join('new-pkg', '2.0.0+build.1')))
  } finally {
    rmWorkspace(root)
  }
})

test('junction 数据根下 create/fork 不误拒（round-13：canonPath 两侧同策略）', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-onto-juncws-'))
  try {
    const real = join(base, 'real-ws')
    mkdirSync(join(real, 'packages'), { recursive: true })
    const link = join(base, 'junc-ws')
    symlinkSync(real, link, 'junction')
    // 数据根经 junction 访问：fresh 新版本路径（尚不存在）必须放行
    const ws = new PackageWorkspace(join(link, 'ws'))
    const dir = ws.createPackage({ name: 'pkg-j', version: '1.0.0', domain: 'TST' })
    assert.ok(existsSync(join(dir, 'package.yaml')), 'junction 根下 create 应成功')
    const forked = ws.forkVersion('pkg-j', '1.0.0', '2.0.0')
    assert.equal(readPackageMeta(forked).version, '2.0.0')
    // 逃逸仍拒：packages 内 junction 指向外部
    const outside = join(base, 'outside')
    mkdirSync(join(outside, 'evil', '1.0.0'), { recursive: true })
    symlinkSync(outside, join(ws.packagesDir, 'evil'), 'junction')
    throwsCode(() => ws.versionDir('evil', '1.0.0'), 'PACKAGE_MALFORMED')
  } finally {
    rmWorkspace(base)
  }
})

test('importVersion 归档 rel 逃逸拒绝（round-13：wire 导入面两遍式校验）', () => {
  const ws = mkWorkspace()
  try {
    const meta = { ...minimalPkg().meta }
    const dirOf = () => ws.versionDir(meta.name, meta.version)
    // 逃逸形态：上钻 / 混合分隔符 / 绝对盘符
    for (const evil of ['../evil.txt', 'a/../../evil.txt', '..\\evil.txt', 'C:\\evil.txt', '/abs/evil.txt', 'a:b.yaml', 'sub/x:ads.yaml', '']) {
      throwsCode(() => ws.importVersion({ meta, files: { [evil]: 'x' } }), 'PACKAGE_MALFORMED')
    }
    // 合法 + 非法混合：整体拒绝且不留半写状态（校验在建目录之前）
    throwsCode(
      () => ws.importVersion({ meta, files: { 'package.yaml': 'kind: BusinessOntologyPackage\n', 'x/../evil.yaml': 'y' } }),
      'PACKAGE_MALFORMED',
    )
    assert.ok(!existsSync(dirOf()), '校验期拒绝不得创建版本目录')
    assert.ok(!existsSync(join(ws.root, 'evil.txt')), '不得写出 packages 根之外')
    // 合法嵌套相对路径仍可导入
    const dir = ws.importVersion({
      meta,
      files: {
        'package.yaml': 'kind: BusinessOntologyPackage\n',
        'o1-objects/dictionaries/dict-x.yaml': 'id: dict-x\nname: X\nvalues: [a]\n',
      },
    })
    assert.ok(existsSync(join(dir, 'o1-objects', 'dictionaries', 'dict-x.yaml')))
  } finally {
    rmWorkspace(ws.root)
  }
})


test('读源围栏：readSourceFile 本体拒绝穿越/ADS/绝对路径/junction 读穿（读写成对）', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'onto-rsrc-'))
  const outside = mkdtempSync(join(tmpdir(), 'onto-rsrc-out-'))
  try {
    const dir = join(tmp, 'pkg', '1.0.0')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(outside, 'secret.yaml'), 'secret: true')
    const bad = (rel) => {
      try {
        readSourceFile(dir, rel)
        assert.fail(`期望拒绝: ${rel}`)
      } catch (e) {
        assert.ok(e instanceof PackageStoreError, `期望 PackageStoreError，得到 ${e}`)
        assert.equal(e.code, 'PACKAGE_MALFORMED')
      }
    }
    bad('../secret.yaml')
    bad('a:b.yaml')
    bad('sub/../../up.yaml')
    bad('C:\\abs.yaml')
    bad('')
    // junction 读穿：子目录指外不得读到外部内容
    symlinkSync(outside, join(dir, 'sub'), 'junction')
    bad('sub/secret.yaml')
    // 合法读回（与写源同口径）
    writeSourceFile(dir, 'o1-objects/x.yaml', 'ok: true')
    assert.ok(readSourceFile(dir, 'o1-objects/x.yaml').includes('ok'))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})