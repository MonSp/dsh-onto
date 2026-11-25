/**
 * 浏览器 E2E 测试链 —— Tabbit 驱动层。
 *
 * Tabbit = 真实 Chromium + Playwright 运行面；本层封装 CLI 调用（Windows 多行 JS
 * 写 UTF-8 临时文件 + cmd 重定向，项目记忆口径），并提供旅程执行上下文：
 * step（用户意图步骤）/ expect（用户期望断言）/ program（浏览器程序）/ shot（截图留证）。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { OUT_DIR, stripLinks } from './env.mjs'

const TABBIT_CLI = `${process.env.LOCALAPPDATA}\\Tabbit\\LocalAgent\\bin\\tabbit-cli.exe`

function cli(args, { input, timeoutMs = 60000 } = {}) {
  const r = spawnSync(TABBIT_CLI, args, {
    input,
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

export function tabbitAvailable() {
  return existsSync(TABBIT_CLI)
}

/** 浏览器诊断（任务/标签/实例）。 */
export function diagnose() {
  const r = cli(['diagnose'], { timeoutMs: 30000 })
  try {
    return JSON.parse(r.stdout)
  } catch {
    return { ok: false, raw: r.stdout + r.stderr }
  }
}

/** 执行一个浏览器程序（JS 源码 → result.value）。 */
export function runProgram(task, js, { timeoutMs = 60000, requestId, extraArgs = [] } = {}) {
  mkdirSync(OUT_DIR, { recursive: true })
  const tmp = join(OUT_DIR, `prog-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.js`)
  // UTF-8 无 BOM + LF：Node 侧 program 解析稳定
  writeFileSync(tmp, js.replace(/\r\n/g, '\n'), 'utf8')
  try {
    const args = ['nodejs', '--task', task, '--timeout-ms', String(timeoutMs), ...extraArgs]
    if (requestId) args.push('--request-id', requestId)
    const r = spawnSync(TABBIT_CLI, args, {
      input: readFileSync(tmp),
      encoding: 'utf8',
      windowsHide: true,
      timeout: timeoutMs + 15000,
      maxBuffer: 32 * 1024 * 1024,
    })
    const out = r.stdout ?? ''
    let parsed = null
    try {
      parsed = JSON.parse(out)
    } catch {
      // 结果可能是「最后一个 JSON 对象」拼在文本里——取最后一段 {…}
      const i = out.lastIndexOf('\n{')
      if (i >= 0) {
        try { parsed = JSON.parse(out.slice(i + 1)) } catch { /* 保持 null */ }
      }
    }
    return { ok: r.status === 0 && parsed?.ok !== false, parsed, stdout: out, stderr: r.stderr ?? '', raw: parsed }
  } finally {
    stripLinks(OUT_DIR)
    rmSync(tmp, { force: true })
  }
}

/** 释放任务标签。 */
export function finishTask(task, { discard = false } = {}) {
  const args = ['finish', '--task', task]
  if (discard) args.push('--discard')
  return cli(args, { timeoutMs: 30000 })
}

/**
 * 从 nodejs 结果信封取值：result.value；大输出为 {type:'file', path} 时读文件
 * （内容可能是 JSON 或纯文本）；其余形状尽量给出可断言的字符串。
 */
export function extractValue(parsed) {
  const res = parsed?.result ?? parsed
  if (res == null) return null
  if (typeof res === 'string' || typeof res === 'number' || typeof res === 'boolean') return res
  if (res.type === 'file' && typeof res.path === 'string' && existsSync(res.path)) {
    const raw = readFileSync(res.path, 'utf8')
    try { return JSON.parse(raw) } catch { return raw }
  }
  if ('value' in res) {
    const v = res.value
    if (v == null) return null
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
    return v
  }
  return res
}

/**
 * 旅程执行上下文：自然语言意图为一等公民——
 * step 说明「用户想做什么」，expect 说明「用户应当看到什么」，失败全部收集不打断后续步骤（除非 fatal）。
 */
export function createJourneyContext(task, journeyId) {
  const steps = []
  const expects = []
  let current = null
  const shotDir = join(OUT_DIR, 'shots', journeyId)
  mkdirSync(shotDir, { recursive: true })

  return {
    task,
    journeyId,
    steps,
    expects,
    get failed() {
      return [...steps, ...expects].filter((x) => !x.ok)
    },
    async step(desc, fn) {
      current = { desc, ok: true, error: null }
      steps.push(current)
      try {
        return await fn()
      } catch (e) {
        current.ok = false
        current.error = String(e?.stack ?? e)
        return undefined
      }
    },
    expect(desc, cond, detail = '') {
      const ok = typeof cond === 'function' ? Boolean(cond()) : Boolean(cond)
      expects.push({ desc, ok, detail: ok ? '' : String(detail) })
      return ok
    },
    /** 浏览器程序：JS 字符串或函数体；返回 result.value（大输出落文件时读回）。 */
    async program(jsOrFn, { timeoutMs = 60000, fatal = false } = {}) {
      const body = typeof jsOrFn === 'function' ? `return await (${jsOrFn.toString()})(page)` : jsOrFn
      const r = runProgram(task, body, { timeoutMs })
      const value = extractValue(r.parsed)
      if (!r.ok) {
        const detail = r.parsed?.error?.message ?? r.parsed?.result?.error ?? ''
        const msg = `program 失败：${detail || ''}\nstdout: ${String(r.stdout).slice(0, 500)}\nstderr: ${String(r.stderr).slice(0, 300)}`
        if (fatal && current) { current.ok = false; current.error = msg }
        if (fatal) throw new Error(msg)
      }
      return value
    },
    async shot(label) {
      const r = await this.program(`return await page.screenshot({ fullPage: false })`, { fatal: false })
      const path = r?.path ?? r?.nextAction?.path ?? null
      if (path && existsSync(path)) {
        const dest = join(shotDir, `${String(shotLabelSeq++).padStart(2, '0')}-${label.replace(/[\\/:*?"<>|]/g, '_')}.png`)
        try { writeFileSync(dest, readFileSync(path)) } catch { /* 截图丢失不判失败 */ }
        return dest
      }
      return null
    },
  }
}

let shotLabelSeq = 0
