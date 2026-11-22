/**
 * 报表数据契约（协议无关，spec chat-run-report S2.1）：RunRecord → RunReport。
 *
 * - 固定结果页与对话报表共用同一投影，数值一致由构造保证；
 * - 以 runRef（runId + 包版本）+ 稳定字段引用标识一次运行的数据；
 * - 人审面口径（完整证据/叙述，同 showRun wire），不经模型面脱敏闸——
 *   模型面文本由工具层单独渲染并过 enforceOutputPolicy。
 * @module @dsh-onto/core/report
 */
import type {
  AuditCheckEntry,
  ContractStatus,
  DataStatus,
  EvidenceChainEntry,
  PendingCheck,
  RuleHitLogEntry,
  ScenarioRunResult,
} from './types.js'
import type { RunRecord } from './runstore.js'

/** 一次运行的稳定标识（runId + 包版本 + 场景）。 */
export interface RunRef {
  runId: string
  package: { name: string; version: string }
  scenarioId: string
  startedAt: string
  savedAt: string
}

export interface ReportSummary {
  candidateCount: number
  excludedCount: number
  /** 无候选时为 null（不得展示为 0 分低风险）。 */
  maxRiskScore: number | null
  /** 命中规则数（候选 hitRuleIds 去重）。 */
  hitRuleCount: number
  /** 恒为 true（认定出口只在人工）。 */
  humanReviewRequired: true
  reviewGate: { threshold: number; required: boolean; requireReviewFor: string[] }
  auditPassed: boolean
  dataStatus?: DataStatus
  contractStatus?: ContractStatus
  dataTrust?: { provenance: string; verified: boolean; note: string }
  datasetSummary: { objects: number; relations: number; behaviors: number; candidates: number }
}

export interface ReportCandidateRow {
  candidateId: string
  objectRef: string
  riskScore: number
  riskLevel?: string
  hitRuleIds: string[]
  evidenceChains: EvidenceChainEntry[]
  narrative: string[]
  pendingChecks: PendingCheck[]
  pendingVerification: boolean
}

export interface RunReport {
  runRef: RunRef
  summary: ReportSummary
  candidates: ReportCandidateRow[]
  excluded: Array<{ candidateId: string; ruleId: string }>
  exclusionFeatureGaps?: Array<{ candidateId: string; ruleId: string; missing: string[] }>
  /** 排序依据溯源（规则命中逐条计分流水）。 */
  ruleHitLog: RuleHitLogEntry[]
  audit: { checks: AuditCheckEntry[]; passed: boolean }
}

/**
 * 稳定字段引用表（绑定/视图规格引用字段而非展示名；换渲染协议不重写报表逻辑）。
 * 形态：`a.b[]` / `a.b[i].c`；`[]` 表示列表元素。
 */
export const REPORT_FIELD_REFS = [
  'runRef.runId',
  'runRef.package.name',
  'runRef.package.version',
  'runRef.scenarioId',
  'runRef.startedAt',
  'runRef.savedAt',
  'summary.candidateCount',
  'summary.excludedCount',
  'summary.maxRiskScore',
  'summary.hitRuleCount',
  'summary.humanReviewRequired',
  'summary.reviewGate.threshold',
  'summary.reviewGate.required',
  'summary.auditPassed',
  'summary.dataStatus',
  'summary.contractStatus',
  'summary.dataTrust.verified',
  'summary.datasetSummary.objects',
  'summary.datasetSummary.relations',
  'summary.datasetSummary.behaviors',
  'summary.datasetSummary.candidates',
  'candidates[].candidateId',
  'candidates[].objectRef',
  'candidates[].riskScore',
  'candidates[].riskLevel',
  'candidates[].hitRuleIds[]',
  'candidates[].evidenceChains[].ruleId',
  'candidates[].evidenceChains[].score',
  'candidates[].evidenceChains[].evidence',
  'candidates[].narrative[]',
  'candidates[].pendingChecks[].ruleId',
  'candidates[].pendingChecks[].missing[]',
  'candidates[].pendingChecks[].note',
  'candidates[].pendingVerification',
  'excluded[].candidateId',
  'excluded[].ruleId',
  'ruleHitLog[].ruleId',
  'ruleHitLog[].candidateId',
  'ruleHitLog[].score',
  'ruleHitLog[].ts',
  'audit.passed',
  'audit.checks[].detail',
] as const

/** 候选行内字段（Table 列绑定的行相对引用；evidenceChains/narrative 供展开）。 */
export const CANDIDATE_ROW_FIELDS = [
  'candidateId',
  'objectRef',
  'riskScore',
  'riskLevel',
  'hitRuleIds',
  'evidenceChains',
  'narrative',
  'pendingChecks',
  'pendingVerification',
] as const

/** 可整体绑定的列表容器（Table.rowsBind=/candidates；Accordion=行级明细四列表；Timeline 额外含 ruleHitLog）。 */
export const REPORT_LIST_REFS = [
  'candidates',
  'candidates[].evidenceChains',
  'candidates[].pendingChecks',
  'candidates[].narrative',
  'candidates[].hitRuleIds',
  'ruleHitLog',
] as const

/** RunRecord → RunReport 纯投影。 */
export function buildRunReport(record: RunRecord): RunReport {
  const result: ScenarioRunResult = record.result
  const candidates = result.candidates.map((c) => ({
    candidateId: c.candidateId,
    objectRef: c.objectRef,
    riskScore: c.riskScore,
    ...(c.riskLevel === undefined ? {} : { riskLevel: c.riskLevel }),
    hitRuleIds: [...c.hitRuleIds],
    evidenceChains: c.evidenceChains.map((e) => ({
      ruleId: e.ruleId,
      score: e.score,
      evidence: e.evidence,
    })),
    narrative: [...c.narrative],
    pendingChecks: c.pendingChecks.map((p) => ({
      ...(p.ruleId === undefined ? {} : { ruleId: p.ruleId }),
      ...(p.missing === undefined ? {} : { missing: [...p.missing] }),
      note: p.note,
    })),
    pendingVerification: c.pendingVerification,
  }))
  const hitRuleCount = new Set(candidates.flatMap((c) => c.hitRuleIds)).size
  const maxRiskScore =
    candidates.length === 0 ? null : Math.max(...candidates.map((c) => c.riskScore))
  return {
    runRef: {
      runId: result.runId,
      package: { name: record.package.name, version: record.package.version },
      scenarioId: result.scenarioId,
      startedAt: result.startedAt,
      savedAt: record.savedAt,
    },
    summary: {
      candidateCount: candidates.length,
      excludedCount: result.excluded.length,
      maxRiskScore,
      hitRuleCount,
      humanReviewRequired: true,
      reviewGate: {
        threshold: result.reviewGate.threshold,
        required: result.reviewGate.required,
        requireReviewFor: [...result.reviewGate.requireReviewFor],
      },
      auditPassed: result.audit.passed,
      ...(result.dataStatus === undefined ? {} : { dataStatus: result.dataStatus }),
      ...(result.contractStatus === undefined ? {} : { contractStatus: result.contractStatus }),
      ...(result.dataTrust === undefined
        ? {}
        : {
            dataTrust: {
              provenance: result.dataTrust.provenance,
              verified: result.dataTrust.verified,
              note: result.dataTrust.note,
            },
          }),
      datasetSummary: { ...record.datasetSummary },
    },
    candidates,
    excluded: result.excluded.map((x) => ({ candidateId: x.candidateId, ruleId: x.ruleId })),
    ...(result.exclusionFeatureGaps === undefined
      ? {}
      : {
          exclusionFeatureGaps: result.exclusionFeatureGaps.map((g) => ({
            candidateId: g.candidateId,
            ruleId: g.ruleId,
            missing: [...g.missing],
          })),
        }),
    ruleHitLog: result.ruleHitLog.map((l) => ({
      ruleId: l.ruleId,
      candidateId: l.candidateId,
      score: l.score,
      ts: l.ts,
    })),
    audit: {
      checks: result.audit.checks.map((c) => ({
        check: c.check,
        closed: c.closed,
        detail: c.detail,
        ts: c.ts,
        ...(c.blocking === undefined ? {} : { blocking: c.blocking }),
      })),
      passed: result.audit.passed,
    },
  }
}

/**
 * 校验稳定字段引用是否落在报表契约内（绑定闸口用）。
 * 支持形态：`summary.maxRiskScore`、`candidates[].riskScore`、`candidates[0].riskScore`。
 */
export function isReportFieldRef(ref: string): boolean {
  if (typeof ref !== 'string' || ref === '') return false
  const normalized = ref.replace(/\[(\d+)\]/g, '[]')
  return (REPORT_FIELD_REFS as readonly string[]).includes(normalized)
}

/** 候选行相对字段引用（Table 列绑定用）。 */
export function isCandidateRowField(field: string): boolean {
  return (CANDIDATE_ROW_FIELDS as readonly string[]).includes(field)
}

/**
 * JSON-pointer 形态（A2UI `@path` 绑定）→ 稳定字段引用形态：
 * `/candidates/0/riskScore` → `candidates[].riskScore`；非法指针返回 null。
 */
export function reportPointerToRef(pointer: string): string | null {
  if (typeof pointer !== 'string' || !pointer.startsWith('/') || pointer === '/') return null
  const segs = pointer.slice(1).split('/')
  const parts: string[] = []
  for (const seg of segs) {
    if (seg === '') return null
    if (/^\d+$/.test(seg)) {
      if (parts.length === 0) return null
      const prev = parts.pop() as string
      if (prev.endsWith('[]')) return null
      parts.push(`${prev}[]`)
      continue
    }
    parts.push(seg)
  }
  return parts.join('.')
}

/** 校验 `@path` 绑定指针落在报表契约内。 */
export function isReportPointer(pointer: string): boolean {
  const ref = reportPointerToRef(pointer)
  return ref !== null && isReportFieldRef(ref)
}

/** 校验列表容器指针（Table.rowsBind / Accordion.bind 目标）。 */
export function isReportListPointer(pointer: string): boolean {
  const ref = reportPointerToRef(pointer)
  return ref !== null && (REPORT_LIST_REFS as readonly string[]).includes(ref)
}

/** 按 `@path` 指针读报表值（越界/缺段返回 undefined）。 */
export function resolveReportPointer(report: RunReport, pointer: string): unknown {
  if (typeof pointer !== 'string' || !pointer.startsWith('/') || pointer === '/') return undefined
  let cur: unknown = report
  for (const seg of pointer.slice(1).split('/')) {
    if (seg === '') return undefined
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(seg)) return undefined
      cur = cur[Number(seg)]
    } else if (cur !== null && typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[seg]
    } else {
      return undefined
    }
    if (cur === undefined) return undefined
  }
  return cur
}

export interface ChartPoint {
  label: string
  value: number
}

/**
 * 图表取点（null-safe，渲染层共用）：非有限值跳过并断线分段（绝不补 0），
 * 行序即 x 序；全空返回空段（渲染显 `—`）。
 */
export function projectChartPoints(
  report: RunReport,
  rowsBind: string,
  labelField: string,
  valueField: string,
): { points: ChartPoint[]; segments: ChartPoint[][] } {
  const rows = resolveReportPointer(report, rowsBind)
  const points: ChartPoint[] = []
  const segments: ChartPoint[][] = []
  let current: ChartPoint[] = []
  if (Array.isArray(rows)) {
    for (const r of rows) {
      const rec = r !== null && typeof r === 'object' ? (r as Record<string, unknown>) : null
      const raw = rec === null ? undefined : rec[valueField]
      if (typeof raw === 'number' && Number.isFinite(raw)) {
        const pt: ChartPoint = {
          label: rec === null ? '' : fmtChartLabel(rec[labelField]),
          value: raw,
        }
        points.push(pt)
        current.push(pt)
      } else if (current.length > 0) {
        segments.push(current)
        current = []
      }
    }
  }
  if (current.length > 0) segments.push(current)
  return { points, segments }
}

function fmtChartLabel(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (Array.isArray(v)) return v.map((x) => fmtChartLabel(x)).join(', ')
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}
