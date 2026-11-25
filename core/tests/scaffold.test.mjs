/** 插件脚手架验收（api-to-plugin T6）：生成 ≠ 签发、占位替换、契约冻结、包零改动。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { derivePackage, generatePlugin, loadPackage, readPackageMeta } from '../dist/index.js'
import { mkWorkspace, rmWorkspace, REPO_ROOT } from './helpers.mjs'

const SCN = 'SCN-WST-HAZARD-MIX'

/**
 * 真跑生成物 e2e（dataset/connector 两臂都要过）：把 @dsh-onto/core 以 junction 挂进
 * 生成物 node_modules 后执行 tests/run-e2e.test.mjs——分支不只锚字符串在位。
 */
function runGeneratedE2E(outDir) {
  const nm = join(outDir, 'node_modules', '@dsh-onto')
  mkdirSync(nm, { recursive: true })
  const coreLink = join(nm, 'core')
  if (!existsSync(coreLink)) symlinkSync(join(REPO_ROOT, 'core'), coreLink, 'junction')
  try {
    execFileSync(process.execPath, ['--test', join(outDir, 'tests', 'run-e2e.test.mjs')], {
      encoding: 'utf8',
      stdio: 'pipe',
    })
  } catch (e) {
    assert.fail(`生成物 e2e 失败:\n${e.stdout ?? ''}\n${e.stderr ?? ''}`)
  }
}

/**
 * 生成的 .ps1 落盘须带 UTF-8 BOM（scaffold.ts 写盘加 \uFEFF；PS 5.1 无 BOM 的 UTF-8 按 ANSI 读，
 * 中文注释/字符串会咬掉引号致解析失败）。断言字节头 EF BB BF——用 Buffer 读，utf8 读会吞 BOM。
 */
function assertPs1Bom(outDir, files) {
  const ps1s = files.filter((f) => f.endsWith('.ps1'))
  assert.ok(ps1s.length > 0, '模板树应含 .ps1 脚本')
  for (const rel of ps1s) {
    const buf = readFileSync(join(outDir, ...rel.split('/')))
    assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${rel} 落盘应带 UTF-8 BOM（EF BB BF）`)
  }
}

/**
 * 生成插件 tsc --noEmit（构建闸）：不 install——把仓库/harness 侧类型依赖 junction 进生成物
 * node_modules，用 core 的 typescript 过生成源（模板 app.ts/locale.ts + bindings.ts）。
 * 类型源缺失（未 pnpm install 的检出）时跳过并告警，不硬撑。
 */
function runGeneratedTsc(outDir) {
  const nm = join(outDir, 'node_modules')
  const harness = join(REPO_ROOT, '..', 'deepseek-harness')
  const link = (name, candidates) => {
    const target = candidates.find((p) => existsSync(p))
    if (target === undefined) return `缺类型源 ${name}（试过: ${candidates.join(' / ')}）`
    const dst = join(nm, ...name.split('/'))
    if (!existsSync(dst)) {
      mkdirSync(dirname(dst), { recursive: true })
      symlinkSync(target, dst, 'junction')
    }
    return null
  }
  const missing = [
    link('@dsh-onto/core', [join(REPO_ROOT, 'core')]),
    link('@dsh-onto/runtime', [join(REPO_ROOT, 'runtime')]),
    link('@deepseek-ai/cordis', [join(harness, 'vendor', 'cordis')]),
    link('@types/node', [join(REPO_ROOT, 'core', 'node_modules', '@types', 'node'), join(harness, 'node_modules', '@types', 'node')]),
    link('@types/react', [join(REPO_ROOT, 'workbench', 'node_modules', '@types', 'react'), join(harness, 'node_modules', '@types', 'react')]),
    link('zod', [join(REPO_ROOT, 'backend', 'node_modules', 'zod'), join(harness, 'node_modules', 'zod')]),
  ].filter((m) => m !== null)
  const tscBin = join(REPO_ROOT, 'core', 'node_modules', 'typescript', 'bin', 'tsc')
  if (missing.length > 0 || !existsSync(tscBin)) {
    const why = [...missing, ...(existsSync(tscBin) ? [] : ['缺 typescript（core 未 install）'])]
    console.warn(`[scaffold] 跳过生成插件 tsc 构建断言：${why.join('；')}`)
    return
  }
  try {
    execFileSync(process.execPath, [tscBin, '--noEmit', '-p', join(outDir, 'tsconfig.json')], {
      encoding: 'utf8',
      stdio: 'pipe',
    })
  } catch (e) {
    assert.fail(`生成插件 tsc 构建失败:\n${e.stdout ?? ''}\n${e.stderr ?? ''}`)
  }
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

function setupIssuedWst() {
  const ws = mkWorkspace()
  const dir = ws.versionDir('wst-ops', '1.0.0')
  cpSync(join(REPO_ROOT, 'packages', 'wst', '1.0.0'), dir, { recursive: true })
  writeFileSync(join(dir, 'bindings', 'api-sources.yaml'), shapeYaml(), 'utf8')
  writeFileSync(join(dir, 'bindings', 'source-maps.yaml'), mapsYaml(), 'utf8')
  mkdirSync(join(dir, 'fixtures'), { recursive: true })
  cpSync(
    join(REPO_ROOT, 'mock-services', 'wst-api', 'data', 'snapshot.json'),
    join(dir, 'fixtures', `replay-${SCN}.json`),
  )
  // 测试夹具直接置签发态（状态机的人审语义在 transition 端点断言，此处模拟人工步骤完成）；
  // 清 issueRecord 锚（manifestDigest 与重派生不符会触发 manifest anchor mismatch）
  const metaPath = join(dir, 'package.yaml')
  let text = readFileSync(metaPath, 'utf8')
  text = text.replace(/^status:.*$/m, 'status: ISSUED')
  text = text.replace(/^issueRecord:\s*\n(?:[ \t]+.*\n?)*/m, 'issueRecord: []\n')
  if (/^issueRecord:\s*\[\s*\]/m.test(text)) {
    text = text.replace(
      /^issueRecord:\s*\[\s*\]/m,
      "issueRecord:\n  - version: 1.0.0\n    issuedAt: '2026-11-22T00:00:00Z'\n    issuedBy: 测试主持人（人工）",
    )
  }
  text = text.split('\n').filter((l) => !l.includes('manifestDigest')).join('\n')
  writeFileSync(metaPath, text, 'utf8')
  derivePackage(dir)
  return { ws, dir, root: ws.root }
}

test('plugin generate：文件齐全、占位清零、契约冻结、包零改动', () => {
  const { dir, root } = setupIssuedWst()
  const outDir = join(root, 'gen-app')
  try {
    const before = readFileSync(join(dir, 'package.yaml'), 'utf8')
    const result = generatePlugin({
      versionDir: dir,
      scenarioId: SCN,
      sourceId: 'SRC-WST-CORE',
      outDir,
    })
    assert.equal(result.warnings.length, 0, JSON.stringify(result.warnings))
    for (const rel of [
      'package.json',
      'tsconfig.json',
      'pnpm-workspace.yaml',
      'cordis.patch.yml',
      'icon.svg',
      '.env.example',
      'src/index.ts',
      'src/client.ts',
      'src/client/app.ts',
      'src/client/report.ts',
      'src/client/locale.ts',
      'src/bindings.ts',
      'plugin.config.json',
      'tests/run-e2e.test.mjs',
      'tests/fixtures/replay.json',
      'scripts/setup-profile.ps1',
      'scripts/dump-config.ps1',
      'scripts/seed-release.mjs',
      'scripts/deploy.ps1',
    ]) {
      assert.ok(existsSync(join(outDir, rel)), `缺文件: ${rel}`)
    }
    // 占位清零（抽查关键文件）
    for (const rel of ['package.json', 'src/index.ts', 'src/client.ts', 'src/client/app.ts', 'scripts/setup-profile.ps1']) {
      const text = readFileSync(join(outDir, rel), 'utf8')
      assert.ok(!/__[A-Z][A-Z0-9_]*__/.test(text), `${rel} 残留占位`)
    }
    // .ps1 落盘带 UTF-8 BOM（PS 5.1 兼容；写盘机制见 scaffold.ts `\uFEFF` 前缀）
    assertPs1Bom(outDir, result.files)
    // chat-run-report：对话报表面（toolview keyed show_run_report + getRunReport 描述符 + 共享校验）
    assert.ok(readFileSync(join(outDir, 'src', 'client.ts'), 'utf8').includes('getRunReport'))
    const appTs = readFileSync(join(outDir, 'src', 'client', 'app.ts'), 'utf8')
    assert.ok(appTs.includes('tool.call.toolview'))
    assert.ok(appTs.includes('show_run_report'))
    assert.ok(appTs.includes('getRunReport'))
    assert.ok(appTs.includes('listReportPages'))
    const reportTs = readFileSync(join(outDir, 'src', 'client', 'report.ts'), 'utf8')
    assert.ok(reportTs.includes('@dsh-onto/core/surface'))
    assert.ok(reportTs.includes('@dsh-onto/core/report'))
    for (const comp of ['KeyValue', 'Badge', 'Callout', 'Progress', 'Timeline', 'TabsBox']) {
      assert.ok(reportTs.includes(comp), `report.ts 须渲染 ${comp}`)
    }
    assert.ok(reportTs.includes('ChartBox'), 'report.ts 须渲染 ChartBox')
    assert.ok(reportTs.includes("case 'Chart'"))
    for (const extra of ['evalWhen', 'renderCell', 'renderSpark', 'palette']) {
      assert.ok(reportTs.includes(extra), `report.ts 须渲染 ${extra}`)
    }
    for (const extra of ['projectChartGroups', 'projectChartStacks', 'projectChartSeries', 'collectUiDefaults', 'filterBy', 'case \'Input\'', 'case \'Select\'']) {
      assert.ok(reportTs.includes(extra), `report.ts 须渲染 ${extra}`)
    }
    for (const extra of ['ComparePanel', 'createDiffToolView', 'copyTableText']) {
      assert.ok(reportTs.includes(extra), `report.ts 须渲染 ${extra}`)
    }
    assert.ok(appTs.includes('show_run_diff'), 'app.ts 须注册 show_run_diff toolview')
    // 同 run 对比互斥 + 换 pair/换页清旧卡（防残留）；表格筛选可空判空（堵 Number(null)=0）
    assert.ok(appTs.includes('compareRunId === runId'), 'app.ts 须含同 run 对比互斥')
    assert.ok(reportTs.includes('filterNum'), 'report.ts 须含筛选数值化判空')
    // 契约冻结
    const bindings = readFileSync(join(outDir, 'src', 'bindings.ts'), 'utf8')
    assert.ok(bindings.includes('SRC-WST-CORE'))
    assert.ok(bindings.includes('OBJ-WST-BIN'))
    const config = JSON.parse(readFileSync(join(outDir, 'plugin.config.json'), 'utf8'))
    assert.equal(config.scenarioId, SCN)
    assert.equal(config.shape.mode, 'snapshot')
    assert.equal(config.maps.length, 2)
    // 无真实凭据：.env.example 只有占位/示例回环地址
    const env = readFileSync(join(outDir, '.env.example'), 'utf8')
    assert.ok(!/token\s*=\s*\S+/i.test(env.replace(/^#.*$/gm, '')))
    // Windows 路径进 JS 模板须为正斜杠（`\1` 等会被当八进制转义）；且语法可解析
    const seed = readFileSync(join(outDir, 'scripts', 'seed-release.mjs'), 'utf8')
    const srcLine = seed.split('\n').find((l) => l.includes('const SRC_PKG_DIR'))
    assert.ok(srcLine !== undefined && !srcLine.includes('\\'), `SRC_PKG_DIR 应为正斜杠路径: ${String(srcLine)}`)
    execFileSync(process.execPath, ['--check', join(outDir, 'scripts', 'seed-release.mjs')])
    // 生成插件 tsc 构建闸（type-check 生成源）+ e2e 真跑（connector 臂）：夹具→映射→场景→候选/规则/证据/人审断言
    runGeneratedTsc(outDir)
    runGeneratedE2E(outDir)
    // 包零改动
    assert.equal(readFileSync(join(dir, 'package.yaml'), 'utf8'), before)
  } finally {
    rmWorkspace(root)
  }
})

test('plugin generate：DRAFT 包拒绝（生成 ≠ 签发）', () => {
  const ws = mkWorkspace()
  try {
    const dir = ws.versionDir('wst-ops', '1.0.0')
    cpSync(join(REPO_ROOT, 'packages', 'wst', '1.0.0'), dir, { recursive: true })
    // 示例包可能是 ISSUED（验收产物）；本用例显式回置 DRAFT
    const metaPath = join(dir, 'package.yaml')
    writeFileSync(metaPath, readFileSync(metaPath, 'utf8').replace(/^status:.*$/m, 'status: DRAFT'), 'utf8')
    writeFileSync(join(dir, 'bindings', 'api-sources.yaml'), shapeYaml(), 'utf8')
    writeFileSync(join(dir, 'bindings', 'source-maps.yaml'), mapsYaml(), 'utf8')
    derivePackage(dir)
    assert.throws(
      () =>
        generatePlugin({
          versionDir: dir,
          scenarioId: SCN,
          sourceId: 'SRC-WST-CORE',
          outDir: join(ws.root, 'gen'),
        }),
      /签发/,
    )
    assert.ok(readPackageMeta(dir).status === 'DRAFT')
  } finally {
    rmWorkspace(ws.root)
  }
})

test('plugin generate：缺回放夹具 → 警告不阻断', () => {
  const { dir, root } = setupIssuedWst()
  try {
    rmSync(join(dir, 'fixtures'), { recursive: true, force: true })
    derivePackage(dir)
    const r2 = generatePlugin({
      versionDir: dir,
      scenarioId: SCN,
      sourceId: 'SRC-WST-CORE',
      outDir: join(root, 'gen-app2'),
    })
    assert.ok(r2.warnings.some((w) => w.includes('回放夹具')))
  } finally {
    rmWorkspace(root)
  }
})

test('plugin generate dataset 模式：纯内容包出业务页（无 bindings），--fixture 复制数据集夹具，包零改动', () => {
  const ws = mkWorkspace()
  const versionDir = join(REPO_ROOT, 'packages', 'ebike-charging', '1.0.0')
  const outDir = join(ws.root, 'ebike-app')
  try {
    const before = readFileSync(join(versionDir, 'package.yaml'), 'utf8')
    const result = generatePlugin({
      versionDir,
      scenarioId: 'SCN-EBC-CHARGE-RISK',
      outDir,
      fixturePath: join(REPO_ROOT, 'examples', 'ebc-run.json'),
    })
    assert.equal(result.warnings.length, 0, JSON.stringify(result.warnings))
    const config = JSON.parse(readFileSync(join(outDir, 'plugin.config.json'), 'utf8'))
    assert.equal(config.dataMode, 'dataset')
    assert.equal(config.sourceId, null)
    assert.equal(config.shape, null)
    const bindings = readFileSync(join(outDir, 'src', 'bindings.ts'), 'utf8')
    assert.ok(bindings.includes("mode: 'dataset'"), 'bindings 须标注 dataset 模式')
    // 运行夹具 = 数据集本体（对象/关系/行为/候选）
    const fixture = JSON.parse(readFileSync(join(outDir, 'tests', 'fixtures', 'replay.json'), 'utf8'))
    assert.ok(Array.isArray(fixture.objects) && fixture.objects.length > 0, '夹具须含对象')
    assert.ok(Array.isArray(fixture.candidates) && fixture.candidates.length > 0, '夹具须含候选')
    // 页面通道分支在位（dataset 输入）；连接器登记分支在位
    const appTs = readFileSync(join(outDir, 'src', 'client', 'app.ts'), 'utf8')
    assert.ok(appTs.includes("DATA_MODE === 'dataset'"), 'app.ts 须含 dataset 通道')
    assert.ok(appTs.includes('datasetText'), 'app.ts 须含数据集输入')
    const indexTs = readFileSync(join(outDir, 'src', 'index.ts'), 'utf8')
    assert.ok(indexTs.includes("BINDINGS.mode === 'dataset'"), 'index.ts 须按模式跳过连接器登记')
    // 占位清零
    for (const rel of ['package.json', 'src/index.ts', 'src/client/app.ts', 'src/client/locale.ts', 'scripts/deploy.ps1']) {
      const text = readFileSync(join(outDir, rel), 'utf8')
      assert.ok(!/__[A-Z][A-Z0-9_]*__/.test(text), `${rel} 残留占位`)
    }
    // .ps1 落盘带 UTF-8 BOM（与 connector 臂同机制）
    assertPs1Bom(outDir, result.files)
    // e2e 模式分支在位
    const e2e = readFileSync(join(outDir, 'tests', 'run-e2e.test.mjs'), 'utf8')
    assert.ok(e2e.includes("config.dataMode === 'dataset'"), 'e2e 须按模式取夹具')
    // 生成插件 tsc 构建闸 + e2e 真跑（dataset 臂）：内联数据通道 → 场景 → 候选/规则/证据/人审断言
    runGeneratedTsc(outDir)
    runGeneratedE2E(outDir)
    // 包零改动（ISSUED 只读）
    assert.equal(readFileSync(join(versionDir, 'package.yaml'), 'utf8'), before)
  } finally {
    rmWorkspace(ws.root)
  }
})

test('plugin generate dataset 模式：--fixture 指向不存在的文件 → 拒绝', () => {
  const ws = mkWorkspace()
  try {
    assert.throws(
      () =>
        generatePlugin({
          versionDir: join(REPO_ROOT, 'packages', 'ebike-charging', '1.0.0'),
          scenarioId: 'SCN-EBC-CHARGE-RISK',
          outDir: join(ws.root, 'gen-x'),
          fixturePath: join(ws.root, 'no-such-fixture.json'),
        }),
      /fixture/i,
    )
  } finally {
    rmWorkspace(ws.root)
  }
})

test('plugin generate dataset 模式：--fixture 指向目录 → 拒绝（不 cpSync 整树）', () => {
  const ws = mkWorkspace()
  try {
    assert.throws(
      () =>
        generatePlugin({
          versionDir: join(REPO_ROOT, 'packages', 'ebike-charging', '1.0.0'),
          scenarioId: 'SCN-EBC-CHARGE-RISK',
          outDir: join(ws.root, 'gen-y'),
          fixturePath: join(REPO_ROOT, 'examples'),
        }),
      /须是文件/,
    )
  } finally {
    rmWorkspace(ws.root)
  }
})
