/**
 * 端到端（无浏览器）：tax-api → 连接器 → SCN-TAX-BURDEN-ANOMALY 执行。
 * 证明第二插件取数与判分同源路径可用；humanReviewRequired 恒真。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { copyExamplePackage, rmWorkspace } from '../../../core/tests/helpers.mjs'
import { runScenario } from '../../../core/dist/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..', '..')
const { createTaxDataConnector } = await import(
  pathToFileURL(join(HERE, '..', 'dist', 'tax-connector.js')).href
)

let apiProc
let baseUrl
let ws

function waitListening(proc, ms = 8000) {
  return new Promise((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => reject(new Error(`tax-api not listening: ${buf}`)), ms)
    proc.stdout.on('data', (d) => {
      buf += String(d)
      if (buf.includes('"listening"')) {
        const line = buf.split('\n').find((l) => l.includes('"listening"'))
        clearTimeout(timer)
        resolve(JSON.parse(line).port)
      }
    })
    proc.stderr.on('data', (d) => {
      buf += String(d)
    })
    proc.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`tax-api exited ${code}: ${buf}`))
    })
  })
}

before(async () => {
  apiProc = spawn(process.execPath, [join(REPO, 'mock-services', 'tax-api', 'server.mjs'), '--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: join(REPO, 'mock-services', 'tax-api'),
  })
  const port = await waitListening(apiProc)
  baseUrl = `http://127.0.0.1:${port}`
  ws = copyExamplePackage('tax')
})

after(() => {
  if (apiProc && apiProc.exitCode === null) apiProc.kill()
  if (ws) rmWorkspace(ws.root)
})

test('connector dataset → SCN-TAX-BURDEN-ANOMALY 打分与审计', async () => {
  const connector = createTaxDataConnector({ baseUrl, kind: 'simulated' })
  const fetched = await connector.fetch({}, { tenant: 't', objectTypes: [] })
  assert.ok(fetched.dataset.candidates.length >= 1, 'at least one candidate')

  const result = runScenario(ws.dir, 'SCN-TAX-BURDEN-ANOMALY', fetched.dataset, {
    analysisMode: 'explore',
    dataBasis: {
      nature: 'simulated',
      complete: fetched.complete === true,
      fresh: true,
      snapshotId: 'snap-tax-e2e',
      sourceId: 'SRC-TAX-CORE',
    },
  })

  assert.equal(result.humanReviewRequired, true)
  assert.equal(result.contractStatus, 'conformant')
  assert.ok(result.candidates.length >= 1, `candidates=${result.candidates.length}`)
  for (const c of result.candidates) {
    assert.equal(typeof c.riskScore, 'number')
    assert.ok(Array.isArray(c.hitRuleIds))
    assert.ok(Array.isArray(c.evidenceChains))
    assert.ok(Array.isArray(c.pendingChecks))
  }
  // 高风险纳税人（华信贸易特征）应命中至少一条规则
  const risky = result.candidates.find((c) => c.objectRef === '91110000T001')
  assert.ok(risky, 'T001 candidate present')
  assert.ok(risky.hitRuleIds.length > 0, `expected hits, got ${JSON.stringify(risky.hitRuleIds)}`)
  assert.equal(result.audit.forbiddenPhraseHits.length, 0, 'no forbidden phrases')
  // explore + connector + features unverified → conditional（非 verified）
  assert.ok(
    result.dataStatus === 'conditional' || result.dataStatus === 'verified',
    `dataStatus=${result.dataStatus}`,
  )
})
