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
  isInsideDir,
  isSafeRelPath,
  loadPackage,
  runScenario,
  verifyDerived,
  type KnowledgeSourceRecord,
  type OntologyPackage,
  type RuntimeDataset,
  type ScenarioRunResult,
  type SourceType,
} from '@dsh-onto/core'
import {
  AgentToolError,
  assertRunContract,
  collectPhrases,
  enforceOutputPolicy,
  isRecord,
  registerServerDir,
  rememberPhrases,
  renderRunText,
  toolExecute,
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
  // 错误信封剥除清单：工具错误不再回显 dataDir 派生的任何服务端路径（P2.4）。
  registerServerDir(dataDir)
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
      execute: toolExecute((args: { name: string; version: string }) =>
        toolOut(summarizePackage(load(args.name, args.version))),
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
      execute: toolExecute((args: { name: string; version: string; ruleId?: string }) =>
        toolOut(ruleDossier(load(args.name, args.version), args.ruleId)),
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
      execute: toolExecute((args: { name: string; version: string; objectId?: string }) => {
        const contracts = readToolContracts(ws.versionDir(args.name, args.version))
        return toolOut({ contracts: pickContracts(contracts, args.objectId) })
      }),
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
      execute: toolExecute((args: { name: string; version: string }) =>
        toolOut(scenarioCatalog(load(args.name, args.version))),
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
      execute: toolExecute((args: {
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
        rememberPhrases(result.runId, phrases)
        return toolOut(enforceOutputPolicy(result, phrases))
      }),
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
      execute: toolExecute((args: {
        packageId: string
        sourceType: SourceType
        name: string
        content: string
      }) => {
        const source = uploadKnowledgeForPkg(knowledge, ws.listVersions(), args)
        return toolOut({ source: sourceSummary(source) })
      }),
    }),
  )
}
