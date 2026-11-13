/**
 * dsh 原生 agent 工具面：场景执行 / 只读查询 / 知识上传。
 *
 * 约束（工具面信任边界；三策略收口见 agent-policy / agent-grants / 本模块分工）：
 * - 签发/审阅端点永不注册（规范 §12.4）；
 * - 策略裁决全部在 agent-policy（禁语/错误信封/契约断言）与 agent-grants（收权），
 *   本模块只做注册、投影与数据双通道；
 * - run_scenario 工具结果恒含 ruleId 回指、humanReviewRequired=true 与禁语扫描。
 * @module @dsh-onto/backend/agent-tools
 */
import { readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  KnowledgeStore,
  PackageStoreError,
  PackageWorkspace,
  SOURCE_TYPES,
  abstractCounterexampleDrafts,
  abstractSkillDrafts,
  buildDiffTable,
  buildRunRecord,
  buildTaskSignature,
  compareRunRecords,
  deriveFeatures,
  expandEntity,
  exportRunArchive,
  isInsideDir,
  isValidId,
  isSafeRelPath,
  listExperienceNotes,
  listRunRecords,
  loadExperienceNote,
  loadPackage,
  loadRunRecord,
  loadRunRedlines,
  MAX_EXPAND_HOPS,
  projectFeatures,
  retrieveSimilar,
  reviewExperienceNote,
  runScenario,
  saveExperienceNote,
  saveRunRecord,
  verifyDerived,
  writeQualityReport,
  type DraftCandidate,
  type DraftItem,
  type ExpandResult,
  type ExperienceNote,
  type ExperienceOutcome,
  type FeatureRecipe,
  type KnowledgeSourceRecord,
  type ModelGraph,
  type OntologyPackage,
  type RunArchive,
  type RunDiff,
  type RuntimeDataset,
  type ScenarioRunResult,
  type SkeletonRecord,
  type SourceType,
} from '@dsh-onto/core'
import {
  AgentToolError,
  assertBatchContract,
  assertDiffContract,
  assertRunContract,
  asToolError,
  collectPhrases,
  configurePhraseStore,
  enforceOutputPolicy,
  isRecord,
  registerServerDir,
  rememberPhrases,
  renderBatchText,
  renderExportText,
  renderRunDiffText,
  renderRunText,
  retreatPhraseEcho,
  retreatRenderText,
  reviseTopHitAdvice,
  toolExecute,
  type BatchRunItem,
  type BatchRunOutput,
  type BatchRunSummary,
  type TopHitRevision,
} from './agent-policy.js'
import {
  assertDatasetGranted,
  grantGuardDecision,
  pickContracts,
  readToolContracts,
} from './agent-grants.js'
import { resolveDataDir } from './services.js'
import { compareVersions } from './agent-skills.js'
import { buildGraphForTool, capabilitiesFor } from './model-face.js'
import { registerExpertTools } from './agent-experts.js'

/* ───────────────────────── 数据集双通道（S2.3） ───────────────────────── */

/** 校验并收窄 RuntimeDataset 形状；对象/关系明细留给 core 的 DATA_INGEST 对照 O1。 */
export function validateDatasetShape(value: unknown): RuntimeDataset {
  if (!isRecord(value)) {
    throw new AgentToolError('INVALID_ARGS', 'dataset 必须是 JSON 对象（objects/relations/candidates）')
  }
  const { objects, relations, candidates, behaviors } = value
  if (!Array.isArray(objects) || !Array.isArray(relations) || !Array.isArray(candidates)) {
    throw new AgentToolError('INVALID_ARGS', 'dataset 需要 objects/relations/candidates 三个数组')
  }
  // 元素级形状：下游 assertDatasetGranted 与 core 会解引用 id/type/from/to——
  // 畸形元素必须落 INVALID_ARGS 受控错误面，不得裸抛 TypeError。
  // 实例 id 重复会使收权解析歧义（同 id 异型可伪托已收权类型），一律拒绝。
  const seenObjectIds = new Set<string>()
  for (const o of objects) {
    if (!isRecord(o) || typeof o.id !== 'string' || o.id === '' || typeof o.type !== 'string' || o.type === '') {
      throw new AgentToolError('INVALID_ARGS', 'object 需要非空字符串 id 与 type')
    }
    // 声明 type 是纯类型 ID（O1/O2 语法无冒号）；「:实例」段只允许出现在引用侧
    // （objectRef/objectId）。type 夹带冒号会在收权二次剥段时被截成已收权前缀（伪托）。
    if (o.type.includes(':')) {
      throw new AgentToolError('INVALID_ARGS', `object.type 不得含实例段（收到: ${o.type}）`)
    }
    if (seenObjectIds.has(o.id)) {
      throw new AgentToolError('INVALID_ARGS', `object 实例 ID 重复: ${o.id}`)
    }
    seenObjectIds.add(o.id)
  }
  for (const r of relations) {
    if (
      !isRecord(r) ||
      typeof r.id !== 'string' ||
      r.id === '' ||
      typeof r.type !== 'string' ||
      r.type === '' ||
      typeof r.from !== 'string' ||
      r.from === '' ||
      typeof r.to !== 'string' ||
      r.to === ''
    ) {
      throw new AgentToolError('INVALID_ARGS', 'relation 需要非空字符串 id/type/from/to')
    }
    if (r.type.includes(':')) {
      throw new AgentToolError('INVALID_ARGS', `relation.type 不得含实例段（收到: ${r.type}）`)
    }
  }
  if (behaviors !== undefined && behaviors !== null) {
    if (!Array.isArray(behaviors)) {
      throw new AgentToolError('INVALID_ARGS', 'behaviors 必须是数组')
    }
    for (const b of behaviors) {
      if (!isRecord(b) || typeof b.id !== 'string' || b.id === '' || typeof b.type !== 'string' || b.type === '') {
        throw new AgentToolError('INVALID_ARGS', 'behavior 需要非空字符串 id 与 type')
      }
      if (b.type.includes(':')) {
        throw new AgentToolError('INVALID_ARGS', `behavior.type 不得含实例段（收到: ${b.type}）`)
      }
    }
  }
  for (const c of candidates) {
    if (
      !isRecord(c) ||
      typeof c.candidateId !== 'string' ||
      c.candidateId === '' ||
      typeof c.objectRef !== 'string' ||
      c.objectRef === ''
    ) {
      throw new AgentToolError('INVALID_ARGS', 'candidate 需要非空字符串 candidateId 与 objectRef')
    }
    if (!isRecord(c.features)) {
      throw new AgentToolError('INVALID_ARGS', `candidate ${c.candidateId} 缺少 features 对象`)
    }
    if (!Array.isArray(c.tags) || c.tags.some((t) => typeof t !== 'string')) {
      throw new AgentToolError('INVALID_ARGS', `candidate ${c.candidateId} 的 tags 必须是字符串数组`)
    }
  }
  return value as unknown as RuntimeDataset
}

/**
 * datasetPath / dataset 二选一（决策 D2）。
 * datasetPath 绝对或相对工作目录，且必须落在工作目录围栏内（tool-face-policy P2.1）；
 * 内联形态为完整 RuntimeDataset。`opts.baseDir` 仅供测试指定围栏根，生产不传（默认进程 cwd）。
 */
export function loadDatasetFromArgs(
  args: { datasetPath?: string; dataset?: unknown },
  opts: { baseDir?: string } = {},
): RuntimeDataset {
  const hasPath = typeof args.datasetPath === 'string' && args.datasetPath.length > 0
  const hasInline = args.dataset !== undefined && args.dataset !== null
  if (hasPath === hasInline) {
    throw new AgentToolError('INVALID_ARGS', 'datasetPath 与 dataset 必须且只能提供一个')
  }
  if (hasPath) {
    // 错误回显调用方原文，不回显 resolve() 后的绝对路径（不泄露进程 cwd）。
    const raw = args.datasetPath as string
    const path = isAbsolute(raw) ? raw : resolve(raw)
    // 工作目录围栏：越界 / junction·符号链接逃逸 / ADS 冒号一律拒绝（I3）。
    const baseDir = opts.baseDir ?? process.cwd()
    const rel = relative(baseDir, path)
    if (!isInsideDir(baseDir, path) || !isSafeRelPath(rel)) {
      throw new AgentToolError(
        'INVALID_ARGS',
        `dataset 文件越出工作目录（围栏防穿越）: ${raw} ——会话工作区或外部夹具请改用 dataset 内联传入`,
      )
    }
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      // D1 方案 B：相对路径按进程 cwd 解析，会话 cwd 不同处必然读不到——
      // 报错直接给可复制内联示例，调用方无需再猜恢复路径。
      throw new AgentToolError(
        'INVALID_ARGS',
        `无法读取 dataset 文件: ${raw} ——相对路径按平台进程工作目录解析，会话工作区或外部夹具请改用 dataset 内联，`
          + '样例数据在 dsh-onto 源码检出目录的 examples/ 下（aml-run.json / med-run.json / tax-run.json），'
          + '可复制示例: {"objects":[],"relations":[],"candidates":[]}',
      )
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new AgentToolError('INVALID_ARGS', `dataset 文件不是合法 JSON: ${raw}`)
    }
    return validateDatasetShape(parsed)
  }
  return validateDatasetShape(args.dataset)
}

/* ───────────────────────── 只读查询投影 ───────────────────────── */

export function summarizePackage(pkg: OntologyPackage): Record<string, unknown> {
  return {
    meta: {
      name: pkg.meta.name,
      version: pkg.meta.version,
      domain: pkg.meta.domain,
      status: pkg.meta.status,
    },
    counts: {
      objects: pkg.objects.length,
      relations: pkg.relations.length,
      behaviors: pkg.behaviors.length,
      scoreRules: pkg.scoreRules.length,
      exclusionRules: pkg.exclusionRules.length,
      skillTemplates: pkg.skillTemplates.length,
      scenarios: pkg.scenarios.length,
    },
    ruleIds: [...pkg.scoreRules.map((r) => r.id), ...pkg.exclusionRules.map((r) => r.id)],
    scenarioIds: pkg.scenarios.map((s) => s.id),
  }
}

/** list_packages 输出投影：只保留四字段，不回显 dir 等服务端路径（S2.2 规范值）；按包名 + semver 版本序排列。 */
export function projectPackageList(
  versions: ReadonlyArray<{ name: string; version: string; status: string; domain: string; dir?: string }>,
): Array<{ name: string; version: string; status: string; domain: string }> {
  return versions
    .map((v) => ({ name: v.name, version: v.version, status: v.status, domain: v.domain }))
    .sort((a, b) => (a.name === b.name ? compareVersions(a.version, b.version) : a.name < b.name ? -1 : 1))
}

export function ruleDossier(pkg: OntologyPackage, ruleId?: string): Record<string, unknown> {
  const scoreRules = pkg.scoreRules.map((r) => ({
    id: r.id,
    name: r.name,
    kind: 'score',
    weight: r.weight,
    expression: r.expression,
    threshold: r.threshold ?? null,
    evidenceTemplate: r.evidenceTemplate ?? null,
  }))
  const exclusionRules = pkg.exclusionRules.map((r) => ({
    id: r.id,
    name: r.name,
    kind: 'exclusion',
    action: r.action,
    factor: r.factor ?? null,
    condition: r.condition,
  }))
  if (ruleId === undefined) {
    return {
      scoreRules: scoreRules.map(({ kind: _kind, ...rest }) => rest),
      exclusionRules: exclusionRules.map(({ kind: _kind, ...rest }) => rest),
    }
  }
  const hit = scoreRules.find((r) => r.id === ruleId) ?? exclusionRules.find((r) => r.id === ruleId)
  if (hit === undefined) throw new AgentToolError('NOT_FOUND', `规则不存在: ${ruleId}`)
  return { rule: hit }
}

export function scenarioCatalog(pkg: OntologyPackage): Record<string, unknown> {
  return {
    scenarios: pkg.scenarios.map((s) => ({
      id: s.id,
      name: s.name,
      goal: s.goal,
      boundary: s.boundary,
      inputs: s.inputs.map((i) => ({ name: i.name, type: i.type, required: i.required })),
      outputFields: s.outputs.fields,
    })),
  }
}

/** 上传回执摘要：只保留 S2.2 规范字段，不回显 content（§12.3 大块数据不进模型上下文）。 */
export function sourceSummary(rec: KnowledgeSourceRecord): Record<string, unknown> {
  return {
    id: rec.id,
    sourceType: rec.sourceType,
    name: rec.name,
    sha256: rec.sha256,
    parseStatus: rec.parseStatus,
  }
}

/**
 * packageId（`name@version`）必须是工作区真实包；格式错 → INVALID_ARGS，不存在 → NOT_FOUND。
 * 返回裸包名：知识管线（parse → 候选 → materialize）与工作台 listSources 均按
 * `meta.name` 裸名比对，入库带 `@version` 会恒判 package mismatch（S2.6 闭环）。
 */
export function requireExistingPackage(
  versions: ReadonlyArray<{ name: string; version: string }>,
  packageId: string,
): string {
  const at = packageId.lastIndexOf('@')
  const name = at > 0 ? packageId.slice(0, at) : ''
  const version = at > 0 ? packageId.slice(at + 1) : ''
  if (!name || !version) {
    throw new AgentToolError('INVALID_ARGS', `packageId 须为 name@version 形式: ${packageId}`)
  }
  if (!versions.some((v) => v.name === name && v.version === version)) {
    throw new AgentToolError('NOT_FOUND', `包不存在: ${packageId}`)
  }
  return name
}

/* ── D3：对话建包 / 骨架落盘（人审契约同族） ───────────────────────────── */

/**
 * 对话建包（D3）：只产 DRAFT 空包；同名同版本由 PackageWorkspace 拒绝（PACKAGE_EXISTS，
 * 不幂等覆盖）。不回显服务端目录（P2.4）。
 * humanApproved：建包是对话写动作，须用户明确要求建包（与 save_skeleton 同族契约）。
 */
export function createPackageForPkg(
  ws: { createPackage(meta: { name: string; version: string; domain: string }): string },
  args: { name?: unknown; version?: unknown; domain?: unknown; humanApproved?: unknown },
): { name: string; version: string; domain: string; status: 'DRAFT' } {
  assertHumanApproved(args.humanApproved, '建包')
  const name = typeof args.name === 'string' ? args.name.trim() : ''
  const version = typeof args.version === 'string' ? args.version.trim() : ''
  const domain = typeof args.domain === 'string' ? args.domain.trim() : ''
  if (name === '' || version === '' || domain === '') {
    throw new AgentToolError('INVALID_ARGS', 'name/version/domain 均为必填非空字符串')
  }
  // 包名单段 kebab-case（与工具描述一致；路径安全另由 versionDir isPlainSegment 兜底）。
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new AgentToolError('INVALID_ARGS', `name 须为 kebab-case（小写字母数字与连字符）: ${name}`)
  }
  // 域码进输出渲染：限定大写字母数字，兼作红线面（自由文本域码可夹带禁语）。
  if (!/^[A-Z0-9]{1,12}$/.test(domain)) {
    throw new AgentToolError('INVALID_ARGS', `domain 非法（大写字母数字 1–12 位）: ${domain}`)
  }
  try {
    ws.createPackage({ name, version, domain })
  } catch (e) {
    // 受控业务错误保留机器码与入参级 message（不含路径）；其余交给 toolExecute 信封。
    if (e instanceof PackageStoreError) throw new AgentToolError(e.code, e.message)
    throw e
  }
  return { name, version, domain, status: 'DRAFT' }
}

/**
 * 骨架落盘（D3）：`confirmed` 恒随 `humanApproved`——骨架确认（I6 前置）只由用户在会话中
 * 明确点头驱动，agent 不得自确认（与 apply_draft 同族人审契约）。
 * 包须 `name@version` 存在；ISSUED 只读；ids 非空、去重、全过 ID 语法（TYPE-TAG-NAME / dict-slug）。
 */
export function saveSkeletonForPkg(
  knowledge: KnowledgeStore,
  ws: { versionDir(name: string, version: string): string },
  versions: ReadonlyArray<{ name: string; version: string }>,
  args: { packageId?: unknown; domainCode?: unknown; ids?: unknown; humanApproved?: unknown },
): SkeletonRecord {
  assertHumanApproved(args.humanApproved, '确认骨架')
  const packageId = typeof args.packageId === 'string' ? args.packageId : ''
  const name = requireExistingPackage(versions, packageId)
  const version = packageId.slice(packageId.lastIndexOf('@') + 1)
  const dir = ws.versionDir(name, version)
  let status: string
  try {
    status = loadPackage(dir).meta.status
  } catch {
    throw new AgentToolError('NOT_FOUND', `包不存在或无法加载: ${packageId}`)
  }
  if (status === 'ISSUED') {
    throw new AgentToolError('PACKAGE_READONLY', `${packageId} 已签发只读：骨架修改须 fork 新版本`)
  }
  const domainCode = typeof args.domainCode === 'string' ? args.domainCode.trim() : ''
  if (domainCode === '') throw new AgentToolError('INVALID_ARGS', 'domainCode 必填')
  if (!/^[A-Z0-9]{1,12}$/.test(domainCode)) {
    throw new AgentToolError('INVALID_ARGS', `domainCode 非法（大写字母数字 1–12 位）: ${domainCode}`)
  }
  const ids = args.ids
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new AgentToolError('INVALID_ARGS', 'ids 必须是非空字符串数组')
  }
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const raw of ids) {
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new AgentToolError('INVALID_ARGS', 'ids 含空项')
    }
    const id = raw.trim()
    if (!isValidId(id)) throw new AgentToolError('INVALID_ARGS', `非法 ID: ${id}`)
    if (seen.has(id)) throw new AgentToolError('INVALID_ARGS', `ID 重复: ${id}`)
    seen.add(id)
    normalized.push(id)
  }
  return knowledge.skeletons.save({
    packageId: name,
    domainCode,
    confirmed: true,
    ids: normalized,
  })
}

/** packageId 归一为裸包名（旧数据可能存 name@version；与 knowledge 管线同口径）。 */
function normalizePkgId(packageId: string): string {
  const at = packageId.lastIndexOf('@')
  return at > 0 ? packageId.slice(0, at) : packageId
}

/**
 * 人审契约（I1/I5）：apply_draft / reject_draft 必须显式携带 humanApproved=true——
 * 仅当用户在会话中明确审定后代执行；agent 不得自行批准/驳回。
 */
export function assertHumanApproved(value: unknown, action: string): void {
  if (value !== true) {
    throw new AgentToolError(
      'INVALID_ARGS',
      `humanApproved 必须为 true（人审契约：仅在用户明确指示${action}后代执行；agent 不得自行${action}）`,
    )
  }
}

/** 知识上传（工具面薄封装）：入参 `name@version` 校验存在性，入库 packageId 归一为裸包名。 */
export function uploadKnowledgeForPkg(
  knowledge: KnowledgeStore,
  versions: ReadonlyArray<{ name: string; version: string }>,
  input: { packageId: string; sourceType: SourceType; name: string; content: string },
): KnowledgeSourceRecord {
  const packageName = requireExistingPackage(versions, input.packageId)
  return knowledge.uploadSource({ ...input, packageId: packageName })
}

/**
 * 包加载（工具面）：失败不回显底层路径，统一 NOT_FOUND；
 * 加载后过派生门禁（§8.1「场景执行与规则加载前必须过此门禁」——get_rule 规则口径
 * 与 get_package/list_scenarios 的包内容同闸，漂移/未派生 → DERIVED_DRIFT）。
 */
export function loadToolPackage(
  ws: { versionDir(name: string, version: string): string },
  pkgName: string,
  version: string,
): OntologyPackage {
  let dir: string
  let pkg: OntologyPackage
  try {
    dir = ws.versionDir(pkgName, version)
    pkg = loadPackage(dir)
  } catch {
    throw new AgentToolError('NOT_FOUND', `包不存在或无法加载: ${pkgName}@${version}`)
  }
  let gate: ReturnType<typeof verifyDerived>
  try {
    gate = verifyDerived(dir)
  } catch {
    throw new AgentToolError('DERIVED_DRIFT', '拒绝加载: 派生门禁不可读')
  }
  if (!gate.ok) {
    throw new AgentToolError('DERIVED_DRIFT', `拒绝加载: ${gate.reason}`)
  }
  return pkg
}

/* ───────────────────────── 工具注册 ───────────────────────── */

function textBlock(text: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text' as const, text }]
}

/** 包内全部场景红线（错误面退避用；成功路径仍按命中场景双源取清单）。 */
function phrasesOfPkg(pkg: OntologyPackage): string[] {
  return pkg.scenarios.flatMap((s) =>
    Array.isArray(s.outputContract?.forbiddenPhrases)
      ? s.outputContract.forbiddenPhrases.filter((p) => typeof p === 'string' && p !== '')
      : [],
  )
}

/**
 * 按工具入参惰性取红线清单（仅 toolExecute catch / guard 拒绝时求值）。
 * `name@version` 或 `packageId=name@version` → loadPackage（不依赖派生门禁；
 * 读失败返回 []，退化为无短语退避——与修复前等价）。
 */
function redlinesForArgs(
  ws: PackageWorkspace,
  args: unknown,
): string[] {
  const a = isRecord(args) ? args : {}
  let name: string | undefined
  let version: string | undefined
  if (typeof a.name === 'string' && typeof a.version === 'string') {
    name = a.name
    version = a.version
  } else if (typeof a.packageId === 'string') {
    const at = a.packageId.lastIndexOf('@')
    if (at > 0) {
      name = a.packageId.slice(0, at)
      version = a.packageId.slice(at + 1)
    }
  }
  if (name === undefined || version === undefined) return []
  try {
    return phrasesOfPkg(loadPackage(ws.versionDir(name, version)))
  } catch {
    return []
  }
}

/** diff/export 入参的错误面红线：涉及 RunRecord 的 redlines ∪ 工作区全场景红线
 * （目标记录不存在/损坏时亦有完整退避源——runId 本身可撞红线，NOT_FOUND 回显不得漏出）。 */
export function redlinesForRuns(ws: PackageWorkspace, args: unknown): string[] {
  const a = isRecord(args) ? args : {}
  const out = new Set<string>(workspaceRedlines(ws))
  for (const key of ['runId', 'runIdA', 'runIdB'] as const) {
    const id = a[key]
    if (typeof id !== 'string') continue
    for (const p of loadRunRedlines(ws.root, id) ?? []) out.add(p)
  }
  return [...out]
}

/** 工作区全部包的场景红线（错误面退避的完整源；getter 求值于 catch 内，自身不得抛）。 */
function workspaceRedlines(ws: PackageWorkspace): string[] {
  const out = new Set<string>()
  try {
    for (const v of ws.listVersions()) {
      try {
        for (const p of phrasesOfPkg(loadPackage(v.dir))) out.add(p)
      } catch {
        /* 畸形包跳过：退避清单允许不完整，禁止因它再抛 */
      }
    }
  } catch {
    /* listVersions 理论 FS 竞态：退避 getter 永不裸抛 */
  }
  return [...out]
}

/**
 * 工具出口收窄桥：core 的 interface 返回值与 defineTool 按 output.schema 推断的
 * `InferValue<O>` 结构性不兼容（interface 无隐式索引签名，嵌套数组元素不满足
 * `JsonValue` 对象形态）。`R` 由 execute 的上下文推断为实际契约值类型；
 * 运行时由 output.schema 校验 + assertRunContract 兜底。
 *
 * 同时做 lossless-JSON 边界洗：harness 工具结果快照校验拒绝嵌套 undefined
 * （JSON.stringify 会丢键但对象校验不认），显式 undefined 键在此统一剔除。
 */
function toolOut<T, R>(value: T): R {
  return scrubUndefined(value) as unknown as R
}

/** 递归剔除显式 undefined 键/数组空洞（工具结果须可 lossless 序列化）。 */
function scrubUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => scrubUndefined(v)) as unknown as T
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue
      out[k] = scrubUndefined(v)
    }
    return out as unknown as T
  }
  return value
}

/** 批量条目摘要（S2.3）：只回执行摘要，完整结果以 RunRecord 落盘供 compare/export 跟进。 */
export function summarizeRunResult(result: ScenarioRunResult): BatchRunSummary {
  return {
    candidateCount: result.candidates.length,
    hitRuleCount: new Set(result.candidates.flatMap((c) => c.hitRuleIds)).size,
    excludedCount: result.excluded.length,
    auditPassed: result.audit.passed === true,
    forbiddenPhraseHitCount: result.audit.forbiddenPhraseHits.length,
    humanReviewRequired: true,
  }
}

export const BATCH_RUN_LIMIT = 32

/** export_audit 摘要（S2.4）：模型面只回结构化计数与 workspace 相对 locator，零短语零绝对路径。 */
export interface ExportRunSummary {
  exported: true
  runId: string
  locator: string
  auditPassed: boolean
  candidateCount: number
  hitRuleCount: number
  excludedCount: number
  forbiddenPhraseHitCount: number
  humanReviewRequired: true
}

export function exportSummaryOf(exported: { locator: string; archive: RunArchive }): ExportRunSummary {
  const s = summarizeRunResult(exported.archive.result)
  return {
    exported: true,
    runId: exported.archive.runId,
    locator: exported.locator,
    auditPassed: s.auditPassed,
    candidateCount: s.candidateCount,
    hitRuleCount: s.hitRuleCount,
    excludedCount: s.excludedCount,
    forbiddenPhraseHitCount: s.forbiddenPhraseHitCount,
    humanReviewRequired: true,
  }
}

/** 解析批量场景清单：缺省（undefined/null/空数组）全场景；显式列表去重保序，错型 fail-fast。 */
export function resolveBatchIds(scenarioIds: unknown, pkg: OntologyPackage): string[] {
  if (scenarioIds === undefined || scenarioIds === null) {
    return pkg.scenarios.map((s) => s.id)
  }
  if (!Array.isArray(scenarioIds)) {
    throw new AgentToolError('INVALID_ARGS', 'scenarioIds 需要数组')
  }
  if (scenarioIds.length === 0) {
    return pkg.scenarios.map((s) => s.id)
  }
  if (scenarioIds.some((x) => typeof x !== 'string' || x === '')) {
    throw new AgentToolError('INVALID_ARGS', 'scenarioIds 需要非空字符串条目')
  }
  return [...new Set(scenarioIds as string[])]
}

/**
 * 批量执行（S2.3）：逐项复用 run_scenario 既有契约（装配断言/禁语/落盘），
 * 单项失败落受控信封不中断批次；包级前置失败（上限/门禁/收权）由调用方 fail-loud。
 * seedIds 同组作用于批次；某场景未声明 prep.expand → 该项 error（沿批量失败隔离）。
 */
export function runScenarioBatch(input: {
  ws: PackageWorkspace
  pkg: OntologyPackage
  versionDir: string
  dataset: RuntimeDataset
  ids: readonly string[]
  seedIds?: string[]
}): BatchRunOutput {
  const { ws, pkg, versionDir, dataset, ids, seedIds } = input
  if (ids.length > BATCH_RUN_LIMIT) {
    throw new AgentToolError('INVALID_ARGS', `批量上限 ${BATCH_RUN_LIMIT} 个场景（收到 ${ids.length}）`)
  }
  const pkgRedlines = phrasesOfPkg(pkg)
  const results: BatchRunItem[] = []
  for (const scenarioId of ids) {
    const scenario = pkg.scenarios.find((s) => s.id === scenarioId)
    const reds = scenario?.outputContract.forbiddenPhrases ?? []
    try {
      if (scenario === undefined) {
        throw new AgentToolError('NOT_FOUND', `场景 ${scenarioId} 不存在`)
      }
      if (seedIds !== undefined && !scenario.prep?.expand) {
        throw new AgentToolError('INVALID_ARGS', `场景 ${scenarioId} 未声明 prep.expand，无法应用 seedIds`)
      }
      const result = runScenario(versionDir, scenarioId, dataset, seedIds !== undefined ? { seedIds } : undefined)
      assertRunContract(result)
      const phrases = collectPhrases(result, reds)
      const effective = result.effectiveDataset ?? dataset
      saveRunRecord(
        ws.root,
        buildRunRecord({
          package: { name: pkg.meta.name, version: pkg.meta.version },
          dataset: effective,
          inputDataset: dataset,
          result,
          redlines: phrases,
        }),
      )
      rememberPhrases(result.runId, phrases)
      results.push({
        scenarioId,
        status: 'ok',
        runId: result.runId,
        summary: summarizeRunResult(result),
      })
    } catch (e) {
      // 失败隔离：单项错误落受控信封（机器码 + 整段禁语退避），不中断批次。
      const err = asToolError(e, [], pkgRedlines)
      results.push({ scenarioId, status: 'error', error: { code: err.code, message: err.message } })
    }
  }
  return { results, humanReviewRequired: true }
}

/**
 * run_scenario 的 seedIds 校验（A-8）：错型/空/超限 → INVALID_ARGS。
 * 场景是否声明 prep.expand 由调用方在拿到场景后另查（错误文案须指明场景）。
 */
export function validateRunSeedIds(seedIds: unknown): string[] | undefined {
  if (seedIds === undefined || seedIds === null) return undefined
  if (!Array.isArray(seedIds)) {
    throw new AgentToolError('INVALID_ARGS', 'seedIds 需要数组')
  }
  if (seedIds.length === 0) {
    throw new AgentToolError('INVALID_ARGS', 'seedIds 必须为非空数组')
  }
  if (seedIds.length > EXPAND_SEED_LIMIT) {
    throw new AgentToolError('INVALID_ARGS', `seedIds 上限 ${EXPAND_SEED_LIMIT} 个（收到 ${seedIds.length}）`)
  }
  if (seedIds.some((s) => typeof s !== 'string' || s === '')) {
    throw new AgentToolError('INVALID_ARGS', 'seedIds 须为非空字符串条目')
  }
  return seedIds as string[]
}

/* ─────────── 子图扩展与特征投影（subgraph-expansion S3.2/S4.3） ─────────── */

/** seedIds 数量上限（A-2/A-8，防邻域爆炸的入参面）。 */
export const EXPAND_SEED_LIMIT = 32
/** project_features recipes 数量上限（A-2 同族）。 */
export const PROJECT_RECIPE_LIMIT = 32

export interface ExpandEntityArgs {
  name: string
  version: string
  datasetPath?: string
  dataset?: unknown
  seedIds?: unknown
  hops?: unknown
  relationTypes?: unknown
  direction?: unknown
}

/**
 * `expand_entity` 执行体（导出供 attack-surface 表直测 A-1/A-2）：
 * 参数校验（A-2）→ 数据集双通道加载 → 收权（A-1）→ core BFS → 全种子缺失转 INVALID_ARGS。
 * 扩图是数据准备不打分；输出子 dataset 为输入子集，不新增 grant 面。
 */
export function executeExpandEntity(
  args: ExpandEntityArgs,
  deps: { ws: PackageWorkspace },
): ExpandResult {
  if (typeof args.name !== 'string' || args.name === '' || typeof args.version !== 'string' || args.version === '') {
    throw new AgentToolError('INVALID_ARGS', 'name/version 必须为非空字符串')
  }
  const seedIds = args.seedIds
  if (!Array.isArray(seedIds) || seedIds.length === 0) {
    throw new AgentToolError('INVALID_ARGS', 'seedIds 必须为非空数组')
  }
  if (seedIds.length > EXPAND_SEED_LIMIT) {
    throw new AgentToolError('INVALID_ARGS', `seedIds 上限 ${EXPAND_SEED_LIMIT} 个（收到 ${seedIds.length}）`)
  }
  if (seedIds.some((s) => typeof s !== 'string' || s === '')) {
    throw new AgentToolError('INVALID_ARGS', 'seedIds 须为非空字符串条目')
  }
  let hops: number | undefined
  if (args.hops !== undefined && args.hops !== null) {
    if (typeof args.hops !== 'number' || !Number.isInteger(args.hops) || args.hops < 0 || args.hops > MAX_EXPAND_HOPS) {
      throw new AgentToolError('INVALID_ARGS', `hops 须为 0..${MAX_EXPAND_HOPS} 的整数（硬上限防邻域爆炸）`)
    }
    hops = args.hops
  }
  let relationTypes: string[] | undefined
  if (args.relationTypes !== undefined && args.relationTypes !== null) {
    if (!Array.isArray(args.relationTypes) || args.relationTypes.some((t) => typeof t !== 'string' || t === '')) {
      throw new AgentToolError('INVALID_ARGS', 'relationTypes 须为非空字符串数组')
    }
    relationTypes = args.relationTypes as string[]
  }
  let direction: 'out' | 'in' | 'both' | undefined
  if (args.direction !== undefined && args.direction !== null) {
    if (args.direction !== 'out' && args.direction !== 'in' && args.direction !== 'both') {
      throw new AgentToolError('INVALID_ARGS', 'direction 须为 out | in | both')
    }
    direction = args.direction
  }
  const dataset = loadDatasetFromArgs(args)
  const versionDir = deps.ws.versionDir(args.name, args.version)
  const contracts = readToolContracts(versionDir)
  assertDatasetGranted(dataset, contracts)
  const result = expandEntity(dataset, seedIds as string[], { hops, relationTypes, direction })
  if (result.stats.seeds === 0) {
    throw new AgentToolError('INVALID_ARGS', `种子实体均不存在于 dataset: ${result.missingSeedIds.join(', ')}`)
  }
  return result
}

export interface ProjectFeaturesArgs {
  name: string
  version: string
  datasetPath?: string
  dataset?: unknown
  recipes?: unknown
  overwrite?: unknown
}

export interface ProjectFeaturesResult {
  dataset: RuntimeDataset
  projected: Array<{ candidateId: string; keys: string[] }>
  derived: string[]
  stats: { candidates: number; projectedWrites: number; derivedRecipes: number }
}

/** recipes 结构校验（A-4：配方是数据不是代码——kind/source 白名单，缺字段即拒）。 */
function validateRecipes(raw: unknown): FeatureRecipe[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    throw new AgentToolError('INVALID_ARGS', 'recipes 须为数组')
  }
  if (raw.length > PROJECT_RECIPE_LIMIT) {
    throw new AgentToolError('INVALID_ARGS', `recipes 上限 ${PROJECT_RECIPE_LIMIT} 条（收到 ${raw.length}）`)
  }
  return raw.map((r, i) => {
    if (!isRecord(r) || typeof r['name'] !== 'string' || r['name'] === '') {
      throw new AgentToolError('INVALID_ARGS', `recipes[${i}] 需要非空字符串 name`)
    }
    const kind = r['kind']
    if (kind === 'since') {
      if (typeof r['attr'] !== 'string' || r['attr'] === '') {
        throw new AgentToolError('INVALID_ARGS', `recipes[${i}]（since）需要非空字符串 attr`)
      }
      if (r['now'] !== undefined && r['now'] !== null && typeof r['now'] !== 'string') {
        throw new AgentToolError('INVALID_ARGS', `recipes[${i}]（since）now 须为 ISO 字符串`)
      }
      return r as unknown as FeatureRecipe
    }
    if (kind === 'count') {
      if (r['source'] !== 'behaviors' && r['source'] !== 'relations') {
        throw new AgentToolError('INVALID_ARGS', `recipes[${i}]（count）source 须为 behaviors | relations`)
      }
      return r as unknown as FeatureRecipe
    }
    if (kind === 'ratio') {
      if (typeof r['num'] !== 'string' || typeof r['den'] !== 'string' || r['num'] === '' || r['den'] === '') {
        throw new AgentToolError('INVALID_ARGS', `recipes[${i}]（ratio）需要字符串 num 与 den`)
      }
      if (r['minDen'] !== undefined && r['minDen'] !== null && typeof r['minDen'] !== 'number') {
        throw new AgentToolError('INVALID_ARGS', `recipes[${i}]（ratio）minDen 须为数字`)
      }
      return r as unknown as FeatureRecipe
    }
    throw new AgentToolError('INVALID_ARGS', `recipes[${i}].kind 须为 since | count | ratio（收到 ${String(kind)}）`)
  })
}

/**
 * `project_features` 执行体（导出供 attack-surface 表直测 A-1/A-2/A-4）：
 * 参数校验 → 加载（派生门禁）→ 收权（A-1）→ projectFeatures → deriveFeatures。
 * since 配方缺 now 时在工具边界注入当前时刻（A-7 只约束 core 纯函数不得 new Date()）。
 */
export function executeProjectFeatures(
  args: ProjectFeaturesArgs,
  deps: { ws: PackageWorkspace },
): ProjectFeaturesResult {
  if (typeof args.name !== 'string' || args.name === '' || typeof args.version !== 'string' || args.version === '') {
    throw new AgentToolError('INVALID_ARGS', 'name/version 必须为非空字符串')
  }
  if (args.overwrite !== undefined && args.overwrite !== null && typeof args.overwrite !== 'boolean') {
    throw new AgentToolError('INVALID_ARGS', 'overwrite 须为布尔')
  }
  const recipes = validateRecipes(args.recipes)
  const dataset = loadDatasetFromArgs(args)
  const pkg = loadToolPackage(deps.ws, args.name, args.version)
  const contracts = readToolContracts(deps.ws.versionDir(args.name, args.version))
  assertDatasetGranted(dataset, contracts)
  // 工具边界注入 now（工具面允许当前时刻；core 侧仍由配方携带，保持纯函数）。
  const nowIso = new Date().toISOString()
  const ready = recipes.map((r) =>
    r.kind === 'since' && (r.now === undefined || r.now === null) ? { ...r, now: nowIso } : r,
  )
  const overwrite = args.overwrite === true
  const proj = projectFeatures(pkg, dataset, dataset.candidates, { overwrite })
  const der = deriveFeatures(proj.candidates, dataset, ready)
  return {
    dataset: { ...dataset, candidates: der.candidates },
    projected: proj.projected,
    derived: der.derived,
    stats: {
      candidates: der.candidates.length,
      projectedWrites: proj.projected.reduce((n, p) => n + p.keys.length, 0),
      derivedRecipes: der.derived.length,
    },
  }
}

/**
 * `expand_entity` 渲染（A-5 摘要级）：统计行 + 种子/对象 ID 清单（截断 50）。
 * 零 attrs 正文、零绝对路径；ID 面撞红线 fail-loud，跨段拼接经 retreatRenderText 整段兜底。
 */
export function renderExpandText(v: ExpandResult, phrases: readonly string[] = []): string {
  const list = phrases.filter((p) => p !== '')
  const idFace = (key: string, s: string): string => {
    if (list.some((p) => s.includes(p))) {
      throw new AgentToolError('INVALID_TOOL_OUTPUT', `输出契约失败: 禁语短语与 ID 回指字段冲突（${key}）`)
    }
    return s
  }
  const lines: string[] = []
  lines.push(
    `子图扩展 种子=${v.stats.seeds}（缺失 ${v.missingSeedIds.length}）`
      + ` 对象=${v.stats.objects} 关系=${v.stats.relations} 候选=${v.stats.candidates}`
      + ` truncated=${v.truncated}`,
  )
  if (v.seedIds.length > 0) {
    lines.push(`种子: ${v.seedIds.map((s) => idFace('id', s)).join(', ')}`)
  }
  if (v.missingSeedIds.length > 0) {
    lines.push(`缺失种子: ${v.missingSeedIds.map((s) => idFace('missing', s)).join(', ')}`)
  }
  const ids = v.dataset.objects.map((o) => idFace('id', o.id))
  const shown = ids.slice(0, 50)
  lines.push(`对象: ${shown.join(', ')}${ids.length > 50 ? ` …（共 ${ids.length} 个）` : ''}`)
  lines.push('扩图是数据准备，不打分；打分用 run_scenario')
  return retreatRenderText(lines.join('\n'), list)
}

/**
 * `project_features` 渲染（A-5 摘要级）：计数 + 投影键并集 + 派生配方名。
 * 零 attrs 值正文；自由段（键名/配方名）片段重遮 + 拼接后整段兜底。
 */
export function renderProjectText(
  v: { projected: Array<{ candidateId: string; keys: string[] }>; derived: string[]; stats: { candidates: number; projectedWrites: number; derivedRecipes: number } },
  phrases: readonly string[] = [],
): string {
  const list = phrases.filter((p) => p !== '')
  const face = (s: string): string => (list.some((p) => s.includes(p)) ? '【禁语已脱敏】' : s)
  const keyUnion = [...new Set(v.projected.flatMap((p) => p.keys))]
  const gapCount = v.projected.filter((p) => p.keys.length === 0).length
  const lines: string[] = []
  lines.push(
    `特征投影/派生 候选=${v.stats.candidates} 投影写入=${v.stats.projectedWrites}`
      + ` 派生配方=${v.stats.derivedRecipes} 投影缺口候选=${gapCount}`,
  )
  lines.push(`投影键: ${keyUnion.map(face).join(', ') || '—'}`)
  lines.push(`派生: ${v.derived.map(face).join(', ') || '—'}`)
  lines.push('特征就绪后用 run_scenario 打分')
  return retreatRenderText(lines.join('\n'), list)
}

/** 场景清单渲染（render 与测试共用）。 */
export function renderScenarioList(scenarios: unknown[]): string {
  return (
    scenarios
      .map((s) => {
        const r = s as { id: string; name: string; goal: string }
        return `${r.id} ${r.name} — ${r.goal}`
      })
      .join('\n') || '（无场景）'
  )
}

/**
 * recall_experience 渲染（N4 / P4-5 / E1-2）：只回结构位（runId/score/outcome/理由含字段级对照/
 * reviewFocus 下轮复核提示），无自由流程；冷启动 → 不硬迁移话术；差异 mustChange 非空 → 低置信度转人工话术。
 * render 闸：拼接后兜底（retreatRenderText，P2.2 同口径）。
 */
export function renderRecallText(
  v: {
    coldStart: boolean
    hits: Array<{
      runId: string
      score: number
      outcome: string
      counterexample: boolean
      reasons: string[]
      /** 下轮复核提示（人审面沉淀的结构位条目，过 value/render 闸后上墙）。 */
      reviewFocus: string[]
    }>
    advice: string
  },
  phrases?: readonly string[],
): string {
  if (v.coldStart || v.hits.length === 0) {
    return retreatRenderText(
      ['冷启动：无相似经验（不硬迁移，走全量执行）。', 'humanReviewRequired=true（认定出口只在人工复核）'].join('\n'),
      phrases ?? [],
    )
  }
  const lines = v.hits.map((h) => {
    // 字段级对照 = 签名字段新旧形态（源=/源≠/共有N/同（…）/以「 同」结尾的字段名）；
    // 打分位 = 同 scenarioId / stepShape 一致 / Jaccard 等检索理由。
    const field = h.reasons.filter((r) => /源=|源≠|共有\d|同（| 同$/.test(r))
    const scoreBits = h.reasons.filter((r) => !field.includes(r))
    const focus = h.reviewFocus.length > 0 ? ` 复核提示[${h.reviewFocus.join(', ')}]` : ''
    return [
      `- ${h.runId} score=${h.score.toFixed(2)} outcome=${h.outcome} 反例=${h.counterexample ? '是' : '否'}${focus}`,
      `  打分：${scoreBits.join('; ') || '—'}`,
      `  字段对照：${field.join('; ') || '—'}`,
    ].join('\n')
  })
  return retreatRenderText(
    [`命中 ${v.hits.length} 条：`, ...lines, v.advice, 'humanReviewRequired=true（认定出口只在人工复核）'].join('\n'),
    phrases ?? [],
  )
}

/**
 * recall_experience 命中投影（E1-2）：结构位 + reviewFocus 下轮复核提示。
 * 经验只提示不改分——本函数不触碰打分语义；reviewFocus 经 value 闸后上墙。
 */
export function projectRecallHits(
  hits: ReadonlyArray<{
    note: {
      runId: string
      outcome: string
      counterexample: boolean
      reviewFocus?: string[]
    }
    score: number
    reasons: string[]
  }>,
): Array<{
  runId: string
  score: number
  outcome: string
  counterexample: boolean
  reasons: string[]
  reviewFocus: string[]
}> {
  return hits.map((h) => ({
    runId: h.note.runId,
    score: Number(h.score.toFixed(2)),
    outcome: h.note.outcome,
    counterexample: h.note.counterexample,
    reasons: h.reasons,
    reviewFocus: h.note.reviewFocus ?? [],
  }))
}

/**
 * annotate_experience 纯函数（experience-loop P4-3 / S5.4）：
 * 人审回填 + 首次标注共用——note 已存在走 reviewExperienceNote，不存在则从 RunRecord 新建。
 * humanApproved 人审契约：agent 不得自行标注；误迁移 by 必须非空人工身份（模型不自评）。
 * 审计闸与 CLI `exp annotate` 同口径：新建与回填标 success 均查审计（除非 counterexample）——
 * 机器闸不否决人审的部分留给 workbench `reviewExperience` 人审面（不经本函数）。
 * reusedFromRunId：复用归因（S5.4.4），新建与回填均可写，diff 机械生成。
 */
export function annotateExperienceForTool(
  ws: PackageWorkspace,
  args: {
    runId: string
    outcome?: ExperienceOutcome
    outcomeReason?: string
    misTransfer?: { judged: boolean; by: string; note?: string }
    reviewFocus?: string[]
    counterexample?: boolean
    reusedFromRunId?: string
    humanApproved?: unknown
  },
): {
  runId: string
  outcome: ExperienceOutcome
  counterexample: boolean
  misTransferJudged: boolean
  misTransferBy?: string
  reviewFocus: string[]
  created: boolean
  humanReviewRequired: true
} {
  assertHumanApproved(args.humanApproved, '标注经验')
  const hasPatch =
    args.outcome !== undefined ||
    args.outcomeReason !== undefined ||
    args.misTransfer !== undefined ||
    args.reviewFocus !== undefined ||
    args.reusedFromRunId !== undefined
  if (!hasPatch) {
    throw new AgentToolError('INVALID_ARGS', '至少提供 outcome / outcomeReason / misTransfer / reviewFocus / reusedFromRunId 之一')
  }
  if (args.misTransfer !== undefined) {
    if (typeof args.misTransfer.judged !== 'boolean') {
      throw new AgentToolError('INVALID_ARGS', 'misTransfer.judged 必须是 boolean')
    }
    if (typeof args.misTransfer.by !== 'string' || args.misTransfer.by.trim() === '') {
      throw new AgentToolError('INVALID_ARGS', 'misTransfer.by 必须为非空人工身份（误迁移只由人判）')
    }
  }

  let existing: ExperienceNote | null = null
  try {
    existing = loadExperienceNote(ws.root, args.runId)
  } catch (e) {
    if (e instanceof PackageStoreError && e.code === 'NOT_FOUND') existing = null
    else throw e
  }

  // 审计闸（新建与回填同口径）：标 success 前查 RunRecord 审计，除非 counterexample。
  const gateSuccess = (counterexample: boolean): void => {
    if (args.outcome !== 'success' || counterexample) return
    const rec = loadRunRecord(ws.root, args.runId)
    if (rec.result.audit.passed !== true) {
      throw new AgentToolError(
        'INVALID_ARGS',
        '审计未通过：不得标注 success（请用 failure/partial，或显式 counterexample）',
      )
    }
  }

  if (existing !== null) {
    gateSuccess(existing.counterexample || args.counterexample === true)
    // 旧签名升版：人审触碰即按当前包补 ruleShape（packageScope 不一致时 upgrade 内部跳过）。
    let upgradePkg: ReturnType<typeof loadPackage> | undefined
    try {
      const rec0 = loadRunRecord(ws.root, args.runId)
      upgradePkg = loadPackage(ws.versionDir(rec0.package.name, rec0.package.version))
    } catch {
      upgradePkg = undefined
    }
    const note = reviewExperienceNote(ws.root, args.runId, {
      outcome: args.outcome,
      outcomeReason: args.outcomeReason,
      misTransfer: args.misTransfer,
      reviewFocus: args.reviewFocus,
      reusedFromRunId: args.reusedFromRunId,
      upgradePkg,
    })
    return projectAnnotateReceipt(note, false)
  }

  // 新建路径：必须带 outcome；签名从 RunRecord + 包机械导出（同 CLI exp annotate）。
  if (args.outcome === undefined) {
    throw new AgentToolError('INVALID_ARGS', '经验记录不存在：创建时必须提供 outcome')
  }
  const counterexample = args.counterexample === true
  const rec = loadRunRecord(ws.root, args.runId)
  if (args.outcome === 'success' && rec.result.audit.passed !== true && !counterexample) {
    throw new AgentToolError(
      'INVALID_ARGS',
      '审计未通过：不得标注 success（请用 failure/partial，或显式 counterexample）',
    )
  }
  const pkg = loadPackage(ws.versionDir(rec.package.name, rec.package.version))
  const signature = buildTaskSignature({
    pkg,
    scenarioId: rec.scenarioId,
    datasetSummary: rec.datasetSummary,
  })
  const note: ExperienceNote = {
    runId: args.runId,
    signature,
    outcome: args.outcome,
    outcomeReason: args.outcomeReason,
    skillRefsUsed: signature.skillRefs,
    reusedFrom:
      args.reusedFromRunId !== undefined
        ? {
            runId: args.reusedFromRunId,
            diff: buildDiffTable(signature, loadExperienceNote(ws.root, args.reusedFromRunId).signature),
          }
        : undefined,
    counterexample,
    misTransfer:
      args.misTransfer !== undefined
        ? { judged: args.misTransfer.judged, by: args.misTransfer.by.trim(), note: args.misTransfer.note ?? '' }
        : undefined,
    reviewFocus: args.reviewFocus !== undefined ? [...args.reviewFocus] : undefined,
    savedAt: new Date().toISOString(),
  }
  saveExperienceNote(ws.root, note)
  return projectAnnotateReceipt(note, true)
}

function projectAnnotateReceipt(
  note: ExperienceNote,
  created: boolean,
): {
  runId: string
  outcome: ExperienceOutcome
  counterexample: boolean
  misTransferJudged: boolean
  misTransferBy?: string
  reviewFocus: string[]
  created: boolean
  humanReviewRequired: true
} {
  return {
    runId: note.runId,
    outcome: note.outcome,
    counterexample: note.counterexample,
    misTransferJudged: note.misTransfer?.judged ?? false,
    misTransferBy: note.misTransfer?.by,
    reviewFocus: note.reviewFocus ?? [],
    created,
    humanReviewRequired: true,
  }
}

/** annotate_experience 渲染（N5）：只回结构位回执，无自由流程、无服务端路径；render 闸拼接后兜底。 */
export function renderAnnotateText(
  v: {
    runId: string
    outcome: string
    counterexample: boolean
    misTransferJudged: boolean
    misTransferBy?: string
    reviewFocus: string[]
    created: boolean
  },
  phrases?: readonly string[],
): string {
  const lines = [
    `已标注 ${v.runId} outcome=${v.outcome} 反例=${v.counterexample ? '是' : '否'}（${v.created ? '新建' : '回填'}）`,
  ]
  if (v.misTransferJudged) {
    lines.push(`误迁移 judged=true by=${v.misTransferBy ?? ''}`)
  }
  if (v.reviewFocus.length > 0) {
    lines.push(`reviewFocus: ${v.reviewFocus.join(', ')}`)
  }
  lines.push('humanReviewRequired=true（认定在人工）')
  return retreatRenderText(lines.join('\n'), phrases ?? [])
}

/**
 * abstract_experience 回执行（D13）：merged 技能簇附正文状态/更新通道字段。
 * - `op=update` + `targetId`：正文过期，已入队正文更新草案（批准后 apply_draft 刷新正文）。
 * - `bodyUpToDate`：包内正文与最新簇一致，无需更新（消「批准也没用」落差）。
 */
export interface AbstractQueuedEntry {
  id: string
  name: string
  targetKind: string
  status: string
  members: number
  runId: string
  package?: string
  op?: 'update'
  targetId?: string
  bodyUpToDate?: true
}

/** D13：包内技能正文与最新簇载荷比对（steps/outputTemplate 精确、weights 键排序）。 */
export function skillBodyCurrent(
  el: { steps?: string[]; weights?: Record<string, number>; outputTemplate?: string },
  payload: Record<string, unknown>,
): boolean {
  const steps = Array.isArray(payload['steps']) ? (payload['steps'] as unknown[]) : null
  const w = payload['weights']
  const weights = w !== null && typeof w === 'object' && !Array.isArray(w) ? (w as Record<string, unknown>) : null
  const out = typeof payload['outputTemplate'] === 'string' ? payload['outputTemplate'] : null
  const canon = (x: Record<string, unknown> | null): string =>
    x === null ? 'null' : JSON.stringify(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  return (
    JSON.stringify(el.steps ?? null) === JSON.stringify(steps) &&
    canon(el.weights ?? null) === canon(weights) &&
    (el.outputTemplate ?? null) === out
  )
}

/** D13：从簇载荷提取 SkillTemplate 可更新字段（id/scenarioId 在 update 白名单外，起草即拒——剥掉）。 */
function pickSkillBodyPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (Array.isArray(payload['steps'])) out['steps'] = payload['steps']
  if (payload['weights'] !== null && typeof payload['weights'] === 'object' && !Array.isArray(payload['weights'])) {
    out['weights'] = payload['weights']
  }
  if (typeof payload['outputTemplate'] === 'string') out['outputTemplate'] = payload['outputTemplate']
  return out
}

/**
 * D13：SkillTemplate 簇命中已物化（merged）草案 → 正文更新通道。
 * 比对包内元素正文与最新簇载荷：一致 → 回执 bodyUpToDate（诚实状态，消落差）；
 * 过期 → 入队 op=update 正文更新草案。在途 pending/approved **直接复用且不覆盖 payload**
 * （人审可能已编辑；载荷落后时物化后下轮重抽象按 `#N` 换代重提，自愈）；
 * 上一代已物化则按 `#N` 换代重提，绕开 update 幂等键防死锁。元素定位不到 → null（走原 merged 回执）。
 * 只入队不直写包（I1）；物化必经 apply_draft。经验只提示不改分。
 */
export function skillBodyUpdateEntry(
  knowledge: KnowledgeStore,
  pkg: OntologyPackage,
  packageName: string,
  a: { draft: DraftItem; memberRunIds: string[] },
  mergedCreate: DraftCandidate,
  withPackage: boolean,
): AbstractQueuedEntry | null {
  const base = {
    members: a.memberRunIds.length,
    runId: a.memberRunIds[0],
    ...(withPackage ? { package: `${pkg.meta.name}@${pkg.meta.version}` } : {}),
  }
  // 定位已物化元素：appliedAs → payload.id → 同名兜底
  const hint =
    typeof mergedCreate.appliedAs === 'string' && mergedCreate.appliedAs !== ''
      ? mergedCreate.appliedAs
      : typeof mergedCreate.payload['id'] === 'string'
        ? (mergedCreate.payload['id'] as string)
        : undefined
  const el =
    (hint !== undefined ? pkg.skillTemplates.find((s) => s.id === hint) : undefined) ??
    pkg.skillTemplates.find((s) => s.name === a.draft.name)
  if (!el) return null
  const fresh = pickSkillBodyPayload(a.draft.payload)
  if (skillBodyCurrent(el, a.draft.payload)) {
    return {
      id: mergedCreate.id,
      name: mergedCreate.name,
      targetKind: 'SkillTemplate',
      status: 'merged',
      ...base,
      targetId: el.id,
      bodyUpToDate: true,
    }
  }
  // 在途 update（pending/approved）直接复用——不覆盖 payload（人审可能已编辑；载荷落后时
  // 物化后下轮重抽象会按 #N 换代重提，自愈）
  const baseName = a.draft.name
  const prior = knowledge
    .listCandidates({ packageId: packageName })
    .filter(
      (x) =>
        x.op === 'update' &&
        x.targetKind === 'SkillTemplate' &&
        x.targetId === el.id &&
        (x.name === baseName || x.name.startsWith(`${baseName}#`)) &&
        x.status !== 'rejected',
    )
  const inflight = prior.find((x) => x.status === 'pending' || x.status === 'approved')
  if (inflight) {
    return {
      id: inflight.id,
      name: inflight.name,
      targetKind: 'SkillTemplate',
      status: inflight.status,
      ...base,
      op: 'update',
      targetId: el.id,
    }
  }
  // 无在途 → 新一代 update：上一代已 merged 时按计数换名，绕开同键幂等返回旧草案
  const name = prior.length === 0 ? baseName : `${baseName}#${prior.length + 1}`
  const upd = knowledge.addDraft({
    packageId: packageName,
    item: {
      layer: 'O2',
      op: 'update',
      targetKind: 'SkillTemplate',
      targetId: el.id,
      name,
      payload: fresh,
      confidence: a.draft.confidence,
      rationale: a.draft.rationale,
    },
    provenance: { runId: a.memberRunIds[0] },
  })
  return {
    id: upd.id,
    name: upd.name,
    targetKind: 'SkillTemplate',
    status: upd.status,
    ...base,
    op: 'update',
    targetId: el.id,
  }
}

/**
 * abstract_experience 纯函数（闭环 E2-1；D11 扫全库）：成功/反例经验按结构签名聚簇 →
 * SkillTemplate / RedLine / ExclusionRule 草案入知识库人审队列（pending）。
 * 只入队、永不直写包（I1）；物化必经 apply_draft（humanApproved 人审契约）。
 * 经验只提示不改分——本函数不触碰 core/src/rules.ts 打分语义。
 *
 * packageId 省略（D11）→ 扫描全库：只处理「有经验记录且非 ISSUED」的包；
 * ISSUED 记入 skipped 不整单失败（扫全库是发现面，不该被单个只读包打断）。
 */
export function abstractExperienceForTool(
  ws: PackageWorkspace,
  knowledge: KnowledgeStore,
  args: {
    packageId?: string
    minCluster?: number
    humanApproved?: unknown
  },
): {
  package: string
  scanned?: Array<{
    package: string
    skipped?: string
    queued: number
    skills: number
    counters: number
  }>
  queued: AbstractQueuedEntry[]
  skills: number
  counters: number
  humanReviewRequired: true
} {
  assertHumanApproved(args.humanApproved, '总结经验')
  let minCluster: number | undefined
  if (args.minCluster !== undefined) {
    if (typeof args.minCluster !== 'number' || !Number.isInteger(args.minCluster) || args.minCluster < 1) {
      throw new AgentToolError('INVALID_ARGS', 'minCluster 必须是 ≥1 的整数')
    }
    minCluster = args.minCluster
  }

  const queueOne = (
    pkg: OntologyPackage,
    packageName: string,
    withPackage: boolean,
  ): {
    queued: AbstractQueuedEntry[]
    skills: number
    counters: number
  } => {
    const abs = abstractSkillDrafts(ws.root, { pkg, minCluster })
    const counters = abstractCounterexampleDrafts(ws.root, { pkg, minCluster })
    const queued: AbstractQueuedEntry[] = []
    for (const a of [...abs, ...counters]) {
      const c = knowledge.addDraft({
        packageId: packageName,
        item: a.draft,
        provenance: { runId: a.memberRunIds[0] },
      })
      // D13：SkillTemplate 已物化（merged）→ 正文更新通道（一致回执 bodyUpToDate；过期入队 op=update）
      if (c.status === 'merged' && a.draft.targetKind === 'SkillTemplate') {
        const entry = skillBodyUpdateEntry(knowledge, pkg, packageName, a, c, withPackage)
        if (entry !== null) {
          queued.push(entry)
          continue
        }
      }
      queued.push({
        id: c.id,
        name: c.name,
        targetKind: c.targetKind,
        status: c.status,
        members: a.memberRunIds.length,
        runId: a.memberRunIds[0],
        ...(withPackage ? { package: `${pkg.meta.name}@${pkg.meta.version}` } : {}),
      })
    }
    return { queued, skills: abs.length, counters: counters.length }
  }

  if (args.packageId !== undefined) {
    const packageName = requireExistingPackage(ws.listVersions(), args.packageId)
    const version = args.packageId.slice(args.packageId.lastIndexOf('@') + 1)
    const dir = ws.versionDir(packageName, version)
    let pkg: OntologyPackage
    try {
      pkg = loadPackage(dir)
    } catch {
      throw new AgentToolError('NOT_FOUND', `包不存在或无法加载: ${args.packageId}`)
    }
    if (pkg.meta.status === 'ISSUED') {
      throw new AgentToolError('INVALID_ARGS', `${packageName}@${version} 已签发只读：请 fork 新版本（P1）`)
    }
    const one = queueOne(pkg, packageName, false)
    return {
      package: `${packageName}@${version}`,
      queued: one.queued,
      skills: one.skills,
      counters: one.counters,
      humanReviewRequired: true,
    }
  }

  // D11 扫全库：只扫「有经验记录」的包（无经验包不进回执——发现面要的是「哪里能沉淀」）。
  const scopes = new Set(listExperienceNotes(ws.root).map((n) => n.signature.packageScope))
  const scanned: Array<{
    package: string
    skipped?: string
    queued: number
    skills: number
    counters: number
  }> = []
  const queued: AbstractQueuedEntry[] = []
  let skills = 0
  let countersTotal = 0
  for (const v of ws.listVersions()) {
    const scope = `${v.name}@${v.version}`
    if (!scopes.has(scope)) continue
    if (v.status === 'ISSUED') {
      scanned.push({ package: scope, skipped: '已签发只读：请 fork 新版本（P1）', queued: 0, skills: 0, counters: 0 })
      continue
    }
    let pkg: OntologyPackage
    try {
      pkg = loadPackage(v.dir)
    } catch {
      scanned.push({ package: scope, skipped: '包不存在或无法加载', queued: 0, skills: 0, counters: 0 })
      continue
    }
    const one = queueOne(pkg, v.name, true)
    scanned.push({ package: scope, queued: one.queued.length, skills: one.skills, counters: one.counters })
    queued.push(...one.queued)
    skills += one.skills
    countersTotal += one.counters
  }
  return {
    package: '全库',
    scanned,
    queued,
    skills,
    counters: countersTotal,
    humanReviewRequired: true,
  }
}

/** abstract_experience 渲染（E2-1/D11/D13）：结构位回执（草案 id/kind/簇员/status + 正文更新通道），无服务端路径。 */
export function renderAbstractText(
  v: {
    package: string
    scanned?: Array<{
      package: string
      skipped?: string
      queued: number
      skills: number
      counters: number
    }>
    queued: AbstractQueuedEntry[]
    skills: number
    counters: number
  },
  phrases?: readonly string[],
): string {
  // D13：merged 技能簇行附正文状态——op=update（过期已入队更新草案）/ bodyUpToDate（一致无需更新）
  const entryLine = (q: AbstractQueuedEntry): string => {
    const at = v.scanned !== undefined ? `@${q.package ?? ''} ` : ' '
    const body =
      q.op === 'update' && q.targetId !== undefined
        ? ` op=update targetId=${q.targetId}（正文过时：批准后 apply_draft 刷新技能正文）`
        : q.bodyUpToDate === true
          ? ' bodyUpToDate（正文已与最新簇一致，无需更新）'
          : ''
    return `+ [${q.targetKind}] ${q.name}（${q.id}）${at}status=${q.status} 簇员=${q.members} 代表=${q.runId}${body}`
  }
  if (v.scanned !== undefined) {
    // D11 扫全库回执：逐包一行（含跳过原因），草案行带包归属。
    const lines = [
      `全库扫描：候选经验包 ${v.scanned.length} 个，入队合计 ${v.queued.length} 条（技能 ${v.skills} · 反例 ${v.counters}）`,
      ...v.scanned.map((s) =>
        s.skipped !== undefined
          ? `- ${s.package}：跳过（${s.skipped}）`
          : `- ${s.package}：入队 ${s.queued} 条（技能 ${s.skills} · 反例 ${s.counters}）`,
      ),
      ...v.queued.map(entryLine),
      'humanReviewRequired=true（物化必经 apply_draft 人审；只入队不直写包）',
    ]
    if (v.queued.length === 0) {
      lines.splice(
        1 + v.scanned.length,
        0,
        '无可入队簇（成功同构/反例簇员需 ≥minCluster，缺省 2；当前不足或无参聚经验）',
      )
    }
    return retreatRenderText(lines.join('\n'), phrases ?? [])
  }
  if (v.queued.length === 0) {
    return retreatRenderText(
      [
        `包 ${v.package}：无可入队簇（成功同构/反例簇员需 ≥minCluster，缺省 2；当前不足或无参聚经验）`,
        'humanReviewRequired=true（物化必经 apply_draft 人审；只入队不直写包）',
      ].join('\n'),
      phrases ?? [],
    )
  }
  const lines = [
    `包 ${v.package}：经验抽象入队 ${v.queued.length} 条（技能 ${v.skills} · 反例 ${v.counters}）`,
    ...v.queued.map(entryLine),
    'humanReviewRequired=true（物化必经 apply_draft 人审；只入队不直写包）',
  ]
  return retreatRenderText(lines.join('\n'), phrases ?? [])
}

/** get_model_graph 渲染：概览 + issues 精选（info 之外最多 10 条）。 */
export function renderGraphSummary(g: ModelGraph): string {
  const draftCount = g.nodes.filter((n) => n.draft).length
  const errCount = g.issues.filter((i) => i.level === 'error').length
  const warnCount = g.issues.filter((i) => i.level === 'warn').length
  const lines = [
    `包 ${g.package}@${g.version}（${g.status}，rev ${g.revision}）`,
    `节点 ${g.nodes.length}（待审草案 ${draftCount}）· 边 ${g.edges.length} · issues：error ${errCount} / warn ${warnCount}`,
  ]
  if (g.skeleton) lines.push(`骨架：${g.skeleton.confirmed ? '已确认' : '未确认'}（${g.skeleton.ids.length} 个 ID）`)
  const notable = g.issues.filter((i) => i.level !== 'info').slice(0, 10)
  for (const i of notable) lines.push(`- [${i.level}] ${i.code} @ ${i.where}: ${i.message}`)
  if (g.issues.filter((i) => i.level !== 'info').length > notable.length) {
    lines.push(`… 其余 ${g.issues.filter((i) => i.level !== 'info').length - notable.length} 条见完整结果`)
  }
  return lines.join('\n')
}

/** draft_elements 渲染：入队与拒收清单。 */
export function renderDraftResult(v: {
  package?: string
  turnId?: string
  added?: Array<{ id: string; name: string; targetKind: string; forcedReview?: boolean }>
  rejected?: Array<{ index: number; reason: string }>
  sourceId?: string
}): string {
  const added = v.added ?? []
  const rejected = v.rejected ?? []
  const lines = [`包 ${v.package ?? ''} · 轮次 ${v.turnId ?? ''}：入队 ${added.length} 条`]
  if (v.sourceId) lines.push(`CONVERSATION 原料：${v.sourceId}`)
  if (added.length > 0) {
    lines.push('同批物化提示：用户一次点头后 apply_draft 传入全部 candidateIds 同批物化（勿逐条）；画布节点内嵌 ✓ 亦可直接人审')
  }
  for (const a of added) {
    lines.push(`+ [${a.targetKind}] ${a.name}（${a.id}）${a.forcedReview ? ' · 强制人审' : ''}`)
  }
  for (const r of rejected) lines.push(`- 第 ${r.index + 1} 条拒收：${r.reason}`)
  return lines.join('\n')
}

/** list_capabilities 渲染：L1–L5 每层一行。 */
export function renderCapabilities(cap: Record<string, unknown>): string {
  const line = (key: string): string => {
    const layer = cap[key] as { name?: string; entries?: unknown[]; skills?: unknown[]; experts?: unknown[]; files?: unknown[]; apiSources?: unknown[]; note?: string } | undefined
    if (!layer) return `${key}: —`
    const parts: string[] = [`${key} ${layer.name ?? ''}`]
    if (Array.isArray(layer.entries)) parts.push(`${layer.entries.length} 个场景入口`)
    if (Array.isArray(layer.apiSources)) parts.push(`${layer.apiSources.length} 个数据源`)
    if (Array.isArray(layer.skills)) parts.push(`${layer.skills.length} 个技能`)
    if (Array.isArray(layer.experts)) parts.push(`${layer.experts.length} 个专家`)
    if (Array.isArray(layer.files) && layer.files.length > 0) parts.push(`派生文件 ${layer.files.length}`)
    if (layer.note) parts.push(layer.note)
    return parts.join(' · ')
  }
  const head = `包 ${cap.package ?? ''}（${cap.status ?? ''}）· 派生 ${cap.derived === true ? '已生成' : '未生成'}`
  return [head, line('L1'), line('L2'), line('L3'), line('L4'), line('L5')].join('\n')
}

export const name = 'dsh-onto-agent-tools'
export const inject = ['tools']

export function apply(ctx: Context): void {
  const dataDir = resolveDataDir(ctx)
  // 错误信封剥除清单：工具错误不再回显 dataDir 派生的任何服务端路径（P2.4）。
  registerServerDir(dataDir)
  const ws = new PackageWorkspace(join(dataDir, 'workspace'))
  const knowledge = new KnowledgeStore(dataDir)
  // 短语清单持久后端（S2.1）：跨进程 recall 回读 RunRecord.redlines。
  configurePhraseStore((runId) => loadRunRedlines(ws.root, runId))

  const load = (pkgName: string, version: string): OntologyPackage =>
    loadToolPackage(ws, pkgName, version)

  // 红线惰性取值：仅错误/guard 拒绝时 loadPackage，成功路径零开销。
  const redlines = (args: unknown): string[] => redlinesForArgs(ws, args)

  ctx.tools.guard((execution) => {
    const denial = grantGuardDecision(execution.name, execution.arguments, (n, v) =>
      readToolContracts(ws.versionDir(n, v)),
    )
    if (denial === undefined) return undefined
    // 拒绝语若回显了入参中的红线短语：保留 `CODE:` 机器码前缀，语义段整段退避
    //（guard 出口是字符串信封，码嵌在串里，不能像 AgentToolError 那样靠 .code 字段保码）。
    const retreated = retreatPhraseEcho(denial, redlines(execution.arguments))
    if (retreated === denial) return denial
    const colon = denial.indexOf(':')
    const code = colon > 0 ? denial.slice(0, colon + 1) : ''
    return `${code} 错误消息含禁语，已整段脱敏`
  })

  ctx.tools.register(
    defineTool({
      name: 'list_packages',
      description: '列出工作区全部业务本体包（名称、版本、状态、域）。只读。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            packages: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  name: { type: 'string', required: true },
                  version: { type: 'string', required: true },
                  status: { type: 'string', required: true },
                  domain: { type: 'string', required: true },
                },
              },
            },
          },
        },
        render: (_args, value) =>
          textBlock(
            value.packages
              .map((p) => `${p.name}@${p.version}（${p.status}, ${p.domain}）`)
              .join('\n') || '（无包）',
          ),
      },
      execute: toolExecute(() => ({ packages: projectPackageList(ws.listVersions()) })),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'list_runs',
      description:
        '列出工作区运行记录摘要（runId、包、场景、时间、候选数、审计是否通过）。只读——'
        + '「上次跑得怎么样 / 最近有哪些运行」类发现入口，免翻目录。',
      parameters: {
        limit: { type: 'number', description: '最多返回条数（缺省 20，上限 100）' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            runs: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  runId: { type: 'string', required: true },
                  package: { type: 'string', required: true },
                  scenarioId: { type: 'string', required: true },
                  savedAt: { type: 'string', required: true },
                  candidateCount: { type: 'number', required: true },
                  auditPassed: { type: 'boolean', required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          const runs = (value as { runs: Array<Record<string, unknown>> }).runs
          if (runs.length === 0) return textBlock('（无运行记录）')
          return textBlock(
            runs
              .map(
                (r) =>
                  `- ${String(r.runId)} · ${String(r.package)} · ${String(r.scenarioId)}`
                  + ` · ${String(r.savedAt)} · 候选 ${String(r.candidateCount)} · 审计${r.auditPassed === true ? '过' : '未过'}`,
              )
              .join('\n'),
          )
        },
      },
      execute: toolExecute((args: { limit?: number }) => {
        const limitRaw = args.limit
        const limit =
          typeof limitRaw === 'number' && Number.isFinite(limitRaw) && limitRaw >= 1
            ? Math.min(Math.floor(limitRaw), 100)
            : 20
        const runs = listRunRecords(ws.root)
          .slice(0, limit)
          .map((r) => ({
            runId: r.runId,
            package: `${r.package.name}@${r.package.version}`,
            scenarioId: r.scenarioId,
            savedAt: r.savedAt,
            candidateCount: r.result.candidates?.length ?? 0,
            auditPassed: r.result.audit?.passed === true,
          }))
        return toolOut({ runs })
      }),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'list_drafts',
      description:
        '列出知识库待审/已批草案摘要（id、包、targetKind、name、status、forcedReview）。只读——'
        + '「有哪些待审草案 / 草案什么状态」发现入口，免读 queue.json。',
      parameters: {
        packageId: { type: 'string', description: '可选：按包名过滤（裸名或 name@version）' },
        status: {
          type: 'string',
          enum: ['pending', 'approved', 'merged', 'rejected'],
          description: '可选：按状态过滤',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            drafts: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  id: { type: 'string', required: true },
                  packageId: { type: 'string', required: true },
                  targetKind: { type: 'string', required: true },
                  name: { type: 'string', required: true },
                  status: { type: 'string', required: true },
                  forcedReview: { type: 'boolean', required: true },
                  appliedAs: { type: 'string' },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          const drafts = (value as { drafts: Array<Record<string, unknown>> }).drafts
          if (drafts.length === 0) return textBlock('（无草案）')
          return textBlock(
            drafts
              .map(
                (d) =>
                  `- ${String(d.id)} · ${String(d.packageId)} · [${String(d.targetKind)}] ${String(d.name)}`
                  + ` · ${String(d.status)}`
                  + (typeof d.appliedAs === 'string' && d.appliedAs !== '' ? ` → ${d.appliedAs}` : '')
                  + `${d.forcedReview === true ? ' · 强制人审' : ''}`,
              )
              .join('\n'),
          )
        },
      },
      execute: toolExecute((args: { packageId?: string; status?: string }) => {
        const filter: { packageId?: string; status?: 'pending' | 'approved' | 'merged' | 'rejected' } = {}
        if (typeof args.packageId === 'string' && args.packageId.trim() !== '') {
          filter.packageId = args.packageId.trim()
        }
        if (
          typeof args.status === 'string'
          && (args.status === 'pending' || args.status === 'approved' || args.status === 'merged' || args.status === 'rejected')
        ) {
          filter.status = args.status
        }
        const drafts = knowledge.listCandidates(filter).map((c) => ({
          id: c.id,
          packageId: c.packageId,
          targetKind: c.targetKind,
          name: c.name,
          status: c.status,
          forcedReview: c.forcedReview,
          ...(typeof c.appliedAs === 'string' && c.appliedAs !== '' ? { appliedAs: c.appliedAs } : {}),
        }))
        return toolOut({ drafts })
      }),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'get_package',
      description: '查看一个业务本体包的摘要：元信息、各层计数、规则与场景 ID 清单。只读，不倾倒属性明细。',
      parameters: {
        name: { type: 'string', required: true, description: '包名，如 aml-analysis' },
        version: { type: 'string', required: true, description: '版本号，如 1.0.0' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: {} },
        render: (_args, value) => textBlock(JSON.stringify(value, null, 2)),
      },
      execute: toolExecute(
        (args: { name: string; version: string }) =>
          toolOut(summarizePackage(load(args.name, args.version))),
        [],
        (args) => redlines(args),
      ),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'get_rule',
      description:
        '查看规则口径（O2 打分/排除规则的权重、表达式、阈值、证据模板）。不带 ruleId 返回全量口径清单。只读。',
      parameters: {
        name: { type: 'string', required: true, description: '包名' },
        version: { type: 'string', required: true, description: '版本号' },
        ruleId: { type: 'string', description: '规则 ID，如 RULE-AML-SCORE-FANOUT；缺省返回全部' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: {} },
        render: (_args, value) => textBlock(JSON.stringify(value, null, 2)),
      },
      execute: toolExecute(
        (args: { name: string; version: string; ruleId?: string }) =>
          toolOut(ruleDossier(load(args.name, args.version), args.ruleId)),
        [],
        (args) => redlines(args),
      ),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'list_tool_contracts',
      description:
        '查看对象粒度收权清单（派生 tool-contracts）：每个对象/关系的 grantScope、idRule、可读入参/出参。'
        + '未出现在清单中的对象与属性不可读。只读。',
      parameters: {
        name: { type: 'string', required: true, description: '包名' },
        version: { type: 'string', required: true, description: '版本号' },
        objectId: { type: 'string', description: '按对象/关系 ID 过滤；须在收权清单内' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: { contracts: { type: 'array', required: true, items: { type: 'json' } } },
        },
        render: (_args, value) => textBlock(JSON.stringify(value, null, 2)),
      },
      execute: toolExecute(
        (args: { name: string; version: string; objectId?: string }) => {
          const contracts = readToolContracts(ws.versionDir(args.name, args.version))
          return toolOut({ contracts: pickContracts(contracts, args.objectId) })
        },
        [],
        (args) => redlines(args),
      ),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'list_scenarios',
      description: '列出一个包的场景卡（目标、边界、输入、输出字段）。只读。',
      parameters: {
        name: { type: 'string', required: true, description: '包名' },
        version: { type: 'string', required: true, description: '版本号' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: { scenarios: { type: 'array', required: true, items: { type: 'json' } } },
        },
        render: (_args, value) => textBlock(renderScenarioList(value.scenarios)),
      },
      execute: toolExecute(
        (args: { name: string; version: string }) =>
          toolOut(scenarioCatalog(load(args.name, args.version))),
        [],
        (args) => redlines(args),
      ),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'run_scenario',
      description:
        '执行一个业务本体场景（规则引擎判定，认定出口只在人工）。数据输入二选一：datasetPath（JSON 文件，'
        + '仅限平台进程工作目录内，外部/会话工作区夹具用 dataset 内联）'
        + '或 dataset（内联 RuntimeDataset）。样例数据在 dsh-onto 源码检出目录的 examples/ 下'
        + '（aml-run.json / med-run.json / tax-run.json）——不在会话工作区、也不在平台进程工作目录，'
        + '相对 datasetPath 按平台进程工作目录解析会读不到；请先定位 dsh-onto 检出目录并读取文件内容，'
        + '再用 dataset 内联传入。'
        + '场景声明 prep 时，本次调用会先按声明扩图/投影/派生再打分（可选 seedIds 圈定种子；'
        + 'ad-hoc 扩图仍可用 expand_entity）。'
        + '返回候选风险分、命中规则 ID、证据链、待核实点、'
        + 'humanReviewRequired=true 与禁语扫描结果。',
      parameters: {
        name: { type: 'string', required: true, description: '包名' },
        version: { type: 'string', required: true, description: '版本号' },
        scenarioId: { type: 'string', required: true, description: '场景 ID，如 SCN-AML-FIND-CLUES' },
        datasetPath: {
          type: 'string',
          description: 'RuntimeDataset JSON 文件路径——仅限平台进程工作目录内的路径（围栏防穿越，越界拒绝）；'
            + '样例在 dsh-onto 检出目录 examples/ 下（非会话工作区），通常读不到，请读取文件内容后用 dataset 内联传入',
        },
        dataset: { type: 'json', description: '内联 RuntimeDataset（objects/relations/candidates）' },
        seedIds: {
          type: 'array',
          description: '可选种子实体 ID（非空 ≤32）：场景声明 prep.expand 时用于扩图圈定范围；'
            + '场景未声明 prep.expand 而传入 → INVALID_ARGS。开展场景时从会话提取种子后单次传入即可',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
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
        render: (_args, value) => textBlock(renderRunText(value as unknown as ScenarioRunResult)),
      },
      execute: toolExecute(
        (args: {
          name: string
          version: string
          scenarioId: string
          datasetPath?: string
          dataset?: unknown
          seedIds?: unknown
        }) => {
          const dataset = loadDatasetFromArgs(args)
          const seedIds = validateRunSeedIds(args.seedIds)
          const pkg = load(args.name, args.version)
          const versionDir = ws.versionDir(args.name, args.version)
          const scenario = pkg.scenarios.find((s) => s.id === args.scenarioId)
          if (seedIds !== undefined && !scenario?.prep?.expand) {
            throw new AgentToolError(
              'INVALID_ARGS',
              `场景 ${args.scenarioId} 未声明 prep.expand，无法应用 seedIds`,
            )
          }
          const contracts = readToolContracts(versionDir)
          assertDatasetGranted(dataset, contracts)
          const result = runScenario(
            versionDir,
            args.scenarioId,
            dataset,
            seedIds !== undefined ? { seedIds } : undefined,
          )
          assertRunContract(result)
          // 短语清单双源一次取定（命中 ∪ 场景红线），经注册表带给 render 闸（P2.2）。
          const phrases = collectPhrases(result, scenario?.outputContract.forbiddenPhrases ?? [])
          // 运行留痕（S2.1/S2.4）：effective 进 datasetDigest，原输入只留 inputDigest。
          const effective = result.effectiveDataset ?? dataset
          saveRunRecord(
            ws.root,
            buildRunRecord({
              package: { name: pkg.meta.name, version: pkg.meta.version },
              dataset: effective,
              inputDataset: dataset,
              result,
              redlines: phrases,
            }),
          )
          rememberPhrases(result.runId, phrases)
          return toolOut(enforceOutputPolicy(result, phrases))
        },
        [],
        (args) => redlines(args),
      ),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'compare_runs',
      description:
        '对比两轮场景运行记录（命中规则增删、风险分 delta、待核实变化、排除变化）。' +
        '跨版本/跨场景均可比；结果供人审参考，humanReviewRequired 恒为 true。只读。',
      parameters: {
        runIdA: { type: 'string', required: true, description: '基准运行 ID（如 run-abc12345）' },
        runIdB: { type: 'string', required: true, description: '对比运行 ID（如 run-def67890）' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            runIdA: { type: 'string', required: true },
            runIdB: { type: 'string', required: true },
            scenarioA: { type: 'string', required: true },
            scenarioB: { type: 'string', required: true },
            packageA: { type: 'json', required: true },
            packageB: { type: 'json', required: true },
            sameDataset: { type: 'boolean', required: true },
            candidates: { type: 'json', required: true },
            excludedAdded: { type: 'json', required: true },
            excludedRemoved: { type: 'json', required: true },
            auditPassedA: { type: 'boolean', required: true },
            auditPassedB: { type: 'boolean', required: true },
            humanReviewRequired: { type: 'boolean', required: true, const: true },
          },
        },
        render: (args, value) =>
          textBlock(renderRunDiffText(value as unknown as RunDiff, redlinesForRuns(ws, args))),
      },
      execute: toolExecute(
        (args: { runIdA: string; runIdB: string }) => {
          const a = loadRunRecord(ws.root, args.runIdA)
          const b = loadRunRecord(ws.root, args.runIdB)
          const diff = compareRunRecords(a, b)
          assertDiffContract(diff)
          const phrases = [...new Set([...a.redlines, ...b.redlines].filter((p) => p !== ''))]
          return toolOut(enforceOutputPolicy(diff, phrases))
        },
        [],
        (args) => redlinesForRuns(ws, args),
      ),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'run_scenarios',
      description:
        '批量运行包内场景（同一份数据多场景视角；scenarioIds 缺省为包内全部场景，上限 32）。'
        + '可选 seedIds 同组作用于批次内声明了 prep.expand 的场景；未声明的场景该项落 error。'
        + '单项失败不中断批次；完整结果落运行记录（run-xxxxxxxx），可跟 compare_runs / export_audit。',
      parameters: {
        name: { type: 'string', required: true, description: '包名' },
        version: { type: 'string', required: true, description: '包版本' },
        scenarioIds: {
          type: 'array',
          description: '场景 ID 列表；缺省为包内全部场景',
        },
        datasetPath: {
          type: 'string',
          description: '数据集 JSON 文件路径（与 dataset 二选一；仅限平台进程工作目录内的路径，外部夹具请用 dataset 内联）。'
            + '样例在 dsh-onto 检出目录 examples/ 下（非会话工作区），通常读不到，请读取文件内容后用 dataset 内联传入',
        },
        dataset: {
          type: 'json',
          description: '内联 RuntimeDataset（与 datasetPath 二选一）',
        },
        seedIds: {
          type: 'array',
          description: '可选种子实体 ID（非空 ≤32）：作用于批次内声明了 prep.expand 的场景',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            results: { type: 'json', required: true },
            humanReviewRequired: { type: 'boolean', required: true, const: true },
          },
        },
        render: (args, value) =>
          textBlock(renderBatchText(value as unknown as BatchRunOutput, redlinesForArgs(ws, args))),
      },
      execute: toolExecute(
        (args: {
          name: string
          version: string
          scenarioIds?: unknown
          datasetPath?: string
          dataset?: unknown
          seedIds?: unknown
        }) => {
          const dataset = loadDatasetFromArgs(args)
          const seedIds = validateRunSeedIds(args.seedIds)
          const pkg = load(args.name, args.version)
          const versionDir = ws.versionDir(args.name, args.version)
          const contracts = readToolContracts(versionDir)
          assertDatasetGranted(dataset, contracts)
          const ids = resolveBatchIds(args.scenarioIds, pkg)
          const out = runScenarioBatch({ ws, pkg, versionDir, dataset, ids, seedIds })
          assertBatchContract(out)
          // 出口遮蔽基准：包内全部场景红线（覆盖假场景 ID 回显撞红线形态）。
          return toolOut(enforceOutputPolicy(out, phrasesOfPkg(pkg)))
        },
        [],
        (args) => redlines(args),
      ),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'expand_entity',
      description:
        '沿实例图关系从种子实体 BFS 扩出邻域子 dataset（数据准备，不打分；打分用 run_scenario）。'
        + 'hops 默认 1、硬上限 3；direction 默认 both（out|in|both 可收敛单向）；relationTypes 可只沿指定类型行走。'
        + '种子须存在于 dataset（非空 ≤32）；truncated=true 表示触及跳数上限仍有外沿。'
        + '回执为邻域摘要（统计 + 种子/对象 ID 清单，不含 attrs 明细与边/候选清单）：'
        + '子 dataset = 按对象清单过滤你的输入 dataset（对象命中、边两端命中、候选/行为引用命中即保留）后交 run_scenario。',
      parameters: {
        name: { type: 'string', required: true, description: '包名（收权清单按包核对）' },
        version: { type: 'string', required: true, description: '版本号' },
        seedIds: {
          type: 'array',
          required: true,
          description: '种子实体 ID 列表（非空、≤32，元素须存在于 dataset.objects）',
        },
        hops: { type: 'number', description: '最大跳数 0..3（默认 1；超界 INVALID_ARGS）' },
        relationTypes: { type: 'array', description: '只沿这些关系类型扩展；缺省 = 数据集内全部类型' },
        direction: { type: 'string', description: '扩展方向 out | in | both（默认 both）' },
        datasetPath: {
          type: 'string',
          description: 'RuntimeDataset JSON 文件路径（与 dataset 二选一；仅限平台进程工作目录内，围栏防穿越）',
        },
        dataset: { type: 'json', description: '内联 RuntimeDataset（与 datasetPath 二选一）' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            dataset: { type: 'json', required: true },
            seedIds: { type: 'array', required: true },
            missingSeedIds: { type: 'array', required: true },
            truncated: { type: 'boolean', required: true },
            stats: { type: 'json', required: true },
          },
        },
        render: (args, value) => textBlock(renderExpandText(value as unknown as ExpandResult, redlines(args))),
      },
      execute: toolExecute(
        (args: ExpandEntityArgs) => {
          const result = executeExpandEntity(args, { ws })
          return toolOut(enforceOutputPolicy(result, redlines(args)))
        },
        [],
        (args) => redlines(args),
      ),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'project_features',
      description:
        '按包 featureSources 把对象 attrs 投影进候选 features，并按 recipes 派生 since/count/ratio 特征'
        + '（数据准备，不打分；ad-hoc 探索用此链路——正式开展场景请用 run_scenario(seedIds) 单次调用，'
        + '由场景 prep 声明驱动）。'
        + '投影不覆盖已存在特征（overwrite=true 才覆盖）；派生配方以计算值写入（配方即显式意图）。'
        + 'since 的 now 缺省取当前时刻，显式传 now 可保证回放逐字节一致。'
        + '投影后 COND_FEATURE_UNDECLARED 与排除特征缺口自然收敛。',
      parameters: {
        name: { type: 'string', required: true, description: '包名（featureSources 来源 + 收权清单）' },
        version: { type: 'string', required: true, description: '版本号' },
        recipes: {
          type: 'array',
          description:
            '派生配方列表（≤32）：{name, kind: since|count|ratio, …}；since 带 attr+now，'
            + 'count 带 source: behaviors|relations 与可选 filter，ratio 带 num/den/minDen。缺省不派生',
        },
        overwrite: { type: 'boolean', description: '投影是否覆盖已存在特征（默认 false：显式特征优先）' },
        datasetPath: {
          type: 'string',
          description: 'RuntimeDataset JSON 文件路径（与 dataset 二选一；仅限平台进程工作目录内）',
        },
        dataset: { type: 'json', description: '内联 RuntimeDataset（与 datasetPath 二选一）' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            dataset: { type: 'json', required: true },
            projected: { type: 'array', required: true },
            derived: { type: 'array', required: true },
            stats: { type: 'json', required: true },
          },
        },
        render: (args, value) => textBlock(renderProjectText(value as unknown as ProjectFeaturesResult, redlines(args))),
      },
      execute: toolExecute(
        (args: ProjectFeaturesArgs) => {
          const result = executeProjectFeatures(args, { ws })
          return toolOut(enforceOutputPolicy(result, redlines(args)))
        },
        [],
        (args) => redlines(args),
      ),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'export_audit',
      description:
        '导出一轮运行的审计归档（ruleHitLog、审计项、证据链、时间线）到工作区 runs/exports/ 供人审留痕。' +
        '返回摘要与 workspace 相对 locator；重复导出覆盖幂等。只读数据 + 固定导出目录。',
      parameters: {
        runId: { type: 'string', required: true, description: '运行 ID（如 run-abc12345）' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            exported: { type: 'boolean', required: true, const: true },
            runId: { type: 'string', required: true },
            locator: { type: 'string', required: true },
            auditPassed: { type: 'boolean', required: true },
            candidateCount: { type: 'number', required: true },
            hitRuleCount: { type: 'number', required: true },
            excludedCount: { type: 'number', required: true },
            forbiddenPhraseHitCount: { type: 'number', required: true },
            humanReviewRequired: { type: 'boolean', required: true, const: true },
          },
        },
        render: (args, value) =>
          textBlock(renderExportText(value as unknown as ExportRunSummary, redlinesForRuns(ws, args))),
      },
      execute: toolExecute(
        (args: { runId: string }) => {
          // 固定导出目录（S2.4）：不接受调用方路径，无路径面可攻击。
          const exported = exportRunArchive(ws.root, args.runId)
          const summary = exportSummaryOf(exported)
          return toolOut(enforceOutputPolicy(summary, exported.archive.redlines))
        },
        [],
        (args) => redlinesForRuns(ws, args),
      ),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'recall_experience',
      description:
        '按任务结构签名召回相似历史经验（结构检索，非关键词匹配）。只读。'
        + '命中理由含字段级 signature 新旧对照（scenarioId/ruleRefs/skillRefs/dataBand 等源→新），不止 Jaccard 数字。'
        + '命中含 reviewFocus（下轮复核提示，人审面沉淀的结构位条目）。'
        + 'top-1 走差异修正双路（LLM 腿可注入/启发式回落）与人工闸：unknown 非空或置信度<0.75 → advice 明确转人工'
        + '（附 engine/confidence 结构位）；digest 同构短路直接可参考复用。'
        + '冷启动（无相似经验）或低置信度时不得硬迁移——'
        + '结果仅含结构位（runId/score/outcome/签名字段/reviewFocus/修正回执）与转人工提示，不含自由流程描述。',
      parameters: {
        name: { type: 'string', required: true, description: '包名' },
        version: { type: 'string', required: true, description: '版本号' },
        scenarioId: { type: 'string', required: true, description: '场景 ID，如 SCN-AML-FIND-CLUES' },
        dataset: {
          type: 'json',
          description: '内联 RuntimeDataset（用于结构签名的规模档；缺省按空集=S 档）。'
            + '规模档只看 candidates 数量（S<50/M<500/L≥500）——用户提到数据量时按其数量构造 candidates 数组即可'
            + '（元素可为占位对象，objects/relations 可为空数组）',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            coldStart: { type: 'boolean', required: true },
            hits: { type: 'array', required: true, items: { type: 'json' } },
            advice: { type: 'string', required: true },
            revision: { type: 'json' },
            humanReviewRequired: { type: 'boolean', required: true, const: true },
          },
        },
        render: (args, value) => textBlock(renderRecallText(value as never, redlines(args))),
      },
      execute: toolExecute(
        async (args: { name: string; version: string; scenarioId: string; dataset?: unknown }) => {
          const pkg = load(args.name, args.version)
          const raw = (args.dataset ?? {}) as Partial<RuntimeDataset>
          const dataset: RuntimeDataset = {
            objects: Array.isArray(raw.objects) ? raw.objects : [],
            relations: Array.isArray(raw.relations) ? raw.relations : [],
            behaviors: Array.isArray(raw.behaviors) ? raw.behaviors : undefined,
            candidates: Array.isArray(raw.candidates) ? raw.candidates : [],
          }
          const signature = buildTaskSignature({
            pkg,
            scenarioId: args.scenarioId,
            datasetSummary: {
              objects: dataset.objects.length,
              relations: dataset.relations.length,
              behaviors: dataset.behaviors?.length ?? 0,
              candidates: dataset.candidates.length,
            },
          })
          const result = retrieveSimilar(ws.root, {
            signature,
            externalRefs: pkg.meta.externalRefs,
          })
          const hits = projectRecallHits(result.hits)
          let advice: string
          let revision: TopHitRevision['revision'] | null = null
          if (result.coldStart || hits.length === 0) {
            advice = '冷启动：无相似经验（不硬迁移，走全量执行）'
          } else {
            // E2-2：top-1 走 reviseDiff 双路修正 + 转人工闸（digest 同构由 helper 短路）。
            const top = await reviseTopHitAdvice(signature, result.hits[0].note.signature)
            advice = top.advice
            revision = top.revision
          }
          // value 闸：包内全部场景红线（goalClass 等包自由文本可能撞红线）。
          return toolOut(
            enforceOutputPolicy(
              {
                coldStart: result.coldStart,
                hits,
                advice,
                ...(revision ? { revision } : {}),
                humanReviewRequired: true,
              },
              phrasesOfPkg(pkg),
            ),
          )
        },
        [],
        (args) => redlines(args),
      ),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'annotate_experience',
      description:
        '标注/回填一条经验记录（ExperienceNote 的 outcome、误迁移、reviewFocus）。'
        + 'humanApproved 是人审契约：仅当用户明确指示标注时传 true，agent 不得自行标注；'
        + '误迁移只由人判（misTransfer.by 须为非空人工身份）。'
        + 'note 不存在时按 RunRecord 新建（须带 outcome）；已存在则回填。'
        + '新建与回填标 success 均查审计闸（除非 counterexample）。'
        + 'reusedFromRunId 写复用归因（diff 机械生成）。返回结构位回执，认定出口只在人工。',
      parameters: {
        runId: { type: 'string', required: true, description: '运行 ID（如 run-abc12345）' },
        outcome: {
          type: 'string',
          enum: ['success', 'partial', 'failure', 'pending-human'],
          description: '经验结论；新建时必填',
        },
        outcomeReason: { type: 'string', description: '结论理由（结构位补充，非自由流程）' },
        misTransfer: {
          type: 'json',
          description: '误迁移判定 {judged, by, note?}——by 必须为非空人工身份（模型不自评）',
        },
        reviewFocus: {
          type: 'array',
          items: { type: 'string' },
          description: '下轮检索提示的结构位条目（特征名/OBJ.attr/ruleId）',
        },
        counterexample: { type: 'boolean', description: '反例标记（仅新建路径）' },
        reusedFromRunId: {
          type: 'string',
          description: '复用归因：本轮复用自哪条经验（runId）；diff 按签名机械生成（S5.4.4）',
        },
        humanApproved: {
          type: 'boolean',
          required: true,
          description: '人审契约：仅当用户明确指示标注后代执行传 true',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            runId: { type: 'string', required: true },
            outcome: { type: 'string', required: true },
            counterexample: { type: 'boolean', required: true },
            misTransferJudged: { type: 'boolean', required: true },
            reviewFocus: { type: 'array', required: true, items: { type: 'string' } },
            created: { type: 'boolean', required: true },
            humanReviewRequired: { type: 'boolean', required: true, const: true },
          },
        },
        render: (args, value) => textBlock(renderAnnotateText(value as never, redlinesForRuns(ws, args))),
      },
      execute: toolExecute(
        (raw: {
          runId: string
          humanApproved: boolean
          outcome?: ExperienceOutcome
          outcomeReason?: string
          misTransfer?: unknown
          reviewFocus?: string[]
          counterexample?: boolean
          reusedFromRunId?: string
        }) => {
          const args: Parameters<typeof annotateExperienceForTool>[1] = {
            runId: raw.runId,
            humanApproved: raw.humanApproved,
            outcome: raw.outcome,
            outcomeReason: raw.outcomeReason,
            misTransfer:
              raw.misTransfer !== undefined && raw.misTransfer !== null
                ? (raw.misTransfer as { judged: boolean; by: string; note?: string })
                : undefined,
            reviewFocus: raw.reviewFocus,
            counterexample: raw.counterexample,
            reusedFromRunId: raw.reusedFromRunId,
          }
          // value 闸：误迁移 by / reviewFocus 是人审面自由文本，回流模型面须过红线清单。
          return toolOut(enforceOutputPolicy(annotateExperienceForTool(ws, args), redlinesForRuns(ws, args)))
        },
        [],
        (args) => redlinesForRuns(ws, args),
      ),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'abstract_experience',
      description:
        '经验抽象巩固（E2-1）：把包内成功/反例经验按结构签名聚簇，产出 SkillTemplate/RedLine/ExclusionRule'
        + '草案入知识库人审队列——只入队、永不直写包；物化必须走 apply_draft（humanApproved 人审）。'
        + '用于「总结成功经验 / 沉淀方法论 / 反复出现的做法」类请求：不要再写工作区方法论文档代替本工具。'
        + 'humanApproved 是人审契约：仅当用户明确要求总结/沉淀经验时传 true，agent 不得自行总结。'
        + 'packageId 可省略：省略即扫描全库有经验的非 ISSUED 包（「最近这些成功经验」类请求不必先追问包名，'
        + '也不要为此翻目录找包——直接不传 packageId）。'
        + '反例/误迁移经验不参聚成功簇（反例只落红线或排除草案）；簇员不足回执说明、不硬凑。'
        + 'D13 正文更新通道：技能簇已物化（merged）后重跑——回执 bodyUpToDate 表示正文已与最新簇一致；'
        + '回执 op=update/targetId 表示正文过时、已入队正文更新草案，批准后 apply_draft 即刷新技能正文。'
        + '返回结构位回执（草案 id/kind/status/簇员数），认定出口只在人工。',
      parameters: {
        packageId: {
          type: 'string',
          description: '包 ID（name@version，如 aml-analysis@1.0.0）；省略 = 扫描全库有经验的非 ISSUED 包',
        },
        minCluster: {
          type: 'number',
          description: '最小簇员数（缺省 2；≥1 整数）——低于该值不出草案',
        },
        humanApproved: {
          type: 'boolean',
          required: true,
          description: '人审契约：仅当用户明确指示总结/沉淀经验时传 true',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            package: { type: 'string', required: true },
            scanned: { type: 'array', items: { type: 'json' } },
            queued: { type: 'array', required: true, items: { type: 'json' } },
            skills: { type: 'number', required: true },
            counters: { type: 'number', required: true },
            humanReviewRequired: { type: 'boolean', required: true, const: true },
          },
        },
        render: (_args, value) =>
          textBlock(
            renderAbstractText(
              value as never,
              isRecord(_args) && typeof _args.packageId === 'string' ? redlines(_args) : workspaceRedlines(ws),
            ),
          ),
      },
      execute: toolExecute(
        (args: { packageId?: string; minCluster?: number; humanApproved: boolean }) => {
          // 抽象只读 O 层源与 experiences/，不依赖派生门禁（与 draft_elements 同口径）。
          const result = abstractExperienceForTool(ws, knowledge, {
            packageId: args.packageId,
            minCluster: args.minCluster,
            humanApproved: args.humanApproved,
          })
          // value 闸：指定包用包内场景红线；扫全库用工作区全量（自由文本可能撞任一包红线）。
          const phrases =
            args.packageId !== undefined
              ? phrasesOfPkg(
                  loadPackage(
                    ws.versionDir(
                      requireExistingPackage(ws.listVersions(), args.packageId),
                      args.packageId.slice(args.packageId.lastIndexOf('@') + 1),
                    ),
                  ),
                )
              : workspaceRedlines(ws)
          return toolOut(enforceOutputPolicy(result, phrases))
        },
        [],
        (args) =>
          isRecord(args) && typeof args.packageId === 'string' ? redlines(args) : workspaceRedlines(ws),
      ),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'upload_knowledge_source',
      description:
        '上传一条知识库原料（sha256 幂等；原料只入草稿库，永不直写包）。'
        + 'LLM 解析与人审物化在工作台完成。返回回执摘要，不回显正文。',
      parameters: {
        packageId: { type: 'string', required: true, description: '目标包 ID（如 aml-analysis@1.0.0）' },
        sourceType: {
          type: 'string',
          required: true,
          enum: [...SOURCE_TYPES],
          description: '原料类型',
        },
        name: { type: 'string', required: true, description: '原料名称' },
        content: { type: 'string', required: true, description: '原料正文' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: { source: { type: 'json', required: true } },
        },
        render: (_args, value) => textBlock(JSON.stringify(value, null, 2)),
      },
      execute: toolExecute(
        (args: {
          packageId: string
          sourceType: SourceType
          name: string
          content: string
        }) => {
          const source = uploadKnowledgeForPkg(knowledge, ws.listVersions(), args)
          return toolOut({ source: sourceSummary(source) })
        },
        [],
        (args) => redlines(args),
      ),
    }),
  )

  /* ── 对话式建模（conversational-modeling P4） ─────────────────────────── */

  ctx.tools.register(
    defineTool({
      name: 'get_model_graph',
      description:
        '获取建模图谱（画布数据源）：节点（物化元素 + 待审草案虚线态）、引用边、校验 issues（元素级定位）与骨架状态。'
        + 'DRAFT 即可用（建模在 O 层，不过派生门禁）。只读。',
      parameters: {
        name: { type: 'string', required: true, description: '包名' },
        version: { type: 'string', required: true, description: '版本号' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            package: { type: 'string', required: true },
            version: { type: 'string', required: true },
            status: { type: 'string', required: true },
            nodes: { type: 'array', required: true, items: { type: 'json' } },
            edges: { type: 'array', required: true, items: { type: 'json' } },
            issues: { type: 'array', required: true, items: { type: 'json' } },
            revision: { type: 'number', required: true },
          },
        },
        render: (_args, value) => textBlock(renderGraphSummary(value as unknown as ModelGraph)),
      },
      execute: toolExecute(
        (args: { name: string; version: string }) => {
          const graph = buildGraphForTool({ ws, knowledge, name: args.name, version: args.version })
          const pkg = loadPackage(ws.versionDir(args.name, args.version))
          return toolOut(enforceOutputPolicy(graph, phrasesOfPkg(pkg)))
        },
        [],
        (args) => redlines(args),
      ),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'draft_elements',
      description:
        '对话轮起草：把 items 入草案队列等待人审——只入队列、永不直写包（I1）。'
        + '前置：包须已有已确认骨架（save_skeleton，I6 骨架先行），否则拒绝。'
        + 'items 元素：layer(O1|O2|O3)、targetKind、name、payload、confidence(0..1)、rationale；'
        + 'op 缺省=create 新增元素。op=update 修改/接线既有元素（targetId=元素 ID，Attribute 为 OBJ.attr）：'
        + '标量字段覆盖、weights 按键并入、数组整替，append.<字段>=[…] 追加去重（如给行为接关系）。'
        + '改 ScoreRule.weight 会联动归一（显式权重为准，未动规则吸收残差，并同步技能模板权重）。'
        + '置信度 <0.75 自动 forcedReview；结论性表述只能 targetKind=RedLine。'
        + '同 (包+层+kind+name) 对 pending 草案重提会就地更新载荷（改文案直接再 draft 同名即可）；'
        + 'approved/merged 不覆盖——须 reject_draft 后重提，或对既有元素用 op=update。'
        + '平台建模全流程（骨架人工确认 → 分片起草 → 人审 → 签发派生）见 onto-modeling 技能正文。'
        + '可选 turnText 同时落 CONVERSATION 原料留痕（P3，含 turnId/rationale）。ISSUED 包拒绝（先 fork）。',
      parameters: {
        packageId: { type: 'string', required: true, description: '目标包 ID（name@version，如 aml-analysis@1.0.0）' },
        turnId: { type: 'string', required: true, description: '对话轮次 ID（溯源 I2）' },
        rationale: { type: 'string', required: true, description: '本轮起草总依据（会入 CONVERSATION 留痕）' },
        turnText: { type: 'string', description: '本轮用户输入原文（可选）' },
        items: { type: 'array', required: true, description: 'DraftItem 数组' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            package: { type: 'string', required: true },
            turnId: { type: 'string', required: true },
            added: { type: 'array', required: true, items: { type: 'json' } },
            rejected: { type: 'array', required: true, items: { type: 'json' } },
          },
        },
        render: (_args, value) => textBlock(renderDraftResult(value as Parameters<typeof renderDraftResult>[0])),
      },
      execute: toolExecute(
        (args: {
          packageId: string
          turnId: string
          rationale: string
          turnText?: string
          items: unknown
        }) => {
          const packageName = requireExistingPackage(ws.listVersions(), args.packageId)
          const version = args.packageId.slice(args.packageId.lastIndexOf('@') + 1)
          const pkg = loadPackage(ws.versionDir(packageName, version))
          if (pkg.meta.status === 'ISSUED') {
            throw new AgentToolError(
              'INVALID_ARGS',
              `${packageName}@${version} 已签发只读：请 fork 新版本后起草（P1）`,
            )
          }
          // I6 对话路径：骨架先行——无骨架/未确认不得入队（物化侧另有 defense-in-depth）。
          {
            const skel = knowledge.skeletons.get(packageName)
            if (!skel) {
              throw new AgentToolError('INVALID_ARGS', '对话起草前须先 save_skeleton 落骨架（I6 骨架先行）')
            }
            if (!skel.confirmed) {
              throw new AgentToolError('INVALID_ARGS', '骨架未确认，不得对话起草（I6）——请用户确认骨架后再分片')
            }
          }
          if (!Array.isArray(args.items) || args.items.length === 0) {
            throw new AgentToolError('INVALID_ARGS', 'items 必须是非空数组')
          }
          let sourceId: string | undefined
          if (typeof args.turnText === 'string' && args.turnText.trim() !== '') {
            sourceId = knowledge.uploadSource({
              packageId: packageName,
              sourceType: 'CONVERSATION',
              name: `turn-${args.turnId}`,
              content: `turn: ${args.turnId}\nbasis: ${args.rationale}\n${args.turnText}`,
            }).id
          }
          const added: Array<Record<string, unknown>> = []
          const rejected: Array<{ index: number; reason: string }> = []
          ;(args.items as unknown[]).forEach((raw, index) => {
            try {
              const c = knowledge.addDraft({
                packageId: packageName,
                item: raw as DraftItem,
                provenance: { turnId: args.turnId, sourceId },
              })
              added.push({
                id: c.id,
                name: c.name,
                layer: c.layer,
                targetKind: c.targetKind,
                forcedReview: c.forcedReview,
                conclusionLike: c.conclusionLike,
                status: c.status,
              })
            } catch (e) {
              rejected.push({ index, reason: e instanceof Error ? e.message : String(e) })
            }
          })
          return toolOut(
            enforceOutputPolicy(
              { package: args.packageId, turnId: args.turnId, rationale: args.rationale, added, rejected, sourceId },
              phrasesOfPkg(pkg),
            ),
          )
        },
        [],
        (args) => redlines(args),
      ),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'apply_draft',
      description:
        '人审动作：批准一条或多条草案并作为同一批物化进包（唯一写包路径——经 knowledge 物化通道：'
        + 'ISSUED 拒绝、骨架门 I6、结论性表述拦截）。同批多条请一次传入 candidateIds——权重归一是批'
        + '语义（显式权重为准、未动规则吸收残差），逐条物化会互相打架。humanApproved 是人审契约：'
        + '仅当用户在会话中明确批准后才传 true，agent 不得自行批准（留痕 reviewedBy=agent-tool）。'
        + '「明确批准」须指代本批草案清单本身（用户主动批准/同意这批草案，或批准卡通过）；'
        + '恢复/推进类台词（按提案落盘/继续弄）、包形态与业务范围选择、骨架确认均不构成批准，'
        + '不得引用其作为 humanApproved 依据——未见明确批准先问一句再传。'
        + '物化被门禁跳过时草案保持 approved 可重试；返回每条结果与物化元素 ID。'
        + '整批先预检（结论性表述/包归属/状态）再 approve，预检失败零状态变更；'
        + '已 approved 未物化的草案跳过 review 直接重试物化（与工作台同口径）。'
        + '物化成功后自动重派生（无需再手动 derive），包立刻过加载门禁可直接运行/列技能。',
      parameters: {
        candidateIds: { type: 'array', required: true, description: '草案 ID 数组（dc-…）；同批归一，多条权重更新务必一次传入' },
        name: { type: 'string', required: true, description: '包名' },
        version: { type: 'string', required: true, description: '目标版本号' },
        humanApproved: {
          type: 'boolean',
          required: true,
          description:
            '人审契约：仅当用户明确批准本批草案时传 true；恢复/推进类台词、包形态选择、'
            + '骨架确认均不构成批准，agent 不得自行批准',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            approved: { type: 'boolean', required: true, const: true },
            results: { type: 'array', required: true, items: { type: 'json' } },
            materialized: { type: 'array', required: true, items: { type: 'string' } },
            skipped: { type: 'array', required: true, items: { type: 'json' } },
            summary: {
              type: 'object',
              required: true,
              additionalProperties: true,
              properties: {
                requested: { type: 'number', required: true },
                merged: { type: 'number', required: true },
                materializedCount: { type: 'number', required: true },
                skippedCount: { type: 'number', required: true },
              },
            },
            notes: { type: 'array', items: { type: 'string' } },
          },
        },
        render: (_args, value) => {
          const v = value as unknown as {
            results: Array<{ candidateId: string; status: string; appliedAs: string | null }>
            materialized: string[]
            skipped: Array<{ id: string; reason: string }>
            summary: { requested: number; merged: number; materializedCount: number; skippedCount: number }
            notes?: string[]
          }
          const s = v.summary
          const lines = v.results.map((r) => `- ${r.candidateId} → ${r.status}${r.appliedAs ? `（${r.appliedAs}）` : ''}`)
          const head = `同批申请 ${s.requested} · merged ${s.merged} · 新物化 ${s.materializedCount} · 跳过 ${s.skippedCount}`
          const skips = v.skipped.map((s2) => `跳过 ${s2.id}：${s2.reason}`)
          const notes = (v.notes ?? []).map((n) => `注意：${n}`)
          return textBlock([head, ...lines, ...skips, ...notes].join('\n'))
        },
      },
      execute: toolExecute(
        (args: { candidateIds: string[]; name: string; version: string; humanApproved: boolean }) => {
          assertHumanApproved(args.humanApproved, '批准')
          if (!Array.isArray(args.candidateIds) || args.candidateIds.length === 0) {
            throw new AgentToolError('INVALID_ARGS', 'candidateIds 必须是非空数组')
          }
          const dir = ws.versionDir(args.name, args.version)
          const pkg = loadPackage(dir)
          if (pkg.meta.status === 'ISSUED') {
            throw new AgentToolError('INVALID_ARGS', `${args.name}@${args.version} 已签发只读：请 fork 新版本（P1）`)
          }
          // 预检整批（状态 + 结论性表述 + 包归属）——任一不过则零状态变更，
          // 避免「先逐条 approve、中途 CONCLUSION_BLOCKED → 前半已 approved 卡死」。
          for (const id of args.candidateIds) {
            const before = knowledge.getCandidate(id)
            if (normalizePkgId(before.packageId) !== args.name) {
              throw new AgentToolError(
                'INVALID_ARGS',
                `package mismatch: 草案 ${id} 属于 ${before.packageId}，目标包为 ${args.name}`,
              )
            }
            if (before.status === 'rejected') {
              throw new AgentToolError(
                'INVALID_ARGS',
                `草案 ${id} 已 rejected，不可物化；请重新 draft_elements 后再批`,
              )
            }
            if (before.conclusionLike && before.targetKind !== 'RedLine') {
              throw new AgentToolError(
                'CONCLUSION_BLOCKED',
                `结论性表述禁止进入 ${before.targetKind}（只能落 RedLine 红线）`
                + '（正确路径：新草案 targetKind=RedLine、targetId=场景ID 或 payload.scenarioId、payload.phrases=[短语…]，追加进该场景 forbiddenPhrases）',
              )
            }
          }
          // 仅 pending 走 review；已 approved（前次中断残留）跳过 review 直接进 materialize
          // ——与工作台 draftAction 同口径，防 CANDIDATE_FINALIZED 打断重试。
          for (const id of args.candidateIds) {
            const c = knowledge.getCandidate(id)
            if (c.status === 'pending') {
              knowledge.reviewCandidate(id, 'approve', { reviewedBy: 'agent-tool' })
            }
          }
          const res = knowledge.materialize(dir, args.candidateIds)
          const results = args.candidateIds.map((id) => {
            const after = knowledge.getCandidate(id)
            return {
              candidateId: id,
              status: after.status,
              appliedAs: typeof after.appliedAs === 'string' ? after.appliedAs : null,
            }
          })
          const materialized = results.flatMap((r) => (r.appliedAs !== null ? [r.appliedAs] : []))
          const merged = results.filter((r) => r.status === 'merged').length
          return toolOut(
            enforceOutputPolicy(
              {
                approved: true,
                results,
                materialized,
                skipped: res.skipped,
                summary: {
                  requested: args.candidateIds.length,
                  merged,
                  materializedCount: materialized.length,
                  skippedCount: res.skipped.length,
                },
                // P3-3：接线等结构位回执（多场景未接线等），不静默吞掉
                ...(res.notes && res.notes.length > 0 ? { notes: res.notes } : {}),
              },
              phrasesOfPkg(pkg),
            ),
          )
        },
        [],
        (args) => redlines(args),
      ),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'reject_draft',
      description:
        '人审动作：驳回一条待审草案（状态置 rejected，留痕可回看；不写包）。'
        + '允许 pending 或已 approved 未物化（恢复「已批未写」卡死）；merged 拒绝。'
        + 'humanApproved 同 apply_draft 人审契约：仅当用户明确指示驳回时传 true。',
      parameters: {
        candidateId: { type: 'string', required: true, description: '草案 ID（dc-…）' },
        name: { type: 'string', required: true, description: '包名' },
        version: { type: 'string', required: true, description: '版本号' },
        humanApproved: {
          type: 'boolean',
          required: true,
          description: '人审契约：仅当用户明确指示驳回时传 true；agent 不得自行驳回',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            candidateId: { type: 'string', required: true },
            status: { type: 'string', required: true, const: 'rejected' },
          },
        },
        render: (_args, value) => {
          const v = value as { candidateId: string; status: string }
          return textBlock(`草案 ${v.candidateId} 已驳回（${v.status}）`)
        },
      },
      execute: toolExecute(
        (args: { candidateId: string; name: string; version: string; humanApproved: boolean }) => {
          assertHumanApproved(args.humanApproved, '驳回')
          const dir = ws.versionDir(args.name, args.version)
          const pkg = loadPackage(dir)
          if (pkg.meta.status === 'ISSUED') {
            throw new AgentToolError('INVALID_ARGS', `${args.name}@${args.version} 已签发只读（P1）`)
          }
          const before = knowledge.getCandidate(args.candidateId)
          if (normalizePkgId(before.packageId) !== args.name) {
            throw new AgentToolError(
              'INVALID_ARGS',
              `package mismatch: 草案属于 ${before.packageId}，目标包为 ${args.name}`,
            )
          }
          const c = knowledge.reviewCandidate(args.candidateId, 'reject', { reviewedBy: 'agent-tool' })
          return toolOut({ candidateId: c.id, status: c.status })
        },
        [],
        (args) => redlines(args),
      ),
    }),
  )

  // D3：对话建包 —— DRAFT 空包，同名拒绝；骨架确认另走 save_skeleton 人审契约。
  ctx.tools.register(
    defineTool({
      name: 'create_package',
      description:
        '对话建包（D3）：创建 DRAFT 空包（name/version/domain），随后 save_skeleton 落骨架、'
        + '对话分片起草。同名同版本拒绝（PACKAGE_EXISTS，不覆盖）；签发 ISSUED 仍仅人工。'
        + 'humanApproved 人审契约：仅当用户明确要求建包时传 true，agent 不得自行建包。'
        + '建包只是开局动作，内容仍走 draft_elements 起草 → 人审 apply_draft 物化。',
      parameters: {
        name: { type: 'string', required: true, description: '包名（kebab-case，如 claims-fraud）' },
        version: { type: 'string', required: true, description: '初始版本（如 1.0.0）' },
        domain: { type: 'string', required: true, description: '域码（大写字母数字，1–12 位，如 CLF）' },
        humanApproved: {
          type: 'boolean',
          required: true,
          description: '人审契约：仅当用户明确要求建包时传 true；澄清选择/推进类台词不构成建包批准',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            name: { type: 'string', required: true },
            version: { type: 'string', required: true },
            domain: { type: 'string', required: true },
            status: { type: 'string', required: true, const: 'DRAFT' },
          },
        },
        render: (_args, value) => {
          const v = value as { name: string; version: string; domain: string }
          return textBlock(
            `已创建空包 ${v.name}@${v.version}（域 ${v.domain}，DRAFT）——下一步：骨架提案经用户确认后 save_skeleton`,
          )
        },
      },
      execute: toolExecute(
        (args: { name: string; version: string; domain: string; humanApproved: boolean }) =>
          toolOut(createPackageForPkg(ws, args)),
        [],
        (args) => redlines(args),
      ),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'save_skeleton',
      description:
        '骨架落盘（D3，物化门 I6 前置）：保存全量 ID 清单与域码并置「已确认」。'
        + 'humanApproved 人审契约同 apply_draft：仅当用户在会话中明确确认骨架后才传 true，'
        + 'agent 不得自行确认；点头须指代**这份 ID 清单本身**——包形态/业务范围/域码澄清选择、'
        + '恢复/推进类台词均不构成骨架确认；骨架点头也不得代用作后续 apply_draft 的物化批准。'
        + 'ids 须非空、去重且全过 ID 语法；ISSUED 包只读（先 fork）。'
        + '骨架是唯一能改名/新增 ID 的入口，确认前不得物化任何元素。',
      parameters: {
        packageId: { type: 'string', required: true, description: '目标包 name@version' },
        domainCode: { type: 'string', required: true, description: '域码（大写字母数字，1–12 位）' },
        ids: { type: 'array', required: true, description: '全量骨架 ID 清单（每项须为合法本体 ID，去重）' },
        humanApproved: {
          type: 'boolean',
          required: true,
          description:
            '人审契约：仅当用户明确点头确认这份 ID 清单时传 true；包形态/范围选择、'
            + '恢复类台词均不算，agent 不得自行确认',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            packageId: { type: 'string', required: true },
            domainCode: { type: 'string', required: true },
            confirmed: { type: 'boolean', required: true, const: true },
            ids: { type: 'array', required: true, items: { type: 'string' } },
          },
        },
        render: (_args, value) => {
          const v = value as { packageId: string; domainCode: string; ids: string[] }
          return textBlock(`骨架已确认保存：${v.packageId}（域 ${v.domainCode}，${v.ids.length} 个 ID）——可以开始分片起草`)
        },
      },
      execute: toolExecute(
        (args: { packageId: string; domainCode: string; ids: string[]; humanApproved: boolean }) =>
          toolOut(saveSkeletonForPkg(knowledge, ws, ws.listVersions(), args)),
        [],
        (args) => redlines(args),
      ),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'list_capabilities',
      description:
        'L1–L5 能力清单：这个包能干什么——L1 场景入口 / L2 工具池（数据源与派生契约）/ L3 技能 / '
        + 'L4 专家 / L5 门面。有 manifest 时按 layer 标注分组。只读，DRAFT 即可用。',
      parameters: {
        name: { type: 'string', required: true, description: '包名' },
        version: { type: 'string', required: true, description: '版本号' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: {} },
        render: (_args, value) => textBlock(renderCapabilities(value as Record<string, unknown>)),
      },
      execute: toolExecute(
        (args: { name: string; version: string }) => {
          const cap = capabilitiesFor(ws, args.name, args.version)
          const pkg = loadPackage(ws.versionDir(args.name, args.version))
          return toolOut(enforceOutputPolicy(cap, phrasesOfPkg(pkg)))
        },
        [],
        (args) => redlines(args),
      ),
    }),
  )

  // 质量报告落盘（对话收尾；与工作台校验视图同源 writeQualityReport）
  ctx.tools.register(
    defineTool({
      name: 'write_quality_report',
      description:
        '校验并落盘 quality-report.json（包根，与工作台校验视图同源）。'
        + '物化/改权重后收尾调用；返回 score/passed/errors/warnings 摘要。'
        + '只写报告文件，不改模型源、不触发派生；ISSUED 亦可重算报告。',
      parameters: {
        name: { type: 'string', required: true, description: '包名' },
        version: { type: 'string', required: true, description: '版本号' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            package: { type: 'string', required: true },
            version: { type: 'string', required: true },
            score: { type: 'number', required: true },
            passed: { type: 'boolean', required: true },
            errorCount: { type: 'number', required: true },
            warningCount: { type: 'number', required: true },
            errors: { type: 'array', required: true, items: { type: 'json' } },
            warnings: { type: 'array', required: true, items: { type: 'json' } },
            reportFile: { type: 'string', required: true },
          },
        },
        render: (_args, value) => {
          const v = value as {
            package: string
            version: string
            score: number
            passed: boolean
            errorCount: number
            warningCount: number
          }
          const head = v.passed
            ? `校验通过：${v.package}@${v.version} score=${v.score}（0 error / ${v.warningCount} warn）`
            : `校验未过：${v.package}@${v.version} score=${v.score}（${v.errorCount} error / ${v.warningCount} warn）——先修 error 再送审`
          return textBlock(`${head}；已写盘 quality-report.json`)
        },
      },
      execute: toolExecute(
        (args: { name: string; version: string }) => {
          let dir: string
          let pkg: ReturnType<typeof loadPackage>
          try {
            dir = ws.versionDir(args.name, args.version)
            pkg = loadPackage(dir)
          } catch {
            throw new AgentToolError('NOT_FOUND', `包不存在或无法加载: ${args.name}@${args.version}`)
          }
          const report = writeQualityReport(dir)
          return toolOut(
            enforceOutputPolicy(
              {
                package: report.package,
                version: report.version,
                score: report.score,
                passed: report.passed,
                errorCount: report.errors.length,
                warningCount: report.warnings.length,
                errors: report.errors.slice(0, 50),
                warnings: report.warnings.slice(0, 50),
                reportFile: 'quality-report.json',
              },
              phrasesOfPkg(pkg),
            ),
          )
        },
        [],
        (args) => redlines(args),
      ),
    }),
  )

  // L4 专家面（conversational-modeling P4）：list_experts / invoke_expert 与建模工具共用
  // guard、错误信封与策略闸（registerExpertTools 注入依赖，避免模块环）。
  registerExpertTools(ctx, {
    ws,
    loadGated: load,
    redlines,
    loadDatasetFromArgs,
    textBlock,
    toolOut,
  })
}
