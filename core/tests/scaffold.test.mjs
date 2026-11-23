/** 插件脚手架验收（api-to-plugin T6）：生成 ≠ 签发、占位替换、契约冻结、包零改动。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { derivePackage, generatePlugin, loadPackage, readPackageMeta } from '../dist/index.js'
import { mkWorkspace, rmWorkspace, REPO_ROOT } from './helpers.mjs'

const SCN = 'SCN-WST-HAZARD-MIX'

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
    ]) {
      assert.ok(existsSync(join(outDir, rel)), `缺文件: ${rel}`)
    }
    // 占位清零（抽查关键文件）
    for (const rel of ['package.json', 'src/index.ts', 'src/client.ts', 'src/client/app.ts', 'scripts/setup-profile.ps1']) {
      const text = readFileSync(join(outDir, rel), 'utf8')
      assert.ok(!/__[A-Z][A-Z0-9_]*__/.test(text), `${rel} 残留占位`)
    }
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
