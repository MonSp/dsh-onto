/**
 * 修复版 AML profile 重放（真实 ~/.dsh/profiles/dsh-aml，strict 开、formal 关）：
 *  A 活动版本门禁  B 取数身份/范围  C 运行历史归属  D 回滚重验通过后切指针。
 * 用法：node apps/aml/scripts/m5-fix-replay.mjs（在 worktree 根或 apps/aml 下执行）
 */
import { readFileSync, writeFileSync, copyFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { apply as applyAml } from '@dsh-aml/app'
import {
  ReleaseStore,
  dataSources,
  businessPolicy,
  runtimeContextForHost,
} from '@dsh-onto/runtime'
import { PackageWorkspace } from '@dsh-onto/core'

const REPO = fileURLToPath(new URL('../../..', import.meta.url))
const PROFILE = process.env.DSH_AML_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'dsh-aml')
const WS_ROOT = join(PROFILE, 'dsh-onto', 'workspace')
const RELEASES_ROOT = join(PROFILE, 'dsh-onto', 'releases')
const DATASET = JSON.parse(readFileSync(join(REPO, 'examples', 'aml-run.json'), 'utf8'))

const OWNER = {
  userId: 'u-replay-owner',
  tenant: 'tenant-replay',
  roles: ['analyst'],
  dataScope: { objectTypes: ['OBJ-AML-ACCOUNT', 'OBJ-AML-CUSTOMER', 'OBJ-AML-TXN'] },
}
const INTRUDER = {
  userId: 'u-replay-other',
  tenant: 'tenant-other',
  roles: ['analyst'],
  dataScope: { objectTypes: ['OBJ-AML-ACCOUNT', 'OBJ-AML-CUSTOMER', 'OBJ-AML-TN'] },
}

const results = []
function step(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function store() {
  const ws = new PackageWorkspace(WS_ROOT)
  return new ReleaseStore({
    root: RELEASES_ROOT,
    workspace: ws,
    versions: { core: '0.2.1', runtime: '0.2.1', plugin: '@dsh-aml/app@0.1.0' },
    capabilities: () => ['dryrun', 'ticket-sim'],
    requireActive: true,
  })
}

/** 临时把包源改坏 → 回滚/激活校验失败且不切指针。 */
function withCorruptedPackage(version, fn) {
  const dir = join(WS_ROOT, 'packages', 'aml-analysis', version)
  const pkgYaml = join(dir, 'package.yaml')
  const backup = join(tmpdir(), `pkg-backup-${Date.now()}.yaml`)
  copyFileSync(pkgYaml, backup)
  try {
    const text = readFileSync(pkgYaml, 'utf8')
    writeFileSync(pkgYaml, text.replace(/^name:.*$/m, 'name: corrupted-name'), 'utf8')
    return fn()
  } finally {
    copyFileSync(backup, pkgYaml)
    rmSync(backup, { force: true })
  }
}

async function main() {
  if (!existsSync(join(PROFILE, 'package.json'))) {
    throw new Error(`profile missing: ${PROFILE}`)
  }

  // ── 0. 确保活动指针与两版发布在场（幂等播种） ─────────────────────
  const ws = new PackageWorkspace(WS_ROOT)
  const seed = new ReleaseStore({
    root: RELEASES_ROOT,
    workspace: ws,
    versions: { core: '0.2.1', runtime: '0.2.1', plugin: '@dsh-aml/app@0.1.0' },
    capabilities: () => ['dryrun', 'ticket-sim'],
  })
  const active0 = seed.readActive()
  step('0 前置：活动指针存在', active0 !== null, active0 ? JSON.stringify(active0.packages) : 'null')
  if (!active0 || active0.packages['aml-analysis'] !== '1.0.0') {
    // 播种缺失时用 m4 脚本语义补一版
    const { spawnSync } = await import('node:child_process')
    const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'm4-seed-aml-release.mjs')], {
      cwd: REPO,
      env: { ...process.env, DSH_AML_PROFILE_DIR: PROFILE },
      encoding: 'utf8',
    })
    console.log(r.stdout || '', r.stderr || '')
    if (r.status !== 0) throw new Error('m4-seed-aml-release failed')
  }

  // ── 装载修复版 AML（strict=true；不设 formal 环境） ─────────────────
  const root = mkdtempSync(join(tmpdir(), 'dsh-aml-replay-'))
  const ctx = new Context()
  ctx.reflect.provide('profileContext', { dir: PROFILE })
  let fiber
  let identity = OWNER
  let fetchCalls = 0
  let fetchScopeSeen = null
  try {
    fiber = await ctx.plugin(applyAml)
    const wire = ctx.ontoRuntime
    const runtime = runtimeContextForHost(ctx.root)

    // 身份与取数登记须在宿主 runtime 作用域内（与 wire 同一 scoped 实例）
    runtime.run(() => {
      businessPolicy.setIdentityProvider(() => identity)
      if (!dataSources.has('replay-src')) {
        dataSources.register('replay-src', {
          version: 'test',
          nature: 'simulated',
          async fetch(query, scope) {
            fetchCalls++
            fetchScopeSeen = { query, scope }
            return {
              dataset: DATASET,
              complete: true,
              businessWindow: { from: '2026-01-01', to: new Date().toISOString() },
            }
          },
        })
      }
    })

    const runArgs = {
      name: 'aml-analysis',
      version: '1.0.0',
      scenarioId: 'SCN-AML-FIND-CLUES',
      sourceId: 'replay-src',
      analysisMode: 'explore', // formal 链路未验收——本轮只走 explore + 取数/历史防线
    }

    // ── A 活动版本门禁 ──────────────────────────────────────────────
    try {
      await wire.remoteExportRunScenario({ ...runArgs, version: '1.1.0' })
      step('A1 非活动版 1.1.0 被拒', false, '意外放行')
    } catch (e) {
      const msg = String(e?.message ?? e)
      const code = e?.code ?? ''
      const ok = code === 'RELEASE_VERSION_NOT_ACTIVE' || /RELEASE_VERSION_NOT_ACTIVE|活动版本/.test(msg)
      step('A1 非活动版 1.1.0 被拒', ok, `${code || msg.slice(0, 80)}`)
    }

    // 无活动包场景：临时改 active 指向缺失包名不现实——用 requireActive 对未知包
    // （list 面间接覆盖；wire listScenarios 在 active 存在时按活动过滤）
    const scenarios = await wire.remoteExportListScenarios({ name: 'aml-analysis', version: '1.0.0' })
    step('A2 活动版 1.0.0 可列场景', Array.isArray(scenarios?.scenarios) && scenarios.scenarios.length > 0,
      `n=${scenarios?.scenarios?.length ?? 0}`)

    // ── B 取数身份与范围 ────────────────────────────────────────────
    fetchCalls = 0
    try {
      await wire.remoteExportRunScenario({ ...runArgs, query: { objectTypes: ['OBJ-OTHER'] } })
      step('B1 范围外 objectTypes 被拒', false, '意外放行')
    } catch (e) {
      const msg = String(e?.message ?? e)
      step('B1 范围外 objectTypes 被拒',
        /outside the business scope|数据范围|OBJECT_NOT_GRANTED|Business identity/.test(msg) || e?.code === 'OBJECT_NOT_GRANTED',
        msg.slice(0, 100))
    }
    step('B1b 范围外请求未触达取数', fetchCalls === 0, `calls=${fetchCalls}`)

    identity = null
    fetchCalls = 0
    try {
      await wire.remoteExportRunScenario(runArgs)
      step('B2 身份缺失时取数被拒', false, '意外放行')
    } catch (e) {
      const msg = String(e?.message ?? e)
      step('B2 身份缺失时取数被拒', /Business identity|业务身份/.test(msg) || e?.code === 'OBJECT_NOT_GRANTED',
        msg.slice(0, 100))
    }
    step('B2b 身份缺失未触达取数', fetchCalls === 0, `calls=${fetchCalls}`)

    identity = OWNER
    fetchCalls = 0
    const run1 = await wire.remoteExportRunScenario(runArgs)
    const runId = run1?.result?.runId
    step('B3 身份+范围内取数运行成功', Boolean(runId) && fetchCalls === 1,
      `runId=${runId} calls=${fetchCalls}`)
    if (fetchScopeSeen) {
      const qOk = !fetchScopeSeen.query.objectTypes
        || fetchScopeSeen.query.objectTypes.every(t => OWNER.dataScope.objectTypes.includes(t))
      const sOk = fetchScopeSeen.scope?.tenant === OWNER.tenant
        && Array.isArray(fetchScopeSeen.scope?.objectTypes)
      step('B4 取数入参带租户与范围', qOk && sOk,
        `tenant=${fetchScopeSeen.scope?.tenant} types=${JSON.stringify(fetchScopeSeen.scope?.objectTypes)}`)
    } else {
      step('B4 取数入参带租户与范围', false, '无 fetch 记录')
    }

    // ── C 运行历史归属 ──────────────────────────────────────────────
    const ownerRuns = await wire.remoteExportListRuns()
    const ownerSees = (ownerRuns.runs ?? []).some(r => r.runId === runId)
    step('C1 归属方可见自己的 run', ownerSees, `visible=${ownerRuns.runs?.length}`)

    identity = INTRUDER
    const otherRuns = await wire.remoteExportListRuns()
    const otherSees = (otherRuns.runs ?? []).some(r => r.runId === runId)
    step('C2 非归属方列表不可见', !otherSees, `visible=${otherRuns.runs?.length}`)

    try {
      await wire.remoteExportShowRun({ runId })
      step('C3 非归属方 showRun 被拒', false, '意外放行')
    } catch (e) {
      const msg = String(e?.message ?? e)
      step('C3 非归属方 showRun 被拒', /not accessible|OBJECT_NOT_GRANTED/.test(msg) || e?.code === 'OBJECT_NOT_GRANTED',
        msg.slice(0, 100))
    }

    try {
      await wire.remoteExportReviewChain({ runId })
      step('C4 非归属方 reviewChain 被拒', false, '意外放行')
    } catch (e) {
      const msg = String(e?.message ?? e)
      step('C4 非归属方 reviewChain 被拒', /not accessible|OBJECT_NOT_GRANTED|Business identity/.test(msg) || e?.code === 'OBJECT_NOT_GRANTED',
        msg.slice(0, 100))
    }

    identity = OWNER
    const show = await wire.remoteExportShowRun({ runId })
    step('C5 归属方 showRun 可读', show?.record?.runId === runId)

    // 未绑定归属的历史（模拟旧记录）——直接改 accessBinding 后应不可见
    // （不改盘：仅验证 list 过滤逻辑用 intruder 已覆盖；此处补 export 面）
    try {
      await wire.remoteExportExportAudit({ runId })
      identity = INTRUDER
      await wire.remoteExportExportAudit({ runId })
      step('C6 非归属方 export 被拒', false, '意外放行')
    } catch (e) {
      if (identity === INTRUDER) {
        const msg = String(e?.message ?? e)
        step('C6 非归属方 export 被拒', /not accessible|OBJECT_NOT_GRANTED|Business identity/.test(msg) || e?.code === 'OBJECT_NOT_GRANTED',
          msg.slice(0, 100))
      } else {
        step('C6 非归属方 export 被拒', false, `归属方 export 先失败: ${String(e?.message ?? e).slice(0, 100)}`)
      }
    }
    identity = OWNER

    // ── D 回滚重验 ──────────────────────────────────────────────────
    // 当前活动 1.0.0；确保 1.1.0 已导入后升版再回滚
    const rel = store()
    const has11 = rel.readManifest('aml-analysis', '1.1.0') !== null
    if (!has11) {
      const { spawnSync } = await import('node:child_process')
      const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'm4-seed-aml-release.mjs')], {
        cwd: REPO,
        env: { ...process.env, DSH_AML_PROFILE_DIR: PROFILE },
        encoding: 'utf8',
      })
      if (r.status !== 0) throw new Error('seed 1.1.0 failed: ' + (r.stderr || r.stdout))
    }

    const before = rel.readActive()
    const act = rel.activate('aml-analysis', '1.1.0', { authorizedBy: 'ops-replay' })
    step('D1 升版激活 1.1.0', act?.package?.version === '1.1.0' && rel.activeVersion('aml-analysis') === '1.1.0')

    // 新 run 必须绑 1.1.0；1.0.0 拒绝
    try {
      await wire.remoteExportRunScenario({ ...runArgs, version: '1.0.0' })
      step('D2 升版后旧版 run 被拒', false, '意外放行')
    } catch (e) {
      const code = e?.code ?? ''
      const msg = String(e?.message ?? e)
      step('D2 升版后旧版 run 被拒', code === 'RELEASE_VERSION_NOT_ACTIVE' || /RELEASE_VERSION_NOT_ACTIVE|活动版本/.test(msg),
        code || msg.slice(0, 80))
    }
    const run2 = await wire.remoteExportRunScenario({ ...runArgs, version: '1.1.0' })
    step('D3 升版后 1.1.0 run 成功', Boolean(run2?.result?.runId))

    // 破坏 1.0.0 包源 → 回滚校验失败且指针仍为 1.1.0
    const corrupted = withCorruptedPackage('1.0.0', () => {
      try {
        rel.rollback('aml-analysis', { authorizedBy: 'ops-replay' })
        return { rejected: false, after: rel.activeVersion('aml-analysis') }
      } catch (e) {
        return {
          rejected: true,
          code: e?.code ?? '',
          msg: String(e?.message ?? e).slice(0, 120),
          after: rel.activeVersion('aml-analysis'),
        }
      }
    })
    step('D4 损坏目标版回滚被拒且不切指针',
      corrupted.rejected === true && corrupted.after === '1.1.0',
      `rejected=${corrupted.rejected} after=${corrupted.after} ${corrupted.code ?? ''} ${corrupted.msg ?? ''}`)

    // 完好目标版回滚成功
    const rb = rel.rollback('aml-analysis', { authorizedBy: 'ops-replay' })
    step('D5 完好回滚切回 1.0.0',
      rb?.package?.version === '1.0.0' && rel.activeVersion('aml-analysis') === '1.0.0')

    const hist = rel.readHistory()
    step('D6 history 保留 activate/rollback',
      hist.some(h => h.action === 'activate' && h.to === '1.1.0')
      && hist.some(h => h.action === 'rollback' && h.to === '1.0.0'),
      `entries=${hist.length}`)

    // 回滚后新 run 绑 1.0.0
    const run3 = await wire.remoteExportRunScenario({ ...runArgs, version: '1.0.0' })
    step('D7 回滚后 1.0.0 run 成功', Boolean(run3?.result?.runId))

    // formal 关闭确认：本脚本未设置 DSH_FORMAL_ACTION_ENABLED / DSH_EXT_API_KIND=formal
    step('E1 formal 保持关闭', process.env.DSH_FORMAL_ACTION_ENABLED !== '1'
      && process.env.DSH_EXT_API_KIND !== 'formal',
      `FORMAL=${process.env.DSH_FORMAL_ACTION_ENABLED ?? 'unset'} EXT_KIND=${process.env.DSH_EXT_API_KIND ?? 'unset'}`)
  } finally {
    try {
      runtimeContextForHost(ctx.root).run(() => {
        businessPolicy.setIdentityProvider(null)
        dataSources.unregister('replay-src')
      })
    } catch { /* ignore */ }
    await fiber?.dispose?.()
    try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
  }

  const failed = results.filter(r => !r.ok)
  console.log('\n=== 汇总 ===')
  console.log(`pass=${results.length - failed.length} fail=${failed.length} total=${results.length}`)
  if (failed.length) {
    for (const f of failed) console.log(`  FAIL ${f.name}: ${f.detail}`)
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
