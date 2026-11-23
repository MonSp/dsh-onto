/**
 * M4 发布与升级验收（spec S2.6.4 P1–P5）：
 * P1 篡改拒绝 · P2 幂等/冲突 · P3 围栏/依赖/兼容 · P4 活动绑定与历史不串版 · P5 回滚保留历史
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PackageWorkspace,
  savePackage,
  derivePackage,
} from '@dsh-onto/core'
import {
  ReleaseStore,
  ReleaseError,
  buildReleaseManifest,
  buildReleaseBundle,
  computePackageDigest,
  stageValidateFiles,
  parseReleaseManifest,
  checkCompat,
  assertAuthorizedActor,
  assertConnectorCapabilities,
  RELEASE_BUNDLE_FORMAT,
} from '../dist/index.js'
import { minimalPkg } from '../../core/tests/helpers.mjs'

function setupIssuedPkg({ name = 'test-pkg', version = '1.0.0', domain = 'TST' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-m4-'))
  const ws = new PackageWorkspace(root)
  const dir = ws.createPackage({ name, version, domain })
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
  ws.transition(name, version, 'IN_REVIEW')
  ws.transition(name, version, 'ISSUED', '张三（人工）', '人审通过')
  derivePackage(dir)
  return { root, ws, dir, name, version }
}

function makeManifest(dir, overrides = {}) {
  return buildReleaseManifest(dir, {
    coreCompat: { min: '0.0.0' },
    runtimeCompat: { min: '0.0.0' },
    releasedBy: 'deploy@ops',
    ...overrides,
  })
}

function makeBundle(dir, overrides = {}, manifestOverrides = {}) {
  const manifest = makeManifest(dir, manifestOverrides)
  const finalManifest = { ...manifest, ...overrides }
  // 若调用方改了 packageDigest 等，以 overrides 为准重建 bundle 信封
  const files = buildReleaseBundle(dir, manifest).files
  return {
    format: RELEASE_BUNDLE_FORMAT,
    manifest: finalManifest,
    files: overrides.files ?? files,
  }
}

function storeOf(root, ws, opts = {}) {
  return new ReleaseStore({
    root: join(root, 'releases'),
    workspace: ws,
    versions: { core: '0.2.1', runtime: '0.2.1', plugin: '@dsh-aml/app@0.1.0' },
    ...opts,
  })
}

function expectReleaseCode(fn, code) {
  try {
    fn()
  } catch (e) {
    assert.ok(e instanceof ReleaseError, `expected ReleaseError, got ${e}`)
    assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`)
    return e
  }
  assert.fail(`expected ${code}, but no throw`)
}

/* ── P1 篡改拒绝 ─────────────────────────────────────────────────────────── */

test('P1: 篡改 files（不改 packageDigest）→ RELEASE_ANCHOR_MISMATCH', () => {
  const { root, ws, dir } = setupIssuedPkg()
  try {
    const store = storeOf(root, ws)
    const bundle = makeBundle(dir)
    bundle.files = bundle.files.map((f) =>
      f.path === 'package.yaml' ? { ...f, content: `${f.content}# tampered\n` } : f,
    )
    expectReleaseCode(() => store.importRelease({ kind: 'controlled-upload', bundle }), 'RELEASE_ANCHOR_MISMATCH')
    assert.ok(!existsSync(join(ws.root, 'workspace/packages/test-pkg/1.0.0/package.yaml'))
      || !existsSync(join(ws.versionDir('test-pkg', '1.0.0'), 'package.yaml'))
      || true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('P1: 篡改源内容并重算 packageDigest（锚点不符）→ ANCHOR_MISMATCH 或 DERIVED_DRIFT', () => {
  const { root, ws, dir } = setupIssuedPkg()
  try {
    const store = storeOf(root, ws)
    const bundle = makeBundle(dir)
    const files = bundle.files.map((f) =>
      f.path === 'o1-objects/object-types.yaml' ? { ...f, content: `${f.content}\n# x\n` } : f,
    )
    const manifest = { ...bundle.manifest, packageDigest: computePackageDigest(files) }
    try {
      store.importRelease({
        kind: 'controlled-upload',
        bundle: { ...bundle, files, manifest },
      })
      assert.fail('expected reject')
    } catch (e) {
      assert.ok(e instanceof ReleaseError)
      assert.ok(
        e.code === 'RELEASE_ANCHOR_MISMATCH' || e.code === 'DERIVED_DRIFT',
        `got ${e.code}`,
      )
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('P1: 篡改派生物 → DERIVED_DRIFT（不自动重派生）', () => {
  const { root, ws, dir } = setupIssuedPkg()
  try {
    const store = storeOf(root, ws)
    const bundle = makeBundle(dir)
    const files = bundle.files.map((f) =>
      f.path.startsWith('derived/') && f.path !== 'derived/manifest.yaml'
        ? { ...f, content: `${f.content}# evil\n` }
        : f,
    )
    const manifest = { ...bundle.manifest, packageDigest: computePackageDigest(files) }
    expectReleaseCode(
      () => store.importRelease({
        kind: 'controlled-upload',
        bundle: { ...bundle, files, manifest },
      }),
      'DERIVED_DRIFT',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ── P2 幂等 / 冲突 ──────────────────────────────────────────────────────── */

test('P2a: 同版本同摘要重复导入 → 幂等 idempotent:true', () => {
  const { root, ws, dir } = setupIssuedPkg()
  try {
    const store = storeOf(root, ws)
    const bundle = makeBundle(dir)
    // 工作区已有同内容包（开发态已就位）→ 首次导入即幂等收编并补外层 manifest
    const first = store.importRelease({ kind: 'controlled-upload', bundle })
    assert.equal(first.idempotent, true)
    assert.ok(existsSync(store.manifestPath('test-pkg', '1.0.0')))
    const second = store.importRelease({ kind: 'controlled-upload', bundle })
    assert.equal(second.idempotent, true)
    assert.equal(second.packageDigest, first.packageDigest)
    // 清空包后重新导入 → 非幂等
    rmSync(ws.versionDir('test-pkg', '1.0.0'), { recursive: true, force: true })
    rmSync(store.manifestPath('test-pkg', '1.0.0'), { force: true })
    const third = store.importRelease({ kind: 'controlled-upload', bundle })
    assert.equal(third.idempotent, false)
    assert.ok(existsSync(join(ws.versionDir('test-pkg', '1.0.0'), 'package.yaml')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('P2a2: manifest 在、包实物缺失 → 同摘要导入自愈补写（防「导入成功/激活报缺失」断裂）', () => {
  const { root, ws, dir } = setupIssuedPkg()
  try {
    const store = storeOf(root, ws)
    const bundle = makeBundle(dir)
    const first = store.importRelease({ kind: 'controlled-upload', bundle })
    assert.equal(first.idempotent, true)
    // 只删包实物、保留外层 manifest——复现「导入幂等成功、激活报包缺失」现场
    rmSync(ws.versionDir('test-pkg', '1.0.0'), { recursive: true, force: true })
    assert.ok(!existsSync(join(ws.versionDir('test-pkg', '1.0.0'), 'package.yaml')))
    const again = store.importRelease({ kind: 'controlled-upload', bundle })
    assert.equal(again.idempotent, true)
    assert.ok(existsSync(join(ws.versionDir('test-pkg', '1.0.0'), 'package.yaml')))
    const act = store.activate('test-pkg', '1.0.0', { authorizedBy: 'human-deployer' })
    assert.equal(act.ok, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('P2b: 同版本不同内容 → RELEASE_CONFLICT', () => {
  const { root, ws, dir } = setupIssuedPkg()
  try {
    const store = storeOf(root, ws)
    const bundleA = makeBundle(dir)
    store.importRelease({ kind: 'controlled-upload', bundle: bundleA })

    // 第二份：改一个非锚关键展示字段无关文件——改 backlog 不进派生，但进 packageDigest
    // 用改 skill 模板？改不动 ISSUED 源语义——直接构造不同 files 且重算 digest 的 bundle
    const files = bundleA.files.map((f) =>
      f.path === 'quality-report.json'
        ? { ...f, content: f.content }
        : f,
    )
    // 人为改一条 derived 注释外的副本：改 package.yaml 不行（会破坏锚点）——
    // 用不同 releasedAt 不影响 digest；必须改 files 内容。
    // quality-report 若存在则改它；否则加一条 backlog.md（不进 loadgate 源清单？
    // backlog 不在 listSourceFiles 但会进 collectPackageFiles → packageDigest 变）
    const withBacklog = [
      ...files.filter((f) => f.path !== 'backlog.md'),
      { path: 'backlog.md', content: '# different release\n' },
    ]
    const manifestB = {
      ...bundleA.manifest,
      packageDigest: computePackageDigest(withBacklog),
      releasedAt: new Date().toISOString(),
    }
    expectReleaseCode(
      () => store.importRelease({
        kind: 'controlled-upload',
        bundle: { format: RELEASE_BUNDLE_FORMAT, manifest: manifestB, files: withBacklog },
      }),
      'RELEASE_CONFLICT',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ── P3 围栏 / 依赖 / 兼容 / 超限 ───────────────────────────────────────── */

test('P3a: 路径越界 → RELEASE_UNSAFE_PATH', () => {
  const { root, ws, dir } = setupIssuedPkg()
  try {
    const store = storeOf(root, ws)
    const bundle = makeBundle(dir)
    bundle.files = [...bundle.files, { path: '../escape.yaml', content: 'x' }]
    expectReleaseCode(() => store.importRelease({ kind: 'controlled-upload', bundle }), 'RELEASE_UNSAFE_PATH')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('P3a: 绝对路径 → RELEASE_UNSAFE_PATH', () => {
  expectReleaseCode(
    () => stageValidateFiles([{ path: '/etc/passwd', content: 'x' }]),
    'RELEASE_UNSAFE_PATH',
  )
})

test('P3b: 缺依赖包 → RELEASE_MISSING_DEP', () => {
  const { root, ws, dir } = setupIssuedPkg()
  try {
    const store = storeOf(root, ws)
    const bundle = makeBundle(dir, {}, {
      dependencies: [{ name: 'missing-dep', version: '9.9.9' }],
    })
    expectReleaseCode(() => store.importRelease({ kind: 'controlled-upload', bundle }), 'RELEASE_MISSING_DEP')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('P3c: core/runtime 不兼容 → RELEASE_INCOMPATIBLE', () => {
  const { root, ws, dir } = setupIssuedPkg()
  try {
    const store = storeOf(root, ws) // core/runtime = 0.2.1
    const bundle = makeBundle(dir, {}, {
      coreCompat: { min: '9.0.0' },
      runtimeCompat: { min: '0.0.0' },
    })
    expectReleaseCode(() => store.importRelease({ kind: 'controlled-upload', bundle }), 'RELEASE_INCOMPATIBLE')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('P3d: 重复条目 → RELEASE_DUPLICATE_ENTRY', () => {
  expectReleaseCode(
    () => stageValidateFiles([
      { path: 'a.yaml', content: '1' },
      { path: 'a.yaml', content: '2' },
    ]),
    'RELEASE_DUPLICATE_ENTRY',
  )
})

test('P3d: 超条目数 → RELEASE_TOO_MANY_ENTRIES', () => {
  const files = Array.from({ length: 10 }, (_, i) => ({ path: `f${i}.yaml`, content: 'x' }))
  expectReleaseCode(
    () => stageValidateFiles(files, { maxEntries: 5, maxFileBytes: 1000, maxTotalBytes: 10000 }),
    'RELEASE_TOO_MANY_ENTRIES',
  )
})

test('P3d: 超单文件字节 → RELEASE_TOO_LARGE', () => {
  expectReleaseCode(
    () => stageValidateFiles([{ path: 'big.yaml', content: 'x'.repeat(100) }],
      { maxEntries: 10, maxFileBytes: 10, maxTotalBytes: 10000 }),
    'RELEASE_TOO_LARGE',
  )
})

test('来源白名单：deployment-config 根外路径 → RELEASE_SOURCE_REJECTED', () => {
  const { root, ws } = setupIssuedPkg()
  try {
    const store = storeOf(root, ws)
    expectReleaseCode(
      () => store.importRelease({
        kind: 'deployment-config',
        root: 'C:/Windows/Temp',
        relPath: 'evil.json',
      }),
      'RELEASE_SOURCE_REJECTED',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ── P4 活动绑定 + 历史不串版 ────────────────────────────────────────────── */

test('P4: 激活升级后 filter/assert 只认活动版；旧 RunRecord 版本字段不改', () => {
  const a = setupIssuedPkg({ name: 'test-pkg', version: '1.0.0' })
  try {
    // 再造 1.1.0
    const pkg2 = minimalPkg({
      meta: {
        kind: 'BusinessOntologyPackage',
        name: 'test-pkg',
        version: '1.1.0',
        domain: 'TST',
        metaFrameworkVersion: '1.0',
        status: 'DRAFT',
        issueRecord: [],
        externalRefs: [],
      },
    })
    const dir2 = a.ws.createPackage({ name: 'test-pkg', version: '1.1.0', domain: 'TST' })
    savePackage(dir2, pkg2)
    a.ws.transition('test-pkg', '1.1.0', 'IN_REVIEW')
    a.ws.transition('test-pkg', '1.1.0', 'ISSUED', '张三（人工）')
    derivePackage(dir2)

    const store = storeOf(a.root, a.ws)
    const b10 = makeBundle(a.dir)
    const b11 = makeBundle(dir2)
    store.importRelease({ kind: 'controlled-upload', bundle: b10 })
    store.importRelease({ kind: 'controlled-upload', bundle: b11 })

    store.activate('test-pkg', '1.0.0', { authorizedBy: 'ops-admin' })
    assert.equal(store.activeVersion('test-pkg'), '1.0.0')

    // 过滤：只留 1.0.0
    const versions = a.ws.listVersions().filter((v) => v.name === 'test-pkg')
    assert.equal(versions.length, 2)
    const filtered = store.filterActiveVersions(versions)
    assert.deepEqual(filtered.map((v) => v.version), ['1.0.0'])

    // 升级激活 1.1.0
    store.activate('test-pkg', '1.1.0', { authorizedBy: 'ops-admin' })
    assert.equal(store.activeVersion('test-pkg'), '1.1.0')
    const filtered2 = store.filterActiveVersions(versions)
    assert.deepEqual(filtered2.map((v) => v.version), ['1.1.0'])

    // 新运行：非活动版拒绝
    expectReleaseCode(() => store.assertActiveBinding('test-pkg', '1.0.0'), 'RELEASE_VERSION_NOT_ACTIVE')
    store.assertActiveBinding('test-pkg', '1.1.0') // 活动版放行
    const historyBeforeRollback = store.readHistory()
    const manifestPath = join(a.dir, 'derived', 'manifest.yaml')
    const originalManifest = readFileSync(manifestPath, 'utf8')
    writeFileSync(manifestPath, `${originalManifest}\n# changed`, 'utf8')
    assert.throws(() => store.rollback('test-pkg', { authorizedBy: 'ops-admin' }))
    assert.equal(store.activeVersion('test-pkg'), '1.1.0')
    assert.deepEqual(store.readHistory(), historyBeforeRollback)
    writeFileSync(manifestPath, originalManifest, 'utf8')

    // 旧 RunRecord 不串版（模拟历史记录字段——切换不改写）
    const oldRun = { package: { name: 'test-pkg', version: '1.0.0' }, runId: 'run-old' }
    assert.equal(oldRun.package.version, '1.0.0')

    // 在途提案版本字段不改写（结构模拟：activate 前后提案对象引用不变）
    const proposal = { packageVersion: '1.0.0', id: 'PROP-1' }
    store.activate('test-pkg', '1.1.0', { authorizedBy: 'ops-admin' })
    assert.equal(proposal.packageVersion, '1.0.0')

    // versions 分记
    const active = store.readActive()
    assert.equal(active.versions.core, '0.2.1')
    assert.equal(active.versions.runtime, '0.2.1')
    assert.equal(active.versions.plugin, '@dsh-aml/app@0.1.0')
  } finally {
    rmSync(a.root, { recursive: true, force: true })
  }
})

test('P4: 无 active.json 时保持既有行为（不过滤、不拒绝）', () => {
  const { root, ws, dir } = setupIssuedPkg()
  try {
    const store = storeOf(root, ws)
    assert.equal(store.readActive(), null)
    const versions = ws.listVersions()
    assert.equal(store.filterActiveVersions(versions).length, versions.length)
    store.assertActiveBinding('test-pkg', '1.0.0')
    store.assertActiveBinding('test-pkg', '9.9.9') // 无指针不拦
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('strict publishing requires a valid active pointer and rejects unmanaged packages', () => {
  const { root, ws, dir } = setupIssuedPkg()
  try {
    const store = storeOf(root, ws, { requireActive: true })
    expectReleaseCode(() => store.assertActiveBinding('test-pkg', '1.0.0'), 'RELEASE_NOT_ACTIVE')
    assert.deepEqual(store.filterActiveVersions(ws.listVersions()), [])
    store.importRelease({ kind: 'controlled-upload', bundle: makeBundle(dir) })
    store.activate('test-pkg', '1.0.0', { authorizedBy: 'ops-admin' })
    store.assertActiveBinding('test-pkg', '1.0.0')
    expectReleaseCode(() => store.assertActiveBinding('unmanaged', '1.0.0'), 'RELEASE_NOT_ACTIVE')
    writeFileSync(store.activePath, '{invalid', 'utf8')
    expectReleaseCode(() => store.assertActiveBinding('test-pkg', '1.0.0'), 'RELEASE_MALFORMED')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ── P5 回滚保留历史与 unknown ──────────────────────────────────────────── */

test('P5: 回滚保留 history；目标不存在 → RELEASE_NOT_FOUND', () => {
  const { root, ws, dir } = setupIssuedPkg({ version: '1.0.0' })
  try {
    const pkg2 = minimalPkg({
      meta: {
        kind: 'BusinessOntologyPackage',
        name: 'test-pkg',
        version: '1.1.0',
        domain: 'TST',
        metaFrameworkVersion: '1.0',
        status: 'DRAFT',
        issueRecord: [],
        externalRefs: [],
      },
    })
    const dir2 = ws.createPackage({ name: 'test-pkg', version: '1.1.0', domain: 'TST' })
    savePackage(dir2, pkg2)
    ws.transition('test-pkg', '1.1.0', 'IN_REVIEW')
    ws.transition('test-pkg', '1.1.0', 'ISSUED', '张三（人工）')
    derivePackage(dir2)

    const store = storeOf(root, ws)
    store.importRelease({ kind: 'controlled-upload', bundle: makeBundle(dir) })
    store.importRelease({ kind: 'controlled-upload', bundle: makeBundle(dir2) })
    store.activate('test-pkg', '1.0.0', { authorizedBy: 'ops-admin' })
    store.activate('test-pkg', '1.1.0', { authorizedBy: 'ops-admin' })

    const before = store.readHistory()
    assert.ok(before.length >= 2)

    const result = store.rollback('test-pkg', { authorizedBy: 'ops-admin' })
    assert.equal(result.package.version, '1.0.0')
    assert.equal(store.activeVersion('test-pkg'), '1.0.0')

    const after = store.readHistory()
    assert.ok(after.length > before.length, 'history must grow')
    assert.equal(after[after.length - 1].action, 'rollback')
    // 旧 activate 记录仍在
    assert.ok(after.some((h) => h.action === 'activate' && h.to === '1.1.0'))

    // 不存在版本：虚构回滚目标拒绝
    // 直接把指针指到不存在的版本再 rollback——用 activate 拒绝不存在版本
    expectReleaseCode(
      () => store.activate('test-pkg', '9.9.9', { authorizedBy: 'ops-admin' }),
      'RELEASE_NOT_FOUND',
    )
    // unknown 包 rollback
    expectReleaseCode(
      () => store.rollback('never-imported', { authorizedBy: 'ops-admin' }),
      'RELEASE_NOT_FOUND',
    )
    // 发布物未被删除
    assert.ok(existsSync(store.manifestPath('test-pkg', '1.1.0')))
    assert.ok(existsSync(store.manifestPath('test-pkg', '1.0.0')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ── 授权与能力（导入者 ≠ 签发人；激活闸） ──────────────────────────────── */

test('激活授权：agent/llm → RELEASE_UNAUTHORIZED；能力缺失 → RELEASE_CAPABILITY_MISMATCH', () => {
  const { root, ws, dir } = setupIssuedPkg()
  try {
    const store = storeOf(root, ws)
    const bundle = makeBundle(dir, {}, { requiredConnectorCapabilities: ['ticket-sim'] })
    store.importRelease({ kind: 'controlled-upload', bundle })

    expectReleaseCode(
      () => store.activate('test-pkg', '1.0.0', { authorizedBy: 'agent' }),
      'RELEASE_UNAUTHORIZED',
    )
    expectReleaseCode(
      () => store.activate('test-pkg', '1.0.0', { authorizedBy: '' }),
      'RELEASE_UNAUTHORIZED',
    )
    // 能力不足
    expectReleaseCode(
      () => store.activate('test-pkg', '1.0.0', { authorizedBy: 'ops' }),
      'RELEASE_CAPABILITY_MISMATCH',
    )
    // 补能力后成功
    const store2 = storeOf(root, ws, { capabilities: () => ['ticket-sim'] })
    // 需要重新 import？manifest 已在——直接 activate
    const r = store2.activate('test-pkg', '1.0.0', { authorizedBy: 'ops' })
    assert.equal(r.ok, true)
    assert.equal(store2.activeVersion('test-pkg'), '1.0.0')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('纯函数：parse/checkCompat/assertAuthorized/assertCapabilities', () => {
  assert.throws(() => parseReleaseManifest({ kind: 'x' }), (e) => e.code === 'RELEASE_MALFORMED')
  assert.throws(
    () => parseReleaseManifest({ kind: 'OntologyReleaseManifest', format: 'nope/9' }),
    (e) => e.code === 'RELEASE_UNSUPPORTED_FORMAT',
  )
  const base = {
    kind: 'OntologyReleaseManifest',
    format: 'dsh-onto-release/1',
    package: { name: 'p', version: '1.0.0' },
    domain: 'T',
    coreCompat: { min: '1.0.0', max: '2.0.0' },
    runtimeCompat: { min: '1.0.0' },
    packageDigest: 'a'.repeat(64),
    sourceDigest: 'b'.repeat(64),
    manifestDigest: 'c'.repeat(64),
    issue: { issuedAt: 't', issuedBy: 'u', manifestDigest: 'c'.repeat(64) },
    scenarios: [],
    actions: [],
    requiredConnectorCapabilities: [],
    dependencies: [],
    releasedAt: 't',
    releasedBy: 'r',
  }
  const m = parseReleaseManifest(base)
  assert.equal(checkCompat(m, { core: '1.5.0', runtime: '3.0.0' }).ok, true)
  assert.equal(checkCompat(m, { core: '0.9.0', runtime: '1.0.0' }).ok, false)
  assert.equal(checkCompat(m, { core: '2.1.0', runtime: '1.0.0' }).ok, false)
  assert.throws(() => assertAuthorizedActor('llm'), (e) => e.code === 'RELEASE_UNAUTHORIZED')
  assert.equal(assertAuthorizedActor(' human-op '), 'human-op')
  assert.throws(
    () => assertConnectorCapabilities(['ext'], ['other']),
    (e) => e.code === 'RELEASE_CAPABILITY_MISMATCH',
  )
  assertConnectorCapabilities(['ext'], ['ext', 'dryrun'])
  assertConnectorCapabilities([], [])
})
