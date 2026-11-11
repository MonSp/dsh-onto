/**
 * SKL 方法论模板 → agent skill provider（S2.5）。
 *
 * 每个 O2SkillTemplate 暴露为一个 kebab-case skill；同一 SKL id 多版本并存时
 * 优先 ISSUED，再按版本号降序取一条。包写入路径经 agent-hooks 失效目录。
 * @module @dsh-onto/backend/agent-skills
 */
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {
  SkillCandidate,
  SkillDefinition,
  SkillLookupOptions,
  SkillProvider,
} from '@deepseek-ai/dsh-skill'
import {
  PackageWorkspace,
  isInsideDir,
  loadPackage,
  type O2SkillTemplate,
  type OntologyPackage,
} from '@dsh-onto/core'
import { registerSkillInvalidator } from './agent-hooks.js'
import { resolveDataDir } from './services.js'

/** SKL id → skill 名（`SKL-AML-NARRATIVE` → `skl-aml-narrative`）；不可用 id 返回空串。 */
export function skillNameFromId(sklId: string): string {
  return sklId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** 一个 SKL 模板的来源版本（用于跨版本去重）。 */
export interface SklSource {
  versionDir: string
  status: string
  version: string
  template: O2SkillTemplate
}

function splitPrerelease(version: string): [core: string, prerelease: string] {
  // build metadata（`+...`）不参与优先级（semver §11）；先剥再拆预发布，
  // 否则 `1.0.0+build-1` 会被误拆成 core=`1.0.0+build`、pre=`1`。
  const noBuild = version.split('+')[0]
  const i = noBuild.indexOf('-')
  return i < 0 ? [noBuild, ''] : [noBuild.slice(0, i), noBuild.slice(i + 1)]
}

/** semver 式预发布标识符比较：数字段按数值，数字段低于字母段，逐段直到分出胜负。 */
function comparePrerelease(a: string, b: string): number {
  const pa = a.split('.')
  const pb = b.split('.')
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i += 1) {
    const x = pa[i]
    const y = pb[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const nx = /^\d+$/.test(x) ? Number.parseInt(x, 10) : Number.NaN
    const ny = /^\d+$/.test(y) ? Number.parseInt(y, 10) : Number.NaN
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) return nx - ny
    if (!Number.isNaN(nx)) return -1
    if (!Number.isNaN(ny)) return 1
    return x < y ? -1 : 1
  }
  return 0
}

/** semver 式版本比较（数字段数值序、预发布低于正式版）；skills 去重与 list_packages 展示序共用。 */
export function compareVersions(a: string, b: string): number {
  const [aCore, aPre] = splitPrerelease(a)
  const [bCore, bPre] = splitPrerelease(b)
  const pa = aCore.split('.')
  const pb = bCore.split('.')
  // 非数字段（如 `1.x.0`）不猜测为 0：回退核心串比较，保证确定性。
  if (pa.some((s) => !/^\d+$/.test(s)) || pb.some((s) => !/^\d+$/.test(s))) {
    if (aCore !== bCore) return aCore < bCore ? -1 : 1
  } else {
    const na = pa.map((s) => Number.parseInt(s, 10))
    const nb = pb.map((s) => Number.parseInt(s, 10))
    for (let i = 0; i < Math.max(na.length, nb.length); i += 1) {
      const d = (na[i] ?? 0) - (nb[i] ?? 0)
      if (d !== 0) return d
    }
  }
  if (aPre === bPre) return 0
  if (aPre === '') return 1
  if (bPre === '') return -1
  return comparePrerelease(aPre, bPre)
}

/**
 * 全序比较：ISSUED 优先 → 版本降序 → 版本串字典序 → 模板 id → 版本目录 → 模板序列化。
 * 末级判别收口（`1.0.0+a`≡`1.0.0+b`、双 ISSUED 同版等）——结果与 readdir/模板输入序
 * 无关；仅当两源全字段等价（同目录同模板）才平局，此时取任一结果不可区分（round-13 nit）。
 */
function compareSources(a: SklSource, b: SklSource): number {
  const issuedA = a.status === 'ISSUED' ? 1 : 0
  const issuedB = b.status === 'ISSUED' ? 1 : 0
  if (issuedA !== issuedB) return issuedA - issuedB
  const v = compareVersions(a.version, b.version)
  if (v !== 0) return v
  if (a.version !== b.version) return a.version > b.version ? 1 : -1
  if (a.template.id !== b.template.id) return a.template.id > b.template.id ? 1 : -1
  if (a.versionDir !== b.versionDir) return a.versionDir > b.versionDir ? 1 : -1
  const ja = JSON.stringify(a.template)
  const jb = JSON.stringify(b.template)
  return ja > jb ? 1 : ja < jb ? -1 : 0
}

function betterThan(a: SklSource, b: SklSource): boolean {
  return compareSources(a, b) > 0
}

/** 同 SKL id 去重：ISSUED 优先，再版本号降序。 */
export function pickSkillSources(sources: SklSource[]): Map<string, SklSource> {
  const best = new Map<string, SklSource>()
  for (const s of sources) {
    const cur = best.get(s.template.id)
    if (cur === undefined || betterThan(s, cur)) best.set(s.template.id, s)
  }
  return best
}

/**
 * 跨 SKL id 的 skill 名去重：不同 id 规范化到同名时以 ISSUED 优先、版本降序胜出。
 * 撞名不再静默遮蔽——后到者按同一胜出序让位，结果确定。
 */
export function dedupeSkillNames(sources: Iterable<SklSource>): Map<string, SklSource> {
  const byName = new Map<string, SklSource>()
  for (const s of sources) {
    const name = skillNameFromId(s.template.id)
    if (name === '') continue
    const cur = byName.get(name)
    if (cur === undefined || betterThan(s, cur)) byName.set(name, s)
  }
  return byName
}

/**
 * 候选名必须与 locator.sklId 归一结果一致才可加载——
 * stale/spoofed 候选拒载，不回放错名（get() 前置校验）。
 */
export function candidateNameForSkl(candidateName: unknown, sklId: string): string | undefined {
  const name = skillNameFromId(sklId)
  return name !== '' && name === candidateName ? name : undefined
}

/**
 * 目录条目描述带包身份前缀（L4 身份层）：跨包技能在一屏平铺时按【包@版本 · 域】可识别，
 * 用户/模型引用技能时连本体一起看到，不靠猜 slug。
 */
export function skillListDescription(
  template: O2SkillTemplate,
  meta: { name: string; version: string; domain: string },
): string {
  return `【${meta.name}@${meta.version} · ${meta.domain}】${template.description ?? template.name}`
}

/**
 * 胜出者复核（get() 前置校验）：locator 仍须是当前扫描快照下该名的去重胜出者——
 * 失效目录（fork/transition 后出现更优版本）之外，落选 DRAFT/旧版 locator 一律拒载
 * （round-13 minor：stale 候选绕过 ISSUED 优先）。
 */
export function isCurrentWinner(
  winners: ReadonlyMap<string, SklSource>,
  name: string,
  versionDir: string,
  sklId: string,
): boolean {
  const w = winners.get(name)
  return w !== undefined && w.versionDir === versionDir && w.template.id === sklId
}

/**
 * 扫描一组包版本目录，收集 SKL 模板并跨版本去重。
 * 单包不可加载时经 `onSkip` 上抛给调用方（可观测：损坏包不再无声消失）。
 */
export function collectSkillSources(
  entries: ReadonlyArray<{ dir: string; status: string; version: string }>,
  onSkip?: (dir: string, error: unknown) => void,
): Map<string, SklSource> {
  const sources: SklSource[] = []
  for (const v of entries) {
    let pkg: OntologyPackage
    try {
      pkg = loadPackage(v.dir)
    } catch (e) {
      onSkip?.(v.dir, e)
      continue
    }
    for (const template of pkg.skillTemplates) {
      sources.push({ versionDir: v.dir, status: v.status, version: v.version, template })
    }
  }
  return pickSkillSources(sources)
}

/** locator.versionDir 必须落在 workspace 内（防御纵深：registry 回放契约之外再拦一层；realpath 防符号链接逃逸）。 */
export function locatorInWorkspace(versionDir: string, wsRoot: string): boolean {
  if (typeof versionDir !== 'string' || versionDir === '') return false
  return isInsideDir(wsRoot, versionDir)
}

/** skill locator 窄化：畸形输入返回 undefined，不裸抛 TypeError（get() 前置校验）。 */
export function parseSkillLocator(locator: unknown): { versionDir: string; sklId: string } | undefined {
  if (locator === undefined || locator === null || typeof locator !== 'object') return undefined
  const versionDir = (locator as { versionDir?: unknown }).versionDir
  const sklId = (locator as { sklId?: unknown }).sklId
  if (typeof versionDir !== 'string' || typeof sklId !== 'string') return undefined
  return { versionDir, sklId }
}

/** skill 正文：模板口径 + 红线声明。 */
export function renderSkillBody(
  template: O2SkillTemplate,
  meta: { name: string; version: string; domain: string },
): string {
  const lines: string[] = []
  lines.push(`# ${template.name}（${template.id}）`)
  lines.push('')
  lines.push(`来源包：${meta.name}@${meta.version}（${meta.domain}）`)
  if (template.description) {
    lines.push('')
    lines.push(template.description)
  }
  if (template.steps && template.steps.length > 0) {
    lines.push('')
    lines.push('## 步骤')
    template.steps.forEach((step, i) => {
      lines.push(`${i + 1}. ${step}`)
    })
  }
  const weights = Object.entries(template.weights)
  if (weights.length > 0) {
    lines.push('')
    lines.push('## 权重集合')
    for (const [ruleId, weight] of weights) {
      lines.push(`- ${ruleId}: ${weight}`)
    }
  }
  if (template.outputTemplate) {
    lines.push('')
    lines.push('## 输出模板')
    lines.push(template.outputTemplate)
  }
  lines.push('')
  lines.push('## 红线')
  lines.push('- 叙述只回填模板与证据，禁止认定性表述（认定/确定为/已构成…）。')
  lines.push('- 结论性表述只允许落场景卡 forbiddenPhrases 红线，不得进入输出契约。')
  lines.push('- 分数与规则命中由规则引擎产生；本模板只做叙述装配，配合 run_scenario 的 SKILL_RUN 步骤使用。')
  return lines.join('\n')
}

export const name = 'dsh-onto-agent-skills'
export const inject = ['skills']

/* ── D1：平台对话建模引导（内置技能） ────────────────────────────────────
 * 全新会话收到「从零建本体」需求时，会话代理曾优先加载外部导图技能
 * （ontology-business-map → 独立 HTML/YAML 交付），绕开平台建模链路。
 * 内置引导技能以平台流程/引擎契约为正文，让目录里存在一个更强匹配的正解。
 */

/** 引导技能名（kebab-case；与 SKL 模板命名空间隔离）。 */
export const MODELING_GUIDE_NAME = 'onto-modeling'

/** 引导正文：工作边界 + 标准流程 + 引擎契约（D10：起草前必知的契约说明）。 */
export function renderModelingGuideBody(): string {
  return [
    '# dsh-onto 平台对话式本体建模导引',
    '',
    '用户要在**平台内**从零建立或修改业务本体包时，按本规程作业。**不要**改用外部导图技能',
    '（如 ontology-business-map）产出独立 HTML/YAML 交付物——那不是本平台产物形态；',
    '外部五视角只作工程参考，模型骨架以平台 O1/O2/O3 为准。',
    '',
    '## 工作边界',
    '- 只建模域本体 O1/O2/O3 → 签发派生 L2–L4；不套实例、不跑案件研判',
    '  （run_scenario / invoke_expert 仅作派生可执行性验收，可选跑一次冒烟）。',
    '- 判定在规则引擎、认定在人工：humanApproved 只在用户于会话中明确批准/驳回时为 true，',
    '  agent 不得自审自批；置信度 <0.75 强制人审。',
    '- 「明确批准」只认指代**本次动作对象本身**的点头：对骨架——确认那份 ID 清单（save_skeleton）；',
    '  对物化——批准**这批草案清单**（用户主动说「批准/同意这批草案」，或 ask_user_question',
    '  批准卡里选择批准）。以下**均不构成**批准，不得引用其作为 humanApproved 依据：包形态/',
    '  业务范围/域码等澄清选择、骨架确认（只放行 save_skeleton，不代用作物化批准）、中断恢复或',
    '  推进类台词（「按提案继续/落盘」「继续弄」「就这样」）、分片摘要后的默认往下走——遇到',
    '  这些场景先出示针对草案清单的批准请求（批准卡或明确询问）再物化。骨架点头与物化点头是',
    '  两次独立人审，不得互代。',
    '- ISSUED 只读（修改须 fork 新版本）；签发仅人工（issuedBy 不得为 agent/llm）；',
    '  L 层只读，改 O 层后重派生。',
    '',
    '## 专家识别与点名聚焦（L4 身份层）',
    '- 会话开局、或用户问「有哪些业务本体 / 你能干什么 / 都有哪些专家」时：先调 `list_experts`',
    '  （省略 name/version）拿**全局专家索引**，把身份卡（包@版本 · 域 · 状态 — 首场景目标）列给',
    '  用户选；不要凭记忆报包名或技能名。',
    '- 用户点名某个本体（如「就用反洗钱的」）后，本会话默认**聚焦该包**：后续 list_capabilities /',
    '  list_experts / invoke_expert / draft_elements / save_skeleton 等一律显式传该 name+version，',
    '  直到用户改点名或明确换域。点名只是会话约定（软聚焦），不改执行语义——执行仍走单包场景',
    '  1:1 的专家（invoke_expert），打分只在引擎。',
    '- **会话组合不可热切**（Host 锁定已开聊会话的 preset，头部标签只读）。需要专家深入某条业务线时，',
    '  用 `expert_agent` 派**子 agent**：`agent_preset` 取 onto-aml / onto-tax / onto-med，子 agent 以',
    '  该专家的 persona 与工具面工作并回传最终结论（主线会话保持原 preset 不变）。若用户要"换身份',
    '  长期聊"，引导其新建会话并在 hero 芯片选该专家（可先生成一段交接摘要随首条消息带过去）。',
    '- 向用户介绍技能时连包一起报（技能目录描述自带【包@版本 · 域】前缀），跨本体的同名叙述',
    '  不要裸引 slug。',
    '',
    '## 标准流程',
    '1. 建包：create_package 对话完成（DRAFT 空包，同名同版本拒绝）。骨架先行：先在对话里',
    '   产出骨架提案（域码 + 全量 ID 清单 + 规模预算 + 取舍理由），**仅当用户明确点头确认**',
    '   才调 save_skeleton（humanApproved 契约，agent 不得自行确认）；工作台「包管理 → 新建包」',
    '   「建模 → 编辑骨架」仍是可选人工路径。骨架确认前不得物化；骨架是唯一能改名/新增 ID 的入口。',
    '   骨架提案的规模预算建议单列「数据源绑定（SRC-*/FM-*，可选、接真实数据前必补）」段与业务 ID',
    '   分开计数——v1.1 扩绑时才有预算依据，也避免被误当成骨架外新增。',
    '2. 分片起草 O1 → O2 → O3：draft_elements 只入草案队列（画布虚线态）。',
    '   每批给用户表格化摘要：类别/数量、关键取舍、预期 warn 构成；分片起草期间只给摘要、',
    '   不逐片索要批准——攒到全部分片就绪再请用户点头（E3-1：点头次数越少越好）。',
    '3. 人审物化：用户对**本批草案清单**明确点头后才 apply_draft（humanApproved=true），并把该包',
    '   全部待审草案一次传入 candidateIds 同批物化（一次点头一次 apply；同批多条权重更新必须同批，',
    '   逐条会互相打架）。推进/恢复类台词与包形态选择**不是**本批批准——未见明确批准先出示',
    '   草案清单批准卡（或明确问一句）再物化。用户明确驳回才 reject_draft；用户也可直接在',
    '   画布节点内嵌 ✓/✕ 完成人审。',
    '4. 骨架门 I6：新增 ID 前先请用户在骨架面板补行保存（SKELETON_OUT_OF_SCOPE 会拦骨架外新增）。',
    '   驳回后同名可直接重新起草（平台允许该恢复路径）。',
    '5. update 载荷字段必须在 UPDATABLE 白名单内——见到 not updatable 报错就修字段路径，',
    '   不要换名绕过。ScenarioCard 契约字段写顶层 mustInclude 或 outputContract.mustInclude',
    '   均可（平台归一到 outputContract）。',
    '6. 校验（工作台写盘 quality-report）→ 人工送审签发 ISSUED → 人工派生 + 加载门禁 →',
    '   list_capabilities / list_experts 验收 → 可选一次 run_scenario 冒烟。',
    '7. v1.1/遗留待办沉淀：规范位 = 包根 `backlog.md`（清单视图可读、YAML 导入可写、改写不触发',
    '   DERIVED_DRIFT、fork 自动携带）；对话中先写会话工作区 `<包名>-backlog.md` 草稿，定稿条目',
    '   由用户粘贴进包根。逐条：条目 / 理由 / 预估 ID 数——不要散落在会话里口头带走。',
    '',
    '## 引擎契约（起草前必读）',
    '- ScenarioCard.outputContract.mustInclude 只可列引擎产出项：candidateList / riskScore /',
    '  hitRuleIds / evidenceChains / pendingChecks。其余字段（linkPaths 等）放 outputs.fields',
    '  作契约声明，不得进 mustInclude（否则 checkMustInclude 恒不满足、候选全降级待核实）。',
    '- 技能模板可回填变量只有：candidateId / riskScore / hitCount / ruleIds + 数据特征名；',
    '  其余占位符会渲染成「未知」。证据链由引擎单独追加，不必写进模板。',
    '- 场景引用位 behaviorRefs / exclusionRefs / scoreRefs：显式数组 = 运行时限定范围（缺省 = 全部），',
    '  元素必须指向同类型且闭合。',
    '- 场景阈值必须 ≤ scoreRefs 圈内权重和（riskScore 上限 = 圈内权重和，不二次归一）：超出即',
    '  REVIEW_GATE_UNREACHABLE——阈值按圈内上限标定，别沿用 0.75 全包默认。',
    '',
    '## payload 速查（起草前对照，省读源码）',
    '- ObjectType：id / name / idRule? / attributes[{name,type,required?,refObject?,enumValuesRef?}]',
    '- RelationType：id / name / from / to / attributes[]；Dictionary：id / name / values[]',
    '- BehaviorType：id / name / anchor / relations[] / states? / trigger?',
    '- ScoreRule：id / name / weight（全包合计 1.0）/ expression / threshold? / evidenceTemplate? /',
    '  featureSources?（{特征名: OBJ-*/REL-*}，图谱规则→对象直连；可选）',
    '- ExclusionRule：id / name / action(drop|downweight) / factor? / condition（tag 或表达式） / featureSources?',
    '- SkillTemplate：id / name / weights{与打分规则键集数值全等} / steps[] / outputTemplate?',
    '- ScenarioCard：id / name / goal / boundary / inputs[] / outputs.fields[] / pipeline[7 步] /',
    '  behaviorRefs?·exclusionRefs?·scoreRefs?（缺省=全部，显式=运行收窄）/ outputContract{mustInclude',
    '  只放引擎五键} / reviewGate{threshold ≤ 圈内权重和, includeExcluded?} / auditChecks[O1/O2/O3_CLOSED]',
    '- RedLine：targetId=场景 ID，payload.phrases[]（结论性表述唯一通道）；update 走 targetId 定位、',
    '  载荷字段必须在 UPDATABLE 白名单（not updatable 即修路径，勿换名绕过）',
    '- 结论性表述（认定 / 确定为 / 已构成 / 该客户系…，**含否定式引用**）禁入任何业务元素',
    '  与场景正文；只走 targetKind=RedLine 草案追加进场景 forbiddenPhrases。',
    '- 打分规则权重合计必须 = 1.0；改权重用 op=update 同批物化，技能模板权重自动同权。',
    '- 行为通过 relations 声明产生/使用的关系；场景引用位落地后引用类 warn 才会归零。',
  ].join('\n')
}

/** 内置引导技能提供方（静态内容，无失效目录）。 */
export function createModelingGuideProvider(): SkillProvider {
  const candidate: SkillCandidate = {
    name: MODELING_GUIDE_NAME,
    description:
      'dsh-onto 平台内对话式本体建模全流程导引：建包与骨架人工确认、O1/O2/O3 分片起草、'
      + '人审物化、禁语 RedLine、校验签发派生与验收——平台本体建模需求先读此技能，勿走外部导图交付。',
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'runtime',
    provider: 'onto-modeling-guide',
    rank: 250,
    locator: { builtin: MODELING_GUIDE_NAME },
  }
  return {
    name: 'onto-modeling-guide',
    async list(_options: SkillLookupOptions): Promise<SkillCandidate[]> {
      return [candidate]
    },
    async get(c: SkillCandidate): Promise<SkillDefinition | undefined> {
      // 仅认自家候选：改名/换 provider 的 spoof 一律拒载。
      if (c.name !== MODELING_GUIDE_NAME || c.provider !== 'onto-modeling-guide') return undefined
      return {
        name: candidate.name,
        description: candidate.description,
        invocation: candidate.invocation,
        source: candidate.source,
        provider: candidate.provider,
        content: renderModelingGuideBody(),
        metadata: { id: 'ONTO-MODELING-GUIDE', builtin: true },
      }
    },
  }
}

export function apply(ctx: Context): void {
  const dataDir = resolveDataDir(ctx)
  const wsRoot = join(dataDir, 'workspace')
  const ws = new PackageWorkspace(wsRoot)

  const scan = (): Map<string, SklSource> =>
    collectSkillSources(ws.listVersions(), (dir, error) => {
      // 损坏包不再无声消失：经 cordis logger 暴露（目录本身是服务端数据路径，可入服务端日志）。
      ctx.logger('dsh-onto').warn('skill 扫描跳过不可加载包 %s: %o', dir, error)
    })

  ctx.skills.registerProvider((control) => {
    const unregister = registerSkillInvalidator(control.invalidate)
    control.signal.addEventListener('abort', () => unregister(), { once: true })
    const provider: SkillProvider = {
      name: 'onto-skill-templates',
      async list(_options: SkillLookupOptions): Promise<SkillCandidate[]> {
        const out: SkillCandidate[] = []
        for (const [name, s] of dedupeSkillNames(scan().values())) {
          // 包含性过滤（与 get() 同口径）：packages 内 junction 指外的外来模板不进目录
          // （round-13 nit：此前 list 会列出 get 必拒的 stale/外来候选）。
          if (!locatorInWorkspace(s.versionDir, wsRoot)) continue
          // 身份层：描述带【包@版本 · 域】前缀，跨包平铺一眼可分（meta 读失败保留占位不丢条目）。
          let meta = { name: '?', version: s.version, domain: '?' }
          try {
            const m = loadPackage(s.versionDir).meta
            meta = { name: m.name, version: m.version, domain: m.domain }
          } catch {
            /* 占位 meta */
          }
          out.push({
            name,
            description: skillListDescription(s.template, meta),
            invocation: { modelInvocable: true, userInvocable: true },
            source: 'runtime',
            provider: 'onto-skill-templates',
            rank: 350,
            locator: { versionDir: s.versionDir, sklId: s.template.id },
          })
        }
        return out
      },
      async get(candidate: SkillCandidate): Promise<SkillDefinition | undefined> {
        const loc = parseSkillLocator(candidate.locator)
        if (loc === undefined) return undefined
        const { versionDir, sklId } = loc
        // 候选名必须与 sklId 归一结果一致：stale/spoofed 候选拒载，不回放错名。
        const name = candidateNameForSkl(candidate.name, sklId)
        if (name === undefined) return undefined
        if (!locatorInWorkspace(versionDir, wsRoot)) return undefined
        // 胜出者复核（round-13）：locator 仍须是当前扫描快照下该名的去重胜出者。
        if (!isCurrentWinner(dedupeSkillNames(scan().values()), name, versionDir, sklId)) return undefined
        let pkg: OntologyPackage
        try {
          pkg = loadPackage(versionDir)
        } catch {
          return undefined
        }
        const template = pkg.skillTemplates.find((t) => t.id === sklId)
        if (template === undefined) return undefined
        return {
          name,
          description: skillListDescription(template, pkg.meta),
          invocation: { modelInvocable: true, userInvocable: true },
          source: 'runtime',
          provider: 'onto-skill-templates',
          content: renderSkillBody(template, {
            name: pkg.meta.name,
            version: pkg.meta.version,
            domain: pkg.meta.domain,
          }),
          metadata: { id: template.id, package: pkg.meta.name, version: pkg.meta.version },
        }
      },
    }
    return provider
  })

  // D1：平台建模引导与 SKL 目录并列注册（静态内容，随注册表失效/重建即可）。
  ctx.skills.registerProvider(() => createModelingGuideProvider())
}
