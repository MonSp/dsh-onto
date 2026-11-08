/**
 * 对话式建模 · 专家面验收（conversational-modeling P4/P6；I3/I5/I7）：
 * 图谱组装、能力清单、专家 Profile、I7 duties 断言、guard 白名单与描述符登记。
 */
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
  buildExpertProfiles,
  experienceHintOf,
  readAgentDuties,
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
  'recall_experience',
  'annotate_experience',
  'abstract_experience',
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
    assert.match(text, /- \S+ RULE_EVALUATE · 工具 0 · llm:forbidden/, '打分步 render 含工具 0 与 llm:forbidden')
    assert.match(text, /- \S+ DATA_INGEST · 工具 [1-9]\d* · llm:allowed/, '数据步 render 含非零工具数')
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
