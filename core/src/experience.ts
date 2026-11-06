/**
 * 经验闭环（experience-loop）：任务结构签名（spec experience-loop S4.1）。
 *
 * 签名不是任务描述文本，而是 O1/O2/O3 引用的结构摘要——类比按它召回，
 * 它同时就是适用边界（签名不匹配的域不迁移）。全部字段从 OntologyPackage +
 * datasetSummary 机械导出，无自由文本、无 embedding。
 * @module @dsh-onto/core/experience
 */
import { createHash } from 'node:crypto'
import { PackageStoreError } from './store.js'
import type { OntologyPackage } from './types.js'

export interface TaskSignature {
  scenarioId: string
  /** <name>@<version>；跨包参赛须在 externalRefs 声明。 */
  packageScope: string
  /** scenario.goal 归一（trim，取场景卡原文，不自由发挥）。 */
  goalClass: string
  /** pipeline 规范串：DATA_INGEST>BEHAVIOR_CALL>RULE_EVALUATE(before-scoring)>… */
  stepShape: string
  /** scoreRefs/exclusionRefs/全量（排序去重）。 */
  ruleRefs: string[]
  /** pipeline skillRefs 并集（排序去重）。 */
  skillRefs: string[]
  /** inputs 的 `name:type` 排序串。 */
  inputShape: string[]
  /** datasetSummary.candidates 分档（S<50，M<500，L 其余）。 */
  dataBand: 'S' | 'M' | 'L'
  /** sha256(canonicalJson(以上字段))——精确同构判定。 */
  digest: string
}

/** 键序稳定的规范 JSON（同 runstore 口径：对象键递归排序；数组保序）。 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const s = JSON.stringify(value)
    return s === undefined ? 'null' : s
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const rec = value as Record<string, unknown>
  const keys = Object.keys(rec).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`).join(',')}}`
}

/** 候选数分档（初始值，验收时校准）。 */
export function dataBandOf(candidates: number): 'S' | 'M' | 'L' {
  if (candidates < 50) return 'S'
  if (candidates < 500) return 'M'
  return 'L'
}

export function buildTaskSignature(input: {
  pkg: OntologyPackage
  scenarioId: string
  datasetSummary: { objects: number; relations: number; behaviors: number; candidates: number }
}): TaskSignature {
  const { pkg, scenarioId, datasetSummary } = input
  const scenario = pkg.scenarios.find((s) => s.id === scenarioId)
  if (!scenario) {
    throw new PackageStoreError('NOT_FOUND', `scenario not found: ${scenarioId}`)
  }
  const stepShape = scenario.pipeline
    .map((s) => (s.order ? `${s.stepType}(before-scoring)` : s.stepType))
    .join('>')
  const scoreRefs = scenario.scoreRefs ?? pkg.scoreRules.map((r) => r.id)
  const exclusionRefs = scenario.exclusionRefs ?? pkg.exclusionRules.map((r) => r.id)
  const ruleRefs = [...new Set([...scoreRefs, ...exclusionRefs])].sort()
  const skillRefs = [...new Set(scenario.pipeline.flatMap((s) => s.skillRefs ?? []))].sort()
  const inputShape = scenario.inputs.map((i) => `${i.name}:${i.type}`).sort()
  const core = {
    scenarioId,
    packageScope: `${pkg.meta.name}@${pkg.meta.version}`,
    goalClass: scenario.goal.trim(),
    stepShape,
    ruleRefs,
    skillRefs,
    inputShape,
    dataBand: dataBandOf(datasetSummary.candidates),
  }
  return { ...core, digest: createHash('sha256').update(canonicalJson(core)).digest('hex') }
}
