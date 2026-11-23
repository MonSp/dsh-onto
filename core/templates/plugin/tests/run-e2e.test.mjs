/**
 * 生成插件 e2e 冒烟（api-to-plugin S2.4）：回放夹具 → 配置映射 → 场景 → 候选/规则/证据/人审断言。
 * 路径来自 plugin.config.json（生成时写入）；DSH_ONTO_PACKAGE_DIR 可覆盖包目录。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractSnapshotRows, transformSourceRows, runScenario, loadPackage, buildRunRecord, buildRunReport } from '@dsh-onto/core'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const config = JSON.parse(readFileSync(join(ROOT, 'plugin.config.json'), 'utf8'))
const packageDir = process.env.DSH_ONTO_PACKAGE_DIR ?? config.packageDir
const DATA_MODE = config.dataMode === 'dataset' ? 'dataset' : 'connector'

function fixtureBody() {
  const fixturePath = join(HERE, 'fixtures', 'replay.json')
  assert.ok(existsSync(fixturePath), `缺少运行夹具: ${fixturePath}`)
  return JSON.parse(readFileSync(fixturePath, 'utf8'))
}

/**
 * 数据集取位：dataset 模式夹具即数据集本体（纯内容包，无映射）；
 * connector 模式夹具是源快照，经冻结的映射契约转换（diagnostics 零错误断言在测试里）。
 */
function fixtureDataset() {
  const body = fixtureBody()
  if (DATA_MODE === 'dataset') {
    // dataset 模式夹具即数据集本体：显式断言形状（否则下方 diagnostics 断言在本臂恒真）
    assert.ok(Array.isArray(body.objects) && body.objects.length > 0, 'dataset 夹具须含对象')
    assert.ok(Array.isArray(body.candidates) && body.candidates.length > 0, 'dataset 夹具须含候选')
    return { dataset: body, diagnostics: [] }
  }
  if (config.shape.mode === 'snapshot') return transformSourceRows({ rows: extractSnapshotRows(body, config.shape), maps: config.maps })
  const rows = {}
  for (const [c, v] of Object.entries(body)) {
    rows[c] = Array.isArray(v) ? v : (v?.items ?? [])
  }
  return transformSourceRows({ rows, maps: config.maps })
}

test('运行夹具 → 场景：候选/命中规则/证据/人审齐全', () => {
  const pkg = loadPackage(packageDir)
  assert.equal(pkg.meta.status, 'ISSUED')
  const { dataset, diagnostics } = fixtureDataset()
  assert.equal(
    diagnostics.filter((d) => d.level === 'error').length,
    0,
    JSON.stringify(diagnostics),
  )
  const result = runScenario(packageDir, config.scenarioId, dataset)
  assert.equal(result.humanReviewRequired, true)
  assert.ok(result.candidates.length > 0, '至少一个候选')
  const top = [...result.candidates].sort((a, b) => b.riskScore - a.riskScore)[0]
  assert.ok(top.hitRuleIds.length > 0, '命中规则非空')
  assert.ok(top.evidenceChains.length > 0, '证据链非空')
  assert.equal(result.audit.forbiddenPhraseHits.length, 0, '禁语零命中')
  assert.equal(result.audit.passed, true, JSON.stringify(result.audit.checks))
})

test('runScenario 幂等：同输入双跑逐候选同分（页面/对话同一执行路径的同源保障）', () => {
  // 页面 wire 与 Agent run_scenario 工具调用的是同一 runScenario——此处双跑断言幂等同分
  const a = fixtureDataset().dataset
  const b = fixtureDataset().dataset
  const ra = runScenario(packageDir, config.scenarioId, a)
  const rb = runScenario(packageDir, config.scenarioId, b)
  const proj = (r) =>
    [...r.candidates]
      .map((c) => `${c.candidateId}@${Math.round(c.riskScore * 1e6)}|${[...c.hitRuleIds].sort().join(',')}`)
      .sort()
  assert.deepEqual(proj(ra), proj(rb))
})

test('报表投影：buildRunReport 与运行结果逐项同分（页面/对话共用投影）', () => {
  const { dataset } = fixtureDataset()
  const result = runScenario(packageDir, config.scenarioId, dataset)
  const meta = loadPackage(packageDir).meta
  const report = buildRunReport(
    buildRunRecord({
      package: { name: meta.name, version: meta.version },
      dataset,
      result,
      redlines: [],
    }),
  )
  assert.equal(report.candidates.length, result.candidates.length)
  for (const [i, c] of result.candidates.entries()) {
    const row = report.candidates[i]
    assert.equal(row.candidateId, c.candidateId)
    assert.equal(row.objectRef, c.objectRef)
    assert.equal(row.riskScore, c.riskScore)
    assert.deepEqual(row.hitRuleIds, c.hitRuleIds)
    assert.equal(row.evidenceChains.length, c.evidenceChains.length)
  }
  assert.equal(report.summary.humanReviewRequired, true)
  assert.equal(report.summary.candidateCount, result.candidates.length)
  assert.equal(report.runRef.runId, result.runId)
})
