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
  loadToolPackage,
  pickContracts,
  projectByContract,
  projectPackageList,
  readToolContracts,
  renderRunText,
  renderScenarioList,
  requireExistingPackage,
  ruleDossier,
  scenarioCatalog,
  sourceSummary,
  summarizePackage,
  uploadKnowledgeForPkg,
  validateDatasetShape,
  wrapRunError,
} from '../dist/agent-tools.js'
import {
  HeuristicLlm,
  KnowledgeStore,
  dumpYaml,
  loadPackage,
  loadYaml,
  runScenario,
  sha256Text,
} from '@dsh-onto/core'

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

test('收权：objectRef 实例段（TYPE:inst）按类型段判定，未收权类型仍拒绝', () => {
  const contracts = readToolContracts(AML_DIR)
  const reader = () => contracts
  const granted = 'OBJ-AML-ACCOUNT:x'
  assert.equal(
    grantGuardDecision(
      'list_tool_contracts',
      { objectRef: granted, name: 'aml-analysis', version: '1.0.0' },
      reader,
    ),
    undefined,
  )
  assert.ok(contracts.some((c) => grantMatches(c, granted)), '谓词须按 TYPE 段命中')
  assert.match(
    grantGuardDecision(
      'list_tool_contracts',
      { objectRef: 'OBJ-NOPE:x', name: 'aml-analysis', version: '1.0.0' },
      reader,
    ),
    /OBJECT_NOT_GRANTED: OBJ-NOPE:x/,
  )
  // 双字段：实例段与裸 ID 混用时两者都须收权
  assert.match(
    grantGuardDecision(
      'list_tool_contracts',
      { objectId: granted, objectRef: 'OBJ-NOPE:x', name: 'aml-analysis', version: '1.0.0' },
      reader,
    ),
    /OBJECT_NOT_GRANTED: OBJ-NOPE:x/,
  )
})

test('知识上传：packageId 必须是工作区真实包（name@version），返回裸包名', () => {
  const versions = [
    { name: 'aml-analysis', version: '1.0.0' },
    { name: 'med-analysis', version: '1.0.0' },
  ]
  assert.equal(requireExistingPackage(versions, 'aml-analysis@1.0.0'), 'aml-analysis')
  assert.equal(requireExistingPackage(versions, 'med-analysis@1.0.0'), 'med-analysis')
  expectCode(() => requireExistingPackage(versions, 'nope@1.0.0'), 'NOT_FOUND')
  expectCode(() => requireExistingPackage(versions, 'aml-analysis@9.9.9'), 'NOT_FOUND')
  expectCode(() => requireExistingPackage(versions, 'aml-analysis'), 'INVALID_ARGS')
  expectCode(() => requireExistingPackage(versions, '@1.0.0'), 'INVALID_ARGS')
  expectCode(() => requireExistingPackage(versions, ''), 'INVALID_ARGS')
})

test('list_packages 输出投影：不回显 dir 等服务端路径', () => {
  const projected = projectPackageList([
    {
      name: 'aml-analysis',
      version: '1.0.0',
      status: 'ISSUED',
      domain: 'AML',
      dir: 'D:\\secret\\workspace\\aml\\1.0.0',
    },
    { name: 'med-analysis', version: '1.0.0', status: 'DRAFT', domain: 'MED', dir: '/srv/ws/med/1.0.0' },
  ])
  assert.deepEqual(projected, [
    { name: 'aml-analysis', version: '1.0.0', status: 'ISSUED', domain: 'AML' },
    { name: 'med-analysis', version: '1.0.0', status: 'DRAFT', domain: 'MED' },
  ])
  for (const p of projected) assert.equal('dir' in p, false)
})

test('收权：空类型段（:inst）与空串永不命中，即使条目 grantScope 缺省', () => {
  const malformed = projectByContract({ id: 'TOOL-X', grantScope: '', objectId: '' })
  assert.equal(grantMatches(malformed, ':inst'), false)
  assert.equal(grantMatches(malformed, ''), false)
  const ok = projectByContract({ id: 'TOOL-Y', grantScope: 'OBJ-AML-ACCOUNT' })
  assert.equal(grantMatches(ok, 'OBJ-AML-ACCOUNT:x'), true)
  assert.equal(grantMatches(ok, 'OBJ-NOPE:x'), false)

  const contracts = readToolContracts(AML_DIR)
  assert.match(
    grantGuardDecision(
      'list_tool_contracts',
      { objectRef: ':x', name: 'aml-analysis', version: '1.0.0' },
      () => contracts,
    ),
    /OBJECT_NOT_GRANTED/,
  )
})

test('包加载：失败不回显底层路径，统一 NOT_FOUND', () => {
  const ws = { versionDir: (n, v) => `D:\\secret\\workspace\\${n}\\${v}` }
  try {
    loadToolPackage(ws, 'no-such', '9.9.9')
    assert.fail('期望抛出 NOT_FOUND')
  } catch (e) {
    assert.ok(e instanceof AgentToolError, `期望 AgentToolError，得到 ${e}`)
    assert.equal(e.code, 'NOT_FOUND')
    assert.ok(!e.message.includes('D:\\secret'), `不应泄露底层路径: ${e.message}`)
  }
})

test('收权：非字符串与空串 objectId/objectRef 一律拒绝（无静默跳过）', () => {
  const contracts = readToolContracts(AML_DIR)
  const reader = () => contracts
  const base = { name: 'aml-analysis', version: '1.0.0' }
  assert.match(
    grantGuardDecision('list_tool_contracts', { ...base, objectId: 123 }, reader),
    /OBJECT_NOT_GRANTED: objectId 非法/,
  )
  assert.match(
    grantGuardDecision('list_tool_contracts', { ...base, objectRef: true }, reader),
    /OBJECT_NOT_GRANTED: objectRef 非法/,
  )
  assert.match(
    grantGuardDecision('list_tool_contracts', { ...base, objectId: '' }, reader),
    /OBJECT_NOT_GRANTED: objectId 非法/,
  )
  // null/undefined 视为未提供，不触发收权
  assert.equal(
    grantGuardDecision('list_tool_contracts', { ...base, objectId: null }, reader),
    undefined,
  )
})

test('收权：contracts 读取失败时拒绝原因保留 DERIVED_DRIFT 码', () => {
  const denial = grantGuardDecision(
    'list_tool_contracts',
    { objectId: 'OBJ-AML-ACCOUNT', name: 'aml-analysis', version: '1.0.0' },
    () => {
      throw new AgentToolError('DERIVED_DRIFT', '拒绝加载: missing manifest (never derived)')
    },
  )
  assert.match(denial, /^DERIVED_DRIFT: /)
})

test('收权：非 AgentToolError 回退不回显底层 message', () => {
  const denial = grantGuardDecision(
    'list_tool_contracts',
    { objectId: 'OBJ-AML-ACCOUNT', name: 'aml-analysis', version: '1.0.0' },
    () => {
      throw new Error('D:\\secret\\path\\to\\file')
    },
  )
  assert.match(denial, /^UNKNOWN_ERROR/)
  assert.ok(!denial.includes('D:\\secret'), `不应泄露底层路径: ${denial}`)
})

test('收权：多级实例段 TYPE:a:b 按首个冒号前类型段判定', () => {
  const contracts = readToolContracts(AML_DIR)
  const reader = () => contracts
  const entry = projectByContract({ id: 'TOOL-X', grantScope: 'OBJ-AML-ACCOUNT' })
  assert.equal(grantMatches(entry, 'OBJ-AML-ACCOUNT:a:b'), true)
  assert.equal(
    grantGuardDecision(
      'list_tool_contracts',
      { objectRef: 'OBJ-AML-ACCOUNT:a:b', name: 'aml-analysis', version: '1.0.0' },
      reader,
    ),
    undefined,
  )
  assert.match(
    grantGuardDecision(
      'list_tool_contracts',
      { objectRef: 'OBJ-NOPE:a:b', name: 'aml-analysis', version: '1.0.0' },
      reader,
    ),
    /OBJECT_NOT_GRANTED: OBJ-NOPE:a:b/,
  )
})

test('装配断言：null/错型字段拒绝，不产出残缺结果', () => {
  const dataset = loadDatasetFromArgs({ datasetPath: AML_RUN })
  const good = runScenario(AML_DIR, 'SCN-AML-FIND-CLUES', dataset)
  assert.doesNotThrow(() => assertRunContract(good))

  const nullHit = { ...good, candidates: [{ ...good.candidates[0], hitRuleIds: null }] }
  expectCode(() => assertRunContract(nullHit), 'INVALID_TOOL_OUTPUT')

  const nullScore = { ...good, candidates: [{ ...good.candidates[0], riskScore: null }] }
  expectCode(() => assertRunContract(nullScore), 'INVALID_TOOL_OUTPUT')

  const nullChains = { ...good, candidates: [{ ...good.candidates[0], evidenceChains: null }] }
  expectCode(() => assertRunContract(nullChains), 'INVALID_TOOL_OUTPUT')

  const nullNarrative = { ...good, candidates: [{ ...good.candidates[0], narrative: null }] }
  expectCode(() => assertRunContract(nullNarrative), 'INVALID_TOOL_OUTPUT')
})

test('知识上传回执：仅 S2.2 规范字段，不回显 content/packageId/uploadedAt', () => {
  const summary = sourceSummary({
    id: 'src-1',
    packageId: 'aml-analysis@1.0.0',
    sourceType: 'POLICY',
    name: '制度',
    content: '超敏感正文',
    sha256: 'abc',
    parseStatus: 'uploaded',
    uploadedAt: '2026-11-03T00:00:00.000Z',
  })
  assert.deepEqual(Object.keys(summary).sort(), ['id', 'name', 'parseStatus', 'sha256', 'sourceType'])
  assert.equal('content' in summary, false)
  assert.equal('packageId' in summary, false)
  assert.equal('uploadedAt' in summary, false)
})

test('dataset 错误回显调用方原文，不回显 resolve 后绝对路径', () => {
  const rel = 'no-such-relative-dataset.json'
  try {
    loadDatasetFromArgs({ datasetPath: rel })
    assert.fail('期望 INVALID_ARGS')
  } catch (e) {
    assert.ok(e instanceof AgentToolError, `期望 AgentToolError，得到 ${e}`)
    assert.equal(e.code, 'INVALID_ARGS')
    assert.ok(e.message.includes(rel), `应回显调用方原文: ${e.message}`)
    assert.ok(!/^[A-Za-z]:\\/.test(e.message.split(': ').pop()), `不应含盘符绝对路径: ${e.message}`)
  }
})

test('知识上传全链路：name@version 入参 → 裸名入库 → 解析 → 物化不被 package mismatch 拒绝', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'onto-chain-'))
  try {
    const pkgDir = join(tmp, 'pkg')
    cpSync(AML_DIR, pkgDir, { recursive: true })
    const store = new KnowledgeStore(join(tmp, 'know'))
    const versions = [{ name: 'aml-analysis', version: '1.0.0' }]
    const src = uploadKnowledgeForPkg(store, versions, {
      packageId: 'aml-analysis@1.0.0',
      sourceType: 'POLICY',
      name: '风控红线',
      content: '不得进行高风险转账',
    })
    // 入库 packageId 为裸名：工作台按裸名可见，name@version 不命中
    assert.equal(src.packageId, 'aml-analysis')
    assert.equal(store.listSources('aml-analysis').length, 1)
    assert.equal(store.listSources('aml-analysis@1.0.0').length, 0)
    // 解析（启发式）→ 候选继承裸名 packageId
    const { added } = await store.parseSource(src.id, new HeuristicLlm())
    assert.ok(added.length > 0, '启发式应至少解析出一条候选')
    for (const c of added) assert.equal(c.packageId, 'aml-analysis')
    // 人审批准 → 物化到包副本：不得出现 package mismatch
    for (const c of added) store.reviewCandidate(c.id, 'approve')
    const ids = added.map((c) => c.id)
    const result = store.materialize(pkgDir, ids)
    assert.ok(result.applied.length > 0, `应有候选物化成功: ${JSON.stringify(result.skipped)}`)
    assert.ok(
      result.skipped.every((s) => !s.reason.includes('package mismatch')),
      `不应 package mismatch: ${JSON.stringify(result.skipped)}`,
    )
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('收权：idRules 顶层按 objectId join 进条目（S2.2/S2.4 承诺 idRule）', () => {
  const contracts = readToolContracts(AML_DIR)
  const objContracts = contracts.filter((c) => c.objectId !== undefined)
  assert.ok(objContracts.length > 0)
  for (const c of objContracts) {
    assert.equal(typeof c.idRule, 'string', `${c.id} 应携带 idRule`)
    assert.match(c.idRule, /<\w+>/)
  }
  // relation 条目不在 idRules（derive 只映射 objects）→ 不 join
  const relContracts = contracts.filter((c) => c.relationId !== undefined)
  assert.ok(relContracts.length > 0)
  for (const c of relContracts) assert.equal(c.idRule, undefined)
})

test('list_tool_contracts 过滤：与 guard 同口径（null 未提供、非法拒绝）', () => {
  const contracts = readToolContracts(AML_DIR)
  assert.equal(pickContracts(contracts, null).length, contracts.length)
  assert.equal(pickContracts(contracts, undefined).length, contracts.length)
  expectCode(() => pickContracts(contracts, 123), 'OBJECT_NOT_GRANTED')
  expectCode(() => pickContracts(contracts, ''), 'OBJECT_NOT_GRANTED')
  const picked = pickContracts(contracts, 'OBJ-AML-ACCOUNT')
  assert.ok(picked.length > 0)
  assert.ok(picked.every((c) => grantMatches(c, 'OBJ-AML-ACCOUNT')))
})

test('run_scenario 错误包装：保留错误码、剥离绝对 versionDir', () => {
  const dir = 'D:\\secret\\workspace\\aml\\1.0.0'
  const e = Object.assign(new Error(`missing package.yaml meta in ${dir}`), {
    code: 'PACKAGE_MALFORMED',
  })
  const wrapped = wrapRunError(e, dir)
  assert.ok(wrapped instanceof AgentToolError, `期望 AgentToolError，得到 ${wrapped}`)
  assert.equal(wrapped.code, 'PACKAGE_MALFORMED')
  assert.ok(!wrapped.message.includes('D:\\secret'), `不应泄露路径: ${wrapped.message}`)
  assert.ok(wrapped.message.includes('<pkg>'))
  // 非 Error / 无 code → RUN_FAILED
  assert.equal(wrapRunError('boom', dir).code, 'RUN_FAILED')
  // 不含 versionDir 的业务语义原样保留
  const nf = Object.assign(new Error('场景不存在: SCN-X'), { code: 'SCENARIO_NOT_FOUND' })
  assert.equal(wrapRunError(nf, dir).message, '场景不存在: SCN-X')
})

test('list_packages 输出投影：同包多版本按 semver 升序（1.9.0 先于 1.10.0）', () => {
  const projected = projectPackageList([
    { name: 'x', version: '1.10.0', status: 'DRAFT', domain: 'D' },
    { name: 'x', version: '1.9.0', status: 'DRAFT', domain: 'D' },
    { name: 'x', version: '1.2.0', status: 'DRAFT', domain: 'D' },
    { name: 'a', version: '2.0.0', status: 'DRAFT', domain: 'D' },
  ])
  assert.deepEqual(
    projected.map((p) => `${p.name}@${p.version}`),
    ['a@2.0.0', 'x@1.2.0', 'x@1.9.0', 'x@1.10.0'],
  )
})

test('数据双通道：内联 dataset 形态通过校验，坏形态拒绝', () => {
  const ds = loadDatasetFromArgs({ dataset: { objects: [], relations: [], candidates: [] } })
  assert.deepEqual(ds.candidates, [])
  expectCode(() => loadDatasetFromArgs({ dataset: { objects: [] } }), 'INVALID_ARGS')
  expectCode(() => loadDatasetFromArgs({ dataset: 'not-an-object' }), 'INVALID_ARGS')
})

test('数据形状校验：features 缺失与 tags 错型拒绝', () => {
  const base = {
    objects: [],
    relations: [],
    candidates: [{ candidateId: 'c1', objectRef: 'OBJ:x' }],
  }
  expectCode(() => validateDatasetShape(base), 'INVALID_ARGS')
  expectCode(
    () =>
      validateDatasetShape({
        ...base,
        candidates: [{ candidateId: 'c1', objectRef: 'OBJ:x', features: null }],
      }),
    'INVALID_ARGS',
  )
  expectCode(
    () =>
      validateDatasetShape({
        ...base,
        candidates: [{ candidateId: 'c1', objectRef: 'OBJ:x', features: {}, tags: 'x' }],
      }),
    'INVALID_ARGS',
  )
  expectCode(
    () =>
      validateDatasetShape({
        ...base,
        candidates: [{ candidateId: 'c1', objectRef: 'OBJ:x', features: {}, tags: [1] }],
      }),
    'INVALID_ARGS',
  )
  const ok = validateDatasetShape({
    ...base,
    candidates: [{ candidateId: 'c1', objectRef: 'OBJ:x', features: {}, tags: ['a'] }],
  })
  assert.equal(ok.candidates.length, 1)
})

test('装配断言：candidates 非数组与 pendingChecks 错型拒绝', () => {
  const dataset = loadDatasetFromArgs({ datasetPath: AML_RUN })
  const good = runScenario(AML_DIR, 'SCN-AML-FIND-CLUES', dataset)
  expectCode(() => assertRunContract({ ...good, candidates: 'not-array' }), 'INVALID_TOOL_OUTPUT')
  const nullPending = {
    ...good,
    candidates: [{ ...good.candidates[0], pendingChecks: null }],
  }
  expectCode(() => assertRunContract(nullPending), 'INVALID_TOOL_OUTPUT')
})

test('规则口径：排除规则可按 id 取档', () => {
  const pkg = loadPackage(AML_DIR)
  const all = ruleDossier(pkg)
  assert.ok(all.exclusionRules.length > 0, 'aml 包应有排除规则')
  const excl = all.exclusionRules[0]
  const one = ruleDossier(pkg, excl.id)
  assert.equal(one.rule.id, excl.id)
  assert.equal(one.rule.kind, 'exclusion')
})

test('收权：门禁通过后 tool-contracts 解析失败 → DERIVED_DRIFT 且不泄路径', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'onto-tc-'))
  try {
    cpSync(AML_DIR, tmp, { recursive: true })
    const tcPath = join(tmp, 'derived/tool-contracts/tool-contracts.yaml')
    const bad = 'tools: [unclosed'
    writeFileSync(tcPath, bad, 'utf8')
    // 同步 manifest 指纹使门禁通过（模拟门禁后不可解析的 TOCTOU 等价态）
    const manPath = join(tmp, 'derived/manifest.yaml')
    const man = loadYaml(readFileSync(manPath, 'utf8'))
    const entry = man.derived.find((d) => d.path.includes('tool-contracts'))
    entry.sha256 = sha256Text(bad)
    writeFileSync(manPath, dumpYaml(man), 'utf8')
    try {
      readToolContracts(tmp)
      assert.fail('期望 DERIVED_DRIFT')
    } catch (err) {
      assert.ok(err instanceof AgentToolError, `期望 AgentToolError，得到 ${err}`)
      assert.equal(err.code, 'DERIVED_DRIFT')
      assert.ok(!err.message.includes(tmp), `不应泄露路径: ${err.message}`)
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
