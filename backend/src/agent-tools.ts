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
  PackageWorkspace,
  SOURCE_TYPES,
  buildRunRecord,
  compareRunRecords,
  exportRunArchive,
  isInsideDir,
  isSafeRelPath,
  loadPackage,
  loadRunRecord,
  loadRunRedlines,
  runScenario,
  saveRunRecord,
  verifyDerived,
  type KnowledgeSourceRecord,
  type OntologyPackage,
  type RunArchive,
  type RunDiff,
  type RuntimeDataset,
  type ScenarioRunResult,
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
      throw new AgentToolError('INVALID_ARGS', `dataset 文件越出工作目录: ${raw}`)
    }
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      throw new AgentToolError('INVALID_ARGS', `无法读取 dataset 文件: ${raw}`)
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
 */
function toolOut<T, R>(value: T): R {
  return value as unknown as R
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
        '执行一个业务本体场景（规则引擎判定，认定出口只在人工）。数据输入二选一：datasetPath（JSON 文件）'
        + '或 dataset（内联 RuntimeDataset）。返回候选风险分、命中规则 ID、证据链、待核实点、'
        + 'humanReviewRequired=true 与禁语扫描结果。',
      parameters: {
        name: { type: 'string', required: true, description: '包名' },
        version: { type: 'string', required: true, description: '版本号' },
        scenarioId: { type: 'string', required: true, description: '场景 ID，如 SCN-AML-FIND-CLUES' },
        datasetPath: { type: 'string', description: 'RuntimeDataset JSON 文件路径（绝对或相对工作目录）' },
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
          description: '数据集 JSON 文件路径（与 dataset 二选一）',
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
}
