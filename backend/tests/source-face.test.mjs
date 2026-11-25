/**
 * 接入面 wire 组装验收（api-to-plugin T7）：路径围栏（attack-surface 同风格）、
 * 取数/报告同口径、generate/replay 请求组装、生成物不含 backend/workbench。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, readdirSync, lstatSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentToolError } from '../dist/agent-policy.js'
import {
  generateRequestToInput,
  previewRowsFor,
  probeRowsReport,
  replayRequestToInput,
  requireInsideFence,
  resolveCollectionsOf,
  resolveShapeOf,
  sampleRowsFor,
} from '../dist/source-face.js'
import { PackageWorkspace, derivePackage, generatePlugin, loadPackage, runReplay } from '@dsh-onto/core'

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const WST_SRC = join(REPO, 'packages', 'wst', '1.0.0')
const WST_SNAPSHOT = join(REPO, 'mock-services', 'wst-api', 'data', 'snapshot.json')
const SCN = 'SCN-WST-HAZARD-MIX'

test('脚手架部署：保留原签发、重复导入幂等、显式激活、冲突不改写目标', () => {
  const root = mkFence()
  try {
    const outDir = join(root, 'app')
    const { config } = generatePlugin({ versionDir: WST_SRC, scenarioId: SCN, sourceId: 'SRC-WST-CORE', outDir })
    symlinkSync(join(REPO, 'backend', 'node_modules'), join(outDir, 'node_modules'), 'junction')
    const profile = join(root, 'profile')
    const seed = (dir, ...args) => spawnSync(process.execPath, [join(outDir, 'scripts', 'seed-release.mjs'), ...args], {
      encoding: 'utf8', env: { ...process.env, [config.env.profileDir]: dir },
    })
    const pkgFile = (dir) => join(dir, 'dsh-onto', 'workspace', 'packages', 'wst-ops', '1.0.0', 'package.yaml')
    const active = join(profile, 'dsh-onto', 'releases', 'active.json')
    const original = readFileSync(join(WST_SRC, 'package.yaml'))
    const first = seed(profile)
    assert.equal(first.status, 0, first.stderr)
    assert.deepEqual(readFileSync(pkgFile(profile)), original)
    const again = seed(profile, 'import')
    assert.equal(again.status, 0, again.stderr)
    assert.match(again.stdout, /idempotent=true/)
    assert.notEqual(seed(profile, 'activate').status, 0)
    assert.notEqual(seed(profile, 'activate', 'agent').status, 0)
    assert.equal(existsSync(active), false)
    const activation = seed(profile, 'activate', '测试部署人')
    assert.equal(activation.status, 0, activation.stderr)
    assert.equal(JSON.parse(readFileSync(active, 'utf8')).packages['wst-ops'], '1.0.0')

    const conflict = join(root, 'conflict')
    const target = pkgFile(conflict)
    mkdirSync(join(target, '..'), { recursive: true })
    cpSync(WST_SRC, join(target, '..'), { recursive: true })
    const existing = Buffer.concat([original, Buffer.from('\n# existing version\n')])
    writeFileSync(target, existing)
    const rejected = seed(conflict)
    assert.notEqual(rejected.status, 0)
    assert.match(rejected.stderr, /RELEASE_CONFLICT|already exists with different content/)
    assert.deepEqual(readFileSync(target), existing)
    assert.deepEqual(readFileSync(join(WST_SRC, 'package.yaml')), original)
  } finally {
    rmFence(root)
  }
})

function expectInvalid(fn, label) {
  try {
    fn()
  } catch (e) {
    assert.ok(e instanceof AgentToolError, `${label}: 期望 AgentToolError，得到 ${e}`)
    assert.equal(e.code, 'INVALID_ARGS', `${label}: 错误码`)
    return
  }
  assert.fail(`${label}: 期望抛出 INVALID_ARGS`)
}

function mkFence() {
  return mkdtempSync(join(tmpdir(), 'dsh-onto-src-face-'))
}

function shapeYaml() {
  return `kind: O1ApiSources
sources:
  - id: SRC-WST-CORE
    name: wst
    sourceType: SCHEMA_API
    endpoint: "api://wst-snapshot"
    shape:
      mode: snapshot
      path: /api/v1/bin-snapshot
      collectionPaths:
        bins: bins
        alerts: alerts
      pagination:
        mode: none
`
}

function mapsYaml() {
  return `kind: O1SourceMaps
maps:
  - id: SM-WST-BIN
    collection: bins
    objectType: OBJ-WST-BIN
    idTemplate: <binId>
  - id: SM-WST-ALERT
    kind: candidate
    collection: alerts
    idField: alertId
    objectRefField: binId
    objectType: OBJ-WST-BIN
    features:
      fillRatio: features.fillRatio
    tagsField: tags
`
}

/** wst 形态包（快照 shape + source-maps），放围栏内临时工作区。 */
function setupWst(issued) {
  const fence = mkFence()
  const ws = new PackageWorkspace(join(fence, 'workspace'))
  const dir = ws.versionDir('wst-ops', '1.0.0')
  cpSync(WST_SRC, dir, { recursive: true })
  writeFileSync(join(dir, 'bindings', 'api-sources.yaml'), shapeYaml(), 'utf8')
  writeFileSync(join(dir, 'bindings', 'source-maps.yaml'), mapsYaml(), 'utf8')
  mkdirSync(join(dir, 'fixtures'), { recursive: true })
  cpSync(WST_SNAPSHOT, join(dir, 'fixtures', `replay-${SCN}.json`))
  if (issued === true) {
    // 测试夹具直接置签发态（状态机的人审语义在 transition 端点断言，此处模拟人工步骤完成）
    const metaPath = join(dir, 'package.yaml')
    let text = readFileSync(metaPath, 'utf8')
    text = text.replace(/^status:.*$/m, 'status: ISSUED')
    if (/^issueRecord:\s*\[\s*\]/m.test(text)) {
      text = text.replace(
        /^issueRecord:\s*\[\s*\]/m,
        "issueRecord:\n  - version: 1.0.0\n    issuedAt: '2026-11-22T00:00:00Z'\n    issuedBy: 测试主持人（人工）",
      )
    }
    writeFileSync(metaPath, text, 'utf8')
  }
  derivePackage(dir)
  return { fence, ws, dir }
}

/**
 * 摘链后删树：Windows 上 rmSync(recursive) 顺着 junction 递归删目标内容——
 * 本文件的部署夹具把真身 backend/node_modules junction 进围栏（seed 脚本要解析模块），
 * 不摘链会穿透 @deepseek-ai/* 误删 deepseek-harness（铁律：harness 只读）。
 */
function stripLinks(dir) {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = lstatSync(p)
    if (st.isSymbolicLink()) unlinkSync(p)
    else if (st.isDirectory()) stripLinks(p)
  }
}

function rmFence(fence) {
  stripLinks(fence)
  rmSync(fence, { recursive: true, force: true })
}

/* ─── 路径围栏（attack-surface 风格：逃逸族整族拦截） ─── */

test('围栏：根内绝对/相对路径解析通过；根自身拒绝', () => {
  const fence = mkFence()
  try {
    const inner = join(fence, 'workspace', 'packages', 'wst-ops', '1.0.0')
    assert.equal(requireInsideFence(fence, 'dir', inner), inner)
    assert.equal(requireInsideFence(fence, 'dir', join('workspace', 'x')), join(fence, 'workspace', 'x'))
    expectInvalid(() => requireInsideFence(fence, 'outDir', fence), '根自身')
    expectInvalid(() => requireInsideFence(fence, 'outDir', '.'), '点段')
    expectInvalid(() => requireInsideFence(fence, 'outDir', ''), '空串')
    expectInvalid(() => requireInsideFence(fence, 'outDir', undefined), '缺省')
    expectInvalid(() => requireInsideFence(fence, 'outDir', 123), '非字符串')
  } finally {
    rmFence(fence)
  }
})

test('围栏：../ 逃逸、盘符外绝对路径、ADS 冒号段、反斜杠穿越一律拒绝', () => {
  const fence = mkFence()
  try {
    expectInvalid(() => requireInsideFence(fence, 'outDir', '../evil'), '上级逃逸')
    expectInvalid(() => requireInsideFence(fence, 'outDir', join('..', '..', 'evil')), '多级逃逸')
    expectInvalid(() => requireInsideFence(fence, 'outDir', 'a/../..\\evil'), '反斜杠穿越')
    expectInvalid(() => requireInsideFence(fence, 'outDir', join(tmpdir(), 'outside-fence')), '围栏外绝对路径')
    expectInvalid(() => requireInsideFence(fence, 'fixturePath', 'fixtures/a:b.json'), 'ADS 冒号段')
    expectInvalid(() => requireInsideFence(fence, 'againstDir', 'a:b'), 'ADS 冒号单段')
    expectInvalid(() => requireInsideFence(fence, 'outDir', join(fence, 'x', '..', '..', 'evil')), '归一后越界')
  } finally {
    rmFence(fence)
  }
})

test('generate 请求组装：dir/outDir 双围栏，scenarioId/sourceId 必填', () => {
  const fence = mkFence()
  try {
    const input = generateRequestToInput(fence, {
      dir: 'workspace/p',
      scenarioId: 'SCN-X',
      sourceId: 'SRC-X',
      outDir: 'gen/app',
      force: true,
    })
    assert.equal(input.versionDir, join(fence, 'workspace', 'p'))
    assert.equal(input.outDir, join(fence, 'gen', 'app'))
    assert.equal(input.scenarioId, 'SCN-X')
    assert.equal(input.sourceId, 'SRC-X')
    assert.equal(input.force, true)
    assert.equal(generateRequestToInput(fence, {
      dir: 'p', scenarioId: 'S', sourceId: 'R', outDir: 'o',
    }).force, false, 'force 缺省 false')
    expectInvalid(() => generateRequestToInput(fence, {
      dir: '../p', scenarioId: 'S', sourceId: 'R', outDir: 'o',
    }), 'dir 逃逸')
    expectInvalid(() => generateRequestToInput(fence, {
      dir: 'p', scenarioId: 'S', sourceId: 'R', outDir: '../o',
    }), 'outDir 逃逸')
    expectInvalid(() => generateRequestToInput(fence, {
      dir: 'p', scenarioId: '', sourceId: 'R', outDir: 'o',
    }), 'scenarioId 空')
    expectInvalid(() => generateRequestToInput(fence, {
      dir: 'p', scenarioId: 'S', sourceId: '', outDir: 'o',
    }), 'sourceId 空')
  } finally {
    rmFence(fence)
  }
})

test('replay 请求组装：fixture/against 围栏；空 scopeTypes 必须省略', () => {
  const fence = mkFence()
  try {
    const input = replayRequestToInput(fence, {
      dir: 'workspace/p',
      scenarioId: 'SCN-X',
      fixturePath: 'fixtures/replay.json',
      check: true,
      writeExpected: true,
      againstDir: 'workspace/q',
      scopeTypes: ['OBJ-A'],
    })
    assert.equal(input.versionDir, join(fence, 'workspace', 'p'))
    assert.equal(input.fixturePath, join(fence, 'fixtures', 'replay.json'))
    assert.equal(input.againstDir, join(fence, 'workspace', 'q'))
    assert.equal(input.check, true)
    assert.equal(input.writeExpected, true)
    assert.deepEqual(input.scopeTypes, ['OBJ-A'])
    const base = { dir: 'p', scenarioId: 'SCN-X' }
    assert.equal(replayRequestToInput(fence, base).check, false)
    assert.equal(replayRequestToInput(fence, base).fixturePath, undefined, '缺省夹具随包')
    assert.equal(replayRequestToInput(fence, { ...base, scopeTypes: [] }).scopeTypes, undefined, '空 scope 不得整批剔除')
    assert.equal(replayRequestToInput(fence, { ...base, fixturePath: '' }).fixturePath, undefined, '空串视同缺省')
    expectInvalid(() => replayRequestToInput(fence, { ...base, fixturePath: '../x.json' }), 'fixture 逃逸')
    expectInvalid(() => replayRequestToInput(fence, { ...base, againstDir: '../x' }), 'against 逃逸')
    expectInvalid(() => replayRequestToInput(fence, { ...base, scopeTypes: [''] }), 'scope 空串')
    expectInvalid(() => replayRequestToInput(fence, { dir: 'p' }), 'scenarioId 缺')
  } finally {
    rmFence(fence)
  }
})

/* ─── 取数与报告（CLI cmdSource 同口径） ─── */

test('probe 报告：类型/非空计数/样例上限 3', () => {
  const report = probeRowsReport({
    bins: [
      { binId: 'B1', fillLevel: 0.5, zone: 'canteen', note: null },
      { binId: 'B2', fillLevel: 0.7, zone: 'canteen' },
      { binId: 'B3', fillLevel: 'n/a', zone: 1, note: undefined },
      { binId: 'B4', fillLevel: 0.1, zone: 'canteen', extra: { a: 1 } },
      { binId: 'B5', fillLevel: 0.2, zone: 'canteen', list: [1, 2] },
    ],
  })
  const b = report.bins
  assert.equal(b.rows, 5)
  assert.deepEqual(b.fields.binId.types, ['string'])
  assert.equal(b.fields.binId.nonNull, 5)
  assert.equal(b.fields.binId.samples.length, 3, '样例上限 3')
  assert.ok(b.fields.fillLevel.types.includes('number') && b.fields.fillLevel.types.includes('string'))
  assert.equal(b.fields.fillLevel.nonNull, 5)
  assert.equal(b.fields.note.nonNull, 0, 'null/undefined 不计非空')
  assert.deepEqual(b.fields.list.types, ['array'])
  assert.deepEqual(b.fields.extra.types, ['object'])
  assert.deepEqual(report.OTHER, undefined)
})

test('取数 data 模式：snapshot / collections 两口径均走 extractSnapshotRows/extractPageItems', async () => {
  const { fence, dir } = setupWst(false)
  try {
    const pkg = loadPackage(dir)
    const snapshot = JSON.parse(readFileSync(WST_SNAPSHOT, 'utf8'))
    const snap = await sampleRowsFor(pkg, { data: snapshot })
    assert.equal(snap.origin, 'data:inline')
    assert.equal(snap.rows.bins.length, 3)
    assert.equal(snap.rows.alerts.length, 4)
    // collections 口径：信封 itemsPath + 直接数组两种形态（CLI sampleRows 同分支）
    const envelopePkg = {
      ...pkg,
      apiSources: [{
        id: 'SRC-ENV',
        name: 'env',
        sourceType: 'SCHEMA_API',
        shape: {
          mode: 'collections',
          collectionPath: '/api/v1/{collection}',
          itemsPath: 'items',
          pagination: { mode: 'none' },
        },
      }],
      sourceMaps: [{ id: 'SM-ENV-BIN', collection: 'bins', objectType: 'OBJ-WST-BIN', idTemplate: '<binId>' }],
    }
    const viaItems = await sampleRowsFor(envelopePkg, { data: { bins: { items: [{ binId: 'B1' }, null] } } })
    assert.equal(viaItems.rows.bins.length, 1, 'items 过滤非对象行')
    assert.equal(viaItems.rows.bins[0].binId, 'B1')
    const viaArray = await sampleRowsFor(envelopePkg, { data: { bins: [{ binId: 'B2' }] } })
    assert.equal(viaArray.rows.bins[0].binId, 'B2')
  } finally {
    rmFence(fence)
  }
})

test('取数 url 模式：走 fetchShapeRows（snapshot 一次 GET；collections 跟分页取到 samples 上限）', async () => {
  const { fence, dir } = setupWst(false)
  try {
    const pkg = loadPackage(dir)
    const calls = []
    const snap = await sampleRowsFor(
      pkg,
      { url: 'http://sample.test/' },
      async (p) => {
        calls.push(p)
        return JSON.parse(readFileSync(WST_SNAPSHOT, 'utf8'))
      },
    )
    assert.equal(snap.origin, 'url:http://sample.test')
    assert.deepEqual(calls, ['/api/v1/bin-snapshot'], 'snapshot 一次 GET（尾斜杠归一）')
    assert.equal(snap.rows.bins.length, 3)
    // collections + cursor 分页：直到 samples 上限
    const pagedPkg = {
      ...pkg,
      apiSources: [{
        id: 'SRC-PAGE',
        name: 'page',
        sourceType: 'SCHEMA_API',
        shape: {
          mode: 'collections',
          collectionPath: '/api/v1/{collection}',
          itemsPath: 'items',
          pagination: { mode: 'cursor', cursorParam: 'cursor', nextField: 'nextCursor' },
        },
      }],
      sourceMaps: [{ id: 'SM-P-BIN', collection: 'bins', objectType: 'OBJ-WST-BIN', idTemplate: '<binId>' }],
    }
    const pageCalls = []
    const paged = await sampleRowsFor(
      pagedPkg,
      { url: 'http://sample.test', samples: 3 },
      async (p) => {
        pageCalls.push(p)
        const idx = pageCalls.length
        return { items: [{ binId: `P${idx}-1` }, { binId: `P${idx}-2` }], nextCursor: `c${idx}` }
      },
    )
    assert.equal(paged.rows.bins.length, 3, 'samples 上限截断')
    assert.deepEqual(pageCalls, ['/api/v1/bins', '/api/v1/bins?cursor=c1'], 'cursor 分页参数')
  } finally {
    rmFence(fence)
  }
})

test('取数请求校验：url/data 二选一、samples/协议/形态越界拒绝', async () => {
  const { fence, dir } = setupWst(false)
  try {
    const pkg = loadPackage(dir)
    await assert.rejects(() => sampleRowsFor(pkg, {}), (e) => e.code === 'INVALID_ARGS' && /必须且只能提供一个/.test(e.message))
    await assert.rejects(
      () => sampleRowsFor(pkg, { url: 'http://a.test', data: {} }),
      (e) => e.code === 'INVALID_ARGS' && /必须且只能提供一个/.test(e.message),
    )
    await assert.rejects(() => sampleRowsFor(pkg, { data: 'scalar' }), (e) => e.code === 'INVALID_ARGS')
    await assert.rejects(() => sampleRowsFor(pkg, { data: {}, samples: -1 }), (e) => e.code === 'INVALID_ARGS')
    await assert.rejects(() => sampleRowsFor(pkg, { data: {}, samples: 'x' }), (e) => e.code === 'INVALID_ARGS')
    await assert.rejects(() => sampleRowsFor(pkg, { url: 'file:///etc/passwd' }), (e) => e.code === 'INVALID_ARGS')
    await assert.rejects(() => sampleRowsFor(pkg, { url: 'not-a-url' }), (e) => e.code === 'INVALID_ARGS')
  } finally {
    rmFence(fence)
  }
})

test('shape/集合解析：sourceId 指名、显式集合优先、缺 shape/缺集合拒绝', async () => {
  const { fence, dir } = setupWst(false)
  try {
    const pkg = loadPackage(dir)
    const shape = resolveShapeOf(pkg)
    assert.equal(shape.mode, 'snapshot')
    assert.equal(resolveShapeOf(pkg, 'SRC-WST-CORE').path, '/api/v1/bin-snapshot')
    expectInvalid(() => resolveShapeOf(pkg, 'SRC-NOPE'), '未知 sourceId')
    expectInvalid(() => resolveShapeOf({ ...pkg, apiSources: [{ id: 'A', name: 'a', sourceType: 'SCHEMA_API' }] }), '缺 shape')
    expectInvalid(() => resolveShapeOf({ ...pkg, apiSources: [] }), '缺 apiSources')
    assert.deepEqual(resolveCollectionsOf(pkg, shape), ['bins', 'alerts'], 'source-maps 集合回退')
    assert.deepEqual(resolveCollectionsOf(pkg, shape, ['bins', ' alerts ']), ['bins', 'alerts'], '显式集合优先（trim）')
    assert.deepEqual(
      resolveCollectionsOf({ ...pkg, sourceMaps: [] }, shape),
      ['bins', 'alerts'],
      'shape.collectionPaths 回退',
    )
    expectInvalid(
      () => resolveCollectionsOf({ ...pkg, sourceMaps: [] }, { mode: 'snapshot', path: 'p', pagination: { mode: 'none' } }),
      '无处回退',
    )
  } finally {
    rmFence(fence)
  }
})

test('preview 预览：计数/诊断/证据就绪度/业务窗齐全（wst 快照样本）', async () => {
  const { fence, dir } = setupWst(false)
  try {
    const pkg = loadPackage(dir)
    const out = await previewRowsFor(pkg, { data: JSON.parse(readFileSync(WST_SNAPSHOT, 'utf8')) })
    assert.equal(out.origin, 'data:inline')
    assert.equal(out.counts.objects, 3)
    assert.equal(out.counts.candidates, 4)
    assert.equal(out.counts.byCollection.bins, 3)
    assert.ok(Array.isArray(out.diagnostics))
    assert.ok(Array.isArray(out.evidence))
    assert.ok(typeof out.businessWindow.from === 'string' && typeof out.businessWindow.to === 'string')
  } finally {
    rmFence(fence)
  }
})

/* ─── generate / replay 真跑（围栏内落盘；生成物不含 backend/workbench） ─── */

test('generate：围栏内生成插件文件齐全，产物不含 backend/workbench，包零改动', () => {
  const { fence, dir } = setupWst(true)
  try {
    const input = generateRequestToInput(fence, {
      dir,
      scenarioId: SCN,
      sourceId: 'SRC-WST-CORE',
      outDir: 'gen/wst-app',
    })
    const before = readFileSync(join(dir, 'package.yaml'), 'utf8')
    const result = generatePlugin(input)
    for (const rel of ['package.json', 'src/index.ts', 'src/client.ts', 'src/bindings.ts', 'plugin.config.json']) {
      assert.ok(existsSync(join(result.outDir, rel)), `缺文件: ${rel}`)
    }
    assert.equal(result.warnings.length, 0, JSON.stringify(result.warnings))
    // T7 验收：生成插件不含 backend/workbench（面板属构建侧面，不进生成物）
    for (const rel of result.files) {
      assert.ok(!rel.includes('backend') && !rel.includes('workbench'), `生成物含 backend/workbench 路径: ${rel}`)
    }
    assert.equal(readFileSync(join(dir, 'package.yaml'), 'utf8'), before, '包状态零改动')
    // outDir 逃逸：拒绝发生在任何写盘之前
    expectInvalid(
      () => generateRequestToInput(fence, {
        dir, scenarioId: SCN, sourceId: 'SRC-WST-CORE', outDir: '../escape-app',
      }),
      'outDir 逃逸',
    )
  } finally {
    rmFence(fence)
  }
})

test('replay：随包夹具回放出稳定报告；fixture 逃逸在读盘前拒绝', () => {
  const { fence, dir } = setupWst(false)
  try {
    const input = replayRequestToInput(fence, { dir, scenarioId: SCN, check: true })
    const report = runReplay(input)
    assert.equal(report.scenarioId, SCN)
    assert.equal(report.result.humanReviewRequired, true)
    assert.equal(report.counts.objects, 3)
    assert.equal(report.counts.candidates, 4)
    assert.ok(Array.isArray(report.diagnostics))
    expectInvalid(
      () => replayRequestToInput(fence, { dir, scenarioId: SCN, fixturePath: '../../etc/passwd' }),
      'fixture 逃逸',
    )
  } finally {
    rmFence(fence)
  }
})
