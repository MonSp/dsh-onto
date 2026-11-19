/**
 * M2 A1/A2 — AML host mounts RUN face only; no DEV services/tools.
 *不起完整 dsh host：用假 Context 调 applyRun / OntoRuntime 构造路径断言。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const amlSrc = readFileSync(join(REPO, 'apps', 'aml', 'src', 'index.ts'), 'utf8')
const amlClient = readFileSync(join(REPO, 'apps', 'aml', 'src', 'client.ts'), 'utf8')

test('A2 source: AML host does not register DEV services', () => {
  assert.ok(!amlSrc.includes('OntoWorkspace'), 'no OntoWorkspace')
  assert.ok(!amlSrc.includes('OntoModel'), 'no OntoModel')
  assert.ok(!amlSrc.includes('OntoValidate'), 'no OntoValidate')
  assert.ok(!amlSrc.includes('OntoDerive'), 'no OntoDerive')
  assert.ok(!amlSrc.includes('OntoKnowledge'), 'no OntoKnowledge')
  assert.ok(amlSrc.includes('OntoRuntime'), 'registers OntoRuntime')
  assert.ok(amlSrc.includes('applyRun'), 'registers RUN tools')
})

test('A1 source: AML host does not import backend/workbench', () => {
  assert.ok(!amlSrc.includes('@dsh-onto/backend'), 'no backend dep')
  assert.ok(!amlSrc.includes('@dsh-onto/workbench'), 'no workbench dep')
  assert.ok(!amlClient.includes('@dsh-onto/backend'), 'client no backend')
})

test('A2 client: descriptors are ontoRuntime only (no DEV namespaces)', () => {
  const devNs = ['ontoWorkspace', 'ontoModel', 'ontoValidate', 'ontoDerive', 'ontoKnowledge']
  for (const ns of devNs) {
    assert.ok(!amlClient.includes(`desc('${ns}'`), `client must not desc ${ns}`)
  }
  assert.ok(amlClient.includes("desc('ontoRuntime'"), 'has ontoRuntime descs')
  // every desc is ontoRuntime
  const descs = [...amlClient.matchAll(/desc\('([a-zA-Z]+)'/g)].map((m) => m[1])
  assert.ok(descs.length >= 10, `expected run descs, got ${descs.length}`)
  for (const d of descs) assert.equal(d, 'ontoRuntime', `unexpected namespace ${d}`)
})

test('A1 package.json: depends on runtime/core only (no backend)', () => {
  const pkg = JSON.parse(readFileSync(join(REPO, 'apps', 'aml', 'package.json'), 'utf8'))
  assert.equal(pkg.name, '@dsh-aml/app')
  assert.ok(pkg.dependencies['@dsh-onto/runtime'], 'runtime dep')
  assert.ok(pkg.dependencies['@dsh-onto/core'], 'core dep')
  assert.ok(!pkg.dependencies['@dsh-onto/backend'], 'no backend dep')
  assert.ok(!pkg.dependencies['@dsh-onto/workbench'], 'no workbench dep')
})

test('A4 source: AML apply claims runtime provider (conflict fail-loud)', () => {
  assert.ok(amlSrc.includes('runtime.claim()'), 'claims provider')
})

test('dump-aml-config script asserts backend/workbench absent', () => {
  const s = readFileSync(join(REPO, 'scripts', 'dump-aml-config.ps1'), 'utf8')
  assert.ok(s.includes('@dsh-onto/backend'))
  assert.ok(s.includes('UNEXPECTED'))
  assert.ok(s.includes('@dsh-aml/app'))
})
