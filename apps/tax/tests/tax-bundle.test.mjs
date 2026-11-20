/**
 * TAX 第二插件装配断言：RUN-only、无 DEV、零 core/runtime 改动面、
 * 数据源登记/未登记、连接器结构闭合（同 tax-api fixture）。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = join(HERE, '..')
const REPO = join(APP, '..', '..')

const taxSrc = readFileSync(join(APP, 'src', 'index.ts'), 'utf8')
const taxClient = readFileSync(join(APP, 'src', 'client.ts'), 'utf8')

test('A2 source: TAX host does not register DEV services', () => {
  assert.ok(!taxSrc.includes('OntoWorkspace'), 'no OntoWorkspace')
  assert.ok(!taxSrc.includes('OntoModel'), 'no OntoModel')
  assert.ok(!taxSrc.includes('OntoValidate'), 'no OntoValidate')
  assert.ok(!taxSrc.includes('OntoDerive'), 'no OntoDerive')
  assert.ok(!taxSrc.includes('OntoKnowledge'), 'no OntoKnowledge')
  assert.ok(taxSrc.includes('OntoRuntime'), 'registers OntoRuntime')
  assert.ok(taxSrc.includes('applyRun'), 'registers RUN tools')
})

test('A1 source: TAX host does not import backend/workbench', () => {
  assert.ok(!taxSrc.includes('@dsh-onto/backend'), 'no backend dep')
  assert.ok(!taxSrc.includes('@dsh-onto/workbench'), 'no workbench dep')
  assert.ok(!taxClient.includes('@dsh-onto/backend'), 'client no backend')
})

test('A2 client: descriptors are ontoRuntime only (no DEV namespaces)', () => {
  const devNs = ['ontoWorkspace', 'ontoModel', 'ontoValidate', 'ontoDerive', 'ontoKnowledge']
  for (const ns of devNs) {
    assert.ok(!taxClient.includes(`desc('${ns}'`), `client must not desc ${ns}`)
  }
  assert.ok(taxClient.includes("desc('ontoRuntime'"), 'has ontoRuntime descs')
  const descs = [...taxClient.matchAll(/desc\('([a-zA-Z]+)'/g)].map((m) => m[1])
  for (const d of descs) assert.equal(d, 'ontoRuntime', `unexpected namespace ${d}`)
  assert.ok(descs.length >= 2, `expected run descs, got ${descs.length}`)
})

test('A1 package.json: depends on runtime/core only (no backend)', () => {
  const pkg = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8'))
  assert.equal(pkg.name, '@dsh-tax/app')
  assert.ok(pkg.dependencies['@dsh-onto/runtime'], 'runtime dep')
  assert.ok(pkg.dependencies['@dsh-onto/core'], 'core dep')
  assert.ok(!pkg.dependencies['@dsh-onto/backend'], 'no backend dep')
  assert.ok(!pkg.dependencies['@dsh-onto/workbench'], 'no workbench dep')
})

test('A4 source: TAX apply claims runtime provider (conflict fail-loud)', () => {
  assert.ok(taxSrc.includes('runtime.claim()'), 'claims provider')
  assert.ok(taxSrc.includes("SRC-TAX-CORE"), 'sourceId matches package apiSources')
  assert.ok(taxSrc.includes('DSH_TAX_API_URL'), 'env-gated data source registration')
})

test('S2 source: zero core/runtime source edits in this feature', () => {
  // 构建产物可变（node_modules）；源文件不得被本 feature 触碰。
  // 用 git status 在仓库外验证更稳；此处断言连接器实现在插件内而非改 runtime。
  assert.ok(existsSync(join(APP, 'src', 'tax-connector.ts')), 'connector lives in plugin')
  assert.ok(
    !taxSrc.includes('createExtDataConnector'),
    'TAX does not reuse AML-hardcoded ext connector typeMap',
  )
})

test('S2 client: minimal run page uses same sourceId + runScenario', () => {
  const app = readFileSync(join(APP, 'src', 'client.ts'), 'utf8')
  const page = readFileSync(join(APP, 'src', 'client', 'app.ts'), 'utf8')
  assert.ok(page.includes('SRC-TAX-CORE'), 'page passes sourceId')
  assert.ok(page.includes('runScenario'), 'page calls runScenario')
  assert.ok(page.includes('SCN-TAX-BURDEN-ANOMALY'), 'default scenario is burden anomaly')
  assert.ok(!page.includes('recordReviewDecision'), 'minimal page has no review write')
  void app
})

test('A2 client descriptors registered set matches host RUN face methods used', () => {
  // 页面用到的两个方法必须在描述符表里
  assert.ok(taxClient.includes("'listScenarios'"))
  assert.ok(taxClient.includes("'runScenario'"))
})
