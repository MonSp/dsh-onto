#!/usr/bin/env node
/**
 * 浏览器 E2E 测试链入口 —— 真实用户自然语言旅程（可复跑）。
 *
 * 用法：
 *   node tests/browser-e2e/run.mjs                 # 全链：重生成插件 → 重启宿主 → 全部旅程 → 报告
 *   node tests/browser-e2e/run.mjs --list           # 列旅程
 *   node tests/browser-e2e/run.mjs --journey action-approval [--journey ...]
 *   node tests/browser-e2e/run.mjs --reuse-host     # 复用 3081 在跑宿主（跳过重生成与重启）
 *   node tests/browser-e2e/run.mjs --skip-regen     # 不重生成插件（仍会重启宿主）
 *   node tests/browser-e2e/run.mjs --stop-host      # 跑完停宿主（默认保留）
 *
 * 依赖：wst-api mock（3912，缺则自动拉起）、Tabbit CLI、D:\nvm\v24.22.1 node、
 * deepseek-harness（只读铁律：收尾做完整性守卫）。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  REPO_ROOT, OUT_DIR, NODE_EXE,
  findHostPid, stopHost, startHost, readToken, waitPortFree,
  checkMock, regeneratePlugin, assertWorkspaceIntact,
} from './lib/env.mjs'
import { tabbitAvailable, createJourneyContext, finishTask, diagnose } from './lib/tabbit.mjs'
import { writeReport } from './lib/report.mjs'

const PLUGIN_DIR = join(REPO_ROOT, 'wst-app')
const MOCK_URL = 'http://127.0.0.1:3912'
const HOST_PORT = 3081
const HOST_ENV = {
  DSH_WST_API_URL: MOCK_URL,
  DSH_BIZ_USER_ID: 'demo-analyst',
  DSH_BIZ_TENANT: 'demo-tenant',
  DSH_BIZ_ROLES: 'analyst',
  DSH_BIZ_SCOPE_TYPES: 'OBJ-WST-BIN,OBJ-WST-ROUTE',
}

const JOURNEYS = [
  () => import('./journeys/01-run-analysis.mjs').then((m) => m.default),
  () => import('./journeys/02-review-decision.mjs').then((m) => m.default),
  () => import('./journeys/03-action-approval.mjs').then((m) => m.default),
  () => import('./journeys/04-object-explore.mjs').then((m) => m.default),
  () => import('./journeys/05-report-compare.mjs').then((m) => m.default),
  () => import('./journeys/06-agent-nl.mjs').then((m) => m.default),
]

function parseArgs(argv) {
  const args = { journeys: [], list: false, reuseHost: false, skipRegen: false, stopHost: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--list') args.list = true
    else if (a === '--reuse-host') args.reuseHost = true
    else if (a === '--skip-regen') args.skipRegen = true
    else if (a === '--stop-host') args.stopHost = true
    else if (a === '--journey') args.journeys.push(argv[++i])
    else if (a === '--help' || a === '-h') args.help = true
  }
  return args
}

async function ensureMock() {
  if (await checkMock(MOCK_URL)) return { started: false }
  const child = spawn(NODE_EXE, [join(REPO_ROOT, 'mock-services', 'wst-api', 'server.mjs'), '--port', '3912'], {
    detached: true, stdio: 'ignore', cwd: REPO_ROOT,
  })
  child.unref()
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 400))
    if (await checkMock(MOCK_URL)) return { started: true, pid: child.pid }
  }
  throw new Error('wst-api mock（3912）起不来——请检查 mock-services/wst-api')
}

async function resolveToken(reuse) {
  for (const f of [join(OUT_DIR, `host-${HOST_PORT}.out.log`), join(PLUGIN_DIR, 'deploy-3081.out.log')]) {
    const token = readToken(f)
    if (token) {
      const r = await fetch(`http://127.0.0.1:${HOST_PORT}/?token=${token}`, { redirect: 'manual' }).catch(() => null)
      if (r && r.status !== 401) return token
    }
  }
  return null
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('见文件头注释。--list 列旅程。')
    return 0
  }

  const all = await Promise.all(JOURNEYS.map((load) => load()))
  const picked = args.journeys.length > 0 ? all.filter((j) => args.journeys.includes(j.id)) : all
  if (args.list) {
    for (const j of all) console.log(`${j.id}\t${j.title}`)
    return 0
  }
  if (picked.length === 0) {
    console.error(`无匹配旅程：${args.journeys.join(',')}（--list 查看）`)
    return 2
  }

  // —— 预检 ——
  if (!tabbitAvailable()) {
    console.error('Tabbit CLI 不可用（%LOCALAPPDATA%\\Tabbit\\LocalAgent\\bin\\tabbit-cli.exe）')
    return 2
  }
  await ensureMock()

  // —— 插件与宿主 ——
  let token = null
  let hostUrl = null
  if (args.reuseHost && findHostPid(HOST_PORT) !== null) {
    token = await resolveToken(true)
    if (token) hostUrl = `http://127.0.0.1:${HOST_PORT}/?token=${token}`
    else console.warn('在跑宿主 token 未识别——将重启宿主')
  }
  if (!token) {
    if (!args.skipRegen && !args.reuseHost) {
      console.log('…重生成业务插件（模板 → build → e2e）')
      regeneratePlugin({
        outDir: PLUGIN_DIR,
        scenarioId: 'SCN-WST-HAZARD-MIX',
        sourceId: 'SRC-WST-CORE',
      })
    }
    console.log('…重启 dsh-wst 宿主（3081）')
    await stopHost(HOST_PORT)
    const host = await startHost({ profile: 'dsh-wst', port: HOST_PORT, env: HOST_ENV, logStem: `host-${HOST_PORT}` })
    token = host.token
    hostUrl = host.url
  }
  console.log(`宿主：${hostUrl}`)

  // —— 旅程 ——
  // Tabbit 任务跨次复用会带上一实例的冻结/残留状态（项目记忆：长会话冻结、90s 过期落 about:blank）——
  // 每次运行用全新任务名，开跑前顺手收尾可能残留的同前缀任务。
  const TASK = `dsh-onto-e2e-${Date.now().toString(36)}`
  try { finishTask('dsh-onto-browser-e2e') } catch { /* 历史残留任务收尾失败无妨 */ }
  const results = []
  try {
    const diag = diagnose()
    if (diag?.ok === false) console.warn('Tabbit diagnose 异常（继续尝试）：', JSON.stringify(diag).slice(0, 200))
    for (const j of picked) {
      console.log(`\n▶ ${j.id} — ${j.title}`)
      const c = createJourneyContext(TASK, j.id)
      await j.run(c, { token, hostUrl, pluginDir: PLUGIN_DIR })
      const failed = c.failed.length
      console.log(`  步骤 ${c.steps.filter((s) => s.ok).length}/${c.steps.length} · 期望 ${c.expects.filter((e) => e.ok).length}/${c.expects.length}${failed ? ` · ❌${failed}` : ' · ✅'}`)
      results.push({ id: j.id, title: j.title, userIntents: j.userIntents, steps: c.steps, expects: c.expects })
    }
  } finally {
    try { finishTask(TASK) } catch { /* 释放失败不掩盖结果 */ }
    if (args.stopHost) await stopHost(HOST_PORT)
  }

  // —— 报告与完整性守卫 ——
  const { verdict, totals } = writeReport({
    journeys: results,
    meta: { hostUrl, pluginDir: PLUGIN_DIR, startedAt: new Date().toISOString() },
  })
  const intact = assertWorkspaceIntact()
  if (intact.length > 0) {
    console.error('\n⚠ 工作区完整性告警（测试基建血泪教训，必须处理）：')
    for (const p of intact) console.error('  -', p)
  }
  console.log(`\n${verdict} · 步骤 ${totals.steps - totals.stepsFailed}/${totals.steps} · 期望 ${totals.expects - totals.expectsFailed}/${totals.expects}`)
  console.log(`报告：${join(OUT_DIR, 'report.md')}`)
  return verdict === 'PASS' && intact.length === 0 ? 0 : 1
}

process.exitCode = await main()
