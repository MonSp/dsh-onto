/**
 * L4 专家面（conversational-modeling P4）：`agent-duties.yaml` 从死文档变活——
 * 专家 Profile 由三件派生物组装：duties（职责 / llm 权限 / 人审闸）+ 场景 skillRefs（L3）
 * + tool-contracts 工具白名单（L2）。v1 单专家 = 场景执行主体（1:1，不依赖 experimental
 * Agent Teams）；专家团为渐进增强（spawn_teammate / team_task 叠加，见 spec P4）。
 *
 * - `list_experts`：发现面，DRAFT 即可用（无派生时 profile 降级自场景骨架，derived=false）。
 * - `invoke_expert`：执行面，过派生门禁（L 层执行），I7 断言 duties 对齐与越权即拒。
 * @module @dsh-onto/backend/agent-experts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  DERIVED_FILES,
  buildRunRecord,
  buildTaskSignature,
  loadPackage,
  loadYaml,
  retrieveSimilar,
  runScenario,
  saveRunRecord,
  type OntologyPackage,
  type ScenarioRunResult,
} from '@dsh-onto/core'
import {
  AgentToolError,
  assertRunContract,
  collectPhrases,
  enforceOutputPolicy,
  recallPhrases,
  rememberPhrases,
  retreatRenderText,
  reviseTopHitAdvice,
  toolExecute,
  type TopHitRevision,
} from './agent-policy.js'
import { assertDatasetGranted, readToolContracts } from './agent-grants.js'
import { compareVersions } from './agent-skills.js'
import type { PackageWorkspace } from '@dsh-onto/core'

/** agent-duties 条目（derive 产物形状）。 */
export interface AgentDuty {
  id: string
  scenario: string
  stepId: string
  stepType: string
  stageDuty: string
  toolRefs: string[]
  llm: 'allowed' | 'forbidden'
  humanGate: boolean
}

/** 专家步（有派生时来自 duties；否则降级自场景骨架）。 */
export interface ExpertStep {
  stepId: string
  stepType: string
  stageDuty: string | null
  llm: 'allowed' | 'forbidden' | null
  humanGate: boolean
  toolCount: number
}

/** 专家 Profile（list_experts 输出；invoke_expert 的 expert 包络同源）。 */
export interface ExpertProfile {
  /** v1：专家与场景 1:1，expertId = scenarioId。 */
  expertId: string
  name: string
  goal: string
  boundary: string
  skills: string[]
  tools: string[]
  steps: ExpertStep[]
  humanGates: number
  /** profile 是否来自派生 duties（false = 场景骨架降级）。 */
  derived: boolean
}

/** 读取派生 agent-duties；缺失/不可读返回 null（发现面降级，执行面视为门禁缺失）。 */
export function readAgentDuties(versionDir: string): AgentDuty[] | null {
  try {
    const raw = loadYaml(readFileSync(join(versionDir, DERIVED_FILES.agentDuties), 'utf8')) as {
      duties?: unknown[]
    }
    if (!Array.isArray(raw?.duties)) return null
    return raw.duties.flatMap((d) => {
      if (!d || typeof d !== 'object') return []
      const r = d as Record<string, unknown>
      if (typeof r.scenario !== 'string' || typeof r.stepId !== 'string') return []
      return [
        {
          id: String(r.id ?? ''),
          scenario: r.scenario,
          stepId: r.stepId,
          stepType: String(r.stepType ?? ''),
          stageDuty: String(r.stageDuty ?? ''),
          toolRefs: Array.isArray(r.toolRefs) ? r.toolRefs.map(String) : [],
          llm: r.llm === 'forbidden' ? ('forbidden' as const) : ('allowed' as const),
          humanGate: r.humanGate === true,
        },
      ]
    })
  } catch {
    return null
  }
}

/** 组装包内全部专家 Profile（发现面纯函数）。 */
export function buildExpertProfiles(versionDir: string): { experts: ExpertProfile[]; derived: boolean } {
  const pkg: OntologyPackage = loadPackage(versionDir)
  const duties = readAgentDuties(versionDir)
  const experts: ExpertProfile[] = pkg.scenarios.map((sc) => {
    const scDuties = (duties ?? []).filter((d) => d.scenario === sc.id)
    const skills = [...new Set(sc.pipeline.flatMap((p) => p.skillRefs ?? []))]
    const steps: ExpertStep[] = (
      scDuties.length > 0
        ? scDuties.map((d) => ({
            stepId: d.stepId,
            stepType: d.stepType,
            stageDuty: d.stageDuty,
            llm: d.llm,
            humanGate: d.humanGate,
            toolCount: d.toolRefs.length,
          }))
        : sc.pipeline.map((p) => ({
            stepId: p.stepId,
            stepType: p.stepType,
            stageDuty: null,
            llm: null,
            humanGate: p.stepType === 'HUMAN_REVIEW',
            toolCount: 0,
          }))
    ).sort((a, b) => (a.stepId < b.stepId ? -1 : a.stepId > b.stepId ? 1 : 0))
    return {
      expertId: sc.id,
      name: sc.name,
      goal: sc.goal,
      boundary: sc.boundary,
      skills,
      tools: [...new Set(scDuties.flatMap((d) => d.toolRefs))].sort(),
      steps,
      humanGates: steps.filter((s) => s.humanGate).length,
      derived: duties !== null,
    }
  })
  return { experts, derived: duties !== null }
}

/* ───────────────────────── E1-1：执行前经验只读提示（只提示不改分） ───────────────────────── */

/** expert 包络附带的经验只读提示段（结构位投影，无自由流程）。 */
export interface ExperienceHint {
  coldStart: boolean
  hits: Array<{
    runId: string
    score: number
    outcome: string
    counterexample: boolean
    /** 下轮复核提示（人审面沉淀的结构位条目，过 value/render 闸后上墙）。 */
    reviewFocus: string[]
  }>
  advice: string
  /** E2-2 修正回执（engine/confidence/人工闸/差异项）；冷启动缺省。 */
  revision?: TopHitRevision['revision']
}

/**
 * 执行前结构召回（E1-1）：按 TaskSignature 检索相似经验并投影为只读提示段。
 * 经验只提示不改分——本函数不触碰打分语义，结果仅附加到 expert 包络。
 * 冷启动明说不硬迁移；命中 top-1 走 reviseTopHitAdvice（E2-2：双路修正 + 转人工闸，
 * digest 同构短路），与 recall_experience 同口径。
 */
export async function experienceHintOf(input: {
  root: string
  pkg: OntologyPackage
  scenarioId: string
  datasetSummary: { objects: number; relations: number; behaviors: number; candidates: number }
}): Promise<ExperienceHint> {
  const { root, pkg, scenarioId, datasetSummary } = input
  const signature = buildTaskSignature({ pkg, scenarioId, datasetSummary })
  const result = retrieveSimilar(root, {
    signature,
    externalRefs: pkg.meta.externalRefs,
  })
  const hits: ExperienceHint['hits'] = result.hits.map((h) => ({
    runId: h.note.runId,
    score: Number(h.score.toFixed(2)),
    outcome: h.note.outcome,
    counterexample: h.note.counterexample,
    reviewFocus: h.note.reviewFocus ?? [],
  }))
  let advice: string
  let revision: TopHitRevision['revision'] | undefined
  if (result.coldStart || hits.length === 0) {
    advice = '冷启动：无相似经验（不硬迁移，走全量执行）'
  } else {
    const top = await reviseTopHitAdvice(signature, result.hits[0].note.signature)
    advice = top.advice
    revision = top.revision
  }
  return {
    coldStart: result.coldStart && hits.length === 0,
    hits,
    advice,
    ...(revision ? { revision } : {}),
  }
}

/**
 * I7 断言：duties 与场景 pipeline 对齐，且边界不变——
 * 打分步恒 llm:forbidden、人审步恒 humanGate、toolRefs 全部落在收权清单内（越权即拒）。
 */
export function assertDutiesAligned(
  scenario: OntologyPackage['scenarios'][number],
  duties: AgentDuty[],
  contractIds: ReadonlySet<string>,
): void {
  const stepIds = scenario.pipeline.map((p) => p.stepId)
  if (stepIds.length !== duties.length || stepIds.some((id, i) => duties[i]?.stepId !== id)) {
    throw new AgentToolError('DERIVED_DRIFT', 'duties 与场景 pipeline 不对齐（重新 derive 恢复）')
  }
  for (const d of duties) {
    const step = scenario.pipeline.find((p) => p.stepId === d.stepId)
    if (step === undefined) continue
    if (step.stepType === 'RULE_EVALUATE' && d.llm !== 'forbidden') {
      throw new AgentToolError('DERIVED_DRIFT', `打分步 ${d.stepId} 必须 llm:forbidden（I7）`)
    }
    if (step.stepType === 'HUMAN_REVIEW' && d.humanGate !== true) {
      throw new AgentToolError('DERIVED_DRIFT', `人审步 ${d.stepId} 必须 humanGate=true（I7）`)
    }
    for (const tool of d.toolRefs) {
      if (!contractIds.has(tool)) {
        throw new AgentToolError('DERIVED_DRIFT', `duty ${d.id} 引用非契约工具 ${tool}（越权，I7）`)
      }
    }
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * L4 身份层：包级专家索引（一包一卡）——对话开场/用户问「有哪些业务本体」时
 * 给出可快速识别的身份卡；执行仍走场景 1:1 的 ExpertProfile（invoke_expert）。
 * ═════════════════════════════════════════════════════════════════════════ */

/** 包级专家身份卡（list_experts 省略 name/version 时的全局索引条目）。 */
export interface ExpertIndexCard {
  package: string
  version: string
  domain: string
  status: string
  /** 识别用一句话：首场景 goal；无场景时显式标注「先走建模」。 */
  title: string
  scenarios: Array<{ id: string; goal: string }>
  skills: string[]
}

/**
 * 全局专家索引：扫工作区全部包版本，同包取 ISSUED→版本降序的最优版本聚合成卡。
 * 损坏包跳过（发现面不因单包中断）；phrases 供输出禁语扫描复用。
 */
export function buildExpertIndex(versions: ReadonlyArray<{
  name: string
  version: string
  status: string
  domain: string
  dir: string
}>): { cards: ExpertIndexCard[]; phrases: string[] } {
  const best = new Map<string, (typeof versions)[number]>()
  for (const v of versions) {
    const cur = best.get(v.name)
    if (cur === undefined) {
      best.set(v.name, v)
      continue
    }
    const ia = cur.status === 'ISSUED' ? 1 : 0
    const ib = v.status === 'ISSUED' ? 1 : 0
    if (ib > ia || (ib === ia && compareVersions(v.version, cur.version) > 0)) best.set(v.name, v)
  }
  const cards: ExpertIndexCard[] = []
  const phrases: string[] = []
  for (const v of best.values()) {
    let pkg: OntologyPackage
    try {
      pkg = loadPackage(v.dir)
    } catch {
      continue
    }
    phrases.push(...phrasesOf(pkg))
    const scenarios = pkg.scenarios.map((s) => ({ id: s.id, goal: s.goal }))
    cards.push({
      package: pkg.meta.name,
      version: pkg.meta.version,
      domain: pkg.meta.domain,
      status: pkg.meta.status,
      title: scenarios[0]?.goal ?? '（尚无场景，先走建模）',
      scenarios,
      skills: pkg.skillTemplates.map((t) => t.id),
    })
  }
  cards.sort((a, b) => {
    const ia = a.status === 'ISSUED' ? 1 : 0
    const ib = b.status === 'ISSUED' ? 1 : 0
    if (ia !== ib) return ib - ia
    return a.package < b.package ? -1 : a.package > b.package ? 1 : 0
  })
  return { cards, phrases: [...new Set(phrases)] }
}

/** 全局索引渲染：一包一行身份卡 + 点名聚焦提示（模型可见面即 render）。 */
export function renderExpertIndex(cards: ExpertIndexCard[]): string {
  const lines = [`业务本体专家 ${cards.length} 个（一包一卡 · ISSUED 优先列前）`]
  for (const c of cards) {
    lines.push(`${c.package}@${c.version} · ${c.domain} · ${c.status} —「${c.title}」`)
    if (c.scenarios.length > 0) {
      lines.push(`  场景/专家：${c.scenarios.map((s) => `${s.id}（${s.goal}）`).join('、')}`)
    }
    if (c.skills.length > 0) lines.push(`  技能：${c.skills.join('、')}`)
    lines.push(`  点名聚焦：本会话默认 name=${c.package} version=${c.version}`)
  }
  return lines.join('\n')
}

/** list_experts 渲染：每专家一行 + 步级收权明细（模型可见面即 render，I7 步级边界须可发现）+ 未派生提示。 */
export function renderExperts(v: { experts?: ExpertProfile[]; derived?: boolean }): string {
  const experts = v.experts ?? []
  const lines = [`专家 ${experts.length} 个（duties ${v.derived === true ? '已派生' : '未派生：profile 降级自场景骨架'}）`]
  for (const e of experts) {
    const gates = e.humanGates > 0 ? ` · 人审闸 ${e.humanGates}` : ''
    lines.push(
      `${e.expertId}「${e.name}」— ${e.steps.length} 步 · 技能 ${e.skills.length} · 工具白名单 ${e.tools.length}${gates}`,
    )
    lines.push(`  目标：${e.goal}`)
    for (const s of e.steps) {
      const llm = s.llm ? ` · llm:${s.llm}` : ''
      const gate = s.humanGate ? ' · 人审闸' : ''
      // stageDuty 上墙（实测补）：只给步型/工具数时模型会去翻文件凑「每一步谁干什么」。
      const duty = s.stageDuty ? ` · ${s.stageDuty}` : ''
      lines.push(`  - ${s.stepId} ${s.stepType}${duty} · 工具 ${s.toolCount}${llm}${gate}`)
    }
  }
  return lines.join('\n')
}

/** 专家工具依赖（由 agent-tools.apply 注入，避免模块环）。 */
export function registerExpertTools(
  ctx: Context,
  deps: {
    ws: PackageWorkspace
    loadGated(name: string, version: string): OntologyPackage
    redlines(args: unknown): string[]
    loadDatasetFromArgs(args: { datasetPath?: string; dataset?: unknown }): import('@dsh-onto/core').RuntimeDataset
    textBlock(text: string): Array<{ type: 'text'; text: string }>
    toolOut<T, R>(value: T): R
  },
): void {
  const { ws, loadGated, redlines, loadDatasetFromArgs, textBlock, toolOut } = deps

  ctx.tools.register(
    defineTool({
      name: 'list_experts',
      description:
        'L4 专家清单（双模式）：省略 name/version = 全局业务本体专家索引——跨包身份卡'
        + '（包@版本 · 域 · 状态 · 首场景目标 · 场景/技能清单），会话开场或用户问「有哪些业务本体」'
        + '先用它给用户选、并按卡点名聚焦；给出 name+version = 该包场景级专家明细'
        + '（步级 stageDuty/llm 权限/人审闸、技能与工具白名单）。派生 duties 缺失时降级为场景骨架'
        + '并标 derived=false。只读。',
      parameters: {
        name: { type: 'string', description: '包名（与 version 同时省略 = 全局索引）' },
        version: { type: 'string', description: '版本号（与 name 同时省略 = 全局索引）' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            experts: { type: 'array', required: true, items: { type: 'json' } },
            derived: { type: 'boolean', required: true },
            index: { type: 'array', items: { type: 'json' } },
          },
        },
        render: (_args, value) => {
          const v = value as unknown as { experts?: ExpertProfile[]; derived?: boolean; index?: ExpertIndexCard[] }
          return textBlock(v.index && v.index.length > 0 ? renderExpertIndex(v.index) : renderExperts(v))
        },
      },
      execute: toolExecute(
        (args: { name?: string; version?: string }) => {
          if (!args.name !== !args.version) {
            throw new AgentToolError('INVALID_ARGS', 'name/version 须同时提供（包内明细），或同时省略（全局索引）')
          }
          if (!args.name && !args.version) {
            const { cards, phrases } = buildExpertIndex(ws.listVersions())
            return toolOut(enforceOutputPolicy({ experts: [], derived: false, index: cards }, phrases))
          }
          const out = buildExpertProfiles(ws.versionDir(args.name as string, args.version as string))
          const pkg = loadPackage(ws.versionDir(args.name as string, args.version as string))
          return toolOut(enforceOutputPolicy(out, phrasesOf(pkg)))
        },
        [],
        (args) => redlines(args),
      ),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'invoke_expert',
      description:
        '按 duties 执行一个专家（场景执行主体）：先过派生门禁与 I7 断言（duties 对齐、打分步 llm:forbidden、'
        + 'toolRefs 白名单越权即拒），再走与 run_scenario 相同的规则引擎契约。执行前自动按任务结构签名'
        + '召回相似经验，输出附 expert 包络（职责步/技能/工具白名单）与 experience 只读提示段'
        + '（coldStart/hits 含 reviewFocus/advice——经验只提示不改分）；打分只在引擎，humanReviewRequired 恒 true。'
        + '数据 datasetPath/dataset 二选一：样例数据在 dsh-onto 源码检出目录的 examples/ 下'
        + '（aml-run.json / med-run.json / tax-run.json）——不在会话工作区、也不在平台进程工作目录，'
        + '相对 datasetPath 会读不到；请先定位 dsh-onto 检出目录并读取文件内容，再用 dataset 内联传入。',
      parameters: {
        name: { type: 'string', required: true, description: '包名' },
        version: { type: 'string', required: true, description: '版本号' },
        scenarioId: { type: 'string', required: true, description: '专家/场景 ID（如 SCN-AML-FIND-CLUES）' },
        datasetPath: {
          type: 'string',
          description: 'RuntimeDataset JSON 文件路径（与 dataset 二选一）。样例在 dsh-onto 检出目录'
            + ' examples/ 下（非会话工作区），通常读不到，请读取文件内容后用 dataset 内联传入',
        },
        dataset: { type: 'json', description: '内联 RuntimeDataset（与 datasetPath 二选一）' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            expert: { type: 'json', required: true },
            experience: { type: 'json', required: true },
            scenarioId: { type: 'string', required: true },
            runId: { type: 'string', required: true },
            startedAt: { type: 'string', required: true },
            candidates: { type: 'json', required: true },
            excluded: { type: 'json', required: true },
            humanReviewRequired: { type: 'boolean', required: true, const: true },
            reviewGate: { type: 'json', required: true },
            ruleHitLog: { type: 'json', required: true },
            audit: { type: 'json', required: true },
          },
        },
        render: (_args, value) => textBlock(renderInvoke(value)),
      },
      execute: toolExecute(
        async (args: { name: string; version: string; scenarioId: string; datasetPath?: string; dataset?: unknown }) => {
          const dataset = loadDatasetFromArgs(args)
          const pkg = loadGated(args.name, args.version)
          const versionDir = ws.versionDir(args.name, args.version)
          const scenario = pkg.scenarios.find((s) => s.id === args.scenarioId)
          if (scenario === undefined) {
            throw new AgentToolError('NOT_FOUND', `专家/场景不存在: ${args.scenarioId}`)
          }
          const duties = readAgentDuties(versionDir)
          if (duties === null) {
            throw new AgentToolError('DERIVED_DRIFT', '缺少 agent-duties 派生物（先 derive）')
          }
          const expertDuties = duties.filter((d) => d.scenario === scenario.id)
          const contracts = readToolContracts(versionDir)
          assertDutiesAligned(scenario, expertDuties, new Set(contracts.map((c) => c.id)))
          assertDatasetGranted(dataset, contracts)

          // E1-1：执行前只读召回（经验只提示不改分——不进 runScenario、不碰 rules.ts）。
          // P3-2：提示段失败降级冷启动——只读提示不得阻断场景执行。
          let experience: ExperienceHint
          try {
            experience = await experienceHintOf({
              root: ws.root,
              pkg,
              scenarioId: scenario.id,
              datasetSummary: {
                objects: dataset.objects.length,
                relations: dataset.relations.length,
                behaviors: dataset.behaviors?.length ?? 0,
                candidates: dataset.candidates.length,
              },
            })
          } catch {
            experience = {
              coldStart: true,
              hits: [],
              advice: '冷启动：无相似经验（不硬迁移，走全量执行）',
            }
          }

          const result = runScenario(versionDir, scenario.id, dataset)
          assertRunContract(result)
          const phrases = collectPhrases(result, scenario.outputContract.forbiddenPhrases)
          rememberPhrases(result.runId, phrases)
          // T5 缺陷修复：专家通道同样落 RunRecord（export_audit/annotate/compare 的留痕前提）。
          saveRunRecord(
            ws.root,
            buildRunRecord({
              package: { name: pkg.meta.name, version: pkg.meta.version },
              dataset,
              result,
              redlines: phrases,
            }),
          )

          const profile = buildExpertProfiles(versionDir).experts.find((e) => e.expertId === scenario.id)
          const expert = profile ?? {
            expertId: scenario.id,
            name: scenario.name,
            goal: scenario.goal,
            boundary: scenario.boundary,
            skills: [],
            tools: [],
            steps: [],
            humanGates: 0,
            derived: true,
          }
          return toolOut(enforceOutputPolicy({ expert, experience, ...result }, phrases))
        },
        [],
        (args) => redlines(args),
      ),
    }),
  )
}

/** invoke_expert 渲染：expert 包络一行 + 经验参考段（E1-1）+ 标准运行文本；render 闸兜底。 */
function renderInvoke(value: unknown): string {
  const v = value as {
    expert?: ExpertProfile
    experience?: ExperienceHint
    steps?: unknown
  } & ScenarioRunResult
  const e = v.expert
  const head = e
    ? `专家 ${e.expertId}「${e.name}」· ${e.steps.length} 步 · 技能 ${e.skills.length} · 工具 ${e.tools.length} · 人审闸 ${e.humanGates}`
    : ''
  const exp = renderExperienceSection(v.experience)
  const body = renderRunLike(v)
  const text = [head, exp, body].filter((s) => s !== '').join('\n')
  // render 闸（P2.2）：execute 已 rememberPhrases；直调/测试路径回退命中源。
  return retreatRenderText(text, recallPhrases(v.runId) ?? collectPhrases(v))
}

/**
 * 经验参考段（E1-1）：只读提示上墙——冷启动明说不硬迁移；命中含 runId/score/outcome/
 * reviewFocus 与 advice。value 闸已在 execute 覆盖本段字段；此处只做拼接。
 */
export function renderExperienceSection(h: ExperienceHint | undefined): string {
  if (h === undefined) return ''
  const lines = ['经验参考（只读提示，不参与打分）：']
  if (h.coldStart || h.hits.length === 0) {
    lines.push(`- ${h.advice}`)
  } else {
    for (const hit of h.hits) {
      const focus = hit.reviewFocus.length > 0 ? ` 复核提示[${hit.reviewFocus.join(', ')}]` : ''
      lines.push(
        `- ${hit.runId} score=${hit.score.toFixed(2)} outcome=${hit.outcome} 反例=${hit.counterexample ? '是' : '否'}${focus}`,
      )
    }
    lines.push(`- ${h.advice}`)
  }
  lines.push('humanReviewRequired=true（经验不改分，认定出口只在人工复核）')
  return lines.join('\n')
}

/** 与 renderRunText 同要素的最小运行摘要（避免 agent-tools 循环引用）。 */
function renderRunLike(v: ScenarioRunResult): string {
  const lines = [
    `运行 ${v.runId} · 场景 ${v.scenarioId}`,
    `候选 ${v.candidates.length} · 排除 ${v.excluded.length} · 审计 ${v.audit.passed ? '通过' : '未通过'}`,
    `humanReviewRequired=${v.humanReviewRequired} · 复核阈值 ${v.reviewGate.threshold}`,
  ]
  for (const c of v.candidates.slice(0, 5)) {
    lines.push(`- ${c.candidateId} 分 ${c.riskScore.toFixed(3)} 命中[${c.hitRuleIds.join(',')}] 待核实 ${c.pendingChecks.length}`)
  }
  if (v.candidates.length > 5) lines.push(`… 其余 ${v.candidates.length - 5} 条见完整结果`)
  return lines.join('\n')
}

/** 包内全部场景红线（出口遮蔽基准；与 agent-tools.phrasesOfPkg 同口径）。 */
function phrasesOf(pkg: OntologyPackage): string[] {
  return pkg.scenarios.flatMap((s) =>
    Array.isArray(s.outputContract?.forbiddenPhrases)
      ? s.outputContract.forbiddenPhrases.filter((p) => typeof p === 'string' && p !== '')
      : [],
  )
}
