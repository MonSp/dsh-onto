/**
 * 派生链（规范 §8）：签发后从 O1/O2/O3 生成运行时契约。
 *
 * 派生物只读、可再生成；manifest 登记源与派生文件 sha256 + sourceDigest；
 * 运行时加载前过 loadgate 校验，指纹不符 → DERIVED_DRIFT 拒绝加载。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  DERIVED_DIR,
  listSourceFiles,
  loadPackage,
  readPackageMeta,
  readSourceFile,
  writeSourceFile,
} from './store.js'
import type {
  DerivedManifest,
  ManifestEntry,
  O3ScenarioCard,
  OntologyPackage,
} from './types.js'
import { dumpYaml, loadYaml } from './yamlio.js'

/** 派生文件相对路径（相对版本目录）。 */
export const DERIVED_FILES = {
  toolContracts: `${DERIVED_DIR}/tool-contracts/tool-contracts.yaml`,
  ruleEngineConfig: `${DERIVED_DIR}/rule-engine-config/rule-engine-config.yaml`,
  agentDuties: `${DERIVED_DIR}/agent-duties.yaml`,
  auditChecks: `${DERIVED_DIR}/audit-checks.yaml`,
  scenarioOrchestration: `${DERIVED_DIR}/scenario-orchestration.yaml`,
  manifest: `${DERIVED_DIR}/manifest.yaml`,
} as const

export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * 源文件规范化文本：package.yaml 的签发锚点（issueRecord[].manifestDigest）
 * 是派生之后写入的追加字段，不参与源指纹，否则 manifest 与锚点互相循环依赖。
 */
export function canonicalSourceText(relPath: string, content: string): string {
  if (!relPath.endsWith('package.yaml')) return content
  try {
    const doc = loadYaml(content) as { issueRecord?: Array<Record<string, unknown>> }
    if (Array.isArray(doc.issueRecord)) {
      for (const entry of doc.issueRecord) delete entry['manifestDigest']
    }
    return dumpYaml(doc)
  } catch {
    return content
  }
}

/** 源文件指纹（规范化后）。 */
export function sourceFileSha256(relPath: string, content: string): string {
  return sha256Text(canonicalSourceText(relPath, content))
}

/** 场景 ID → 短名（去掉 SCN-<TAG>- 前缀），用于派生端点 ID。 */
function scenarioShortName(scenarioId: string): string {
  const m = /^SCN-[A-Z0-9]+-(.+)$/.exec(scenarioId)
  return m ? m[1] : scenarioId.replace(/^SCN-/, '')
}

/** 对象/关系 ID → 包短标（OBJ-AML-ACCOUNT → AML）。 */
function idTag(id: string): string {
  const parts = id.split('-')
  return parts.length > 1 ? parts[1] : 'X'
}

/** 各 pipeline 槽位的阶段职责（§8.2 口径）。usesTools：步级收权（P4）——
 * 引擎/人审步不挂工具白名单；数据/行为/技能步挂对象粒度读工具。 */
const STEP_DUTY: Record<string, { stageDuty: string; llm: 'allowed' | 'forbidden'; usesTools: boolean }> = {
  DATA_INGEST: { stageDuty: '数据归一、建图', llm: 'allowed', usesTools: true },
  BEHAVIOR_CALL: { stageDuty: '行为实例生成与关系聚合', llm: 'allowed', usesTools: true },
  RULE_EVALUATE: { stageDuty: '规则引擎判定（排除/打分）', llm: 'forbidden', usesTools: false },
  SKILL_RUN: { stageDuty: '方法论模板叙述（证据摘要）', llm: 'allowed', usesTools: true },
  AUDIT_CHECK: { stageDuty: '三层闭合审计闸门', llm: 'forbidden', usesTools: false },
  HUMAN_REVIEW: { stageDuty: '人工复核（认定唯一出口）', llm: 'forbidden', usesTools: false },
}

/**
 * 从内存模型生成全部派生文档（不落盘）。
 */
export function buildDerived(pkg: OntologyPackage): Record<string, unknown> {
  const tag = idTag(pkg.objects[0]?.id ?? pkg.behaviors[0]?.id ?? `X-${pkg.meta.domain}`)

  // O1 → 工具契约（入出参映射到 O1；按对象粒度收权）
  const toolContracts = {
    kind: 'DerivedToolContracts',
    llmForbidden: true,
    idRules: pkg.objects.map((o) => ({ objectId: o.id, idRule: o.idRule ?? null })),
    tools: [
      ...pkg.objects.map((o) => ({
        id: `TOOL-${idTag(o.id)}-${o.id.split('-').slice(2).join('-')}`,
        name: `读取${o.name}`,
        kind: 'object-read' as const,
        objectId: o.id,
        grantScope: o.id,
        inputs: o.attributes.filter((a) => a.required).map((a) => `${o.id}.${a.name}`),
        outputs: o.attributes.map((a) => `${o.id}.${a.name}`),
      })),
      ...pkg.relations.map((r) => ({
        id: `TOOL-${idTag(r.id)}-${r.id.split('-').slice(2).join('-')}`,
        name: `读取${r.name}`,
        kind: 'relation-read' as const,
        relationId: r.id,
        grantScope: r.id,
        inputs: [r.from, r.to],
        outputs: (r.attributes ?? []).map((a) => `${r.id}.${a.name}`),
      })),
    ],
  }

  // O2 → 规则引擎配置（exclusion 先于 scoring；权重来自 O2；llmForbidden）
  const ruleEngineConfig = {
    kind: 'DerivedRuleEngineConfig',
    llmForbidden: true,
    weightSum: pkg.scoreRules.reduce((a, r) => a + r.weight, 0),
    exclusion: pkg.exclusionRules.map((r) => ({
      id: r.id,
      name: r.name,
      action: r.action,
      factor: r.factor ?? null,
      condition: r.condition,
      order: 'before-scoring',
    })),
    scoring: pkg.scoreRules.map((r) => ({
      id: r.id,
      name: r.name,
      weight: r.weight,
      expression: r.expression,
      threshold: r.threshold ?? null,
      evidenceTemplate: r.evidenceTemplate ?? null,
    })),
    skillTemplates: pkg.skillTemplates.map((s) => ({
      id: s.id,
      name: s.name,
      weights: s.weights,
    })),
  }

  // O3 → 专家分工（阶段职责、工具权限、llm 禁止节点、人工门禁）
  const duties: Array<Record<string, unknown>> = []
  // 对象/关系粒度读工具全集；按步收权（STEP_DUTY.usesTools）裁剪 toolRefs。
  const objectToolIds = toolContracts.tools
    .filter((t) => 'objectId' in t || 'relationId' in t)
    .map((t) => t.id)
  for (const sc of pkg.scenarios) {
    const short = scenarioShortName(sc.id)
    for (const step of sc.pipeline) {
      const duty = STEP_DUTY[step.stepType] ?? { stageDuty: step.stepType, llm: 'allowed' as const, usesTools: true }
      duties.push({
        id: `AGT-${tag}-${short}-${step.stepId}`,
        scenario: sc.id,
        stepId: step.stepId,
        stepType: step.stepType,
        stageDuty: duty.stageDuty,
        toolRefs: duty.usesTools ? objectToolIds : [],
        llm: duty.llm,
        humanGate: step.stepType === 'HUMAN_REVIEW',
      })
    }
  }
  const agentDuties = { kind: 'DerivedAgentDuties', duties }

  // O3 → 审计项（三层闭合 + forbiddenPhrases 来自场景卡）
  const checks: Array<Record<string, unknown>> = []
  const forbiddenPhrases: Record<string, string[]> = {}
  for (const sc of pkg.scenarios) {
    const short = scenarioShortName(sc.id)
    for (const c of sc.auditChecks) {
      checks.push({
        id: `AUD-${tag}-${short}-${c}`,
        scenario: sc.id,
        check: c,
        requirement: closureRequirement(c),
      })
    }
    forbiddenPhrases[sc.id] = [...sc.outputContract.forbiddenPhrases]
  }
  const auditChecks = {
    kind: 'DerivedAuditChecks',
    checks,
    forbiddenPhrases,
    mustInclude: Object.fromEntries(
      pkg.scenarios.map((sc) => [sc.id, [...sc.outputContract.mustInclude]]),
    ),
  }

  // O3 → 场景编排契约
  const scenarioOrchestration = {
    kind: 'DerivedScenarioOrchestration',
    scenarios: pkg.scenarios.map((sc: O3ScenarioCard) => ({
      id: sc.id,
      name: sc.name,
      goal: sc.goal,
      boundary: sc.boundary,
      inputs: sc.inputs,
      outputs: sc.outputs,
      pipeline: sc.pipeline,
      outputContract: sc.outputContract,
      reviewGate: sc.reviewGate,
    })),
  }

  return {
    [DERIVED_FILES.toolContracts]: toolContracts,
    [DERIVED_FILES.ruleEngineConfig]: ruleEngineConfig,
    [DERIVED_FILES.agentDuties]: agentDuties,
    [DERIVED_FILES.auditChecks]: auditChecks,
    [DERIVED_FILES.scenarioOrchestration]: scenarioOrchestration,
  }
}

function closureRequirement(check: string): string {
  switch (check) {
    case 'O1_CLOSED':
      return '引用的对象/关系真实存在（对照行为实例表与运行时数据）'
    case 'O2_CLOSED':
      return '行为实例与规则命中真实发生（对照行为实例表与规则日志）'
    case 'O3_CLOSED':
      return '结论未越出场景卡输出契约；禁用表述零命中'
    default:
      return '自定义闭合检查'
  }
}

/**
 * O→L 层标注（conversational-modeling P4）：bindings/工具契约→L2，
 * skill-templates→L3，职责/审计/编排→L4；rule-engine-config 等引擎配置不标
 * （O2 运行配置，非 L 层执行件）。L1/L5 为入口面，不派生。
 */
function layerOfEntry(rel: string): ManifestEntry['layer'] {
  if (rel.startsWith('bindings/')) return 'L2'
  if (rel.startsWith('derived/tool-contracts')) return 'L2'
  if (
    rel.startsWith('derived/agent-duties') ||
    rel.startsWith('derived/audit-checks') ||
    rel.startsWith('derived/scenario-orchestration')
  ) {
    return 'L4'
  }
  if (rel.startsWith('o2-behavior-rules/skill-templates/')) return 'L3'
  return undefined
}

/** manifest 条目构造：path + sha256 + 可选 layer（向后兼容，缺省即无标注）。 */
function withLayer(path: string, sha256: string): ManifestEntry {
  const layer = layerOfEntry(path)
  return layer ? { path, sha256, layer } : { path, sha256 }
}

/**
 * 派生入口：生成 derived/** 并写 manifest（含全部源/派生指纹）。
 * 覆盖已有派生物（只读语义指运行时不得手改，再生成是恢复手段）。
 */
export function derivePackage(versionDir: string): DerivedManifest {
  const pkg = loadPackage(versionDir)
  const derived = buildDerived(pkg)

  // 清掉旧派生目录，重新生成（manifest 除外——先写内容再写 manifest）
  const derivedDir = join(versionDir, DERIVED_DIR)
  rmSync(derivedDir, { recursive: true, force: true })
  mkdirSync(derivedDir, { recursive: true })

  for (const [rel, doc] of Object.entries(derived)) {
    const full = join(versionDir, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, dumpYaml(doc), 'utf8')
  }

  const sources: ManifestEntry[] = listSourceFiles(versionDir).map((rel) =>
    withLayer(rel, sourceFileSha256(rel, readSourceFile(versionDir, rel))),
  )
  const derivedEntries: ManifestEntry[] = Object.keys(derived).map((rel) =>
    withLayer(rel, sha256Text(readFileSync(join(versionDir, rel), 'utf8'))),
  )

  const meta = readPackageMeta(versionDir)
  const manifest: DerivedManifest = {
    kind: 'DerivedManifest',
    package: meta.name,
    version: meta.version,
    domain: meta.domain,
    generatedAt: new Date().toISOString(),
    sourceDigest: sourceDigestOf(sources),
    sources,
    derived: derivedEntries,
  }
  const manifestText = dumpYaml(manifest)
  writeFileSync(join(versionDir, DERIVED_FILES.manifest), manifestText, 'utf8')

  // 库外锚点：ISSUED 包把 manifest 指纹追加进签发记录（防「改派生物+改 manifest」双改）。
  if (meta.status === 'ISSUED') {
    recordManifestAnchor(versionDir, sha256Text(manifestText))
  }
  return manifest
}

/** 源指纹聚合摘要：按 path 排序的 `path:sha256` 连接后取 sha256。 */
export function sourceDigestOf(sources: ManifestEntry[]): string {
  const lines = [...sources].sort((a, b) => (a.path < b.path ? -1 : 1)).map((e) => `${e.path}:${e.sha256}`)
  return sha256Text(lines.join('\n'))
}

/** 读取派生 manifest；缺失返回 null。 */
export function readManifest(versionDir: string): DerivedManifest | null {
  const path = join(versionDir, DERIVED_FILES.manifest)
  if (!existsSync(path)) return null
  const doc = loadYaml(readFileSync(path, 'utf8'))
  return (doc as DerivedManifest) ?? null
}

/**
 * 把 manifest 指纹写入签发记录（仅 ISSUED 包；这是签发记录的追加，
 * 不是 Schema 修改——ISSUED 源 Schema 仍只读）。
 */
export function recordManifestAnchor(versionDir: string, manifestSha256: string): void {
  const meta = readPackageMeta(versionDir)
  if (meta.status !== 'ISSUED') return
  const last = meta.issueRecord[meta.issueRecord.length - 1]
  if (last) {
    last.manifestDigest = manifestSha256
    const text = readFileSync(join(versionDir, 'package.yaml'), 'utf8')
    const doc = loadYaml(text) as { issueRecord?: Array<Record<string, unknown>> }
    if (doc.issueRecord && doc.issueRecord.length > 0) {
      doc.issueRecord[doc.issueRecord.length - 1].manifestDigest = manifestSha256
      writeFileSync(join(versionDir, 'package.yaml'), dumpYaml(doc), 'utf8')
    }
  }
}
