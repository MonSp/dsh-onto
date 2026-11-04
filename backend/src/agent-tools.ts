/**
 * dsh 原生 agent 工具面：场景执行 / 只读查询 / 知识上传。
 *
 * 约束（docs/compose/spec/dsh-native-integration.md）：
 * - 签发/审阅端点永不注册（规范 §12.4）；
 * - 对象粒度收权以派生 `derived/tool-contracts` 为事实源（guard + 输出投影）；
 * - run_scenario 工具结果恒含 ruleId 回指、humanReviewRequired=true 与禁语扫描。
 * @module @dsh-onto/backend/agent-tools
 */
import { readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  DERIVED_FILES,
  KnowledgeStore,
  PackageStoreError,
  PackageWorkspace,
  SOURCE_TYPES,
  loadPackage,
  loadYaml,
  runScenario,
  verifyDerived,
  type KnowledgeSourceRecord,
  type OntologyPackage,
  type RuntimeDataset,
  type ScenarioRunResult,
  type SourceType,
} from '@dsh-onto/core'
import { resolveDataDir } from './services.js'
import { compareVersions } from './agent-skills.js'

/** 工具层错误；message 直接面向模型，code 供测试与断言。 */
export class AgentToolError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'AgentToolError'
    this.code = code
  }
}

/** 全部 dsh-onto 工具名；guard 只作用于本工具面。 */
export const ONTOOL_NAMES: ReadonlySet<string> = new Set([
  'list_packages',
  'get_package',
  'get_rule',
  'list_tool_contracts',
  'list_scenarios',
  'run_scenario',
  'upload_knowledge_source',
])

/* ───────────────────────── 数据集双通道（S2.3） ───────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 校验并收窄 RuntimeDataset 形状；对象/关系明细留给 core 的 DATA_INGEST 对照 O1。 */
export function validateDatasetShape(value: unknown): RuntimeDataset {
  if (!isRecord(value)) {
    throw new AgentToolError('INVALID_ARGS', 'dataset 必须是 JSON 对象（objects/relations/candidates）')
  }
  const { objects, relations, candidates } = value
  if (!Array.isArray(objects) || !Array.isArray(relations) || !Array.isArray(candidates)) {
    throw new AgentToolError('INVALID_ARGS', 'dataset 需要 objects/relations/candidates 三个数组')
  }
  for (const c of candidates) {
    if (!isRecord(c) || typeof c.candidateId !== 'string' || typeof c.objectRef !== 'string') {
      throw new AgentToolError('INVALID_ARGS', 'candidate 需要字符串 candidateId 与 objectRef')
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
 * datasetPath 绝对或相对进程 cwd；内联形态为完整 RuntimeDataset。
 */
export function loadDatasetFromArgs(args: { datasetPath?: string; dataset?: unknown }): RuntimeDataset {
  const hasPath = typeof args.datasetPath === 'string' && args.datasetPath.length > 0
  const hasInline = args.dataset !== undefined && args.dataset !== null
  if (hasPath === hasInline) {
    throw new AgentToolError('INVALID_ARGS', 'datasetPath 与 dataset 必须且只能提供一个')
  }
  if (hasPath) {
    // 错误回显调用方原文，不回显 resolve() 后的绝对路径（不泄露进程 cwd）。
    const raw = args.datasetPath as string
    const path = isAbsolute(raw) ? raw : resolve(raw)
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

/* ───────────────────────── 输出契约装配断言（S2.3） ───────────────────────── */

/** 装配断言：工具结果必须完整携带输出契约要件；失败即 isError，不产出残缺结果。 */
export function assertRunContract(result: ScenarioRunResult): void {
  if (!Array.isArray(result.candidates)) {
    throw new AgentToolError('INVALID_TOOL_OUTPUT', '输出契约失败: candidates 不是数组')
  }
  for (const c of result.candidates) {
    if (typeof c.riskScore !== 'number') {
      throw new AgentToolError('INVALID_TOOL_OUTPUT', `输出契约失败: ${c.candidateId} riskScore 不是数字`)
    }
    for (const key of ['hitRuleIds', 'evidenceChains', 'pendingChecks', 'narrative'] as const) {
      if (!Array.isArray(c[key])) {
        throw new AgentToolError('INVALID_TOOL_OUTPUT', `输出契约失败: ${c.candidateId} ${key} 不是数组`)
      }
    }
  }
  if (result.humanReviewRequired !== true) {
    throw new AgentToolError('INVALID_TOOL_OUTPUT', '输出契约失败: humanReviewRequired 必须为 true')
  }
  if (!result.audit || !Array.isArray(result.audit.forbiddenPhraseHits)) {
    throw new AgentToolError('INVALID_TOOL_OUTPUT', '输出契约失败: audit.forbiddenPhraseHits 缺失')
  }
}

/** 面向模型的合规渲染：候选摘要 + 强制合规页脚。 */
export function renderRunText(result: ScenarioRunResult): string {
  const lines: string[] = []
  lines.push(`场景 ${result.scenarioId} · 运行 ${result.runId}`)
  for (const c of result.candidates) {
    lines.push(`- ${c.candidateId}（${c.objectRef}）riskScore=${c.riskScore}`)
    lines.push(`  命中规则: ${c.hitRuleIds.join(', ') || '—'}`)
    for (const e of c.evidenceChains) {
      lines.push(`  证据[${e.ruleId}] ${e.evidence} (score=${e.score})`)
    }
    for (const p of c.pendingChecks) {
      const missing = p.missing && p.missing.length > 0 ? `（缺 ${p.missing.join(', ')}）` : ''
      lines.push(`  待核实: ${p.note}${missing}`)
    }
    if (c.pendingVerification) lines.push('  pendingVerification=true')
    for (const n of c.narrative) lines.push(`  叙述: ${n}`)
  }
  for (const x of result.excluded) {
    lines.push(`排除: ${x.candidateId}（${x.ruleId}）`)
  }
  lines.push('—— 合规 ——')
  lines.push('humanReviewRequired=true（认定出口只在人工复核）')
  const hits = result.audit.forbiddenPhraseHits
  lines.push(`禁语扫描: ${hits.length === 0 ? '0 命中（通过）' : `${hits.length} 命中`}`)
  for (const h of hits) {
    lines.push(`  禁语[${h.phrase}] @ ${h.where}`)
  }
  lines.push(`三层闭合: ${result.audit.passed ? 'passed' : 'failed'}`)
  return lines.join('\n')
}

/* ───────────────────────── 对象粒度收权（S2.4） ───────────────────────── */

/** tool-contracts 条目；只保留 grant 相关字段（输出投影）。 */
export interface ToolContractEntry {
  id: string
  objectId?: string
  relationId?: string
  grantScope: string
  idRule?: string | null
  inputs: string[]
  outputs: string[]
}

/** 逐字段裁剪到 grant 面，防御意外扩面。 */
export function projectByContract(raw: unknown): ToolContractEntry {
  const r = isRecord(raw) ? raw : {}
  const entry: ToolContractEntry = {
    id: String(r.id ?? ''),
    grantScope: String(r.grantScope ?? ''),
    inputs: Array.isArray(r.inputs) ? r.inputs.map(String) : [],
    outputs: Array.isArray(r.outputs) ? r.outputs.map(String) : [],
  }
  if (typeof r.objectId === 'string') entry.objectId = r.objectId
  if (typeof r.relationId === 'string') entry.relationId = r.relationId
  if (r.idRule === null) entry.idRule = null
  else if (typeof r.idRule === 'string') entry.idRule = r.idRule
  return entry
}

/** 读取派生收权清单；先过加载门禁，漂移即拒绝。顶层 `idRules` 按 objectId join 进条目（derive 实际格式）。 */
export function readToolContracts(versionDir: string): ToolContractEntry[] {
  const gate = verifyDerived(versionDir)
  if (!gate.ok) {
    throw new AgentToolError('DERIVED_DRIFT', `拒绝加载: ${gate.reason}`)
  }
  let tools: unknown[]
  let idRules: Array<{ objectId: string; idRule: string | null }> = []
  try {
    const raw = loadYaml(readFileSync(join(versionDir, DERIVED_FILES.toolContracts), 'utf8')) as {
      tools?: unknown[]
      idRules?: unknown[]
    }
    tools = Array.isArray(raw?.tools) ? raw.tools : []
    idRules = Array.isArray(raw?.idRules)
      ? raw.idRules.flatMap((r) => {
          if (!isRecord(r) || typeof r.objectId !== 'string') return []
          return [{ objectId: r.objectId, idRule: r.idRule === null ? null : String(r.idRule ?? '') }]
        })
      : []
  } catch (e) {
    // 门禁通过后仍失败（如 TOCTOU 删文件）：按不可加载处理；只回错误码，
    // 不拼 e.message（ENOENT 的 message 含全路径）。
    const code =
      e instanceof Error && 'code' in e && typeof (e as { code?: unknown }).code === 'string'
        ? (e as { code: string }).code
        : ''
    throw new AgentToolError('DERIVED_DRIFT', `拒绝加载: tool-contracts 不可读${code ? `（${code}）` : ''}`)
  }
  const idRuleByObject = new Map(idRules.map((r) => [r.objectId, r.idRule]))
  return tools.map((t) => {
    const entry = projectByContract(t)
    if (entry.idRule === undefined && entry.objectId !== undefined && idRuleByObject.has(entry.objectId)) {
      entry.idRule = idRuleByObject.get(entry.objectId) ?? null
    }
    return entry
  })
}

/** grant 判定的主体：运行时引用带实例段（`OBJ-AML-ACCOUNT:x`），收权是对象粒度，按类型段匹配。 */
function grantSubject(objectId: string): string {
  const i = objectId.indexOf(':')
  return i >= 0 ? objectId.slice(0, i) : objectId
}

/** grantScope 判定：objectId（可含 `:实例` 段）必须落在收权清单内，否则拒绝。 */
export function grantMatches(entry: ToolContractEntry, objectId: string): boolean {
  const subject = grantSubject(objectId)
  if (subject === '') return false
  return entry.grantScope === subject || entry.objectId === subject || entry.relationId === subject
}

export function checkGrant(contracts: ToolContractEntry[], objectId: string | undefined): string | undefined {
  if (objectId === undefined) return undefined
  const hit = contracts.some((c) => grantMatches(c, objectId))
  return hit ? undefined : `OBJECT_NOT_GRANTED: ${objectId}`
}

/** guard 判定纯函数：args 带 objectId/objectRef 即须过收权；缺 name/version 一律拒绝。 */
export function grantGuardDecision(
  toolName: string,
  args: unknown,
  readContracts: (name: string, version: string) => ToolContractEntry[],
): string | undefined {
  if (!ONTOOL_NAMES.has(toolName)) return undefined
  const a = isRecord(args) ? args : {}
  // args 含 objectId/objectRef 即须过收权（S2.4）：非字符串/空串一律拒绝，
  // 不静默跳过；null/undefined 视为未提供。
  const scoped: string[] = []
  for (const key of ['objectId', 'objectRef'] as const) {
    const v = a[key]
    if (v === undefined || v === null) continue
    if (typeof v !== 'string' || v.length === 0) {
      return `OBJECT_NOT_GRANTED: ${key} 非法（须为非空字符串）`
    }
    scoped.push(v)
  }
  if (scoped.length === 0) return undefined
  if (typeof a.name !== 'string' || typeof a.version !== 'string') {
    return `OBJECT_NOT_GRANTED: ${scoped.join(', ')}（缺少 name/version，无法核对收权清单）`
  }
  try {
    const contracts = readContracts(a.name, a.version)
    for (const objectId of scoped) {
      const denial = checkGrant(contracts, objectId)
      if (denial !== undefined) return denial
    }
    return undefined
  } catch (e) {
    // 保留机器可读错误码（AgentToolError / PackageStoreError——后者 message 只含调用方入参），
    // 拒绝语义不丢码；其余错误不回显底层 message。
    if (e instanceof AgentToolError) return `${e.code}: ${e.message}`
    if (e instanceof PackageStoreError) return `${e.code}: ${e.message}`
    return 'UNKNOWN_ERROR: 收权清单读取失败'
  }
}

/**
 * dataset 收权（run_scenario 双通道解析后、`runScenario` 之前）：
 * `candidates[].objectRef` 先解析到类型（实例 id → `objects[].type`，否则按 `:` 前类型段），
 * 逐条过 grantScope；无法解析或未收权一律拒绝（deny-by-default，不以放行掩盖越权）。
 * 顶层 args 由 guard 收口、dataset 由本函数收口，两层覆盖全部入参面。
 */
export function assertDatasetGranted(
  dataset: RuntimeDataset,
  contracts: ToolContractEntry[],
): void {
  const typeByInstanceId = new Map(dataset.objects.map((o) => [o.id, o.type]))
  for (const c of dataset.candidates) {
    const subject = typeByInstanceId.get(c.objectRef) ?? grantSubject(c.objectRef)
    if (checkGrant(contracts, subject) !== undefined) {
      throw new AgentToolError(
        'OBJECT_NOT_GRANTED',
        `dataset 候选 ${c.candidateId} 的 objectRef ${c.objectRef}（类型 ${subject}）不在收权清单`,
      )
    }
  }
}

/* ───────────────────────── 只读查询投影 ───────────────────────── */

/**
 * list_tool_contracts 过滤：与 guard 同口径——null/undefined 视为未提供（返回全部）；
 * 非法值拒绝，不静默退化。
 */
export function pickContracts(
  contracts: ToolContractEntry[],
  objectId: unknown,
): ToolContractEntry[] {
  if (objectId === undefined || objectId === null) return contracts
  if (typeof objectId !== 'string' || objectId.length === 0) {
    throw new AgentToolError('OBJECT_NOT_GRANTED', 'objectId 非法（须为非空字符串）')
  }
  return contracts.filter((c) => grantMatches(c, objectId))
}

/**
 * core 场景执行异常 → 工具错误：保留机器码与业务语义，
 * 但剥离 message 中的绝对 versionDir（不回显服务端路径）。
 */
export function wrapRunError(e: unknown, versionDir: string): AgentToolError {
  const code =
    e instanceof Error && 'code' in e && typeof (e as { code?: unknown }).code === 'string'
      ? (e as { code: string }).code
      : 'RUN_FAILED'
  const raw = e instanceof Error ? e.message : String(e)
  // versionDir 为空（versionDir() 消毒拒绝时尚无路径）时不剥——split('') 会逐字符打散。
  const msg = versionDir !== '' && raw.includes(versionDir) ? raw.split(versionDir).join('<pkg>') : raw
  return new AgentToolError(code, msg)
}

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

/** 包加载（工具面）：失败不回显底层路径，统一 NOT_FOUND。 */
export function loadToolPackage(
  ws: { versionDir(name: string, version: string): string },
  pkgName: string,
  version: string,
): OntologyPackage {
  try {
    return loadPackage(ws.versionDir(pkgName, version))
  } catch {
    throw new AgentToolError('NOT_FOUND', `包不存在或无法加载: ${pkgName}@${version}`)
  }
}

/* ───────────────────────── 工具注册 ───────────────────────── */

function textBlock(text: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text' as const, text }]
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
  const ws = new PackageWorkspace(join(dataDir, 'workspace'))
  const knowledge = new KnowledgeStore(dataDir)

  const load = (pkgName: string, version: string): OntologyPackage =>
    loadToolPackage(ws, pkgName, version)

  ctx.tools.guard((execution) =>
    grantGuardDecision(execution.name, execution.arguments, (n, v) =>
      readToolContracts(ws.versionDir(n, v)),
    ),
  )

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
      async execute() {
        return { packages: projectPackageList(ws.listVersions()) }
      },
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
      async execute(args) {
        return toolOut(summarizePackage(load(args.name, args.version)))
      },
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
      async execute(args) {
        return toolOut(ruleDossier(load(args.name, args.version), args.ruleId))
      },
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
      async execute(args) {
        const contracts = readToolContracts(ws.versionDir(args.name, args.version))
        return toolOut({ contracts: pickContracts(contracts, args.objectId) })
      },
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
      async execute(args) {
        return toolOut(scenarioCatalog(load(args.name, args.version)))
      },
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
      async execute(args) {
        const dataset = loadDatasetFromArgs(args)
        let versionDir: string
        try {
          versionDir = ws.versionDir(args.name, args.version)
        } catch (e) {
          // versionDir 消毒拒绝（穿越输入）：保留机器码，message 不含服务端路径。
          throw wrapRunError(e, '')
        }
        const contracts = readToolContracts(versionDir)
        assertDatasetGranted(dataset, contracts)
        let result: ScenarioRunResult
        try {
          result = runScenario(versionDir, args.scenarioId, dataset)
        } catch (e) {
          throw wrapRunError(e, versionDir)
        }
        assertRunContract(result)
        return result as never
      },
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
      async execute(args) {
        const source = uploadKnowledgeForPkg(knowledge, ws.listVersions(), {
          packageId: args.packageId,
          sourceType: args.sourceType as SourceType,
          name: args.name,
          content: args.content,
        })
        return toolOut({ source: sourceSummary(source) })
      },
    }),
  )
}
