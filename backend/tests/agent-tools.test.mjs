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
  assertNoForbiddenPhrases,
  assertRunContract,
  asToolError,
  configureDiffLlm,
  enforceOutputPolicy,
  renderRunText,
  reviseTopHitAdvice,
} from '../dist/agent-policy.js'
import {
  assertDatasetGranted,
  checkGrant,
  grantGuardDecision,
  grantMatches,
  pickContracts,
  projectByContract,
  readToolContracts,
} from '../dist/agent-grants.js'
import {
  loadDatasetFromArgs,
  loadToolPackage,
  projectPackageList,
  projectRecallHits,
  renderRecallText,
  renderAnnotateText,
  renderAbstractText,
  annotateExperienceForTool,
  abstractExperienceForTool,
  skillBodyCurrent,
  renderScenarioList,
  assertHumanApproved,
  createPackageForPkg,
  requireExistingPackage,
  saveSkeletonForPkg,
  ruleDossier,
  scenarioCatalog,
  sourceSummary,
  summarizePackage,
  uploadKnowledgeForPkg,
  validateDatasetShape,
} from '../dist/agent-tools.js'
import {
  HeuristicLlm,
  KnowledgeStore,
  PackageWorkspace,
  buildRunRecord,
  buildTaskSignature,
  derivePackage,
  dumpYaml,
  loadExperienceNote,
  loadPackage,
  loadRunRecord,
  loadYaml,
  reviewExperienceNote,
  runScenario,
  saveExperienceNote,
  saveRunRecord,
  sha256Text,
} from '@dsh-onto/core'

const AML_DIR = fileURLToPath(new URL('../../packages/aml/1.0.0', import.meta.url))
const AML_RUN = fileURLToPath(new URL('../../examples/aml-run.json', import.meta.url))
const REPO = fileURLToPath(new URL('../../', import.meta.url))
// datasetPath 工作目录围栏（tool-face-policy P2.1）：测试显式指定围栏根为仓库根。
const BASE = { baseDir: REPO }

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
  const ds = loadDatasetFromArgs({ datasetPath: AML_RUN }, BASE)
  assert.ok(Array.isArray(ds.candidates) && ds.candidates.length > 0)
  assert.ok(Array.isArray(ds.objects) && Array.isArray(ds.relations))
})

test('数据双通道：坏路径与坏 JSON 均拒绝', () => {
  expectCode(() => loadDatasetFromArgs({ datasetPath: 'Z:\\not\\exist\\nope.json' }), 'INVALID_ARGS')
  const tmp = mkdtempSync(join(tmpdir(), 'onto-ds-'))
  try {
    writeFileSync(join(tmp, 'bad.json'), '{ not json', 'utf8')
    expectCode(() => loadDatasetFromArgs({ datasetPath: join(tmp, 'bad.json') }, { baseDir: tmp }), 'INVALID_ARGS')
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
  const dataset = loadDatasetFromArgs({ datasetPath: AML_RUN }, BASE)
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
  const dataset = loadDatasetFromArgs({ datasetPath: AML_RUN }, BASE)
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
  const dataset = loadDatasetFromArgs({ datasetPath: AML_RUN }, BASE)
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

test('recall_experience 渲染（N4/P4-5/E1-2）：字段级对照；冷启动不硬迁；差异转人工；reviewFocus 上墙', () => {
  // 冷启动：不硬迁移话术
  const cold = renderRecallText({ coldStart: true, hits: [], advice: 'x' })
  assert.match(cold, /冷启动/)
  assert.match(cold, /不硬迁移/)

  // 命中：打分行 + 字段级对照行 + 低置信度转人工 + 下轮复核提示
  const hit = renderRecallText({
    coldStart: false,
    hits: [{
      runId: 'run-abc12345',
      score: 0.9,
      outcome: 'success',
      counterexample: false,
      reasons: [
        '同 scenarioId',
        'stepShape 一致',
        '规则/技能 Jaccard=1.00',
        'scenarioId 同（SCN-AML-FIND-CLUES）',
        'dataBand 同（S）',
        'ruleRefs 共有5/新独有0/源独有0',
        'skillRefs 共有1/新独有0/源独有0',
        'inputShape 同（taxpayerId:string）',
      ],
      reviewFocus: ['listHitCount', '集中转入'],
    }],
    advice: '低置信度：结构位差异（ruleRefs）→ 转人工确认后方可复用',
  })
  assert.match(hit, /run-abc12345/)
  assert.match(hit, /score=0\.90/)
  assert.match(hit, /打分：/)
  assert.match(hit, /字段对照：/)
  assert.match(hit, /scenarioId 同（SCN-AML-FIND-CLUES）/)
  assert.match(hit, /ruleRefs 共有5\/新独有0\/源独有0/)
  assert.match(hit, /Jaccard=1\.00/)
  assert.match(hit, /转人工/)
  // E1-2：下轮复核提示随命中上墙
  assert.match(hit, /复核提示\[listHitCount, 集中转入\]/)
  // 无自由流程描述（不出现步骤编造词）
  assert.doesNotMatch(hit, /执行流程|步骤图|自由/)

  // reviewFocus 为空则不出现复核提示段（不渲染空括号）
  const noFocus = renderRecallText({
    coldStart: false,
    hits: [{
      runId: 'run-empty01',
      score: 0.8,
      outcome: 'success',
      counterexample: false,
      reasons: ['同 scenarioId'],
      reviewFocus: [],
    }],
    advice: 'x',
  })
  assert.ok(!noFocus.includes('复核提示'), `空 reviewFocus 不得渲染复核提示: ${noFocus}`)
})

test('recall_experience 字段级理由经工具投影（P4-5 源断言）', () => {
  const src = readFileSync(join(REPO, 'backend', 'src', 'agent-tools.ts'), 'utf8')
  assert.ok(src.includes('字段级 signature 新旧对照'), '工具描述须声明字段级对照')
  const coreSrc = readFileSync(join(REPO, 'core', 'src', 'experience.ts'), 'utf8')
  assert.ok(coreSrc.includes('signatureFieldReasons'), 'core 须导出 signatureFieldReasons')
  assert.ok(coreSrc.includes('reasons.push(...signatureFieldReasons'), 'retrieveSimilar 须挂字段级理由')
})

test('E1-2：recall execute 投影 reviewFocus，render 上墙复核提示（源断言）', () => {
  const src = readFileSync(join(REPO, 'backend', 'src', 'agent-tools.ts'), 'utf8')
  const recallIdx = src.indexOf("name: 'recall_experience'")
  const annotateIdx = src.indexOf("name: 'annotate_experience'")
  assert.ok(recallIdx > 0 && annotateIdx > recallIdx)
  const recallSlice = src.slice(recallIdx, annotateIdx)
  // execute：命中投影走 projectRecallHits（带 note.reviewFocus ?? []）
  assert.ok(recallSlice.includes('projectRecallHits'), 'recall execute 须走 projectRecallHits')
  const projIdx = src.indexOf('export function projectRecallHits')
  assert.ok(projIdx > 0, '须导出 projectRecallHits 纯函数')
  assert.ok(
    src.includes('reviewFocus: h.note.reviewFocus ?? []'),
    'projectRecallHits 须投影 h.note.reviewFocus ?? []',
  )
  // render：复核提示上墙且挂 retreatRenderText 兜底
  assert.ok(recallSlice.includes('renderRecallText'), 'recall render 须走 renderRecallText')
  assert.ok(src.includes('复核提示['), 'renderRecallText 须渲染复核提示')
  assert.ok(src.includes('retreatRenderText'), 'renderRecallText 须挂 retreatRenderText 兜底')
  // 描述须声明 reviewFocus 可发现
  assert.ok(recallSlice.includes('reviewFocus'), '工具描述须声明 reviewFocus')
  // 打分语义不碰：rules.ts 不得引用 experience
  const rulesSrc = readFileSync(join(REPO, 'core', 'src', 'rules.ts'), 'utf8')
  assert.ok(!rulesSrc.includes('experience'), 'rules.ts 不得引用 experience（经验只提示不改分）')
})

test('E1-2：projectRecallHits 纯函数——reviewFocus 缺省 []，score 两位小数', () => {
  const hits = projectRecallHits([
    {
      note: {
        runId: 'run-e12a',
        outcome: 'success',
        counterexample: false,
        reviewFocus: ['listHitCount'],
      },
      score: 0.906,
      reasons: ['digest 同构'],
    },
    {
      note: {
        runId: 'run-e12b',
        outcome: 'partial',
        counterexample: true,
      },
      score: 0.7,
      reasons: ['同 scenarioId'],
    },
  ])
  assert.equal(hits.length, 2)
  assert.deepEqual(hits[0].reviewFocus, ['listHitCount'])
  assert.equal(hits[0].score, 0.91)
  assert.deepEqual(hits[1].reviewFocus, [], '缺省 reviewFocus 须为 []')
  assert.equal(hits[1].score, 0.7)
  assert.equal(hits[1].counterexample, true)
  assert.equal(hits[0].reasons[0], 'digest 同构')
  // 打分语义不碰：投影只透传 score，不重算
  assert.equal(hits[0].score, Number((0.906).toFixed(2)))
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

test('人审契约：apply_draft/reject_draft 的 humanApproved 必须显式为 true（I1/I5）', () => {
  // 通过：仅 true
  assert.doesNotThrow(() => assertHumanApproved(true, '批准'))
  // 拒绝：缺省 / 假值 / 非布尔（模型手误）——agent 不得自行审定
  for (const v of [undefined, null, false, 'true', 1]) {
    expectCode(() => assertHumanApproved(v, '批准'), 'INVALID_ARGS')
    expectCode(() => assertHumanApproved(v, '驳回'), 'INVALID_ARGS')
  }
})

test('D6：apply_draft 描述明示物化后自动重派生（防回退到手动 derive 提权）', () => {
  const src = readFileSync(join(REPO, 'backend', 'src', 'agent-tools.ts'), 'utf8')
  const at = src.indexOf("name: 'apply_draft'")
  assert.ok(at >= 0, 'apply_draft 工具须在源中登记')
  const window = src.slice(at, at + 900)
  assert.ok(
    window.includes('物化成功后自动重派生'),
    'apply_draft 描述须告知物化后自动重派生（D6）',
  )
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

test('收权：versionDir 消毒拒绝保留 PACKAGE_MALFORMED 码（不退化 UNKNOWN_ERROR）', () => {
  const ws = new PackageWorkspace(mkdtempSync(join(tmpdir(), 'onto-guard-ws-')))
  try {
    // 与 apply() 装配同形的 readContracts 接线：穿越入参在 versionDir 即抛 PackageStoreError
    const denial = grantGuardDecision(
      'list_tool_contracts',
      { objectId: 'OBJ-AML-ACCOUNT', name: '..', version: '..' },
      (n, v) => readToolContracts(ws.versionDir(n, v)),
    )
    assert.match(denial, /^PACKAGE_MALFORMED: /)
    assert.ok(!denial.includes(ws.root), `不应泄露工作区路径: ${denial}`)
  } finally {
    rmSync(ws.root, { recursive: true, force: true })
  }
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
  const dataset = loadDatasetFromArgs({ datasetPath: AML_RUN }, BASE)
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

  // typeof NaN === 'number'，纯 typeof 拦不住——非有限数一律拒绝（防核心回归）
  for (const bad of [NaN, Infinity, -Infinity, '0.5', null, undefined]) {
    expectCode(
      () => assertRunContract({ ...good, candidates: [{ ...good.candidates[0], riskScore: bad }] }),
      'INVALID_TOOL_OUTPUT',
    )
  }
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

test('D1 方案 B：相对路径读取失败给出可复制 dataset 内联示例（不再只报「无法读取」）', () => {
  // 相对路径按 process.cwd() 解析且落在默认围栏内，但文件不存在 → 走读取失败分支
  // （模拟会话 cwd 与仓库不一致时 examples/aml-run.json 读不到的 D1 场景）。
  const rel = 'no-such-d1-relative-dataset.json'
  let caught
  try {
    loadDatasetFromArgs({ datasetPath: rel })
    assert.fail('期望 INVALID_ARGS')
  } catch (e) {
    caught = e
  }
  assert.ok(caught instanceof AgentToolError, `期望 AgentToolError，得到 ${caught}`)
  assert.equal(caught.code, 'INVALID_ARGS')
  assert.ok(caught.message.includes(rel), `应回显调用方原文: ${caught.message}`)
  assert.ok(caught.message.includes('无法读取'), `应保留读取失败语义: ${caught.message}`)
  assert.ok(caught.message.includes('dataset 内联'), `须指引内联恢复: ${caught.message}`)
  assert.ok(
    caught.message.includes('{"objects":[],"relations":[],"candidates":[]}'),
    `须附可复制内联示例: ${caught.message}`,
  )
  // 内联示例本身必须过形状校验（调用方可原样粘贴恢复）
  const example = JSON.parse(caught.message.slice(caught.message.indexOf('{"objects"')))
  assert.doesNotThrow(() => validateDatasetShape(example))
  // 错误面不回显 resolve 后绝对路径（含 cwd 盘符路径）
  assert.ok(!/^[A-Za-z]:\\/.test(caught.message.split(': ').pop()), `不得泄漏绝对路径: ${caught.message}`)
})

test('D2 数据集发现引导：run/invoke 工具描述与读取失败信封均指明 examples/ 样例位置', () => {
  // 1) 源断言：三个执行工具的描述/参数描述含样例目录引导（防文案回退）
  const toolsSrc = readFileSync(join(REPO, 'backend', 'src', 'agent-tools.ts'), 'utf8')
  const expertsSrc = readFileSync(join(REPO, 'backend', 'src', 'agent-experts.ts'), 'utf8')
  for (const [label, src] of [['agent-tools', toolsSrc], ['agent-experts', expertsSrc]]) {
    const hits = src.split('examples/').length - 1
    assert.ok(hits >= 2, `${label} 至少两处 examples/ 样例引导（描述 + 参数/信封），实际 ${hits}`)
    assert.ok(src.includes('aml-run.json'), `${label} 须点名 aml-run.json 样例`)
    assert.ok(src.includes('dataset 内联'), `${label} 须给出 dataset 内联恢复路径`)
  }
  // run_scenario / run_scenarios / invoke_expert 三工具均被覆盖
  assert.ok(toolsSrc.includes("name: 'run_scenario'") && toolsSrc.includes("name: 'run_scenarios'"))
  assert.ok(expertsSrc.includes("name: 'invoke_expert'"))

  // 2) 错误信封在场：读取失败时引导至 examples/ 样例 + 内联
  let caught
  try {
    loadDatasetFromArgs({ datasetPath: 'no-such-d2-relative-dataset.json' })
    assert.fail('期望 INVALID_ARGS')
  } catch (e) {
    caught = e
  }
  assert.ok(caught instanceof AgentToolError, `期望 AgentToolError，得到 ${caught}`)
  assert.ok(caught.message.includes('examples/'), `读取失败信封须指明样例目录: ${caught.message}`)
  assert.ok(caught.message.includes('aml-run.json'), `读取失败信封须点名样例文件: ${caught.message}`)
  // 信封仍不泄漏绝对路径（D1 不变量不回退）
  assert.ok(!/^[A-Za-z]:\\/.test(caught.message.split(': ').pop()), `不得泄漏绝对路径: ${caught.message}`)
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
    // 入库 packageId 为裸名：工作台按裸名可见；过滤亦归一，name@version 同样命中
    assert.equal(src.packageId, 'aml-analysis')
    assert.equal(store.listSources('aml-analysis').length, 1)
    assert.equal(store.listSources('aml-analysis@1.0.0').length, 1)
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

test('错误信封：保留错误码与业务语义、剥服务端目录；原生 fs 错误只留机器码', () => {
  const dir = 'D:\\secret\\workspace\\aml\\1.0.0'
  const e = Object.assign(new Error(`missing package.yaml meta in ${dir}`), {
    code: 'PACKAGE_MALFORMED',
  })
  const wrapped = asToolError(e, [dir])
  assert.ok(wrapped instanceof AgentToolError, `期望 AgentToolError，得到 ${wrapped}`)
  assert.equal(wrapped.code, 'PACKAGE_MALFORMED')
  assert.ok(!wrapped.message.includes('D:\\secret'), `不应泄露路径: ${wrapped.message}`)
  assert.ok(wrapped.message.includes('<pkg>'))
  // 非 Error / 无 code → RUN_FAILED
  assert.equal(asToolError('boom', [dir]).code, 'RUN_FAILED')
  // 不含服务端目录的业务语义原样保留
  const nf = Object.assign(new Error('场景不存在: SCN-X'), { code: 'SCENARIO_NOT_FOUND' })
  assert.equal(asToolError(nf, [dir]).message, '场景不存在: SCN-X')
  // 空 redact 项不剥串——split('') 会逐字符打散
  const plain = asToolError(new Error('invalid package path: x@../y'), [''])
  assert.equal(plain.message, 'invalid package path: x@../y')
  // Windows 路径大小写不敏感：大小写变体同样剥离
  const cased = asToolError(
    Object.assign(new Error('missing package.yaml meta in C:\\Users\\Demo\\pkg'), { code: 'PACKAGE_MALFORMED' }),
    ['c:\\users\\demo\\pkg'],
  )
  assert.ok(!cased.message.toLowerCase().includes('demo\\pkg'), `大小写变体不得回显: ${cased.message}`)
  assert.ok(cased.message.includes('<pkg>'))
  // 原生 fs 错误（errno 词形码）：只留机器码，原文（含绝对路径）不入模型面（I2）
  const fsErr = Object.assign(new Error('ENOENT: open C:\\Users\\Demo\\pkg\\package.yaml'), { code: 'ENOENT' })
  const enoent = asToolError(fsErr, ['c:\\users\\demo\\pkg'])
  assert.equal(enoent.code, 'ENOENT')
  assert.ok(!enoent.message.includes('open'), `fs 原文不得回显: ${enoent.message}`)
  assert.ok(!enoent.message.toLowerCase().includes('demo\\pkg'))
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
  const dataset = loadDatasetFromArgs({ datasetPath: AML_RUN }, BASE)
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

test('dataset 收权：实例 id 解析到类型过 grantScope，未收权/无法解析拒绝', () => {
  const contracts = readToolContracts(AML_DIR)
  const ds = (objects, refs) => ({
    objects,
    relations: [],
    candidates: refs.map((objectRef, i) => ({
      candidateId: `c${i + 1}`,
      objectRef,
      features: {},
      tags: [],
    })),
  })
  // 实例 id → objects[].type（examples/aml-run.json 同形）
  assertDatasetGranted(
    ds([{ id: 'ACCT-001', type: 'OBJ-AML-ACCOUNT', attrs: {} }], ['ACCT-001']),
    contracts,
  )
  // 类型段直引与实例段
  assertDatasetGranted(ds([], ['OBJ-AML-CUSTOMER']), contracts)
  assertDatasetGranted(ds([], ['OBJ-AML-ACCOUNT:x']), contracts)
  // 实例解析出的类型未收权 → 拒绝
  expectCode(
    () =>
      assertDatasetGranted(
        ds([{ id: 'g1', type: 'OBJ-NOPE', attrs: {} }], ['g1']),
        contracts,
      ),
    'OBJECT_NOT_GRANTED',
  )
  // 无法解析的裸 ref（deny-by-default）
  expectCode(() => assertDatasetGranted(ds([], ['GHOST-9']), contracts), 'OBJECT_NOT_GRANTED')
})

test('dataset 收权：验收样例 aml-run.json 引用全部在收权面内（防误伤）', () => {
  const contracts = readToolContracts(AML_DIR)
  const dataset = loadDatasetFromArgs({ datasetPath: AML_RUN }, BASE)
  assertDatasetGranted(dataset, contracts)
})

// ── 终审修复回归：dataset 收权双旁路（重复 id / 类型段伪托） / NaN 分数 / 禁语整体脱敏 ──

test('dataset 收权：重复实例 id 一律拒绝（同 id 异型不可伪托已收权类型）', () => {
  const contracts = readToolContracts(AML_DIR)
  const ds = (objects, refs) => ({
    objects,
    relations: [],
    candidates: refs.map((objectRef, i) => ({
      candidateId: `c${i + 1}`,
      objectRef,
      features: {},
      tags: [],
    })),
  })
  // 同 id 异型：首条未收权、复制品收权——旧实现 Map 后者覆盖前者会放行
  expectCode(
    () =>
      assertDatasetGranted(
        ds(
          [
            { id: 'g1', type: 'OBJ-NOPE', attrs: {} },
            { id: 'g1', type: 'OBJ-AML-ACCOUNT', attrs: {} },
          ],
          ['g1'],
        ),
        contracts,
      ),
    'OBJECT_NOT_GRANTED',
  )
  // 复制品带类型段形态同样拒绝
  expectCode(
    () =>
      assertDatasetGranted(
        ds(
          [
            { id: 'g1', type: 'OBJ-NOPE', attrs: {} },
            { id: 'g1', type: 'OBJ-AML-ACCOUNT', attrs: {} },
          ],
          ['OBJ-AML-ACCOUNT:g1'],
        ),
        contracts,
      ),
    'OBJECT_NOT_GRANTED',
  )
  // 单一声明且类型未收权仍拒绝（原行为不回退）
  expectCode(
    () =>
      assertDatasetGranted(
        ds([{ id: 'g1', type: 'OBJ-NOPE', attrs: {} }], ['OBJ-AML-ACCOUNT:g1']),
        contracts,
      ),
    'OBJECT_NOT_GRANTED',
  )
})

test('dataset 收权：类型段伪托拒绝——实例在图中以声明类型为准，与前缀不符即拒', () => {
  const contracts = readToolContracts(AML_DIR)
  const ds = (objects, refs) => ({
    objects,
    relations: [],
    candidates: refs.map((objectRef, i) => ({
      candidateId: `c${i + 1}`,
      objectRef,
      features: {},
      tags: [],
    })),
  })
  // 实例声明为未收权类型，ref 带已收权类型前缀——伪托放行（旧实现按前缀匹配）
  expectCode(
    () =>
      assertDatasetGranted(
        ds([{ id: 'c1', type: 'OBJ-NOPE', attrs: {} }], ['OBJ-AML-ACCOUNT:c1']),
        contracts,
      ),
    'OBJECT_NOT_GRANTED',
  )
  // 实例声明为已收权类型但前缀指向另一类型——不一致即拒（不以放行掩盖越权）
  expectCode(
    () =>
      assertDatasetGranted(
        ds([{ id: 'c1', type: 'OBJ-AML-CUSTOMER', attrs: {} }], ['OBJ-AML-ACCOUNT:c1']),
        contracts,
      ),
    'OBJECT_NOT_GRANTED',
  )
  // 声明类型与前缀一致且已收权——放行
  assertDatasetGranted(
    ds([{ id: 'c1', type: 'OBJ-AML-ACCOUNT', attrs: {} }], ['OBJ-AML-ACCOUNT:c1']),
    contracts,
  )
  // 实例不在图中：回退类型段匹配（运行时实例段既有口径）
  assertDatasetGranted(ds([], ['OBJ-AML-ACCOUNT:x']), contracts)
})

// ── 第 10 轮修复回归：dataset 元素形状 / excluded 契约 / 禁语渲染脱敏 / 内联 e2e ──

test('dataset 形状：objects/relations/behaviors 畸形元素落 INVALID_ARGS（不裸抛 TypeError）', () => {
  expectCode(() => validateDatasetShape({ objects: [null], relations: [], candidates: [] }), 'INVALID_ARGS')
  expectCode(
    () =>
      validateDatasetShape({
        objects: [{ id: 'A', type: 'T' }],
        relations: [{ id: 'R', type: 'RT', from: 'A' }],
        candidates: [],
      }),
    'INVALID_ARGS',
  )
  expectCode(
    () => validateDatasetShape({ objects: [{ id: 1, type: 'T' }], relations: [], candidates: [] }),
    'INVALID_ARGS',
  )
  expectCode(
    () => validateDatasetShape({ objects: [], relations: [], candidates: [], behaviors: [null] }),
    'INVALID_ARGS',
  )
  const ok = validateDatasetShape({
    objects: [{ id: 'A', type: 'T', attrs: {} }],
    relations: [{ id: 'R', type: 'RT', from: 'A', to: 'B' }],
    candidates: [],
  })
  assert.equal(ok.objects.length, 1)
})

test('dataset 形状：object 实例 ID 重复一律拒绝（收权解析歧义，INVALID_ARGS）', () => {
  expectCode(
    () =>
      validateDatasetShape({
        objects: [
          { id: 'g1', type: 'OBJ-NOPE' },
          { id: 'g1', type: 'OBJ-AML-ACCOUNT' },
        ],
        relations: [],
        candidates: [],
      }),
    'INVALID_ARGS',
  )
  // 同型重复同样拒绝（图中 id 必须唯一）
  expectCode(
    () =>
      validateDatasetShape({
        objects: [
          { id: 'g1', type: 'OBJ-AML-ACCOUNT' },
          { id: 'g1', type: 'OBJ-AML-ACCOUNT' },
        ],
        relations: [],
        candidates: [],
      }),
    'INVALID_ARGS',
  )
})

test('装配断言：excluded 形状校验（非数组/畸形条目即 INVALID_TOOL_OUTPUT）', () => {
  const dataset = loadDatasetFromArgs({ datasetPath: AML_RUN }, BASE)
  const good = runScenario(AML_DIR, 'SCN-AML-FIND-CLUES', dataset)
  assert.doesNotThrow(() => assertRunContract(good))
  expectCode(() => assertRunContract({ ...good, excluded: 'not-array' }), 'INVALID_TOOL_OUTPUT')
  expectCode(() => assertRunContract({ ...good, excluded: [null] }), 'INVALID_TOOL_OUTPUT')
  expectCode(() => assertRunContract({ ...good, excluded: [{ candidateId: 'x' }] }), 'INVALID_TOOL_OUTPUT')
})

test('renderRunText：禁语命中时渲染文本脱敏（含叙述/证据行），排除行在场', () => {
  const dataset = loadDatasetFromArgs({ datasetPath: AML_RUN }, BASE)
  const result = runScenario(AML_DIR, 'SCN-AML-FIND-CLUES', dataset)
  const text = renderRunText(result)
  // aml-run.json 实产出排除项（CAND-003 / RULE-AML-EXCL-WHITELIST）
  assert.ok(result.excluded.length > 0, '验收样例应产出排除项')
  for (const x of result.excluded) {
    assert.ok(text.includes(`排除: ${x.candidateId}（${x.ruleId}）`), `渲染应含排除行: ${x.candidateId}`)
  }
  assert.ok(result.excluded.some((x) => x.candidateId === 'CAND-003'), '验收样例应排除 CAND-003')
  // 真实命中形态：短语在 narrative/evidence 里（特征插值/模板回填），命中登记指向这些位置——
  // 渲染文本（模型可见面）必须整体脱敏；core/wire 人审面保留原文（工具出口由 enforceOutputPolicy 收口）。
  const hitPhrase = '确定为洗钱'
  const hit = {
    ...result,
    candidates: result.candidates.map((c, i) =>
      i === 0
        ? {
            ...c,
            narrative: [...c.narrative, `本条叙述${hitPhrase}`],
            evidenceChains: [
              ...c.evidenceChains,
              { ruleId: 'RULE-AML-SCORE-FANOUT', score: 0.5, evidence: `证据${hitPhrase}` },
            ],
          }
        : c,
    ),
    audit: {
      ...result.audit,
      forbiddenPhraseHits: [
        { phrase: hitPhrase, where: 'candidates[0].narrative[0]' },
        { phrase: hitPhrase, where: 'candidates[0].evidenceChains[0].evidence' },
      ],
    },
  }
  const hitText = renderRunText(hit)
  assert.ok(!hitText.includes(hitPhrase), '渲染文本不得回显禁语短语（叙述/证据行也须脱敏）')
  assert.ok(hitText.includes('【禁语已脱敏】'), '脱敏标记在场')
  assert.match(hitText, /禁语扫描: 2 命中/)
  assert.match(hitText, /禁语命中 @ candidates\[0\]\.narrative\[0\]/)
  // core/wire 人审面保留完整短语（renderRunText 不改写入参；工具出口 canonical 值经 enforceOutputPolicy 裁剪）
  assert.equal(hit.audit.forbiddenPhraseHits[0].phrase, hitPhrase)
  assert.ok(
    hit.candidates[0].narrative.some((n) => n.includes(hitPhrase)),
    'core 结构面保留原文供人审',
  )
})

test('数据形状：空串 id/objectRef/type 一律拒绝（与顶层 guard 口径对称）', () => {
  expectCode(() => validateDatasetShape({ objects: [{ id: '', type: 'T' }], relations: [], candidates: [] }), 'INVALID_ARGS')
  expectCode(() => validateDatasetShape({ objects: [{ id: 'O', type: '' }], relations: [], candidates: [] }), 'INVALID_ARGS')
  expectCode(
    () => validateDatasetShape({ objects: [], relations: [{ id: 'R', type: '', from: 'a', to: 'b' }], candidates: [] }),
    'INVALID_ARGS',
  )
  expectCode(
    () => validateDatasetShape({ objects: [], relations: [], candidates: [{ candidateId: '', objectRef: 'X', features: {}, tags: [] }] }),
    'INVALID_ARGS',
  )
  expectCode(
    () => validateDatasetShape({ objects: [], relations: [], candidates: [{ candidateId: 'C', objectRef: '', features: {}, tags: [] }] }),
    'INVALID_ARGS',
  )
  const ok = validateDatasetShape({
    objects: [{ id: 'A1', type: 'OBJ-AML-ACCOUNT' }],
    relations: [],
    candidates: [{ candidateId: 'C1', objectRef: 'A1', features: {}, tags: [] }],
  })
  assert.equal(ok.candidates[0].objectRef, 'A1')
})

test('工具出口禁语脱敏：结构面不回显短语本体（count/where 保留）', () => {
  const dataset = loadDatasetFromArgs({ datasetPath: AML_RUN }, BASE)
  const result = runScenario(AML_DIR, 'SCN-AML-FIND-CLUES', dataset)
  const hitPhrase = '确定为洗钱'
  const hit = {
    ...result,
    audit: {
      ...result.audit,
      checks: [{ check: 'O3_CLOSED', closed: true, detail: `禁语命中: ${hitPhrase}@candidates[0].narrative[0]`, ts: 't' }],
      forbiddenPhraseHits: [{ phrase: hitPhrase, where: 'candidates[0].narrative[0]' }],
    },
  }
  const masked = enforceOutputPolicy(hit)
  const face = JSON.stringify(masked.audit)
  assert.ok(!face.includes(hitPhrase), `工具出口结构面不得回显短语: ${face}`)
  assert.ok(face.includes('【禁语已脱敏】'), '脱敏标记在场')
  assert.equal(masked.audit.forbiddenPhraseHits.length, 1)
  assert.equal(masked.audit.forbiddenPhraseHits[0].where, 'candidates[0].narrative[0]')
  // phrase 字段空化：不回显短语本体（round-13 复审改定——同时是幂等锚点：
  // 二次脱敏时 needle 为空即同引用返回，不依赖「标记 vs 短语恰为标记」的歧义判断）
  assert.equal(masked.audit.forbiddenPhraseHits[0].phrase, '')
  assert.equal(masked.humanReviewRequired, true)
  // 候选/证据面原样（裁剪只发生在 audit）
  assert.deepEqual(masked.candidates, result.candidates)
  // 无命中时原样返回（同引用，零拷贝开销）
  assert.equal(enforceOutputPolicy(result), result)
  // renderRunText 对已脱敏结果幂等（不再回显、计数不变）
  const text = renderRunText(masked)
  assert.ok(!text.includes(hitPhrase))
  assert.match(text, /禁语扫描: 1 命中/)
})

test('端到端：内联 dataset 走 runScenario 与 datasetPath 同契约', () => {
  const inline = loadDatasetFromArgs({ dataset: JSON.parse(readFileSync(AML_RUN, 'utf8')) })
  const result = runScenario(AML_DIR, 'SCN-AML-FIND-CLUES', inline)
  assertRunContract(result)
  assert.equal(result.humanReviewRequired, true)
  assert.ok(result.candidates.length > 0)
  assert.ok(result.candidates.some((c) => c.hitRuleIds.length > 0))
})

test('D3 create_package：DRAFT 空包、缺参拒绝、同名同版本 PACKAGE_EXISTS 拒绝、不回显路径', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'onto-d3-'))
  try {
    const ws = new PackageWorkspace(join(tmp, 'workspace'))
    const r = createPackageForPkg(ws, { name: 'd3-demo', version: '1.0.0', domain: 'D3T' })
    assert.equal(r.status, 'DRAFT')
    assert.equal(r.name, 'd3-demo')
    assert.equal(r.domain, 'D3T')
    assert.ok(!('dir' in r), '不回显服务端路径')
    // 同名同版本拒绝（幂等不覆盖）
    expectCode(() => createPackageForPkg(ws, { name: 'd3-demo', version: '1.0.0', domain: 'D3T' }), 'PACKAGE_EXISTS')
    // 缺参 / 空白
    expectCode(() => createPackageForPkg(ws, { name: ' ', version: '1.0.0', domain: 'D3T' }), 'INVALID_ARGS')
    expectCode(() => createPackageForPkg(ws, { name: 'x', version: '', domain: 'D3T' }), 'INVALID_ARGS')
    // 包名 kebab-case、域码大写字母数字（与工具描述一致）
    expectCode(() => createPackageForPkg(ws, { name: 'Bad_Name', version: '1.0.0', domain: 'D3T' }), 'INVALID_ARGS')
    expectCode(() => createPackageForPkg(ws, { name: 'ok-name', version: '1.0.0', domain: 'd3t' }), 'INVALID_ARGS')
    expectCode(() => createPackageForPkg(ws, { name: 'ok-name', version: '1.0.0', domain: 'D3T-X' }), 'INVALID_ARGS')
    // 真实落盘且为空包
    const pkg = loadPackage(ws.versionDir('d3-demo', '1.0.0'))
    assert.equal(pkg.meta.status, 'DRAFT')
    assert.equal(pkg.objects.length, 0)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('D3 save_skeleton：humanApproved 契约 + ID 语法/去重 + 包存在性 + ISSUED 拒绝', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'onto-d3s-'))
  try {
    const ws = new PackageWorkspace(join(tmp, 'workspace'))
    ws.createPackage({ name: 'd3-sk', version: '1.0.0', domain: 'D3S' })
    const knowledge = new KnowledgeStore(tmp)
    const versions = ws.listVersions()
    const base = { packageId: 'd3-sk@1.0.0', domainCode: 'D3S', ids: ['OBJ-D3S-A', 'dict-d3s-k'] }

    // 未点头 → 人审契约拒绝
    expectCode(() => saveSkeletonForPkg(knowledge, ws, versions, { ...base, humanApproved: false }), 'INVALID_ARGS')
    // 点头 → 落盘 confirmed=true
    const rec = saveSkeletonForPkg(knowledge, ws, versions, { ...base, humanApproved: true })
    assert.equal(rec.confirmed, true)
    assert.equal(rec.domainCode, 'D3S')
    const stored = knowledge.skeletons.get('d3-sk')
    assert.deepEqual(stored.ids, ['OBJ-D3S-A', 'dict-d3s-k'])
    assert.equal(stored.confirmed, true)

    // ID 语法 / 空 / 重复 → 拒绝
    expectCode(
      () => saveSkeletonForPkg(knowledge, ws, versions, { ...base, ids: ['not an id'], humanApproved: true }),
      'INVALID_ARGS',
    )
    expectCode(() => saveSkeletonForPkg(knowledge, ws, versions, { ...base, ids: [], humanApproved: true }), 'INVALID_ARGS')
    expectCode(
      () => saveSkeletonForPkg(knowledge, ws, versions, { ...base, ids: ['OBJ-D3S-A', 'OBJ-D3S-A'], humanApproved: true }),
      'INVALID_ARGS',
    )
    // 缺 domainCode
    expectCode(
      () => saveSkeletonForPkg(knowledge, ws, versions, { ...base, domainCode: '', humanApproved: true }),
      'INVALID_ARGS',
    )
    // 包不存在 / 非 name@version
    expectCode(
      () => saveSkeletonForPkg(knowledge, ws, versions, { ...base, packageId: 'ghost@1.0.0', humanApproved: true }),
      'NOT_FOUND',
    )
    expectCode(
      () => saveSkeletonForPkg(knowledge, ws, versions, { ...base, packageId: 'd3-sk', humanApproved: true }),
      'INVALID_ARGS',
    )

    // ISSUED 包只读（状态机两步走到 ISSUED）
    ws.transition('d3-sk', '1.0.0', 'IN_REVIEW')
    ws.transition('d3-sk', '1.0.0', 'ISSUED', 'tester（人工）')
    expectCode(
      () => saveSkeletonForPkg(knowledge, ws, ws.listVersions(), { ...base, humanApproved: true }),
      'PACKAGE_READONLY',
    )
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('D12：datasetPath 围栏可发现性——越界报错指引内联，参数描述明示工作目录围栏', () => {
  // 1) 越界报错带恢复指引（不再只说「越出工作目录」）
  const tmp = mkdtempSync(join(tmpdir(), 'onto-d12-'))
  try {
    expectCode(() => loadDatasetFromArgs({ datasetPath: join(tmp, 'x.json') }, { baseDir: REPO }), 'INVALID_ARGS')
    try {
      loadDatasetFromArgs({ datasetPath: join(tmp, 'x.json') }, { baseDir: REPO })
      assert.fail('期望越界拒绝')
    } catch (e) {
      assert.ok(e instanceof AgentToolError)
      assert.ok(e.message.includes('内联'), '越界报错须指引 dataset 内联: ' + e.message)
      assert.ok(e.message.includes('围栏'), '越界报错须点明围栏语义: ' + e.message)
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }

  // 2) 工具面参数/描述明示围栏（源断言，防文案回退）
  const src = readFileSync(join(REPO, 'backend', 'src', 'agent-tools.ts'), 'utf8')
  const hits = src.split('仅限平台进程工作目录').length - 1
  assert.ok(hits >= 2, 'run_scenario 与 run_scenarios 的 datasetPath 描述均须明示围栏')
  assert.ok(src.includes('会话工作区或外部夹具请改用 dataset 内联') || src.includes('会话工作区或外部夹具请改用 dataset 内联')
    || src.includes('外部夹具请用 dataset 内联') || src.includes('会话工作区、外部夹具请改用 dataset 内联'),
    '描述须给出内联恢复路径')
})

/* ── P4-3 annotate_experience（N5） ── */

function mkAnnotateFixture({ auditPassed = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'onto-ann-'))
  const ws = new PackageWorkspace(join(root, 'workspace'))
  const dir = ws.versionDir('aml-analysis', '1.0.0')
  cpSync(AML_DIR, dir, { recursive: true })
  derivePackage(dir)
  const dataset = loadDatasetFromArgs({ datasetPath: AML_RUN }, { baseDir: REPO })
  const result = runScenario(dir, 'SCN-AML-FIND-CLUES', dataset)
  if (!auditPassed) {
    result.audit = { ...result.audit, passed: false }
  }
  const rec = buildRunRecord({
    package: { name: 'aml-analysis', version: '1.0.0' },
    dataset,
    result,
    redlines: [],
  })
  saveRunRecord(ws.root, rec)
  return { root, ws, runId: rec.runId }
}

test('annotate_experience：humanApproved 契约 + 新建/回填 + 误迁移 by 非空（N5）', () => {
  const { root, ws, runId } = mkAnnotateFixture()
  try {
    // 未点头 → 人审契约拒绝
    expectCode(
      () => annotateExperienceForTool(ws, { runId, outcome: 'success' }),
      'INVALID_ARGS',
    )
    // 无任何 patch 字段
    expectCode(
      () => annotateExperienceForTool(ws, { runId, humanApproved: true }),
      'INVALID_ARGS',
    )
    // 新建：outcome=success（审计已过）
    const created = annotateExperienceForTool(ws, {
      runId,
      outcome: 'success',
      outcomeReason: '三层闭合',
      reviewFocus: ['listHitCount'],
      humanApproved: true,
    })
    assert.equal(created.created, true)
    assert.equal(created.outcome, 'success')
    assert.equal(created.humanReviewRequired, true)
    assert.deepEqual(created.reviewFocus, ['listHitCount'])
    assert.equal(created.misTransferJudged, false)
    // 落盘可回读
    const note = loadExperienceNote(ws.root, runId)
    assert.equal(note.outcome, 'success')
    assert.equal(note.signature.scenarioId, 'SCN-AML-FIND-CLUES')

    // 回填：误迁移（by 非空人工身份）
    const patched = annotateExperienceForTool(ws, {
      runId,
      misTransfer: { judged: true, by: '张三', note: '复用到异域' },
      humanApproved: true,
    })
    assert.equal(patched.created, false)
    assert.equal(patched.misTransferJudged, true)
    assert.equal(patched.misTransferBy, '张三')

    // 误迁移 by 空白 → 拒（模型不自评 / 必须人工身份）
    expectCode(
      () =>
        annotateExperienceForTool(ws, {
          runId,
          misTransfer: { judged: true, by: '  ' },
          humanApproved: true,
        }),
      'INVALID_ARGS',
    )

    // 新建缺 outcome → 拒
    const second = mkAnnotateFixture()
    try {
      expectCode(
        () => annotateExperienceForTool(second.ws, { runId: second.runId, humanApproved: true }),
        'INVALID_ARGS',
      )
    } finally {
      rmSync(second.root, { recursive: true, force: true })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('annotate_experience：审计未过不得标 success（除非 counterexample）', () => {
  const { root, ws, runId } = mkAnnotateFixture({ auditPassed: false })
  try {
    expectCode(
      () => annotateExperienceForTool(ws, { runId, outcome: 'success', humanApproved: true }),
      'INVALID_ARGS',
    )
    // failure 可过
    const failed = annotateExperienceForTool(ws, {
      runId,
      outcome: 'failure',
      humanApproved: true,
    })
    assert.equal(failed.outcome, 'failure')
    // counterexample 可过 success
    const second = mkAnnotateFixture({ auditPassed: false })
    try {
      const counter = annotateExperienceForTool(second.ws, {
        runId: second.runId,
        outcome: 'success',
        counterexample: true,
        humanApproved: true,
      })
      assert.equal(counter.counterexample, true)
    } finally {
      rmSync(second.root, { recursive: true, force: true })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('annotate_experience 渲染（N5）：结构位回执、无自由流程、humanReviewRequired 在场', () => {
  const text = renderAnnotateText({
    runId: 'run-abc12345',
    outcome: 'success',
    counterexample: false,
    misTransferJudged: true,
    misTransferBy: '张三',
    reviewFocus: ['listHitCount'],
    created: false,
  })
  assert.match(text, /run-abc12345/)
  assert.match(text, /outcome=success/)
  assert.match(text, /回填/)
  assert.match(text, /误迁移 judged=true by=张三/)
  assert.match(text, /reviewFocus: listHitCount/)
  assert.match(text, /humanReviewRequired=true/)
  // 无自由流程描述、无服务端路径
  assert.doesNotMatch(text, /执行流程|步骤图|D:\\|workspace\//)
})

/* ── E2-1 abstract_experience ── */

function mkAbstractFixture() {
  const root = mkdtempSync(join(tmpdir(), 'onto-abs-'))
  const ws = new PackageWorkspace(join(root, 'workspace'))
  const dir = ws.versionDir('aml-analysis', '1.0.0')
  cpSync(AML_DIR, dir, { recursive: true })
  derivePackage(dir)
  const knowledge = new KnowledgeStore(root)
  const dataset = loadDatasetFromArgs({ datasetPath: AML_RUN }, BASE)
  const mkRun = () => {
    const result = runScenario(dir, 'SCN-AML-FIND-CLUES', dataset)
    const rec = buildRunRecord({
      package: { name: 'aml-analysis', version: '1.0.0' },
      dataset,
      result,
      redlines: [],
    })
    saveRunRecord(ws.root, rec)
    annotateExperienceForTool(ws, {
      runId: rec.runId,
      outcome: 'success',
      outcomeReason: '三层闭合',
      reviewFocus: ['listHitCount'],
      humanApproved: true,
    })
    return rec.runId
  }
  return { root, ws, knowledge, mkRun }
}

test('abstract_experience：humanApproved 契约 + 聚簇入队结构位回执（E2-1）', () => {
  const { root, ws, knowledge, mkRun } = mkAbstractFixture()
  try {
    // 未点头 → 人审契约拒绝
    expectCode(
      () => abstractExperienceForTool(ws, knowledge, { packageId: 'aml-analysis@1.0.0' }),
      'INVALID_ARGS',
    )
    // 单条经验不足簇 → 空回执（不硬凑）
    mkRun()
    const empty = abstractExperienceForTool(ws, knowledge, {
      packageId: 'aml-analysis@1.0.0',
      humanApproved: true,
    })
    assert.equal(empty.queued.length, 0)
    assert.equal(empty.skills, 0)
    assert.equal(empty.humanReviewRequired, true)

    // 第二条成功同构 → SkillTemplate 草案入队 pending
    mkRun()
    const abs = abstractExperienceForTool(ws, knowledge, {
      packageId: 'aml-analysis@1.0.0',
      humanApproved: true,
    })
    assert.equal(abs.package, 'aml-analysis@1.0.0')
    assert.equal(abs.skills, 1)
    assert.equal(abs.queued.length, 1)
    const q = abs.queued[0]
    assert.equal(q.targetKind, 'SkillTemplate')
    assert.equal(q.status, 'pending')
    assert.equal(q.members, 2)
    assert.ok(q.id.startsWith('dc-'))
    assert.equal(abs.humanReviewRequired, true)
    // 只入队：草案在知识库队列，不直写包
    const cands = knowledge.listCandidates({ packageId: 'aml-analysis', status: 'pending' })
    assert.equal(cands.length, 1)
    assert.equal(cands[0].id, q.id)

    // 幂等：同簇再抽象返回同一条 live 草案
    const again = abstractExperienceForTool(ws, knowledge, {
      packageId: 'aml-analysis@1.0.0',
      humanApproved: true,
    })
    assert.equal(again.queued[0].id, q.id)

    // minCluster 非法
    expectCode(
      () =>
        abstractExperienceForTool(ws, knowledge, {
          packageId: 'aml-analysis@1.0.0',
          minCluster: 0,
          humanApproved: true,
        }),
      'INVALID_ARGS',
    )

    // ISSUED 拒绝（package.yaml 平铺 meta；只写 meta 不动派生）
    const pkgPath = ws.versionDir('aml-analysis', '1.0.0')
    const pkg = loadPackage(pkgPath)
    pkg.meta.status = 'ISSUED'
    writeFileSync(join(pkgPath, 'package.yaml'), dumpYaml(pkg.meta), 'utf8')
    expectCode(
      () => abstractExperienceForTool(ws, knowledge, { packageId: 'aml-analysis@1.0.0', humanApproved: true }),
      'INVALID_ARGS',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('abstract_experience 渲染（E2-1）：结构位回执、空簇说明、humanReviewRequired 在场', () => {
  const text = renderAbstractText({
    package: 'aml-analysis@1.0.0',
    queued: [
      {
        id: 'dc-abc123',
        name: '可疑交易线索检索经验模板',
        targetKind: 'SkillTemplate',
        status: 'pending',
        members: 3,
        runId: 'run-abc12345',
      },
    ],
    skills: 1,
    counters: 0,
  })
  assert.match(text, /aml-analysis@1\.0\.0/)
  assert.match(text, /入队 1 条/)
  assert.match(text, /SkillTemplate/)
  assert.match(text, /dc-abc123/)
  assert.match(text, /status=pending/)
  assert.match(text, /簇员=3/)
  assert.match(text, /humanReviewRequired=true/)
  assert.match(text, /apply_draft/)
  assert.doesNotMatch(text, /执行流程|步骤图|D:\\|workspace\//)

  const cold = renderAbstractText({
    package: 'aml-analysis@1.0.0',
    queued: [],
    skills: 0,
    counters: 0,
  })
  assert.match(cold, /无可入队簇/)
  assert.match(cold, /humanReviewRequired=true/)
})

test('E2-1 源断言：abstract_experience 注册 + ONTOOL_NAMES + 描述引导方法论链路', () => {
  const src = readFileSync(join(REPO, 'backend', 'src', 'agent-tools.ts'), 'utf8')
  const idx = src.indexOf("name: 'abstract_experience'")
  assert.ok(idx > 0, 'abstract_experience 须注册')
  const next = src.indexOf("name: '", idx + 10)
  const slice = src.slice(idx, next > 0 ? next : idx + 4000)
  assert.ok(slice.includes('abstractExperienceForTool'), 'execute 须走纯函数')
  assert.ok(slice.includes('humanApproved'), 'humanApproved 契约在场')
  assert.ok(slice.includes('总结成功经验') || slice.includes('方法论'), '描述须引导方法论链路（D7）')
  const grants = readFileSync(join(REPO, 'backend', 'src', 'agent-grants.ts'), 'utf8')
  assert.ok(grants.includes("'abstract_experience'"), 'ONTOOL_NAMES 须登记')
})

/* ── D11 abstract_experience 省 packageId 扫全库 ── */

test('D11：省 packageId 扫全库——有经验非 ISSUED 包入队，ISSUED 跳过不整单失败', () => {
  const { root, ws, knowledge, mkRun } = mkAbstractFixture()
  try {
    // humanApproved 契约与 packageId 无关（省略 packageId 也要点头）
    expectCode(() => abstractExperienceForTool(ws, knowledge, {}), 'INVALID_ARGS')

    // 无任何经验 → 空扫描回执（不抛、不硬凑）
    const cold = abstractExperienceForTool(ws, knowledge, { humanApproved: true })
    assert.equal(cold.package, '全库')
    assert.deepEqual(cold.scanned, [])
    assert.equal(cold.queued.length, 0)
    assert.equal(cold.humanReviewRequired, true)

    // 两条同构成功经验 → 扫描模式入队，queued 带包归属
    mkRun()
    mkRun()
    const scan = abstractExperienceForTool(ws, knowledge, { humanApproved: true })
    assert.equal(scan.package, '全库')
    assert.ok(Array.isArray(scan.scanned))
    const entry = scan.scanned.find((s) => s.package === 'aml-analysis@1.0.0')
    assert.ok(entry, '有经验包须进 scanned')
    assert.equal(entry.skipped, undefined)
    assert.equal(entry.queued, 1)
    assert.equal(scan.queued.length, 1)
    assert.equal(scan.queued[0].package, 'aml-analysis@1.0.0')
    assert.equal(scan.queued[0].targetKind, 'SkillTemplate')
    assert.equal(scan.skills, 1)
    assert.equal(scan.humanReviewRequired, true)

    // ISSUED → 记入 skipped，不整单失败（发现面不被单个只读包打断）
    const pkgPath = ws.versionDir('aml-analysis', '1.0.0')
    const pkg = loadPackage(pkgPath)
    pkg.meta.status = 'ISSUED'
    writeFileSync(join(pkgPath, 'package.yaml'), dumpYaml(pkg.meta), 'utf8')
    const skippedScan = abstractExperienceForTool(ws, knowledge, { humanApproved: true })
    const skipped = skippedScan.scanned.find((s) => s.package === 'aml-analysis@1.0.0')
    assert.ok(skipped, 'ISSUED 包仍须出现在 scanned')
    assert.match(skipped.skipped, /ISSUED|签发只读/)
    assert.equal(skippedScan.queued.length, 0)
    assert.equal(skippedScan.humanReviewRequired, true)
    // 显式传 packageId 的单包路径仍硬拒（E2-1 契约不回退）
    expectCode(
      () => abstractExperienceForTool(ws, knowledge, { packageId: 'aml-analysis@1.0.0', humanApproved: true }),
      'INVALID_ARGS',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('D11 渲染：全库扫描回执逐包一行（含跳过原因）+ 草案带包归属 + humanReviewRequired', () => {
  const text = renderAbstractText({
    package: '全库',
    scanned: [
      { package: 'aml-analysis@1.0.0', queued: 1, skills: 1, counters: 0 },
      { package: 'tax-analysis@1.0.0', skipped: '已签发只读：请 fork 新版本（P1）', queued: 0, skills: 0, counters: 0 },
    ],
    queued: [
      {
        id: 'dc-abc123',
        name: '可疑交易线索检索经验模板',
        targetKind: 'SkillTemplate',
        status: 'pending',
        members: 3,
        runId: 'run-abc12345',
        package: 'aml-analysis@1.0.0',
      },
    ],
    skills: 1,
    counters: 0,
  })
  assert.match(text, /全库扫描/)
  assert.match(text, /候选经验包 2 个/)
  assert.match(text, /aml-analysis@1\.0\.0：入队 1 条/)
  assert.match(text, /tax-analysis@1\.0\.0：跳过（已签发只读/)
  assert.match(text, /@aml-analysis@1\.0\.0/)
  assert.match(text, /dc-abc123/)
  assert.match(text, /humanReviewRequired=true/)
  assert.doesNotMatch(text, /D:\\|workspace\//)

  const empty = renderAbstractText({ package: '全库', scanned: [], queued: [], skills: 0, counters: 0 })
  assert.match(empty, /候选经验包 0 个/)
  assert.match(empty, /无可入队簇/)
  assert.match(empty, /humanReviewRequired=true/)
})

test('D11 源断言：packageId 可省略 + 描述引导「不必先追问包名」', () => {
  const src = readFileSync(join(REPO, 'backend', 'src', 'agent-tools.ts'), 'utf8')
  const idx = src.indexOf("name: 'abstract_experience'")
  assert.ok(idx > 0)
  const next = src.indexOf("name: '", idx + 10)
  const slice = src.slice(idx, next > 0 ? next : idx + 5000)
  // 参数声明不得再 required: true
  const paramBlock = slice.slice(slice.indexOf('parameters:'), slice.indexOf('output:'))
  assert.ok(!/packageId:\s*\{[^}]*required:\s*true/.test(paramBlock), 'packageId 不得 required')
  assert.ok(slice.includes('可省略'), '描述须声明 packageId 可省略（D11）')
  assert.ok(slice.includes('扫描全库'), '描述须引导扫全库（D11）')
  assert.ok(slice.includes('不必先追问包名') || slice.includes('不要为此翻目录'), '描述须阻止追问包名摩擦（D11）')
})

/* ── D13 SkillTemplate merged → 正文更新通道 ── */

test('D13 skillBodyCurrent：steps/outputTemplate 精确比对、weights 键序无关', () => {
  const el = { steps: ['候选 {candidateId}', 'listHitCount'], weights: { 'RULE-A': 0.6, 'RULE-B': 0.4 }, outputTemplate: '摘要：{riskScore}' }
  // 完全一致（weights 键序不同也算一致）
  assert.equal(
    skillBodyCurrent(el, {
      steps: ['候选 {candidateId}', 'listHitCount'],
      weights: { 'RULE-B': 0.4, 'RULE-A': 0.6 },
      outputTemplate: '摘要：{riskScore}',
    }),
    true,
  )
  // steps 少一项 → 过期
  assert.equal(skillBodyCurrent(el, { steps: ['候选 {candidateId}'], weights: el.weights, outputTemplate: el.outputTemplate }), false)
  // steps 多一项（新 reviewFocus 入簇）→ 过期
  assert.equal(
    skillBodyCurrent(el, { steps: [...el.steps, '关联集中度'], weights: el.weights, outputTemplate: el.outputTemplate }),
    false,
  )
  // outputTemplate 变 → 过期
  assert.equal(skillBodyCurrent(el, { steps: el.steps, weights: el.weights, outputTemplate: '别的' }), false)
  // weights 数值变 → 过期
  assert.equal(skillBodyCurrent(el, { steps: el.steps, weights: { 'RULE-A': 0.5, 'RULE-B': 0.5 }, outputTemplate: el.outputTemplate }), false)
})

test('D13：SkillTemplate 已物化后再抽象——正文一致回执 bodyUpToDate；正文过期入队 op=update', () => {
  const { root, ws, knowledge, mkRun } = mkAbstractFixture()
  try {
    const dir = ws.versionDir('aml-analysis', '1.0.0')
    const pkgId = 'aml-analysis@1.0.0'

    mkRun()
    mkRun()
    // 第一次抽象：create 草案 pending
    const first = abstractExperienceForTool(ws, knowledge, { packageId: pkgId, humanApproved: true })
    assert.equal(first.queued[0].status, 'pending')
    assert.equal(first.queued[0].op, undefined, '未物化不走正文更新通道')
    const createId = first.queued[0].id

    // 人审批准 + 物化（同 apply_draft 路径）
    knowledge.reviewCandidate(createId, 'approve')
    const applied = knowledge.materialize(dir, [createId])
    assert.deepEqual(applied.applied, [createId])
    const el0 = loadPackage(dir).skillTemplates.find((s) => s.name === first.queued[0].name)
    assert.ok(el0, '物化后技能元素须在包内')

    // 第二次抽象（无新经验）→ 正文与最新簇一致 → bodyUpToDate，不入新草案
    const second = abstractExperienceForTool(ws, knowledge, { packageId: pkgId, humanApproved: true })
    assert.equal(second.queued[0].status, 'merged')
    assert.equal(second.queued[0].bodyUpToDate, true, '正文一致须回执 bodyUpToDate')
    assert.equal(second.queued[0].targetId, el0.id)
    const pendingAfterUpToDate = knowledge.listCandidates({ packageId: 'aml-analysis', status: 'pending' })
    assert.equal(pendingAfterUpToDate.length, 0, 'bodyUpToDate 不得入队新草案')

    // 新 reviewFocus 入簇 → 正文过期 → 入队 op=update 正文更新草案
    const runIds = first.queued[0].runId // 任取其一；再补一条新 focus 的经验
    annotateExperienceForTool(ws, {
      runId: runIds,
      reviewFocus: ['listHitCount', '关联集中度'],
      humanApproved: true,
    })
    const third = abstractExperienceForTool(ws, knowledge, { packageId: pkgId, humanApproved: true })
    const updEntry = third.queued[0]
    assert.equal(updEntry.op, 'update', '正文过期须回执 op=update')
    assert.equal(updEntry.targetId, el0.id)
    assert.equal(updEntry.status, 'pending')
    assert.equal(updEntry.targetKind, 'SkillTemplate')
    assert.notEqual(updEntry.id, createId, 'update 草案须是新候选，不得复用 merged create')

    // 幂等：在途 update 再抽象返回同一条，不重复入队
    const thirdAgain = abstractExperienceForTool(ws, knowledge, { packageId: pkgId, humanApproved: true })
    assert.equal(thirdAgain.queued[0].id, updEntry.id, '在途 update 须幂等复用')
    const updates = knowledge
      .listCandidates({ packageId: 'aml-analysis' })
      .filter((c) => c.op === 'update' && c.targetKind === 'SkillTemplate')
    assert.equal(updates.length, 1, '不得重复入队 update')

    // 批准 + 物化 update → 正文刷新
    knowledge.reviewCandidate(updEntry.id, 'approve')
    const appliedUpd = knowledge.materialize(dir, [updEntry.id])
    assert.deepEqual(appliedUpd.applied, [updEntry.id])
    const el1 = loadPackage(dir).skillTemplates.find((s) => s.id === el0.id)
    assert.ok(el1.steps.includes('关联集中度'), `物化后 steps 须含新 focus: ${JSON.stringify(el1.steps)}`)

    // 第三次抽象（无再变）→ bodyUpToDate
    const fourth = abstractExperienceForTool(ws, knowledge, { packageId: pkgId, humanApproved: true })
    assert.equal(fourth.queued[0].bodyUpToDate, true)

    // 又一批新 focus 入簇 → 上一代 update 已 merged → 按 #N 换代重提，不撞幂等
    annotateExperienceForTool(ws, {
      runId: runIds,
      reviewFocus: ['listHitCount', '关联集中度', '资金分层'],
      humanApproved: true,
    })
    const fifth = abstractExperienceForTool(ws, knowledge, { packageId: pkgId, humanApproved: true })
    const gen2 = fifth.queued[0]
    assert.equal(gen2.op, 'update')
    assert.equal(gen2.status, 'pending')
    assert.match(gen2.name, /#2$/, `上一代 merged 后须换代重提: ${gen2.name}`)
    assert.notEqual(gen2.id, updEntry.id)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('D13 渲染：op=update/targetId 与 bodyUpToDate 结构位 + 无路径泄漏', () => {
  const stale = renderAbstractText({
    package: 'aml-analysis@1.0.0',
    queued: [
      {
        id: 'dc-upd001',
        name: '可疑交易线索检索经验模板',
        targetKind: 'SkillTemplate',
        status: 'pending',
        members: 3,
        runId: 'run-abc12345',
        op: 'update',
        targetId: 'SKL-AML-EXP-FIND-CLUES',
      },
    ],
    skills: 1,
    counters: 0,
  })
  assert.match(stale, /op=update targetId=SKL-AML-EXP-FIND-CLUES/)
  assert.match(stale, /正文过时/)
  assert.match(stale, /humanReviewRequired=true/)
  assert.doesNotMatch(stale, /D:\\|workspace\//)

  const current = renderAbstractText({
    package: 'aml-analysis@1.0.0',
    queued: [
      {
        id: 'dc-abc123',
        name: '可疑交易线索检索经验模板',
        targetKind: 'SkillTemplate',
        status: 'merged',
        members: 3,
        runId: 'run-abc12345',
        targetId: 'SKL-AML-EXP-FIND-CLUES',
        bodyUpToDate: true,
      },
    ],
    skills: 1,
    counters: 0,
  })
  assert.match(current, /bodyUpToDate/)
  assert.match(current, /正文已与最新簇一致/)
  assert.doesNotMatch(current, /op=update/, 'bodyUpToDate 不得误报 update')

  // 扫全库路径同样带正文状态位
  const scanned = renderAbstractText({
    package: '全库',
    scanned: [{ package: 'aml-analysis@1.0.0', queued: 1, skills: 1, counters: 0 }],
    queued: [
      {
        id: 'dc-abc123',
        name: '可疑交易线索检索经验模板',
        targetKind: 'SkillTemplate',
        status: 'merged',
        members: 3,
        runId: 'run-abc12345',
        package: 'aml-analysis@1.0.0',
        bodyUpToDate: true,
      },
    ],
    skills: 1,
    counters: 0,
  })
  assert.match(scanned, /@aml-analysis@1\.0\.0 status=merged/)
  assert.match(scanned, /bodyUpToDate/)
})

test('D13 源断言：描述引导正文更新通道（op=update / bodyUpToDate）', () => {
  const src = readFileSync(join(REPO, 'backend', 'src', 'agent-tools.ts'), 'utf8')
  const idx = src.indexOf("name: 'abstract_experience'")
  assert.ok(idx > 0)
  const next = src.indexOf("name: '", idx + 10)
  const slice = src.slice(idx, next > 0 ? next : idx + 6000)
  assert.ok(slice.includes('正文更新通道'), '描述须声明 D13 正文更新通道')
  assert.ok(slice.includes('op=update'), '描述须引导 op=update 正文更新草案')
  assert.ok(slice.includes('bodyUpToDate'), '描述须声明 bodyUpToDate 诚实回执')
  assert.ok(slice.includes('apply_draft'), '描述须指明刷新路径是 apply_draft')
})


/* ── 评审 M1/I1：recall/annotate 三出口（value 闸 + render 兜底 + humanReviewRequired） ── */

test('I1 recall 渲染拼接后兜底：短语命中 → 整段退避为标记', () => {
  const phrase = '确定为洗钱'
  const raw = renderRecallText({
    coldStart: false,
    hits: [{
      runId: 'run-abc12345',
      score: 0.9,
      outcome: 'success',
      counterexample: false,
      reasons: [`goalClass 源=「${phrase}」→ 新=「识别线索」`, '同 scenarioId'],
      reviewFocus: [],
    }],
    advice: '结构同构可参考复用',
  })
  assert.ok(raw.includes(phrase), '无清单时原样（直调测试路径）')
  const masked = renderRecallText({
    coldStart: false,
    hits: [{
      runId: 'run-abc12345',
      score: 0.9,
      outcome: 'success',
      counterexample: false,
      reasons: [`goalClass 源=「${phrase}」→ 新=「识别线索」`],
      reviewFocus: [],
    }],
    advice: 'x',
  }, [phrase])
  assert.ok(!masked.includes(phrase), `短语不得泄漏: ${masked}`)
  assert.match(masked, /【禁语已脱敏】/)
  // 冷启动分支同样带 humanReviewRequired
  const cold = renderRecallText({ coldStart: true, hits: [], advice: 'x' })
  assert.match(cold, /humanReviewRequired=true/)
})

test('I1 annotate 渲染拼接后兜底：misTransferBy 撞短语 → 整段退避', () => {
  const phrase = '已构成犯罪'
  const masked = renderAnnotateText({
    runId: 'run-abc12345',
    outcome: 'success',
    counterexample: false,
    misTransferJudged: true,
    misTransferBy: `判定人${phrase}`,
    reviewFocus: [],
    created: false,
  }, [phrase])
  assert.ok(!masked.includes(phrase), `短语不得泄漏: ${masked}`)
  assert.match(masked, /【禁语已脱敏】/)
})

test('I1 recall value 闸：enforceOutputPolicy 遮蔽 goalClass 撞短语', () => {
  const phrase = '认定洗钱'
  const value = {
    coldStart: false,
    hits: [{
      runId: 'run-abc12345',
      score: 0.9,
      outcome: 'success',
      counterexample: false,
      reasons: [`goalClass 源=「${phrase}」→ 新=「x」`],
    }],
    advice: 'ok',
    humanReviewRequired: true,
  }
  const gated = enforceOutputPolicy(value, [phrase])
  const text = JSON.stringify(gated)
  assert.ok(!text.includes(phrase), `value 闸后不得含短语: ${text}`)
  assert.equal(gated.humanReviewRequired, true)
})

test('I1 source：recall/execute 挂 enforceOutputPolicy + render 挂 retreatRenderText', () => {
  const src = readFileSync(join(REPO, 'backend', 'src', 'agent-tools.ts'), 'utf8')
  // recall execute 与 annotate execute 都过 value 闸
  const recallIdx = src.indexOf("name: 'recall_experience'")
  const annotateIdx = src.indexOf("name: 'annotate_experience'")
  const uploadIdx = src.indexOf("name: 'upload_knowledge_source'")
  assert.ok(recallIdx > 0 && annotateIdx > recallIdx && uploadIdx > annotateIdx)
  const recallSlice = src.slice(recallIdx, annotateIdx)
  const annotateSlice = src.slice(annotateIdx, uploadIdx)
  assert.ok(recallSlice.includes('enforceOutputPolicy'), 'recall execute 须挂 value 闸')
  assert.ok(recallSlice.includes("humanReviewRequired: { type: 'boolean', required: true, const: true }"), 'recall schema 须 const humanReviewRequired')
  // render 走 renderRecallText（内部 retreatRenderText 兜底）
  assert.ok(recallSlice.includes('renderRecallText'), 'recall render 须走 renderRecallText')
  assert.ok(src.includes('retreatRenderText'), 'renderRecallText 须挂 retreatRenderText 兜底')
  assert.ok(annotateSlice.includes('enforceOutputPolicy'), 'annotate execute 须挂 value 闸')
  assert.ok(annotateSlice.includes('renderAnnotateText'), 'annotate render 须走 renderAnnotateText')
})

test('L1 annotate 回填标 success 同过审计闸（两步绕过封死）', () => {
  const { root, ws, runId } = mkAnnotateFixture({ auditPassed: false })
  try {
    // 先建 failure（审计未过允许）
    annotateExperienceForTool(ws, { runId, outcome: 'failure', humanApproved: true })
    // 再回填 success → 拒（L1：回填与新建同闸）
    expectCode(
      () => annotateExperienceForTool(ws, { runId, outcome: 'success', humanApproved: true }),
      'INVALID_ARGS',
    )
    // workbench 人审面（reviewExperienceNote 直调）可覆盖——机器闸不否决人审
    const note = reviewExperienceNote(ws.root, runId, { outcome: 'success' })
    assert.equal(note.outcome, 'success')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('L2 annotate reusedFromRunId：新建与回填均写复用归因', () => {
  const { root, ws, runId } = mkAnnotateFixture()
  try {
    // 造一条源经验
    const srcRun = 'run-src00001'
    const rec = loadRunRecord(ws.root, runId)
    const srcNote = {
      runId: srcRun,
      signature: buildTaskSignature({
        pkg: loadPackage(ws.versionDir(rec.package.name, rec.package.version)),
        scenarioId: rec.scenarioId,
        datasetSummary: rec.datasetSummary,
      }),
      outcome: 'success',
      skillRefsUsed: [],
      counterexample: false,
      savedAt: '2026-11-01T00:00:00.000Z',
    }
    saveExperienceNote(ws.root, srcNote)
    // 新建带 reusedFrom
    const created = annotateExperienceForTool(ws, {
      runId,
      outcome: 'success',
      reusedFromRunId: srcRun,
      humanApproved: true,
    })
    assert.equal(created.created, true)
    const note1 = loadExperienceNote(ws.root, runId)
    assert.equal(note1.reusedFrom?.runId, srcRun)
    assert.ok(note1.reusedFrom?.diff, 'diff 须机械生成')
    // 回填写 reusedFrom
    const patched = annotateExperienceForTool(ws, {
      runId,
      reviewFocus: ['listHitCount'],
      reusedFromRunId: srcRun,
      humanApproved: true,
    })
    assert.equal(patched.created, false)
    const note2 = loadExperienceNote(ws.root, runId)
    assert.equal(note2.reusedFrom?.runId, srcRun)
    assert.deepEqual(note2.reviewFocus, ['listHitCount'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('L5 recall 字段分栏：stepShape 同 / goalClass 同落字段对照栏', () => {
  const text = renderRecallText({
    coldStart: false,
    hits: [{
      runId: 'run-abc12345',
      score: 0.9,
      outcome: 'success',
      counterexample: false,
      reasons: [
        '同 scenarioId',
        'stepShape 一致',
        '规则/技能 Jaccard=1.00',
        'stepShape 同',
        'goalClass 同',
        'scenarioId 同（SCN-AML-FIND-CLUES）',
        'digest 同构',
      ],
      reviewFocus: [],
    }],
    advice: 'x',
  })
  const fieldLine = text.split('\n').find((l) => l.includes('字段对照')) ?? ''
  const scoreLine = text.split('\n').find((l) => l.includes('打分')) ?? ''
  assert.ok(fieldLine.includes('stepShape 同'), `stepShape 同 须在字段对照栏: ${text}`)
  assert.ok(fieldLine.includes('goalClass 同'), `goalClass 同 须在字段对照栏: ${text}`)
  assert.ok(fieldLine.includes('scenarioId 同（'), '带括号形态在字段对照栏')
  assert.ok(scoreLine.includes('同 scenarioId'), '检索打分理由留在打分栏')
  assert.ok(scoreLine.includes('Jaccard'), 'Jaccard 留在打分栏')
})

/* ── E2-2：reviseTopHitAdvice 接生产（digest 短路 + reviseDiff 双路 + 转人工闸） ── */

test('E2-2：reviseTopHitAdvice——digest 短路 / heuristic 转人工闸 / LLM 腿注入与回落', async () => {
  const pkg = loadPackage(AML_DIR)
  const sigS = buildTaskSignature({
    pkg,
    scenarioId: 'SCN-AML-FIND-CLUES',
    datasetSummary: { objects: 4, relations: 4, behaviors: 0, candidates: 4 },
  })
  const sigM = buildTaskSignature({
    pkg,
    scenarioId: 'SCN-AML-FIND-CLUES',
    datasetSummary: { objects: 4, relations: 4, behaviors: 0, candidates: 67 },
  })
  configureDiffLlm(null)
  try {
    // digest 同构 → 短路跳过修正
    const same = await reviseTopHitAdvice(sigS, sigS)
    assert.equal(same.revision.engine, 'digest')
    assert.equal(same.revision.humanGate, false)
    assert.match(same.advice, /结构同构可参考复用/)
    assert.match(same.advice, /digest 同构短路/)
    assert.deepEqual(same.revision.unknown, [])

    // 非同构 + 默认 null 端口 → heuristic 腿：人工闸恒触发（confidence 0.50 < 0.75）
    const gated = await reviseTopHitAdvice(sigM, sigS)
    assert.equal(gated.revision.engine, 'heuristic')
    assert.equal(gated.revision.humanGate, true)
    assert.match(gated.advice, /转人工/)
    assert.match(gated.advice, /engine=heuristic/)
    assert.match(gated.advice, /confidence=0\.50/)
    assert.ok(gated.revision.mustChange.includes('dataBand'), 'S→M 须落 mustChange')
    assert.ok(gated.revision.unknown.includes('scenarioId'), 'heuristic 不背书项落 unknown')

    // LLM 腿注入：高置信 + unknown 空 → 闸放行
    configureDiffLlm({
      complete: async () =>
        JSON.stringify({
          reusable: [{ item: 'stepShape', note: '同' }],
          mustChange: [{ item: 'dataBand', why: 'S→M' }],
          unknown: [],
          confidence: 0.92,
        }),
    })
    const ok = await reviseTopHitAdvice(sigM, sigS)
    assert.equal(ok.revision.engine, 'llm')
    assert.equal(ok.revision.humanGate, false)
    assert.match(ok.advice, /修正后可参考复用/)
    assert.match(ok.advice, /engine=llm/)
    assert.match(ok.advice, /dataBand/, '放行仍须列出差异表调整项')

    // LLM 腿失败 → reviseDiff 回落 heuristic（双路语义）
    configureDiffLlm({ complete: async () => { throw new Error('net down') } })
    const fb = await reviseTopHitAdvice(sigM, sigS)
    assert.equal(fb.revision.engine, 'heuristic')
    assert.equal(fb.revision.humanGate, true)
    assert.match(fb.advice, /转人工/)
  } finally {
    configureDiffLlm(null)
  }
})

test('E2-2 源断言：recall/hint 接 reviseTopHitAdvice（双路+人工闸）；rules.ts 不碰', () => {
  const atSrc = readFileSync(join(REPO, 'backend', 'src', 'agent-tools.ts'), 'utf8')
  const recallIdx = atSrc.indexOf("name: 'recall_experience'")
  const annotateIdx = atSrc.indexOf("name: 'annotate_experience'")
  assert.ok(recallIdx > 0 && annotateIdx > recallIdx)
  const recallSlice = atSrc.slice(recallIdx, annotateIdx)
  assert.ok(recallSlice.includes('reviseTopHitAdvice'), 'recall execute 须走 reviseTopHitAdvice')
  assert.ok(recallSlice.includes('revision'), 'recall value 须带 revision 结构位回执')
  assert.ok(recallSlice.includes('engine/confidence'), '工具描述须声明 engine/confidence 结构位')
  const aeSrc = readFileSync(join(REPO, 'backend', 'src', 'agent-experts.ts'), 'utf8')
  assert.ok(aeSrc.includes('await reviseTopHitAdvice') || aeSrc.includes('reviseTopHitAdvice('), 'hint 须接 reviseTopHitAdvice')
  assert.ok(/await experienceHintOf\(/.test(aeSrc), 'hint 调用点须 await（async 接线）')
  const policySrc = readFileSync(join(REPO, 'backend', 'src', 'agent-policy.ts'), 'utf8')
  assert.ok(policySrc.includes('requiresHumanReview'), '闸门须用 requiresHumanReview')
  assert.ok(policySrc.includes('reviseDiff'), '须接 reviseDiff 双路')
  const rulesSrc = readFileSync(join(REPO, 'core', 'src', 'rules.ts'), 'utf8')
  assert.ok(!rulesSrc.includes('experience'), 'rules.ts 不得引用 experience（经验只提示不改分）')
})
