/**
 * agent-tools 纯函数与工具出口契约测试（不起 dsh host）。
 * 夹具直接使用仓库示例包 packages/aml/1.0.0（只读）与 examples/aml-run.json。
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  AgentToolError,
  assertRunContract,
  checkGrant,
  grantGuardDecision,
  grantMatches,
  loadDatasetFromArgs,
  projectByContract,
  readToolContracts,
  renderRunText,
  renderScenarioList,
  ruleDossier,
  scenarioCatalog,
  sourceSummary,
  summarizePackage,
  validateDatasetShape,
} from '../dist/agent-tools.js'
import { KnowledgeStore, loadPackage, runScenario } from '@dsh-onto/core'

const AML_DIR = fileURLToPath(new URL('../../packages/aml/1.0.0', import.meta.url))
const AML_RUN = fileURLToPath(new URL('../../examples/aml-run.json', import.meta.url))

function expectCode(fn, code) {
  try {
    fn()
  } catch (e) {
    assert.ok(e instanceof AgentToolError, `期望 AgentToolError，得到 ${e}`)
    assert.equal(e.code, code)
    return
  }
  assert.fail(`期望抛出 ${code}`)
}

test('数据双通道：datasetPath 与 dataset 必须二选一', () => {
  expectCode(() => loadDatasetFromArgs({}), 'INVALID_ARGS')
  expectCode(
    () => loadDatasetFromArgs({ datasetPath: AML_RUN, dataset: { objects: [], relations: [], candidates: [] } }),
    'INVALID_ARGS',
  )
})

test('数据双通道：datasetPath 读取 examples/aml-run.json 成功', () => {
  const ds = loadDatasetFromArgs({ datasetPath: AML_RUN })
  assert.ok(Array.isArray(ds.candidates) && ds.candidates.length > 0)
  assert.ok(Array.isArray(ds.objects) && Array.isArray(ds.relations))
})

test('数据双通道：坏路径与坏 JSON 均拒绝', () => {
  expectCode(() => loadDatasetFromArgs({ datasetPath: 'Z:\\not\\exist\\nope.json' }), 'INVALID_ARGS')
  const tmp = mkdtempSync(join(tmpdir(), 'onto-ds-'))
  try {
    writeFileSync(join(tmp, 'bad.json'), '{ not json', 'utf8')
    expectCode(() => loadDatasetFromArgs({ datasetPath: join(tmp, 'bad.json') }), 'INVALID_ARGS')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('数据形状校验：缺数组与坏 candidate 拒绝', () => {
  expectCode(() => validateDatasetShape({ objects: [], candidates: [] }), 'INVALID_ARGS')
  expectCode(
    () =>
      validateDatasetShape({
        objects: [],
        relations: [],
        candidates: [{ candidateId: 'c1' }],
      }),
    'INVALID_ARGS',
  )
  const ok = validateDatasetShape({
    objects: [],
    relations: [],
    candidates: [{ candidateId: 'c1', objectRef: 'OBJ-AML-ACCOUNT:x', features: { a: 1 }, tags: [] }],
  })
  assert.equal(ok.candidates.length, 1)
})

test('端到端：aml-analysis@1.0.0 跑 SCN-AML-FIND-CLUES，装配断言通过', () => {
  const dataset = loadDatasetFromArgs({ datasetPath: AML_RUN })
  const result = runScenario(AML_DIR, 'SCN-AML-FIND-CLUES', dataset)
  assertRunContract(result)
  assert.equal(result.humanReviewRequired, true)
  assert.ok(result.candidates.length > 0)
  let anyHit = false
  for (const c of result.candidates) {
    for (const e of c.evidenceChains) assert.ok(e.ruleId.startsWith('RULE-'))
    for (const id of c.hitRuleIds) assert.ok(id.startsWith('RULE-'))
    if (c.hitRuleIds.length > 0) anyHit = true
  }
  assert.ok(anyHit, '至少一个候选命中规则并回指 ruleId')
})

test('装配断言：缺契约要件即 INVALID_TOOL_OUTPUT', () => {
  const dataset = loadDatasetFromArgs({ datasetPath: AML_RUN })
  const good = runScenario(AML_DIR, 'SCN-AML-FIND-CLUES', dataset)

  expectCode(() => assertRunContract({ ...good, humanReviewRequired: false }), 'INVALID_TOOL_OUTPUT')
  expectCode(() => assertRunContract({ ...good, audit: undefined }), 'INVALID_TOOL_OUTPUT')
  expectCode(
    () =>
      assertRunContract({
        ...good,
        candidates: [{ candidateId: 'x', objectRef: 'y', riskScore: 0.1 }],
      }),
    'INVALID_TOOL_OUTPUT',
  )
})

test('renderRunText：合规页脚成立且渲染文本不触发禁语', () => {
  const dataset = loadDatasetFromArgs({ datasetPath: AML_RUN })
  const result = runScenario(AML_DIR, 'SCN-AML-FIND-CLUES', dataset)
  const text = renderRunText(result)

  assert.match(text, /humanReviewRequired=true/)
  assert.match(text, /禁语扫描: 0 命中（通过）/)
  assert.match(text, /三层闭合: passed/)

  const pkg = loadPackage(AML_DIR)
  for (const sc of pkg.scenarios) {
    for (const phrase of sc.outputContract.forbiddenPhrases) {
      assert.ok(!text.includes(phrase), `渲染文本不得含禁语「${phrase}」`)
    }
  }
  // 合规页脚与命中规则必须在场
  assert.match(text, /命中规则: RULE-/)
  assert.match(text, /证据\[RULE-/)
})

test('收权：projectByContract 只留 grant 面字段', () => {
  const entry = projectByContract({
    id: 'TOOL-AML-ACCOUNT-ACCOUNT',
    kind: 'object-read',
    objectId: 'OBJ-AML-ACCOUNT',
    grantScope: 'OBJ-AML-ACCOUNT',
    idRule: '<bank_code>:<acct_no>',
    inputs: ['OBJ-AML-ACCOUNT.acctNo'],
    outputs: ['OBJ-AML-ACCOUNT.acctType'],
    leaked: 'secret',
  })
  assert.deepEqual(Object.keys(entry).sort(), [
    'grantScope',
    'id',
    'idRule',
    'inputs',
    'objectId',
    'outputs',
  ])
  assert.equal(entry.leaked, undefined)
})

test('收权：aml 包 tool-contracts 可读且 grantScope 均落在 O1', () => {
  const contracts = readToolContracts(AML_DIR)
  assert.ok(contracts.length > 0)
  const pkg = loadPackage(AML_DIR)
  const known = new Set([...pkg.objects.map((o) => o.id), ...pkg.relations.map((r) => r.id)])
  for (const c of contracts) {
    assert.ok(known.has(c.grantScope), `${c.id} 的 grantScope ${c.grantScope} 须是包内对象/关系`)
  }
  assert.equal(checkGrant(contracts, 'OBJ-AML-ACCOUNT'), undefined)
  assert.match(checkGrant(contracts, 'OBJ-NOPE'), /OBJECT_NOT_GRANTED/)
  assert.equal(checkGrant(contracts, undefined), undefined)
})

test('收权：派生漂移 → DERIVED_DRIFT 拒绝', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'onto-drift-'))
  try {
    cpSync(AML_DIR, tmp, { recursive: true })
    const manifestPath = join(tmp, 'derived', 'manifest.yaml')
    writeFileSync(manifestPath, readFileSync(manifestPath, 'utf8').replace(/sha256:.*/, 'sha256: tampered'), 'utf8')
    expectCode(() => readToolContracts(tmp), 'DERIVED_DRIFT')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('只读查询投影：摘要/口径/场景清单字段齐全', () => {
  const pkg = loadPackage(AML_DIR)
  const summary = summarizePackage(pkg)
  assert.equal(summary.meta.name, 'aml-analysis')
  assert.ok(summary.ruleIds.length > 0)
  assert.ok(summary.scenarioIds.includes('SCN-AML-FIND-CLUES'))

  const all = ruleDossier(pkg)
  assert.ok(all.scoreRules.length > 0)
  assert.ok('weight' in all.scoreRules[0] && 'expression' in all.scoreRules[0])
  const one = ruleDossier(pkg, all.scoreRules[0].id)
  assert.equal(one.rule.id, all.scoreRules[0].id)
  expectCode(() => ruleDossier(pkg, 'RULE-NOPE'), 'NOT_FOUND')

  const catalog = scenarioCatalog(pkg)
  assert.ok(catalog.scenarios.length > 0)
  assert.ok(Array.isArray(catalog.scenarios[0].outputFields))
  assert.match(renderScenarioList(catalog.scenarios), /SCN-AML-FIND-CLUES/)
})

test('知识上传回执不回显 content', () => {
  const summary = sourceSummary({
    id: 'src-1',
    packageId: 'aml-analysis@1.0.0',
    sourceType: 'POLICY',
    name: '制度',
    content: '超长敏感正文',
    sha256: 'abc',
    parseStatus: 'uploaded',
    uploadedAt: '2026-11-03T00:00:00.000Z',
  })
  assert.equal(summary.content, undefined)
  assert.equal(summary.sha256, 'abc')
})

test('知识上传 sha256 幂等：同内容二次上传跳过', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'onto-know-'))
  try {
    const store = new KnowledgeStore(tmp)
    const req = {
      packageId: 'aml-analysis@1.0.0',
      sourceType: 'POLICY',
      name: '制度摘要',
      content: '同一份内容',
    }
    const first = store.uploadSource(req)
    const before = store.listSources(req.packageId).length
    const second = store.uploadSource(req)
    assert.equal(store.listSources(req.packageId).length, before, '同 sha256 不应新增')
    assert.equal(second.sha256, first.sha256)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('收权 guard：缺 name/version 与未收权对象一律拒绝（无旁路）', () => {
  const contracts = readToolContracts(AML_DIR)
  const reader = () => contracts

  assert.equal(grantGuardDecision('bash', { objectId: 'OBJ-AML-ACCOUNT' }, reader), undefined)
  assert.equal(grantGuardDecision('get_rule', { name: 'aml-analysis', version: '1.0.0' }, reader), undefined)

  const missingArgs = grantGuardDecision(
    'list_tool_contracts',
    { objectId: 'OBJ-AML-ACCOUNT' },
    reader,
  )
  assert.match(missingArgs, /OBJECT_NOT_GRANTED/)

  const viaObjectRef = grantGuardDecision(
    'list_tool_contracts',
    { objectRef: 'OBJ-NOPE', name: 'aml-analysis', version: '1.0.0' },
    reader,
  )
  assert.match(viaObjectRef, /OBJECT_NOT_GRANTED: OBJ-NOPE/)

  const bothFields = grantGuardDecision(
    'list_tool_contracts',
    { objectId: 'OBJ-AML-ACCOUNT', objectRef: 'OBJ-NOPE', name: 'aml-analysis', version: '1.0.0' },
    reader,
  )
  assert.match(bothFields, /OBJECT_NOT_GRANTED: OBJ-NOPE/, '双字段时两者都必须收权')

  assert.equal(
    grantGuardDecision(
      'list_tool_contracts',
      { objectId: 'OBJ-AML-ACCOUNT', name: 'aml-analysis', version: '1.0.0' },
      reader,
    ),
    undefined,
  )
  assert.match(
    grantGuardDecision(
      'list_tool_contracts',
      { objectId: 'OBJ-NOPE', name: 'aml-analysis', version: '1.0.0' },
      reader,
    ),
    /OBJECT_NOT_GRANTED/,
  )
  assert.match(
    grantGuardDecision(
      'list_tool_contracts',
      { objectId: 'OBJ-AML-ACCOUNT', name: 'aml-analysis', version: '1.0.0' },
      () => {
        throw new AgentToolError('DERIVED_DRIFT', '拒绝加载: tampered')
      },
    ),
    /拒绝加载/,
  )
})

test('收权谓词与过滤一致：guard 放行的对象必能在清单中取到条目', () => {
  const contracts = readToolContracts(AML_DIR)
  for (const c of contracts) {
    const scope = c.grantScope
    assert.equal(checkGrant(contracts, scope), undefined, `${scope} 应放行`)
    assert.ok(contracts.some((x) => grantMatches(x, scope)), `${scope} 过滤应命中`)
  }
})
