/**
 * 跨 run 对比视图（report-export-compare S2.2）：RunDiff 的 UI 投影（协议无关、**纯函数**）。
 *
 * - 复用 `compareRunRecords` 的并集/delta 语义（缺席侧 null，**不补 0**）；
 * - 稳定字段引用表 DIFF_FIELD_REFS 供 Compare 与后续绑定面使用；
 * - `buildRunDiffView`（依赖 runstore/compareRunRecords）在 runstore.ts——本模块保持
 *   零 node 依赖，供客户端渲染器直接内联。
 * @module @dsh-onto/core/diffview
 */
import type { RunDiff, RunDiffCandidate } from './runstore.js'

export interface RunDiffView {
  head: {
    runIdA: string
    runIdB: string
    packageA: { name: string; version: string }
    packageB: { name: string; version: string }
    scenarioA: string
    scenarioB: string
    sameDataset: boolean
    auditPassedA: boolean
    auditPassedB: boolean
  }
  /** 并集候选 delta 行（缺席侧 score 为 null；delta 仅两侧齐时给出）。 */
  deltas: RunDiffCandidate[]
  excludedAdded: Array<{ candidateId: string; ruleId: string }>
  excludedRemoved: Array<{ candidateId: string; ruleId: string }>
  summary: {
    deltaCount: number
    addedCount: number
    removedCount: number
    /** 无双侧齐备 delta 时为 null（不展示为 0）。 */
    maxAbsDelta: number | null
    humanReviewRequired: true
  }
}

/** 对比视图稳定字段引用表。 */
export const DIFF_FIELD_REFS = [
  'head.runIdA',
  'head.runIdB',
  'head.packageA.name',
  'head.packageA.version',
  'head.packageB.name',
  'head.packageB.version',
  'head.scenarioA',
  'head.scenarioB',
  'head.sameDataset',
  'head.auditPassedA',
  'head.auditPassedB',
  'deltas[].candidateId',
  'deltas[].riskScoreA',
  'deltas[].riskScoreB',
  'deltas[].riskScoreDelta',
  'deltas[].hitRuleIdsAdded[]',
  'deltas[].hitRuleIdsRemoved[]',
  'deltas[].pendingChecksAdded[]',
  'deltas[].pendingChecksRemoved[]',
  'excludedAdded[].candidateId',
  'excludedAdded[].ruleId',
  'excludedRemoved[].candidateId',
  'excludedRemoved[].ruleId',
  'summary.deltaCount',
  'summary.addedCount',
  'summary.removedCount',
  'summary.maxAbsDelta',
  'summary.humanReviewRequired',
] as const

/** 由既有 RunDiff 出视图（wire/tool 同源路径；纯函数）。 */
export function diffViewOf(diff: RunDiff): RunDiffView {
  const deltas = diff.candidates.map((c) => ({
    candidateId: c.candidateId,
    riskScoreA: c.riskScoreA,
    riskScoreB: c.riskScoreB,
    riskScoreDelta: c.riskScoreDelta,
    hitRuleIdsAdded: [...c.hitRuleIdsAdded],
    hitRuleIdsRemoved: [...c.hitRuleIdsRemoved],
    pendingChecksAdded: [...c.pendingChecksAdded],
    pendingChecksRemoved: [...c.pendingChecksRemoved],
  }))
  const withDelta = deltas.filter((d) => d.riskScoreDelta !== null)
  const addedCount = deltas.reduce((s, d) => s + d.hitRuleIdsAdded.length, 0)
  const removedCount = deltas.reduce((s, d) => s + d.hitRuleIdsRemoved.length, 0)
  return {
    head: {
      runIdA: diff.runIdA,
      runIdB: diff.runIdB,
      packageA: { ...diff.packageA },
      packageB: { ...diff.packageB },
      scenarioA: diff.scenarioA,
      scenarioB: diff.scenarioB,
      sameDataset: diff.sameDataset,
      auditPassedA: diff.auditPassedA,
      auditPassedB: diff.auditPassedB,
    },
    deltas,
    excludedAdded: diff.excludedAdded.map((x) => ({ ...x })),
    excludedRemoved: diff.excludedRemoved.map((x) => ({ ...x })),
    summary: {
      deltaCount: withDelta.length,
      addedCount,
      removedCount,
      maxAbsDelta:
        withDelta.length === 0
          ? null
          : Math.max(...withDelta.map((d) => Math.abs(d.riskScoreDelta as number))),
      humanReviewRequired: true,
    },
  }
}

/** 校验对比字段引用（`deltas[].riskScoreDelta` 形态；数字下标折叠）。 */
export function isDiffFieldRef(ref: string): boolean {
  if (typeof ref !== 'string' || ref === '') return false
  const normalized = ref.replace(/\[(\d+)\]/g, '[]')
  return (DIFF_FIELD_REFS as readonly string[]).includes(normalized)
}
