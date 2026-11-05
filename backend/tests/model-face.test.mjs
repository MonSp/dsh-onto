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
  readAgentDuties,
  renderExperts,
} from '../dist/agent-experts.js'
import {
  renderCapabilities,
  renderDraftResult,
  renderGraphSummary,
} from '../dist/agent-tools.js'
import {
  KnowledgeStore,
  PackageWorkspace,
  derivePackage,
  loadPackage,
  readManifest,
} from '@dsh-onto/core'

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const AML_DIR = join(REPO, 'packages', 'aml', '1.0.0')
const NEW_TOOLS = [
  'get_model_graph',
  'draft_elements',
  'apply_draft',
  'reject_draft',
  'list_capabilities',
  'list_experts',
  'invoke_expert',
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
  assert.ok(ONTOOL_NAMES.size >= 17)
})

/* ── 描述符手工表同步（AGENTS.md：新增 @Remote 必须登记） ─────────────── */

test('手工描述符表登记 getGraph / addDraft / saveSkeleton', () => {
  const src = readFileSync(join(REPO, 'backend', 'src', 'client.ts'), 'utf8')
  assert.ok(src.includes(`desc('ontoModel', 'getGraph'`), 'ontoModel.getGraph 未登记')
  assert.ok(src.includes(`desc('ontoKnowledge', 'addDraft'`), 'ontoKnowledge.addDraft 未登记')
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

    // I3：每条 issue 要么 package 级、要么 where 能定位到节点
    const nodeIds = new Set(graph.nodes.map((n) => n.id))
    for (const i of graph.issues) {
      const located =
        i.where === 'package' ||
        nodeIds.has(i.where) ||
        /^[A-Z]{2,4} [A-Z]+-[A-Z0-9-]+/.test(i.where)
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
    for (const s of ruleSteps) assert.equal(s.llm, 'forbidden', '打分步必须 llm:forbidden')
    assert.ok(e.humanGates >= 1, 'HUMAN_REVIEW 人审闸')
    assert.ok(e.tools.length > 0, '工具白名单来自 tool-contracts')
    assert.ok(e.skills.includes('SKL-AML-NARRATIVE'))
    assert.ok(renderExperts({ experts, derived }).includes('SCN-AML-FIND-CLUES'))
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
})
