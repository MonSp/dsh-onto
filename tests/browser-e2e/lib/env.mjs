/**
 * 浏览器 E2E 测试链 —— 环境生命周期层。
 *
 * 职责：生成插件（plugin generate → build → test）→ 宿主起停（含 token 发现）→
 * mock 依赖检查 → 收尾完整性守卫（deepseek-harness 只读铁律：测试不得穿透 junction 误删）。
 * Windows 运维口径来自项目记忆：node 用 D:\nvm\v24.22.1（harness boot 指纹校验拒 MIMO_NODE），
 * pnpm 用 deepseek-harness/node_modules/.bin，宿主命令 = node --import tsx/esm apps/cli/src/bin.ts。
 */
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, readFileSync, readdirSync, lstatSync, unlinkSync, openSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = join(HERE, '..', '..', '..')
export const HARNESS_DIR = join(REPO_ROOT, '..', 'deepseek-harness')
export const NODE_EXE = 'D:\\nvm\\v24.22.1\\node.exe'
export const PNPM = join(HARNESS_DIR, 'node_modules', '.bin', 'pnpm.CMD')
export const OUT_DIR = join(REPO_ROOT, 'tests', 'browser-e2e', '.out')

const PATH_PREFIX = `D:\\nvm\\v24.22.1;${join(HARNESS_DIR, 'node_modules', '.bin')}`

function sh(cmd, args, opts = {}) {
  // .CMD/.BAT 不能裸 spawn（Windows）——经 cmd /c 执行
  const isCmd = /\.(cmd|bat)$/i.test(cmd)
  const r = spawnSync(
    isCmd ? 'cmd.exe' : cmd,
    isCmd ? ['/d', '/c', cmd, ...args] : args,
    {
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
      env: { ...process.env, PATH: `${PATH_PREFIX};${process.env.PATH}` },
      ...opts,
    },
  )
  if (r.error && r.status === null) {
    return { status: -1, stdout: '', stderr: `spawn 失败：${r.error.message}` }
  }
  return r
}

/** 宿主进程发现：netstat -ano 找端口监听 pid。 */
export function findHostPid(port) {
  const r = sh('netstat', ['-ano', '-p', 'tcp'])
  for (const line of (r.stdout ?? '').split(/\r?\n/)) {
    const m = line.match(new RegExp(`^\\s*TCP\\s+\\S+:${port}\\s+\\S+:\\S+\\s+LISTENING\\s+(\\d+)`))
    if (m) return Number(m[1])
  }
  return null
}

/** 端口是否空闲（用于等待释放/占用）。 */
export function portFree(port) {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, '127.0.0.1')
  })
}

export async function waitPortFree(port, timeoutMs = 15000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (findHostPid(port) === null && (await portFree(port))) return true
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

export async function waitPortListen(port, timeoutMs = 30000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (findHostPid(port) !== null) return true
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

/** 停宿主（阶梯口径：重启前先杀旧监听）。 */
export async function stopHost(port) {
  const pid = findHostPid(port)
  if (pid !== null) {
    sh('taskkill', ['/PID', String(pid), '/F', '/T'])
    await waitPortFree(port)
  }
  return pid
}

/** 从宿主 stdout 日志取 token（dsh web: http://127.0.0.1:PORT/?token=XXX）。 */
export function readToken(logFile) {
  if (!existsSync(logFile)) return null
  const m = readFileSync(logFile, 'utf8').match(/\?token=([A-Za-z0-9_\-]+)/)
  return m ? m[1] : null
}

/**
 * 启动 dsh 宿主（detached，stdout/stderr 直落日志文件——用 fd 不用 pipe：
 * pipe 会在父进程退出后 EPIPE 把宿主拖死），等待监听并解析 token。
 * 返回 { pid, token, url, logFile }。
 */
export async function startHost({ profile, port, env = {}, logStem }) {
  const logDir = OUT_DIR
  mkdirSync(logDir, { recursive: true })
  const logFile = join(logDir, `${logStem ?? `host-${port}`}.out.log`)
  const errFile = join(logDir, `${logStem ?? `host-${port}`}.err.log`)
  const outFd = openSync(logFile, 'w') // 截断重写：readToken 只认本次实例
  const errFd = openSync(errFile, 'w')
  const child = spawn(
    NODE_EXE,
    ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', profile, '--no-open', '--port', String(port)],
    {
      cwd: HARNESS_DIR,
      detached: true,
      stdio: ['ignore', outFd, errFd],
      env: { ...process.env, PATH: `${PATH_PREFIX};${process.env.PATH}`, ...env },
    },
  )
  child.unref()

  const t0 = Date.now()
  while (Date.now() - t0 < 40000) {
    const token = readToken(logFile)
    if (token && findHostPid(port) !== null) {
      return { pid: child.pid, token, url: `http://127.0.0.1:${port}/?token=${token}`, logFile }
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error(`宿主启动超时（${profile}@${port}）：${logFile}`)
}

/** mock 依赖（wst-api 只读 mock）在位检查。 */
export async function checkMock(baseUrl) {
  try {
    const r = await fetch(`${baseUrl}/api/v1/bin-snapshot`)
    return r.ok
  } catch {
    return false
  }
}

/**
 * 重生成业务插件（修复后的模板 → 产物），并 build + test（PR 验证口径：tsc + esbuild + e2e）。
 * --force 覆盖生成物；.env / node_modules / deploy 日志不在生成集，不受影响。
 */
export function regeneratePlugin({ outDir, scenarioId, sourceId, fixture }) {
  mkdirSync(outDir, { recursive: true })
  const args = [
    join(REPO_ROOT, 'core', 'dist', 'cli.js'),
    'plugin', 'generate',
    '--dir', join(REPO_ROOT, 'packages', 'wst', '1.0.0'),
    '--scenario', scenarioId,
    '--out', outDir,
    '--force',
  ]
  if (sourceId) args.push('--source', sourceId)
  if (fixture) args.push('--fixture', fixture)
  const gen = sh(NODE_EXE, args, { cwd: REPO_ROOT })
  if (gen.status !== 0) throw new Error(`plugin generate 失败：${(gen.stderr || '') + (gen.stdout || '')}`)
  const build = sh(PNPM, ['run', 'build'], { cwd: outDir })
  if (build.status !== 0) throw new Error(`生成插件 build 失败：${(build.stdout || '') + (build.stderr || '')}`)
  const test = sh(PNPM, ['run', 'test'], { cwd: outDir })
  if (test.status !== 0) throw new Error(`生成插件 e2e 失败：${(test.stdout || '') + (test.stderr || '')}`)
  return { gen: gen.stdout, build: build.stdout, test: test.stdout }
}

/**
 * 收尾完整性守卫（测试基建血泪教训）：deepseek-harness 不得留下被删文件，
 * core/dist 不得被 junction 穿透清理误删。
 */
export function assertWorkspaceIntact() {
  const problems = []
  const st = sh('git', ['-C', HARNESS_DIR, 'status', '--short'])
  if ((st.stdout ?? '').trim() !== '') problems.push(`deepseek-harness 工作区不干净：${st.stdout.trim()}`)
  if (!existsSync(join(HARNESS_DIR, 'vendor', 'cordis', 'lib', 'index.js'))) problems.push('vendor/cordis/lib 缺失')
  if (!existsSync(join(REPO_ROOT, 'core', 'dist', 'index.js'))) problems.push('core/dist 缺失')
  return problems
}

/** 测试树内摘链（同 helpers.mjs 口径：rmSync 会顺 junction 删真身）。 */
export function stripLinks(dir) {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = lstatSync(p)
    if (st.isSymbolicLink()) unlinkSync(p)
    else if (st.isDirectory()) stripLinks(p)
  }
}
