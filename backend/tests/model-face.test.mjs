/**
 * 对话式建模 · 专家面验收（conversational-modeling P4/P6；I3/I5/I7）：
 * 图谱组装、能力清单、专家 Profile、I7 duties 断言、guard 白名单与描述符登记。
 */
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AgentToolError } from '../dist/agent-policy.js'
import {
  ONTOOL_NAMES,
  readToolContracts,
} from '../dist/agent-grants.js'
import {
  buildGraphForTool,
  capabilitiesFor,
} from '../dist/model-face.js'
import {
  assertDutiesAligned,
  buildExpertIndex,
  buildExpertProfiles,
  experienceHintOf,
  readAgentDuties,
  renderExpertIndex,
  renderExperts,
  renderExperienceSection,
  registerExpertTools,
} from '../dist/agent-experts.js'
import {
  loadDatasetFromArgs,
  loadToolPackage,
  renderCapabilities,
  renderDraftResult,
  renderGraphSummary,
} from '../dist/agent-tools.js'
import {
  KnowledgeStore,
  PackageWorkspace,
  buildTaskSignature,
  derivePackage,
  loadPackage,
  loadRunRecord,
  readManifest,
  runScenario,
  saveExperienceNote,
} from '@dsh-onto/core'

const REPO = fileURLToPath(new URL('../../', import.meta.url))

/** workbench 源：PR#10 拆分后入口 + client/**（源断言扫全量）。 */
function readWorkbenchClientSrc() {
  const root = join(REPO, 'workbench', 'src')
  const parts = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const fp = join(dir, name)
      if (statSync(fp).isDirectory()) walk(fp)
      else if (name.endsWith('.ts')) parts.push(readFileSync(fp, 'utf8'))
    }
  }
  walk(root)
  return parts.join('\n')
}

const AML_DIR = join(REPO, 'packages', 'aml', '1.0.0')
const AML_RUN = join(REPO, 'examples', 'aml-run.json')
const NEW_TOOLS = [
  'get_model_graph',
  'draft_elements',
  'apply_draft',
  'reject_draft',
  'list_capabilities',
  'list_experts',
  'invoke_expert',
  'create_package',
  'save_skeleton',
  'write_quality_report',
  'recall_experience',
  'annotate_experience',
  'abstract_experience',
  'list_runs',
  'list_drafts',
]

function mkAmlWorkspace({ derived = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-onto-mf-'))
  const ws = new PackageWorkspace(join(root, 'workspace'))
  const dir = ws.createPackage({ name: 'aml-analysis', version: '1.0.0', domain: 'AML' })
  cpSync(AML_DIR, dir, { recursive: true })
  // 示例包自带 derived/：先剥离，按需重新派生（derived=false 必须真实未派生）
  rmSync(join(dir, 'derived'), { recursive: true, force: true })
  if (derived) derivePackage(dir)
  const knowledge = new KnowledgeStore(root)
  return { root, ws, dir, knowledge }
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true })
}

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

/* ── guard 白名单（I5）：新工具必须进 ONTOOL_NAMES，否则 guard 静默跳过 ── */

test('I5：全部建模/专家工具登记进 ONTOOL_NAMES（guard 白名单）', () => {
  for (const t of NEW_TOOLS) assert.ok(ONTOOL_NAMES.has(t), `${t} 必须在 ONTOOL_NAMES`)
  assert.ok(ONTOOL_NAMES.size >= 20)
})

/* ── 描述符手工表同步（AGENTS.md：新增 @Remote 必须登记） ─────────────── */

test('手工描述符表登记 getGraph / saveSkeleton', () => {
  const src = readFileSync(join(REPO, 'backend', 'src', 'client.ts'), 'utf8')
  assert.ok(src.includes(`desc('ontoModel', 'getGraph'`), 'ontoModel.getGraph 未登记')
  assert.ok(src.includes(`desc('ontoKnowledge', 'saveSkeleton'`), 'ontoKnowledge.saveSkeleton 未登记')
})

/* ── 图谱组装（I1/I2/I3） ────────────────────────────────────────────── */

test('get_model_graph 数据源：元素节点 + 引用边 + issue 定位（I3），DRAFT 不需派生', () => {
  const { root, ws, knowledge } = mkAmlWorkspace()
  try {
    const graph = buildGraphForTool({ ws, knowledge, name: 'aml-analysis', version: '1.0.0' })
    assert.equal(graph.package, 'aml-analysis')
    assert.equal(graph.status, 'DRAFT')
    assert.ok(graph.nodes.length > 10, 'AML 包节点齐全')
    assert.ok(graph.nodes.some((n) => n.kind === 'object'))
    assert.ok(graph.nodes.some((n) => n.kind === 'scenario' && n.layer === 'O3'))
    assert.ok(graph.edges.some((e) => e.kind === 'relation'))
    assert.ok(graph.edges.some((e) => e.kind === 'anchor'))
    assert.ok(graph.revision > 0)

    // I3：graph.issues.where 恒为「节点 ID | 'package'」（core 归一，无孤立报错）
    const nodeIds = new Set(graph.nodes.map((n) => n.id))
    for (const i of graph.issues) {
      const located = i.where === 'package' || nodeIds.has(i.where)
      assert.ok(located, `${i.code} where=${i.where} 未定位`)
    }
    // 渲染冒烟
    assert.ok(renderGraphSummary(graph).includes('节点'))
  } finally {
    cleanup(root)
  }
})

test('草案上图与溯源回连（I1/I2）：pending 虚线节点，物化后 provenance 上节点', () => {
  const { root, ws, dir, knowledge } = mkAmlWorkspace()
  try {
    // I6 对话路径：物化前须已确认骨架
    knowledge.skeletons.save({
      packageId: 'aml-analysis',
      domainCode: 'AML',
      confirmed: true,
      ids: ['OBJ-AML-DRAFTED'],
    })
    const draft = knowledge.addDraft({
      packageId: 'aml-analysis',
      item: {
        layer: 'O1',
        targetKind: 'ObjectType',
        name: '草稿对象',
        payload: { id: 'OBJ-AML-DRAFTED', attributes: [] },
        confidence: 0.9,
      },
      provenance: { turnId: 'turn-42' },
    })
    let graph = buildGraphForTool({ ws, knowledge, name: 'aml-analysis', version: '1.0.0' })
    const draftNode = graph.nodes.find((n) => n.id === draft.id)
    assert.ok(draftNode && draftNode.draft === true, 'pending 草案为虚线节点')
    assert.equal(draftNode.provenance.turnId, 'turn-42')

    // 批准物化 → 虚线转实线，provenance 经 appliedAs 回连
    knowledge.reviewCandidate(draft.id, 'approve')
    const res = knowledge.materialize(dir, [draft.id])
    assert.deepEqual(res.applied, [draft.id])
    graph = buildGraphForTool({ ws, knowledge, name: 'aml-analysis', version: '1.0.0' })
    const node = graph.nodes.find((n) => n.id === 'OBJ-AML-DRAFTED')
    assert.ok(node && node.draft === false, '物化后为实线节点')
    assert.equal(node.provenance.turnId, 'turn-42')
    assert.ok(!graph.nodes.some((n) => n.id === draft.id), 'approved 草案退出画布')
  } finally {
    cleanup(root)
  }
})

/* ── 能力清单（P4） ──────────────────────────────────────────────────── */

test('list_capabilities：L1–L5 齐全，manifest layer 分组（L2/L3/L4），未派生 derived=false', () => {
  const plain = mkAmlWorkspace()
  try {
    const cap = capabilitiesFor(plain.ws, 'aml-analysis', '1.0.0')
    assert.equal(cap.derived, false)
    for (const k of ['L1', 'L2', 'L3', 'L4', 'L5']) assert.ok(cap[k], `${k} 缺失`)
    assert.equal(cap.L1.entries.length, 1, '一个 AML 场景入口')
    assert.equal(cap.L3.skills.length, 1, 'SKL-AML-NARRATIVE')
    const text = renderCapabilities(cap)
    assert.ok(text.includes('L1') && text.includes('L5'))
  } finally {
    cleanup(plain.root)
  }

  const derived = mkAmlWorkspace({ derived: true })
  try {
    const cap = capabilitiesFor(derived.ws, 'aml-analysis', '1.0.0')
    assert.equal(cap.derived, true)
    assert.ok(
      cap.L2.files.some((f) => f.startsWith('derived/tool-contracts')),
      'L2 含工具契约派生物',
    )
    assert.ok(
      cap.L4.files.some((f) => f.startsWith('derived/agent-duties')),
      'L4 含 duties 派生物',
    )
    assert.ok(cap.L3.files.some((f) => f.startsWith('o2-behavior-rules/skill-templates/')), 'L3 含技能模板源')
    const manifest = readManifest(derived.dir)
    assert.ok(manifest.sources.some((e) => e.layer === 'L2' && e.path.startsWith('bindings/')))
  } finally {
    cleanup(derived.root)
  }
})

/* ── 专家面（P4/I7） ─────────────────────────────────────────────────── */

test('buildExpertProfiles：派生后 duties 上墙，打分步 llm:forbidden、人审闸计数正确', () => {
  const { root, dir } = mkAmlWorkspace({ derived: true })
  try {
    const { experts, derived } = buildExpertProfiles(dir)
    assert.equal(derived, true)
    assert.equal(experts.length, 1)
    const e = experts[0]
    assert.equal(e.expertId, 'SCN-AML-FIND-CLUES')
    assert.equal(e.steps.length, 7, 'AML 七步 pipeline')
    const ruleSteps = e.steps.filter((s) => s.stepType === 'RULE_EVALUATE')
    assert.ok(ruleSteps.length >= 2)
    for (const s of ruleSteps) {
      assert.equal(s.llm, 'forbidden', '打分步必须 llm:forbidden')
      assert.equal(s.toolCount, 0, '打分步不挂工具白名单（步级收权）')
    }
    const dataSteps = e.steps.filter((s) => s.stepType === 'DATA_INGEST' || s.stepType === 'BEHAVIOR_CALL')
    for (const s of dataSteps) assert.ok(s.toolCount > 0, `${s.stepType} 挂对象粒度读工具`)
    assert.ok(e.humanGates >= 1, 'HUMAN_REVIEW 人审闸')
    assert.equal(e.steps.find((s) => s.stepType === 'HUMAN_REVIEW').toolCount, 0, '人审步不挂工具白名单')
    assert.ok(e.tools.length > 0, '工具白名单来自 tool-contracts')
    assert.ok(e.skills.includes('SKL-AML-NARRATIVE'))
    const text = renderExperts({ experts, derived })
    assert.ok(text.includes('SCN-AML-FIND-CLUES'))
    // render 即模型可见面：步级收权（toolCount/llm/人审闸）必须上墙（I7 可发现）
    assert.match(text, /- \S+ RULE_EVALUATE · 规则引擎判定（排除\/打分） · 工具 0 · llm:forbidden/, '打分步 render 含 stageDuty、工具 0 与 llm:forbidden')
  assert.match(text, /HUMAN_REVIEW · 人工复核（认定唯一出口）/, '人审步 stageDuty 上墙（每一步谁干什么可读）')
    assert.match(text, /- \S+ DATA_INGEST · 数据归一、建图 · 工具 [1-9]\d* · llm:allowed/, '数据步 render 含 stageDuty 与非零工具数')
  } finally {
    cleanup(root)
  }
})

test('未派生时专家面降级自场景骨架：derived=false、llm=null、人审闸仍标记', () => {
  const { root, dir } = mkAmlWorkspace()
  try {
    const { experts, derived } = buildExpertProfiles(dir)
    assert.equal(derived, false)
    assert.equal(readAgentDuties(dir), null, '未派生无 duties 文件')
    const e = experts[0]
    assert.equal(e.steps.length, 7)
    assert.equal(e.steps.find((s) => s.stepType === 'RULE_EVALUATE').llm, null)
    assert.equal(e.steps.find((s) => s.stepType === 'HUMAN_REVIEW').humanGate, true)
  } finally {
    cleanup(root)
  }
})

test('I7：duties 断言——对齐、打分步 llm、人审闸、工具白名单越权即拒', () => {
  const { root, dir } = mkAmlWorkspace({ derived: true })
  try {
    const duties = readAgentDuties(dir)
    assert.ok(duties && duties.length > 0)
    const pkg = loadPackage(dir)
    const scenario = pkg.scenarios.find((s) => s.id === 'SCN-AML-FIND-CLUES')
    const contractIds = new Set(readToolContracts(dir).map((c) => c.id))
    const scDuties = duties.filter((d) => d.scenario === scenario.id)

    // 合法 duties 通过
    assert.doesNotThrow(() => assertDutiesAligned(scenario, scDuties, contractIds))

    // 打分步 llm 放开 → DERIVED_DRIFT
    const badLlm = scDuties.map((d) => (d.stepType === 'RULE_EVALUATE' ? { ...d, llm: 'allowed' } : d))
    expectCode(() => assertDutiesAligned(scenario, badLlm, contractIds), 'DERIVED_DRIFT')

    // 人审闸缺失 → DERIVED_DRIFT
    const badGate = scDuties.map((d) => (d.stepType === 'HUMAN_REVIEW' ? { ...d, humanGate: false } : d))
    expectCode(() => assertDutiesAligned(scenario, badGate, contractIds), 'DERIVED_DRIFT')

    // 工具白名单外引用（越权）→ DERIVED_DRIFT
    const badTools = scDuties.map((d, i) => (i === 0 ? { ...d, toolRefs: ['TOOL-EVIL-OUTSIDE'] } : d))
    expectCode(() => assertDutiesAligned(scenario, badTools, contractIds), 'DERIVED_DRIFT')

    // 与 pipeline 不对齐（缺步）→ DERIVED_DRIFT
    expectCode(() => assertDutiesAligned(scenario, scDuties.slice(1), contractIds), 'DERIVED_DRIFT')
  } finally {
    cleanup(root)
  }
})

test('渲染助手全冒烟：draft/capabilities 结果可读且分层齐', () => {
  const text = renderDraftResult({
    package: 'aml-analysis@1.0.0',
    turnId: 'turn-1',
    added: [{ id: 'dc-1', name: '草稿', targetKind: 'ObjectType', forcedReview: false }],
    rejected: [{ index: 1, reason: 'bad confidence' }],
  })
  assert.ok(text.includes('dc-1') && text.includes('拒收'))
  // E3-1：入队回执附同批物化提示（一次点头一次 apply，勿逐条）
  assert.ok(text.includes('同批物化提示'), 'draft_elements 回执须附同批物化提示')
  assert.ok(text.includes('apply_draft'), '提示须点名 apply_draft 批量路径')
})

test('E3-1：draft_elements 零入队时不刷同批物化提示', () => {
  const text = renderDraftResult({
    package: 'aml-analysis@1.0.0',
    turnId: 'turn-2',
    added: [],
    rejected: [{ index: 0, reason: 'bad' }],
  })
  assert.ok(!text.includes('同批物化提示'), '无入队不应刷批量提示')
})

/* ── E1-1：invoke_expert 执行前自动召回经验（只提示不改分） ────────────── */

function mkInvokeFixture() {
  const { root, ws, dir, knowledge } = mkAmlWorkspace({ derived: true })
  const dataset = JSON.parse(readFileSync(AML_RUN, 'utf8'))
  const tools = new Map()
  const ctx = { tools: { register: (def) => void tools.set(def.name, def) } }
  registerExpertTools(ctx, {
    ws,
    loadGated: (name, version) => loadToolPackage(ws, name, version),
    redlines: () => [],
    loadDatasetFromArgs,
    textBlock: (text) => [{ type: 'text', text }],
    toolOut: (v) => v,
  })
  return { root, ws, dir, knowledge, dataset, tools }
}

/** 打分面归一：剔除 runId/startedAt/各类 ts 等易变位，只比打分语义。 */
function scoringFace(v) {
  const strip = (x) => {
    if (Array.isArray(x)) return x.map(strip)
    if (x !== null && typeof x === 'object') {
      const out = {}
      for (const [k, val] of Object.entries(x)) {
        if (k === 'ts' || k === 'runId' || k === 'startedAt') continue
        out[k] = strip(val)
      }
      return out
    }
    return x
  }
  return strip({
    scenarioId: v.scenarioId,
    candidates: v.candidates,
    excluded: v.excluded,
    reviewGate: v.reviewGate,
    humanReviewRequired: v.humanReviewRequired,
    audit: v.audit,
    ruleHitLog: v.ruleHitLog ?? [],
  })
}

test('E1-1：invoke_expert 冷启动附 experience 只读提示段（不硬迁移话术）', async () => {
  const fx = mkInvokeFixture()
  try {
    const invoke = fx.tools.get('invoke_expert')
    assert.ok(invoke, 'invoke_expert 须注册')
    const value = await invoke.execute({
      name: 'aml-analysis',
      version: '1.0.0',
      scenarioId: 'SCN-AML-FIND-CLUES',
      dataset: fx.dataset,
    })
    assert.equal(value.humanReviewRequired, true)
    assert.ok(value.experience, '输出须附 experience 段')
    assert.equal(value.experience.coldStart, true)
    assert.match(value.experience.advice, /冷启动/)
    assert.match(value.experience.advice, /不硬迁移/)
    // ruleId / 证据链在场（run 契约）
    assert.ok(value.candidates.length > 0)
    assert.ok(value.candidates.some((c) => c.hitRuleIds.length > 0 || c.evidenceChains.length >= 0))
    // render 含经验参考段
    const blocks = invoke.output.render({ name: 'aml-analysis', version: '1.0.0' }, value)
    const text = blocks.map((b) => b.text ?? '').join('\n')
    assert.match(text, /经验参考/)
    assert.match(text, /humanReviewRequired=true/)
    // T5 缺陷修复：专家通道须落 RunRecord（export_audit/annotate 留痕前提）
    const rec = loadRunRecord(fx.ws.root, value.runId)
    assert.equal(rec.runId, value.runId)
    assert.equal(rec.scenarioId, 'SCN-AML-FIND-CLUES')
  } finally {
    cleanup(fx.root)
  }
})

test('E1-1：命中路径附 reviewFocus/advice，且打分与不召回逐字段一致', async () => {
  const fx = mkInvokeFixture()
  try {
    const invoke = fx.tools.get('invoke_expert')
    const args = {
      name: 'aml-analysis',
      version: '1.0.0',
      scenarioId: 'SCN-AML-FIND-CLUES',
      dataset: fx.dataset,
    }
    // 第一次：冷启动
    const cold = await invoke.execute(args)
    assert.equal(cold.experience.coldStart, true)

    // 造一条同签名经验（含 reviewFocus），模拟上轮人审沉淀
    const pkg = loadPackage(fx.dir)
    const signature = buildTaskSignature({
      pkg,
      scenarioId: 'SCN-AML-FIND-CLUES',
      datasetSummary: {
        objects: fx.dataset.objects.length,
        relations: fx.dataset.relations.length,
        behaviors: fx.dataset.behaviors?.length ?? 0,
        candidates: fx.dataset.candidates.length,
      },
    })
    saveExperienceNote(fx.ws.root, {
      runId: 'run-e1hit01',
      signature,
      outcome: 'success',
      outcomeReason: '三层闭合',
      skillRefsUsed: signature.skillRefs,
      counterexample: false,
      reviewFocus: ['listHitCount', 'OBJ-AML-ACCOUNT.balance'],
      savedAt: new Date().toISOString(),
    })

    // 第二次：命中
    const warm = await invoke.execute(args)
    assert.equal(warm.experience.coldStart, false)
    assert.ok(warm.experience.hits.length > 0, '同签名须命中')
    const hit = warm.experience.hits[0]
    assert.equal(hit.runId, 'run-e1hit01')
    assert.ok(hit.reviewFocus.includes('listHitCount'), 'hits 须含 reviewFocus')
    assert.ok(warm.experience.advice.length > 0, 'advice 在场')
    assert.equal(warm.humanReviewRequired, true)

    // 打分与不召回逐字段一致（经验只提示不改分）
    assert.deepEqual(scoringFace(warm), scoringFace(cold))

    // render 命中路径含复核提示
    const blocks = invoke.output.render(args, warm)
    const text = blocks.map((b) => b.text ?? '').join('\n')
    assert.match(text, /run-e1hit01/)
    assert.match(text, /复核提示/)
    assert.match(text, /listHitCount/)
  } finally {
    cleanup(fx.root)
  }
})

test('E1-1 源断言：召回只附包络不进引擎，experience 过 value/render 闸', () => {
  const src = readFileSync(join(REPO, 'backend', 'src', 'agent-experts.ts'), 'utf8')
  const hintIdx = src.indexOf('experienceHintOf(')
  const runIdx = src.indexOf('runScenario(versionDir')
  assert.ok(hintIdx > 0 && runIdx > hintIdx, '执行前召回（hint 在 runScenario 之前）')
  assert.ok(
    src.includes('{ expert, experience, ...result }'),
    'experience 只随包络附加，不参与 runScenario 入参',
  )
  assert.ok(src.includes('enforceOutputPolicy({ expert, experience, ...result }'), 'experience 须过 value 闸')
  assert.ok(src.includes('retreatRenderText'), 'render 须挂 retreatRenderText 兜底')
  // 打分语义不碰：rules.ts 不得引用 experience
  const rulesSrc = readFileSync(join(REPO, 'core', 'src', 'rules.ts'), 'utf8')
  assert.ok(!rulesSrc.includes('experience'), 'rules.ts 不得引用 experience（经验只提示不改分）')
})

test('P3-2：invoke_expert 经验提示失败降级冷启动，不阻断 runScenario', () => {
  const src = readFileSync(join(REPO, 'backend', 'src', 'agent-experts.ts'), 'utf8')
  assert.ok(src.includes('P3-2：提示段失败降级冷启动'), '须有 P3-2 降级注释')
  assert.ok(src.includes('try {') && src.includes('experienceHintOf('), 'experienceHintOf 须包在 try 内')
  assert.ok(
    src.includes("advice: '冷启动：无相似经验（不硬迁移，走全量执行）'"),
    '降级须给出冷启动不硬迁移话术',
  )
  // catch 块内不得出现 runScenario——降级路径只填 experience，不跳过执行
  const tryIdx = src.indexOf('P3-2：提示段失败降级冷启动')
  const catchIdx = src.indexOf('} catch {', tryIdx)
  const afterCatch = src.slice(catchIdx, src.indexOf('const result = runScenario', catchIdx))
  assert.ok(!afterCatch.includes('return'), '降级 catch 不得提前 return 跳过执行')
})

test('P2-2/P3-3 源断言：materialize derive 失败回滚 + SkillTemplate wire notes 上墙', () => {
  const coreSrc = readFileSync(join(REPO, 'core', 'src', 'knowledge.ts'), 'utf8')
  assert.ok(coreSrc.includes('DERIVE_FAILED'), 'materialize 须有 DERIVE_FAILED 受控错误码')
  assert.ok(coreSrc.includes('restorePkg(pkg, originalSnap)'), 'derive 失败须回滚物化前源快照')
  assert.ok(coreSrc.includes('delete c.appliedAs'), 'derive 失败须清 appliedAs 保持可重试')
  assert.ok(coreSrc.includes('opts?.derive ?? derivePackage'), 'derive 须可注入（测试桩）')
  assert.ok(coreSrc.includes('out.wire'), 'applyDraftToPackage 须回传 wire 接线结果')
  assert.ok(coreSrc.includes('未接线 pipeline.skillRefs'), '多场景未接线须有结构位 reason')

  const atSrc = readFileSync(join(REPO, 'backend', 'src', 'agent-tools.ts'), 'utf8')
  assert.ok(atSrc.includes('res.notes'), 'apply_draft 须透传 materialize notes')
  assert.ok(atSrc.includes('注意：${n}'), 'apply_draft render 须上墙 notes')
  assert.ok(
    atSrc.includes('直接复用且不覆盖 payload'),
    'skillBodyUpdateEntry JSDoc 须与实现一致（不覆盖在途 payload）',
  )
})

test('P1 修复源断言：wire save/writeSource 自动重派生 + create_package humanApproved + 对话骨架门', () => {
  const svc = readFileSync(join(REPO, 'backend', 'src', 'services.ts'), 'utf8')
  assert.ok(svc.includes("throw ontoError('onto/drift'"), 'save/writeSource derive 失败须受控 onto/drift')
  assert.ok(svc.includes('derivePackage(dir)'), 'wire save/writeSource 成功路径须自动 derive')
  // save 与 writeSource 两处
  const deriveCount = (svc.match(/derivePackage\(dir\)/g) || []).length
  assert.ok(deriveCount >= 2, `save+writeSource 均须 derive，实际 ${deriveCount}`)

  const at = readFileSync(join(REPO, 'backend', 'src', 'agent-tools.ts'), 'utf8')
  assert.ok(at.includes('assertHumanApproved(args.humanApproved, \'建包\')'), 'create_package 须 humanApproved')
  assert.ok(at.includes('对话起草前须先 save_skeleton'), 'draft_elements 须骨架先行')
  assert.ok(at.includes('骨架未确认，不得对话起草'), 'draft_elements 须已确认骨架')
  assert.ok(at.includes("name: 'list_runs'"), 'list_runs 须注册')
  assert.ok(at.includes("name: 'list_drafts'"), 'list_drafts 须注册')
  assert.ok(at.includes("name: 'write_quality_report'"), 'write_quality_report 须注册')
  assert.ok(at.includes('materializedCount'), 'apply_draft 须回 summary.materializedCount')
  assert.ok(at.includes('appliedAs'), 'list_drafts 须投影 appliedAs')
  // 已批未写恢复：预检整批 + 跳过已 approved 的 review（防 CANDIDATE_FINALIZED 卡死）
  assert.ok(at.includes('预检整批'), 'apply_draft 须整批预检后再 approve')
  assert.ok(at.includes("c.status === 'pending'"), 'apply_draft 仅对 pending 走 review')

  const grants = readFileSync(join(REPO, 'backend', 'src', 'agent-grants.ts'), 'utf8')
  assert.ok(grants.includes("'list_runs'"), 'list_runs 须入 ONTOOL_NAMES')
  assert.ok(grants.includes("'list_drafts'"), 'list_drafts 须入 ONTOOL_NAMES')
  assert.ok(grants.includes("'write_quality_report'"), 'write_quality_report 须入 ONTOOL_NAMES')

  const wb = readWorkbenchClientSrc()
  assert.ok(wb.includes('issueConfirm'), 'issue 须 confirm 文案')
  assert.ok(wb.includes("window.confirm(`${t('issueConfirm')}"), 'issue 按钮须 window.confirm')

  for (const pkg of ['core', 'backend', 'workbench']) {
    const pj = JSON.parse(readFileSync(join(REPO, pkg, 'package.json'), 'utf8'))
    assert.equal(pj.version, '0.2.1', `${pkg} package.json version 须 0.2.1`)
  }
})

test('实测 P0/P1/P2/P3 修复源断言：签发门禁+迁移重派生 / 物化跳过上墙 / 回填 by 前端拦 / 画布按钮二遍 / 红线并入场景校验', () => {
  const svc = readFileSync(join(REPO, 'backend', 'src', 'services.ts'), 'utf8')
  assert.ok(svc.includes('assertIssueReady(dir)'), '签发端点须先过 assertIssueReady 门禁')
  assert.ok(svc.includes("onto/issue-gate"), 'ISSUE_GATE_* 须映射 onto/issue-gate')
  // save + writeSource + transition 迁移后重派生
  const deriveCount = (svc.match(/derivePackage\(dir\)/g) || []).length
  assert.ok(deriveCount >= 3, `transition 之后也须重派生（save+writeSource+transition），实际 ${deriveCount}`)
  assert.ok(svc.includes('状态已迁移到'), '迁移后 derive 失败须给可操作文案')
  assert.ok(svc.includes('红线候选只能并入场景'), 'RedLine merge 须校验场景载体')

  const coreV = readFileSync(join(REPO, 'core', 'src', 'validate.ts'), 'utf8')
  assert.ok(coreV.includes('export function assertIssueReady'), 'core 须导出签发门禁')
  assert.ok(coreV.includes('ISSUE_GATE_EMPTY'), '空壳（无场景/无规则）须有专属错误码')
  assert.ok(coreV.includes('之后必须再 derive'), '门禁须注明双 derive 约定（勿删任一次）')

  const cli = readFileSync(join(REPO, 'core', 'src', 'cli.ts'), 'utf8')
  assert.ok(cli.includes('assertIssueReady(dir)'), 'CLI issue 须同门禁')
  const cliIssue = cli.slice(cli.indexOf("case 'issue'"), cli.indexOf("case 'export'"))
  assert.ok(cliIssue.includes('derivePackage(dir)'), 'CLI issue 签发后须重派生')
  assert.ok(cliIssue.includes('状态已迁移到 ISSUED'), 'CLI issue 迁移后 derive 失败须受控上墙')
  const cliReview = cli.slice(cli.indexOf("case 'review'"), cli.indexOf("case 'issue'"))
  assert.ok(cliReview.includes('状态已迁移到 IN_REVIEW'), 'CLI review 迁移后 derive 失败须受控上墙')
  assert.ok(cliReview.includes('可手动 dsh-onto derive'), 'CLI 半成功态须给可操作下一步')

  const kb = readFileSync(join(REPO, 'core', 'src', 'knowledge.ts'), 'utf8')
  assert.ok(kb.includes('getCandidate(id: string)'), 'KnowledgeStore 须暴露 getCandidate 供端点前置校验')

  const wb = readWorkbenchClientSrc()
  assert.ok(wb.includes("approveSkip: '批准已记录，但物化未落地（被跳过）'"), '物化跳过须错误条上墙（不得绿勾吞掉）')
  assert.ok(wb.includes("setError(`${t('approveSkip')}"), '单条批准全跳过须走 setError')
  assert.ok(wb.includes("|| (formMis !== '' && !formBy.trim())"), '误迁移回填 by 前端必拦')
  assert.ok(wb.includes("className: 'ogc-node-acts'"), '人审按钮须二遍绘制（脱离节点组防遮挡）')
  assert.ok(wb.includes('graph.nodes.filter((nd) => nd.draft)'), '二遍绘制作用于全部草案节点')
})

test('L4 身份层：buildExpertIndex 一包一卡、ISSUED 优先选版、无场景回退、渲染带点名聚焦', () => {
  const { root, ws } = mkAmlWorkspace()
  try {
    ws.forkVersion('aml-analysis', '1.0.0', '1.1.0')
    ws.transition('aml-analysis', '1.1.0', 'IN_REVIEW')
    ws.transition('aml-analysis', '1.1.0', 'ISSUED', 'tester（人工）')
    ws.createPackage({ name: 'idx-empty', version: '1.0.0', domain: 'IDX' })

    const { cards, phrases } = buildExpertIndex(ws.listVersions())
    assert.equal(cards.length, 2, '一包一卡（同包多版本聚合）')

    const aml = cards.find((c) => c.package === 'aml-analysis')
    assert.equal(aml.version, '1.1.0', '同包取 ISSUED 优先版本')
    assert.equal(aml.status, 'ISSUED')
    assert.ok(aml.scenarios.length >= 1, '场景清单非空')
    assert.ok(aml.title.length > 0, 'title=首场景 goal')
    assert.ok(aml.skills.length >= 1, '技能清单非空')

    const empty = cards.find((c) => c.package === 'idx-empty')
    assert.match(empty.title, /尚无场景/, '无场景包显式回退标注')
    assert.ok(Array.isArray(phrases))

    const text = renderExpertIndex(cards)
    assert.match(text, /业务本体专家 2 个/)
    assert.match(text, /aml-analysis@1\.1\.0/)
    assert.match(text, /点名聚焦：本会话默认 name=aml-analysis version=1\.1\.0/)
    assert.ok(text.indexOf('aml-analysis') < text.indexOf('idx-empty'), 'ISSUED 优先列前')
  } finally {
    cleanup(root)
  }
})

test('L4 空全局索引：render 走 index 分支（不落明细「duties 未派生」文案）', () => {
  // 空数组也必须是「没有包」语义，而不是 experts=[] + derived=false 的降级文案。
  const emptyText = renderExpertIndex([])
  assert.match(emptyText, /业务本体专家 0 个/)
  assert.match(emptyText, /暂无包/)
  assert.ok(!emptyText.includes('duties'), '空索引不得出现 duties 降级措辞')
  assert.ok(!emptyText.includes('场景骨架'), '空索引不得出现骨架降级措辞')

  // render 分支：index 键存在（即使 []）→ index 渲染；缺省 → 明细渲染。
  const src = readFileSync(join(REPO, 'backend', 'src', 'agent-experts.ts'), 'utf8')
  assert.ok(
    src.includes('v.index !== undefined ? renderExpertIndex(v.index) : renderExperts(v)'),
    'render 须以 index 键存在与否分支，而非 length>0',
  )
})

test('list_experts：不存在包统一 NOT_FOUND（不回显 PACKAGE_MALFORMED/missing package.yaml meta）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-onto-mf-ne-'))
  try {
    const ws = new PackageWorkspace(join(root, 'workspace'))
    const tools = new Map()
    const ctx = { tools: { register: (def) => void tools.set(def.name, def) } }
    registerExpertTools(ctx, {
      ws,
      loadGated: (name, version) => loadToolPackage(ws, name, version),
      redlines: () => [],
      loadDatasetFromArgs,
      textBlock: (text) => [{ type: 'text', text }],
      toolOut: (v) => v,
    })
    const list = tools.get('list_experts')
    assert.ok(list, 'list_experts 须注册')

    const idx = await list.execute({})
    assert.deepEqual(idx.index, [])

    try {
      await list.execute({ name: 'no-such-pkg', version: '9.9.9' })
      assert.fail('期望抛出 NOT_FOUND')
    } catch (e) {
      assert.equal(e.code, 'NOT_FOUND', `实际 code=${e.code}: ${e.message}`)
      assert.match(e.message, /no-such-pkg@9\.9\.9/)
      assert.ok(!/missing package\.yaml|PACKAGE_MALFORMED/i.test(e.message), '不得回显底层原因')
    }

    for (const name of ['aml-analysis', 'tax-risk', 'med-safety']) {
      try {
        await list.execute({ name, version: '1.0.0' })
        assert.fail(`${name} 期望 NOT_FOUND`)
      } catch (e) {
        assert.equal(e.code, 'NOT_FOUND', `${name}: ${e.code}`)
      }
    }
  } finally {
    cleanup(root)
  }
})
