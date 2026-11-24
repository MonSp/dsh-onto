/**
 * source-config 跨进程互斥验收（合入阻塞项）：真实双进程并发 upsert。
 * - 不同 sourceId 并发写入互不覆盖（读→归属判定→合并→原子替换全程持锁，丢条目=锁失效）；
 * - 同一 sourceId 被不同包争用 → 锁内归属判定，恰好一个成功。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadSourceConfigs, upsertSourceConfig } from '../dist/source-config.js'

const DIST_URL = pathToFileURL(fileURLToPath(new URL('../dist/source-config.js', import.meta.url))).href

const CHILD_SRC = `
import { existsSync, writeFileSync } from 'node:fs'
const [distUrl, dataDir, readyFile, goFile, resultFile, mode, arg, owner] = process.argv.slice(2)
const { upsertSourceConfig } = await import(distUrl)
const entry = (sourceId, pkgName) => ({
  sourceId,
  package: { name: pkgName, version: '1.0.0' },
  sourceKind: 'simulated',
  apiBaseUrl: 'http://127.0.0.1:3912',
  registeredAt: new Date().toISOString(),
})
writeFileSync(readyFile, '1', 'utf8')
while (!existsSync(goFile)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2)
try {
  if (mode === 'sweep') {
    for (let i = 0; i < 15; i++) upsertSourceConfig(dataDir, entry(arg + '-' + i, arg))
  } else {
    upsertSourceConfig(dataDir, entry(arg, owner))
  }
  writeFileSync(resultFile, 'ok', 'utf8')
} catch (e) {
  writeFileSync(resultFile, 'err:' + (e && e.code ? e.code : '') + ':' + (e && e.message ? e.message : String(e)), 'utf8')
  process.exitCode = 1
}
`

function spawnChild(script, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: 'ignore' })
    child.on('exit', (code) => resolve(code ?? -1))
    child.on('error', () => resolve(-1))
  })
}

async function waitFiles(paths, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (paths.every((p) => existsSync(p))) return
    if (Date.now() > deadline) throw new Error(`等待子进程就绪超时: ${paths.join(', ')}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-src-lock-'))
  const script = join(root, 'child.mjs')
  writeFileSync(script, CHILD_SRC, 'utf8')
  return {
    root,
    script,
    dataDir: join(root, 'dsh-onto'),
    goFile: join(root, 'go'),
  }
}

test('双进程并发 upsert：不同 sourceId 互不覆盖（读→合并→替换全程持锁）', async () => {
  const { root, script, dataDir, goFile } = setup()
  try {
    const workers = ['proc-a', 'proc-b'].map((prefix) => ({
      prefix,
      ready: join(root, `ready-${prefix}`),
      result: join(root, `res-${prefix}`),
    }))
    const exits = workers.map((w) =>
      spawnChild(script, [DIST_URL, dataDir, w.ready, goFile, w.result, 'sweep', w.prefix]),
    )
    await waitFiles(workers.map((w) => w.ready))
    writeFileSync(goFile, 'go', 'utf8')
    assert.deepEqual(await Promise.all(exits), [0, 0], '两个进程都须成功')
    for (const w of workers) {
      assert.equal(readFileSync(w.result, 'utf8'), 'ok', `${w.prefix} 全部写入成功`)
    }
    const configs = loadSourceConfigs(dataDir)
    assert.equal(configs.length, 30, `30 条并发写入须全部保留（丢条目=锁失效）: ${configs.length}`)
    for (const w of workers) {
      for (let i = 0; i < 15; i++) {
        assert.ok(
          configs.some((c) => c.sourceId === `${w.prefix}-${i}` && c.package.name === w.prefix),
          `缺条目 ${w.prefix}-${i}`,
        )
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('双进程争用同一 sourceId：不同包只允许一个成功（归属判定在锁内）', async () => {
  for (let round = 0; round < 3; round++) {
    const { root, script, dataDir, goFile } = setup()
    const sourceId = `SRC-CONTEST-${round}`
    try {
      const workers = ['pkg-a', 'pkg-b'].map((owner) => ({
        owner,
        ready: join(root, `ready-${owner}`),
        result: join(root, `res-${owner}`),
      }))
      const exits = workers.map((w) =>
        spawnChild(script, [DIST_URL, dataDir, w.ready, goFile, w.result, 'contest', sourceId, w.owner]),
      )
      await waitFiles(workers.map((w) => w.ready))
      writeFileSync(goFile, 'go', 'utf8')
      const codes = await Promise.all(exits)
      assert.equal(codes.filter((c) => c === 0).length, 1, `第 ${round} 轮恰好一个成功: ${codes.join(',')}`)
      const outcomes = workers.map((w) => readFileSync(w.result, 'utf8'))
      assert.equal(outcomes.filter((o) => o === 'ok').length, 1, `第 ${round} 轮结果须恰好一个 ok: ${outcomes.join(' | ')}`)
      const loser = outcomes.find((o) => o !== 'ok')
      assert.ok(/占用/.test(loser ?? ''), `败者须是归属占用拒绝: ${loser}`)
      const configs = loadSourceConfigs(dataDir)
      assert.equal(configs.length, 1)
      assert.equal(configs[0].sourceId, sourceId)
      assert.ok(['pkg-a', 'pkg-b'].includes(configs[0].package.name))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

test('锁内归属判定（单进程直锚）：同 sourceId 异包替换 → 拒', () => {
  const { root, dataDir } = setup()
  try {
    const at = new Date().toISOString()
    upsertSourceConfig(dataDir, {
      sourceId: 'SRC-OWN', package: { name: 'pkg-a', version: '1.0.0' },
      sourceKind: 'simulated', apiBaseUrl: 'http://127.0.0.1:3912', registeredAt: at,
    })
    // 同包重发布（幂等替换）放行
    upsertSourceConfig(dataDir, {
      sourceId: 'SRC-OWN', package: { name: 'pkg-a', version: '1.0.1' },
      sourceKind: 'simulated', apiBaseUrl: 'http://127.0.0.1:3912', registeredAt: at,
    })
    assert.equal(loadSourceConfigs(dataDir)[0].package.version, '1.0.1')
    // 异包争用 → 锁内拒
    assert.throws(
      () => upsertSourceConfig(dataDir, {
        sourceId: 'SRC-OWN', package: { name: 'pkg-b', version: '2.0.0' },
        sourceKind: 'simulated', apiBaseUrl: 'http://127.0.0.1:3912', registeredAt: at,
      }),
      (e) => /占用/.test(e.message),
    )
    assert.equal(loadSourceConfigs(dataDir)[0].package.name, 'pkg-a', '败者不得改写归属')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
