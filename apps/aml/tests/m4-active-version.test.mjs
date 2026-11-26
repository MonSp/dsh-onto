/**
 * M4 活动版本切换冒烟（进程内 dsh-aml 工具面）：
 * 受控导入 1.0.0/1.1.0 → 激活 1.0.0 → list/run 绑活动版 → 升级激活 1.1.0
 * → 旧 RunRecord 不串版、非活动 run 拒绝 → 回滚 1.0.0 → history 保留。
 *
 * 不起浏览器；复用 applyRun 假 Context（与 m3-f1 同装配）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { applyRun } from '@dsh-onto/runtime/agent-tools'
import {
  businessPolicy,
  currentRuntimeContext,
  provideRuntimeContext,
  registerActionConnector,
  ReleaseStore,
  buildReleaseManifest,
  buildReleaseBundle,
  dataSources,
  runtimeContextForHost,
} from '@dsh-onto/runtime'
import { apply as applyAml } from '@dsh-aml/app'
import { derivePackage, PackageWorkspace, loadPackage, readPackageMeta } from '@dsh-onto/core'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const AML_SRC = join(REPO, 'packages', 'aml', '1.0.0')
const DATASET = JSON.parse(readFileSync(join(REPO, 'examples', 'aml-run.json'), 'utf8'))

const IDENTITY = {
  userId: 'u-m4',
  tenant: 'tenant-m4',
  roles: ['analyst'],
  dataScope: { objectTypes: ['OBJ-AML-ACCOUNT', 'OBJ-AML-CUSTOMER', 'OBJ-AML-TXN'] },
}

test('AML wire checks release, business scope and run ownership', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-aml-wire-'))
  const ctx = new Context()
  ctx.reflect.provide('profileContext', { dir: root })
  let fiber
  try {
    const ws = new PackageWorkspace(join(root, 'dsh-onto', 'workspace'))
    const dir = installAmlVersion(ws.root, '1.0.0')
    const releases = new ReleaseStore({ root: join(root, 'dsh-onto', 'releases'), workspace: ws })
    fiber = await ctx.plugin(applyAml)
    const wire = ctx.ontoRuntime
    const runtime = runtimeContextForHost(ctx.root)
    const args = { name: 'aml-analysis', version: '1.0.0', scenarioId: 'SCN-AML-FIND-CLUES' }
    await assert.rejects(wire.remoteExportListScenarios(args), /no active release/)
    const manifest = buildReleaseManifest(dir, {
      coreCompat: { min: '0.0.0' }, runtimeCompat: { min: '0.0.0' }, releasedBy: 'fixture',
    })
    releases.importRelease({ kind: 'controlled-upload', bundle: buildReleaseBundle(dir, manifest) })
    releases.activate(args.name, args.version, { authorizedBy: 'host:fixture-ops' })
    let calls = 0
    let owner = null
    runtime.run(() => {
      businessPolicy.setIdentityProvider(() => owner)
      dataSources.register('wire-fixture', {
        version: 'test', nature: 'simulated',
        async fetch(query, scope) {
          calls++
          assert.equal(scope.tenant, IDENTITY.tenant)
          assert.deepEqual(query.objectTypes, IDENTITY.dataScope.objectTypes)
          assert.deepEqual(scope.objectTypes, IDENTITY.dataScope.objectTypes)
          return {
            dataset: DATASET,
            complete: true,
            businessWindow: { from: '2026-01-01', to: new Date().toISOString() },
          }
        },
      })
    })
    const source = { ...args, sourceId: 'wire-fixture', analysisMode: 'formal' }
    await assert.rejects(wire.remoteExportRunScenario(source), /Business identity/)
    assert.equal(calls, 0)
    owner = IDENTITY
    await assert.rejects(wire.remoteExportRunScenario({
      ...source, query: { objectTypes: ['OBJ-OTHER'] },
    }), /outside the business scope/)
    assert.equal(calls, 0)
    const { result } = await wire.remoteExportRunScenario(source)
    assert.equal(calls, 1)
    assert.equal(result.humanReviewRequired, true)
    assert.equal((await wire.remoteExportListRuns()).runs.length, 1)
    assert.equal((await wire.remoteExportShowRun({ runId: result.runId })).record.runId, result.runId)
    owner = { ...IDENTITY, tenant: 'different-tenant' }
    assert.deepEqual((await wire.remoteExportListRuns()).runs, [])
    await assert.rejects(wire.remoteExportShowRun({ runId: result.runId }), /not accessible/)
    await assert.rejects(wire.remoteExportReviewChain({ runId: result.runId }), /not accessible/)
    owner = { ...IDENTITY, dataScope: { ...IDENTITY.dataScope, instanceFilter: 'unmatched-' } }
    await assert.rejects(wire.remoteExportRunScenario(source), /数据范围/)
    await assert.rejects(wire.remoteExportShowRun({ runId: result.runId }), /not accessible/)
  } finally {
    await fiber?.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

/** 复制 AML 包到目标版本目录并签发+派生（1.0.0 原样；1.1.0 改 version）。 */
function installAmlVersion(wsRoot, version) {
  const dir = join(wsRoot, 'packages', 'aml-analysis', version)
  mkdirSync(join(dir, '..'), { recursive: true })
  cpSync(AML_SRC, dir, { recursive: true })
  // 重写 package.yaml 版本并回到 DRAFT 再走状态机（源带 ISSUED 时 transition 会拒）
  const pkgYaml = join(dir, 'package.yaml')
  let text = readFileSync(pkgYaml, 'utf8')
  text = text.replace(/^version:.*$/m, `version: ${version}`)
  text = text.replace(/^status:.*$/m, 'status: DRAFT')
  // 清掉旧签发记录（含 manifestDigest），重新人工签发
  text = text.replace(/^issueRecord:.*$/m, 'issueRecord: []')
  // 多行 issueRecord 展开形态兜底：整段替换
  if (/issueRecord:\s*\n\s*-/.test(text)) {
    text = text.replace(/issueRecord:\s*\n(?:\s+.*\n?)*/, 'issueRecord: []\n')
  }
  writeFileSync(pkgYaml, text, 'utf8')

  // 若存在 manifestDigest 残留（YAML 多行），再清一次
  const raw = readFileSync(pkgYaml, 'utf8')
  if (raw.includes('manifestDigest')) {
    const cleaned = raw
      .split('\n')
      .filter((l) => !l.includes('manifestDigest'))
      .join('\n')
    writeFileSync(pkgYaml, cleaned, 'utf8')
  }

  const ws = new PackageWorkspace(wsRoot)
  // createPackage 已存在时会抛；这里直接用 transition
  const meta = readPackageMeta(dir)
  if (meta.status === 'DRAFT') {
    ws.transition('aml-analysis', version, 'IN_REVIEW')
    ws.transition('aml-analysis', version, 'ISSUED', '张三（人工）', 'M4 冒烟签发')
  }
  derivePackage(dir)
  return dir
}

function setupAmlTools() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-aml-m4-'))
  const wsRoot = join(root, 'dsh-onto', 'workspace')
  mkdirSync(wsRoot, { recursive: true })

  installAmlVersion(wsRoot, '1.0.0')
  installAmlVersion(wsRoot, '1.1.0')

  const services = new Map()
  services.set('profileContext', { dir: root })
  services.set('approval', { request: async () => 'allowed-once' })
  const tools = new Map()
  const ctx = {
    on: () => undefined,
    root: { get: (k) => services.get(k) },
    tools: {
      guard: () => () => undefined,
      register: (d) => {
        tools.set(d.name, d)
      },
    },
    skills: { registerProvider: () => undefined },
  }
  provideRuntimeContext(ctx.root, currentRuntimeContext())
  applyRun(ctx)
  businessPolicy.setIdentityProvider(() => IDENTITY)

  const ws = new PackageWorkspace(wsRoot)
  const releases = new ReleaseStore({
    root: join(root, 'dsh-onto', 'releases'),
    workspace: ws,
    versions: { core: '0.2.1', runtime: '0.2.1', plugin: '@dsh-aml/app@0.1.0' },
    capabilities: () => ['dryrun'],
  })

  // 受控导入两版（包已在 workspace → 幂等收编 + 补外层 manifest）
  for (const version of ['1.0.0', '1.1.0']) {
    const dir = ws.versionDir('aml-analysis', version)
    const manifest = buildReleaseManifest(dir, {
      coreCompat: { min: '0.2.0' },
      runtimeCompat: { min: '0.2.0' },
      releasedBy: 'deploy@m4-smoke',
    })
    const bundle = buildReleaseBundle(dir, manifest)
    const result = releases.importRelease({ kind: 'controlled-upload', bundle })
    assert.equal(result.ok, true)
    assert.equal(result.package.version, version)
  }

  return {
    root,
    tools,
    wsRoot,
    releases,
    execCtx: { agent: { session: { id: 'm4-session' } }, callId: 'm4' },
    dispose() {
      businessPolicy.setIdentityProvider(null)
      registerActionConnector(null)
      rmSync(root, { recursive: true, force: true })
    },
  }
}

async function runTool(harness, name, args) {
  const tool = harness.tools.get(name)
  assert.ok(tool, `tool registered: ${name}`)
  return tool.execute(args, harness.execCtx)
}

function listPackages(harness) {
  // list_packages execute 是同步返回 packages；经 toolExecute 可能是 Promise
  return Promise.resolve(runTool(harness, 'list_packages', {}))
}

test('M4 冒烟：导入两版 → 激活切换 → list/run 绑活动版 → 历史不串 → 回滚', async () => {
  const h = setupAmlTools()
  try {
    // ── 导入后尚无活动指针：list 可见两版（开发态语义） ─────────────────
    assert.equal(h.releases.readActive(), null)
    const before = await listPackages(h)
    const versionsBefore = before.packages
      .filter((p) => p.name === 'aml-analysis')
      .map((p) => p.version)
      .sort()
    assert.deepEqual(versionsBefore, ['1.0.0', '1.1.0'])

    // ── 激活 1.0.0 ─────────────────────────────────────────────────────
    const act1 = h.releases.activate('aml-analysis', '1.0.0', { authorizedBy: 'host:ops-admin' })
    assert.equal(act1.previous, null)
    assert.equal(act1.versions.core, '0.2.1')
    assert.equal(act1.versions.plugin, '@dsh-aml/app@0.1.0')

    const after1 = await listPackages(h)
    const v1 = after1.packages
      .filter((p) => p.name === 'aml-analysis')
      .map((p) => p.version)
    assert.deepEqual(v1, ['1.0.0'], '活动版过滤：list_packages 只见 1.0.0')

    // ── run 绑活动版：1.0.0 放行，1.1.0 拒绝 ──────────────────────────
    const okRun = await runTool(h, 'run_scenario', {
      name: 'aml-analysis',
      version: '1.0.0',
      scenarioId: 'SCN-AML-FIND-CLUES',
      dataset: DATASET,
    })
    assert.ok(okRun.runId, 'active version run succeeds')
    assert.equal(okRun.humanReviewRequired, true)
    const runId10 = okRun.runId

    await assert.rejects(
      async () => runTool(h, 'run_scenario', {
        name: 'aml-analysis',
        version: '1.1.0',
        scenarioId: 'SCN-AML-FIND-CLUES',
        dataset: DATASET,
      }),
      (err) => {
        const code = err?.code ?? ''
        const msg = String(err?.message ?? err)
        assert.ok(
          code === 'RELEASE_VERSION_NOT_ACTIVE' || /RELEASE_VERSION_NOT_ACTIVE|活动版本/.test(msg),
          `expect active-version reject, got ${code}: ${msg}`,
        )
        return true
      },
      'non-active version run must reject',
    )

    // ── 升级：激活 1.1.0 ───────────────────────────────────────────────
    const act2 = h.releases.activate('aml-analysis', '1.1.0', { authorizedBy: 'host:ops-admin' })
    assert.equal(act2.previous, '1.0.0')

    const after2 = await listPackages(h)
    const v2 = after2.packages
      .filter((p) => p.name === 'aml-analysis')
      .map((p) => p.version)
    assert.deepEqual(v2, ['1.1.0'], '升级后 list 只见 1.1.0')

    // 旧运行记录不串版（list_runs 投影 package = "name@version" 字符串）
    const runs = await runTool(h, 'list_runs', {})
    const old = runs.runs.find((r) => r.runId === runId10)
    assert.ok(old, 'old run still listed')
    assert.equal(old.package, 'aml-analysis@1.0.0', '升级后旧 RunRecord 仍绑 1.0.0')

    // 新 run 只认 1.1.0；旧版拒绝
    await assert.rejects(
      async () => runTool(h, 'run_scenario', {
        name: 'aml-analysis',
        version: '1.0.0',
        scenarioId: 'SCN-AML-FIND-CLUES',
        dataset: DATASET,
      }),
      (err) => {
        const code = err?.code ?? ''
        assert.ok(
          code === 'RELEASE_VERSION_NOT_ACTIVE' || /RELEASE_VERSION_NOT_ACTIVE|活动版本/.test(String(err?.message ?? err)),
          `got ${code}`,
        )
        return true
      },
    )
    const okRun2 = await runTool(h, 'run_scenario', {
      name: 'aml-analysis',
      version: '1.1.0',
      scenarioId: 'SCN-AML-FIND-CLUES',
      dataset: DATASET,
    })
    assert.ok(okRun2.runId)
    assert.notEqual(okRun2.runId, runId10)

    // list_runs：两条记录各自版本
    const runs2 = await runTool(h, 'list_runs', {})
    const byId = new Map(runs2.runs.map((r) => [r.runId, r]))
    assert.equal(byId.get(runId10).package, 'aml-analysis@1.0.0')
    assert.equal(byId.get(okRun2.runId).package, 'aml-analysis@1.1.0')

    // ── 回滚 → 1.0.0 ──────────────────────────────────────────────────
    const histBefore = h.releases.readHistory().length
    const rb = h.releases.rollback('aml-analysis', { authorizedBy: 'host:ops-admin' })
    assert.equal(rb.package.version, '1.0.0')
    assert.equal(rb.previous, '1.1.0')
    assert.equal(h.releases.activeVersion('aml-analysis'), '1.0.0')

    const afterRb = await listPackages(h)
    const vRb = afterRb.packages
      .filter((p) => p.name === 'aml-analysis')
      .map((p) => p.version)
    assert.deepEqual(vRb, ['1.0.0'], '回滚后 list 只见 1.0.0')

    // history 只增不删
    const histAfter = h.releases.readHistory()
    assert.ok(histAfter.length > histBefore, 'history grows on rollback')
    assert.equal(histAfter[histAfter.length - 1].action, 'rollback')
    assert.ok(histAfter.some((e) => e.action === 'activate' && e.to === '1.1.0'))
    assert.ok(histAfter.some((e) => e.action === 'import' && e.package.version === '1.1.0'))

    // 回滚后新 run 绑 1.0.0；1.1.0 拒绝
    const okRun3 = await runTool(h, 'run_scenario', {
      name: 'aml-analysis',
      version: '1.0.0',
      scenarioId: 'SCN-AML-FIND-CLUES',
      dataset: DATASET,
    })
    assert.ok(okRun3.runId)
    await assert.rejects(
      async () => runTool(h, 'run_scenario', {
        name: 'aml-analysis',
        version: '1.1.0',
        scenarioId: 'SCN-AML-FIND-CLUES',
        dataset: DATASET,
      }),
      (err) => err?.code === 'RELEASE_VERSION_NOT_ACTIVE'
        || /RELEASE_VERSION_NOT_ACTIVE|活动版本/.test(String(err?.message ?? err)),
    )

    // 历史三条 run 版本各自固化
    const runs3 = await runTool(h, 'list_runs', {})
    const versionsByRun = Object.fromEntries(
      runs3.runs.map((r) => [r.runId, String(r.package).split('@')[1]]),
    )
    assert.equal(versionsByRun[runId10], '1.0.0')
    assert.equal(versionsByRun[okRun2.runId], '1.1.0')
    assert.equal(versionsByRun[okRun3.runId], '1.0.0')

    // 发布物仍在（回滚不删）
    assert.ok(h.releases.readManifest('aml-analysis', '1.1.0'))
    assert.ok(h.releases.readManifest('aml-analysis', '1.0.0'))
  } finally {
    h.dispose()
  }
})

test('M4 冒烟：技能发现限定活动版本（agent-skills 扫描过滤同源）', async () => {
  const h = setupAmlTools()
  try {
    // 无指针：两版技能源都在
    const ws = new PackageWorkspace(h.wsRoot)
    const all = ws.listVersions().filter((v) => v.name === 'aml-analysis')
    assert.equal(h.releases.filterActiveVersions(all).length, 2)

    h.releases.activate('aml-analysis', '1.1.0', { authorizedBy: 'host:ops-admin' })
    const filtered = h.releases.filterActiveVersions(all)
    assert.deepEqual(filtered.map((v) => v.version), ['1.1.0'])

    // 两版均可 loadPackage（包内容仍在）；活动过滤只影响发现/选版
    const pkg10 = loadPackage(ws.versionDir('aml-analysis', '1.0.0'))
    assert.equal(pkg10.meta.version, '1.0.0')
    assert.equal(pkg10.meta.status, 'ISSUED')
  } finally {
    h.dispose()
  }
})
