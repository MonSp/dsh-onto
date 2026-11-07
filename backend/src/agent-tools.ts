/**
 * dsh 原生 agent 工具面：场景执行 / 只读查询 / 知识上传。
 *
 * 约束（docs/compose/spec/tool-face-policy.md）：
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
  exportRunArchive,
  isInsideDir,
  isValidId,
  isSafeRelPath,
  loadExperienceNote,
  loadPackage,
  loadRunRecord,
  loadRunRedlines,
  retrieveSimilar,
  reviewExperienceNote,
  runScenario,
  saveExperienceNote,
  saveRunRecord,
  verifyDerived,
  type DraftItem,
  type ExperienceNote,
  type ExperienceOutcome,
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
  toolExecute,
  type BatchRunItem,
  type BatchRunOutput,
  type BatchRunSummary,
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
 */
export function createPackageForPkg(
  ws: { createPackage(meta: { name: string; version: string; domain: string }): string },
  args: { name?: unknown; version?: unknown; domain?: unknown },
): { name: string; version: string; domain: string; status: 'DRAFT' } {
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
 */
export function runScenarioBatch(input: {
  ws: PackageWorkspace
  pkg: OntologyPackage
  versionDir: string
  dataset: RuntimeDataset
  ids: readonly string[]
}): BatchRunOutput {
  const { ws, pkg, versionDir, dataset, ids } = input
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
      const result = runScenario(versionDir, scenarioId, dataset)
      assertRunContract(result)
      const phrases = collectPhrases(result, reds)
      saveRunRecord(
        ws.root,
        buildRunRecord({
          package: { name: pkg.meta.name, version: pkg.meta.version },
          dataset,
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
    const note = reviewExperienceNote(ws.root, args.runId, {
      outcome: args.outcome,
      outcomeReason: args.outcomeReason,
      misTransfer: args.misTransfer,
      reviewFocus: args.reviewFocus,
      reusedFromRunId: args.reusedFromRunId,
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
 * abstract_experience 纯函数（闭环 E2-1）：成功/反例经验按结构签名聚簇 →
 * SkillTemplate / RedLine / ExclusionRule 草案入知识库人审队列（pending）。
 * 只入队、永不直写包（I1）；物化必经 apply_draft（humanApproved 人审契约）。
 * 经验只提示不改分——本函数不触碰 core/src/rules.ts 打分语义。
 */
export function abstractExperienceForTool(
  ws: PackageWorkspace,
  knowledge: KnowledgeStore,
  args: {
    packageId: string
    minCluster?: number
    humanApproved?: unknown
  },
): {
  package: string
  queued: Array<{
    id: string
    name: string
    targetKind: string
    status: string
    members: number
    runId: string
  }>
  skills: number
  counters: number
  humanReviewRequired: true
} {
  assertHumanApproved(args.humanApproved, '总结经验')
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
  let minCluster: number | undefined
  if (args.minCluster !== undefined) {
    if (typeof args.minCluster !== 'number' || !Number.isInteger(args.minCluster) || args.minCluster < 1) {
      throw new AgentToolError('INVALID_ARGS', 'minCluster 必须是 ≥1 的整数')
    }
    minCluster = args.minCluster
  }
  const abs = abstractSkillDrafts(ws.root, { pkg, minCluster })
  const counters = abstractCounterexampleDrafts(ws.root, { pkg, minCluster })
  const queued: Array<{
    id: string
    name: string
    targetKind: string
    status: string
    members: number
    runId: string
  }> = []
  for (const a of [...abs, ...counters]) {
    const c = knowledge.addDraft({
      packageId: packageName,
      item: a.draft,
      provenance: { runId: a.memberRunIds[0] },
    })
    queued.push({
      id: c.id,
      name: c.name,
      targetKind: c.targetKind,
      status: c.status,
      members: a.memberRunIds.length,
      runId: a.memberRunIds[0],
    })
  }
  return {
    package: `${packageName}@${version}`,
    queued,
    skills: abs.length,
    counters: counters.length,
    humanReviewRequired: true,
  }
}

/** abstract_experience 渲染（E2-1）：结构位回执（草案 id/kind/簇员/status），无服务端路径。 */
export function renderAbstractText(
  v: {
    package: string
    queued: Array<{
      id: string
      name: string
      targetKind: string
      status: string
      members: number
      runId: string
    }>
    skills: number
    counters: number
  },
  phrases?: readonly string[],
): string {
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
    ...v.queued.map(
      (q) =>
        `+ [${q.targetKind}] ${q.name}（${q.id}） status=${q.status} 簇员=${q.members} 代表=${q.runId}`,
    ),
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
        }) => {
          const dataset = loadDatasetFromArgs(args)
          const pkg = load(args.name, args.version)
          const versionDir = ws.versionDir(args.name, args.version)
          const scenario = pkg.scenarios.find((s) => s.id === args.scenarioId)
          const contracts = readToolContracts(versionDir)
          assertDatasetGranted(dataset, contracts)
          const result = runScenario(versionDir, args.scenarioId, dataset)
          assertRunContract(result)
          // 短语清单双源一次取定（命中 ∪ 场景红线），经注册表带给 render 闸（P2.2）。
          const phrases = collectPhrases(result, scenario?.outputContract.forbiddenPhrases ?? [])
          // 运行留痕（S2.1）：掩蔽前完整结果 + 双源红线落盘（人审面；模型面出口仍走掩蔽）。
          saveRunRecord(
            ws.root,
            buildRunRecord({
              package: { name: pkg.meta.name, version: pkg.meta.version },
              dataset,
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
        '批量运行包内场景（同一份数据多场景视角；scenarioIds 缺省为包内全部场景，上限 32）。' +
        '单项失败不中断批次；完整结果落运行记录（run-xxxxxxxx），可跟 compare_runs / export_audit。',
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
        }) => {
          const dataset = loadDatasetFromArgs(args)
          const pkg = load(args.name, args.version)
          const versionDir = ws.versionDir(args.name, args.version)
          const contracts = readToolContracts(versionDir)
          assertDatasetGranted(dataset, contracts)
          const ids = resolveBatchIds(args.scenarioIds, pkg)
          const out = runScenarioBatch({ ws, pkg, versionDir, dataset, ids })
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
        + '冷启动（无相似经验）或低置信度（差异含结构位变更）时不得硬迁移——'
        + '结果仅含结构位（runId/score/outcome/签名字段/reviewFocus）与转人工提示，不含自由流程描述。',
      parameters: {
        name: { type: 'string', required: true, description: '包名' },
        version: { type: 'string', required: true, description: '版本号' },
        scenarioId: { type: 'string', required: true, description: '场景 ID，如 SCN-AML-FIND-CLUES' },
        dataset: { type: 'json', description: '内联 RuntimeDataset（用于结构签名的规模档；缺省按空集）' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            coldStart: { type: 'boolean', required: true },
            hits: { type: 'array', required: true, items: { type: 'json' } },
            advice: { type: 'string', required: true },
            humanReviewRequired: { type: 'boolean', required: true, const: true },
          },
        },
        render: (args, value) => textBlock(renderRecallText(value as never, redlines(args))),
      },
      execute: toolExecute(
        (args: { name: string; version: string; scenarioId: string; dataset?: unknown }) => {
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
          if (result.coldStart || hits.length === 0) {
            advice = '冷启动：无相似经验（不硬迁移，走全量执行）'
          } else {
            const draft = buildDiffTable(signature, result.hits[0].note.signature)
            advice =
              draft.mustChange.length > 0
                ? `低置信度：结构位差异（${draft.mustChange.map((m) => m.item).join(', ')}）→ 转人工确认后方可复用`
                : '结构同构可参考复用（仍须过验证闸门，humanReviewRequired=true）'
          }
          // value 闸：包内全部场景红线（goalClass 等包自由文本可能撞红线）。
          return toolOut(
            enforceOutputPolicy(
              { coldStart: result.coldStart, hits, advice, humanReviewRequired: true },
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
        + '反例/误迁移经验不参聚成功簇（反例只落红线或排除草案）；簇员不足回执说明、不硬凑。'
        + '返回结构位回执（草案 id/kind/status/簇员数），认定出口只在人工。',
      parameters: {
        packageId: { type: 'string', required: true, description: '包 ID（name@version，如 aml-analysis@1.0.0）' },
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
            queued: { type: 'array', required: true, items: { type: 'json' } },
            skills: { type: 'number', required: true },
            counters: { type: 'number', required: true },
            humanReviewRequired: { type: 'boolean', required: true, const: true },
          },
        },
        render: (_args, value) => textBlock(renderAbstractText(value as never, redlines(_args))),
      },
      execute: toolExecute(
        (args: { packageId: string; minCluster?: number; humanApproved: boolean }) => {
          // 抽象只读 O 层源与 experiences/，不依赖派生门禁（与 draft_elements 同口径）。
          const result = abstractExperienceForTool(ws, knowledge, {
            packageId: args.packageId,
            minCluster: args.minCluster,
            humanApproved: args.humanApproved,
          })
          const packageName = requireExistingPackage(ws.listVersions(), args.packageId)
          const version = args.packageId.slice(args.packageId.lastIndexOf('@') + 1)
          const pkg = loadPackage(ws.versionDir(packageName, version))
          // value 闸：包内场景红线（rationale/名称等自由文本可能撞红线）。
          return toolOut(enforceOutputPolicy(result, phrasesOfPkg(pkg)))
        },
        [],
        (args) => redlines(args),
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
        + 'items 元素：layer(O1|O2|O3)、targetKind、name、payload、confidence(0..1)、rationale；'
        + 'op 缺省=create 新增元素。op=update 修改/接线既有元素（targetId=元素 ID，Attribute 为 OBJ.attr）：'
        + '标量字段覆盖、weights 按键并入、数组整替，append.<字段>=[…] 追加去重（如给行为接关系）。'
        + '改 ScoreRule.weight 会联动归一（显式权重为准，未动规则吸收残差，并同步技能模板权重）。'
        + '置信度 <0.75 自动 forcedReview；结论性表述只能 targetKind=RedLine。'
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
        + '物化被门禁跳过时草案保持 approved 可重试；返回每条结果与物化元素 ID。'
        + '物化成功后自动重派生（无需再手动 derive），包立刻过加载门禁可直接运行/列技能。',
      parameters: {
        candidateIds: { type: 'array', required: true, description: '草案 ID 数组（dc-…）；同批归一，多条权重更新务必一次传入' },
        name: { type: 'string', required: true, description: '包名' },
        version: { type: 'string', required: true, description: '目标版本号' },
        humanApproved: {
          type: 'boolean',
          required: true,
          description: '人审契约：仅当用户明确指示批准时传 true；agent 不得自行批准',
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
          },
        },
        render: (_args, value) => {
          const v = value as unknown as {
            results: Array<{ candidateId: string; status: string; appliedAs: string | null }>
            materialized: string[]
            skipped: Array<{ id: string; reason: string }>
          }
          const lines = v.results.map((r) => `- ${r.candidateId} → ${r.status}${r.appliedAs ? `（${r.appliedAs}）` : ''}`)
          const head = `同批 ${v.results.length} 条，物化 ${v.materialized.length}：`
          const skips = v.skipped.map((s) => `跳过 ${s.id}：${s.reason}`)
          return textBlock([head, ...lines, ...skips].join('\n'))
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
          for (const id of args.candidateIds) {
            const before = knowledge.getCandidate(id)
            if (normalizePkgId(before.packageId) !== args.name) {
              throw new AgentToolError(
                'INVALID_ARGS',
                `package mismatch: 草案 ${id} 属于 ${before.packageId}，目标包为 ${args.name}`,
              )
            }
          }
          // approve 与物化同一动作（S1 闭环）；同批一次 materialize → 权重归一按批语义。
          for (const id of args.candidateIds) {
            knowledge.reviewCandidate(id, 'approve', { reviewedBy: 'agent-tool' })
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
          return toolOut(
            enforceOutputPolicy(
              { approved: true, results, materialized, skipped: res.skipped },
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
        + '建包只是开局动作，内容仍走 draft_elements 起草 → 人审 apply_draft 物化。',
      parameters: {
        name: { type: 'string', required: true, description: '包名（kebab-case，如 claims-fraud）' },
        version: { type: 'string', required: true, description: '初始版本（如 1.0.0）' },
        domain: { type: 'string', required: true, description: '域码（大写字母数字，1–12 位，如 CLF）' },
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
        (args: { name: string; version: string; domain: string }) => toolOut(createPackageForPkg(ws, args)),
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
        + 'agent 不得自行确认；ids 须非空、去重且全过 ID 语法；ISSUED 包只读（先 fork）。'
        + '骨架是唯一能改名/新增 ID 的入口，确认前不得物化任何元素。',
      parameters: {
        packageId: { type: 'string', required: true, description: '目标包 name@version' },
        domainCode: { type: 'string', required: true, description: '域码（大写字母数字，1–12 位）' },
        ids: { type: 'array', required: true, description: '全量骨架 ID 清单（每项须为合法本体 ID，去重）' },
        humanApproved: {
          type: 'boolean',
          required: true,
          description: '人审契约：仅当用户明确点头确认骨架时传 true；agent 不得自行确认',
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
