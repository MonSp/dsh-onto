/**
 * 发布前回放（api-to-plugin S2.5）——随包冻结快照 → 映射 → 排除 → 打分 → 证据 → 审计，
 * 与 expected 逐项对照；覆盖缺数、越权、版本切换。只做随包验收样例，不搭评测平台。
 *
 * 与 runtime 连接器共用 core 纯转换（transformSourceRows）：回放走的就是部署同一条映射路径。
 * @module @dsh-onto/core/replay
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { derivePackage } from './derive.js'
import { runScenario } from './scenario.js'
import {
  extractPageItems,
  extractSnapshotRows,
  transformSourceRows,
  type SourceMapTransformResult,
  type SourceRow,
  type SourceRows,
} from './sourcemap.js'
import { loadPackage, readPackageMeta, SOURCE_FILE_LAYOUT, writeSourceFile } from './store.js'
import type { ApiShape, OntologyPackage, ScenarioRunResult, ValidationIssue } from './types.js'

export interface ReplayExpectedCandidate {
  candidateId: string
  objectRef: string
  riskScore: number
  hitRuleIds: string[]
  evidenceChains: Array<{ ruleId: string; score: number }>
  pendingChecks: Array<{ ruleId?: string; missing?: string[] }>
  pendingVerification: boolean
}

export interface ReplayExpected {
  scenarioId: string
  candidates: ReplayExpectedCandidate[]
  excluded: Array<{ candidateId: string; ruleId: string }>
  humanReviewRequired: true
  auditPassed: boolean
}

export interface ReplayDiff {
  where: string
  expected: string
  actual: string
}

export interface ReplayReport {
  scenarioId: string
  fixture: string
  package: { name: string; version: string }
  counts: { objects: number; relations: number; candidates: number; behaviors: number }
  businessWindow: { from: string; to: string }
  /** 映射层诊断（缺字段/断引用/类型等——「缺数」在报告可见）。 */
  diagnostics: ValidationIssue[]
  /** 稳定投影：候选/排除/人审/审计。 */
  result: ReplayExpected
  /** 越权收权时被 scope 剔除的对象类型与计数。 */
  scopedOut?: { objectTypes: string[]; objectsDropped: number; candidatesDropped: number }
  comparison?: { ok: boolean; diffs: ReplayDiff[] }
  against?: {
    package: { name: string; version: string }
    candidatesAdded: string[]
    candidatesRemoved: string[]
    scoreDeltas: Array<{ candidateId: string; from: number; to: number }>
    hitRuleChanges: Array<{ candidateId: string; added: string[]; removed: string[] }>
    auditPassed: { from: boolean; to: boolean }
  }
}

const SCORE_EPS = 1e-6

function shapeOf(pkg: OntologyPackage, sourceId?: string): ApiShape {
  const src =
    sourceId !== undefined && sourceId !== ''
      ? pkg.apiSources.find((s) => s.id === sourceId)
      : pkg.apiSources.find((s) => s.shape !== undefined) ?? pkg.apiSources[0]
  if (src === undefined) throw new Error('包内没有 apiSources')
  if (src.shape === undefined) throw new Error(`${src.id} 未声明 shape`)
  return src.shape
}

/** 夹具（原始响应体）→ 行：与 CLI 采样/连接器同口径。 */
export function fixtureToRows(body: unknown, shape: ApiShape, collections?: string[]): SourceRows {
  if (shape.mode === 'snapshot') return extractSnapshotRows(body, shape)
  const rows: SourceRows = {}
  const src = (body ?? {}) as Record<string, unknown>
  const keys = collections ?? Object.keys(src)
  for (const c of keys) {
    const v = src[c]
    rows[c] = Array.isArray(v)
      ? (v.filter((x) => x !== null && typeof x === 'object') as SourceRow[])
      : extractPageItems(v, shape.itemsPath)
  }
  return rows
}

/** 稳定投影：分数定宽比较、集合类字段排序。 */
function projectResult(scenarioId: string, r: ScenarioRunResult): ReplayExpected {
  return {
    scenarioId,
    candidates: [...r.candidates]
      .sort((a, b) => a.candidateId.localeCompare(b.candidateId))
      .map((c) => ({
        candidateId: c.candidateId,
        objectRef: c.objectRef,
        riskScore: Math.round(c.riskScore * 1e6) / 1e6,
        hitRuleIds: [...c.hitRuleIds].sort(),
        evidenceChains: [...c.evidenceChains]
          .map((e) => ({ ruleId: e.ruleId, score: Math.round(e.score * 1e6) / 1e6 }))
          .sort((a, b) => a.ruleId.localeCompare(b.ruleId)),
        pendingChecks: c.pendingChecks.map((p) => ({
          ...(p.ruleId !== undefined ? { ruleId: p.ruleId } : {}),
          ...(p.missing !== undefined ? { missing: [...p.missing].sort() } : {}),
        })),
        pendingVerification: c.pendingVerification,
      })),
    excluded: [...r.excluded]
      .map((e) => ({ candidateId: e.candidateId, ruleId: e.ruleId }))
      .sort((a, b) => `${a.candidateId}|${a.ruleId}`.localeCompare(`${b.candidateId}|${b.ruleId}`)),
    humanReviewRequired: true,
    auditPassed: r.audit.passed === true,
  }
}

function compareExpected(expected: ReplayExpected, actual: ReplayExpected): ReplayDiff[] {
  const diffs: ReplayDiff[] = []
  const expIds = new Set(expected.candidates.map((c) => c.candidateId))
  const actIds = new Set(actual.candidates.map((c) => c.candidateId))
  for (const id of expIds) {
    if (!actIds.has(id)) diffs.push({ where: `candidates.${id}`, expected: '存在', actual: '缺失' })
  }
  for (const id of actIds) {
    if (!expIds.has(id)) diffs.push({ where: `candidates.${id}`, expected: '缺失', actual: '存在' })
  }
  for (const ec of expected.candidates) {
    const ac = actual.candidates.find((c) => c.candidateId === ec.candidateId)
    if (ac === undefined) continue
    if (ac.objectRef !== ec.objectRef) {
      diffs.push({ where: `candidates.${ec.candidateId}.objectRef`, expected: ec.objectRef, actual: ac.objectRef })
    }
    if (Math.abs(ac.riskScore - ec.riskScore) > SCORE_EPS) {
      diffs.push({ where: `candidates.${ec.candidateId}.riskScore`, expected: String(ec.riskScore), actual: String(ac.riskScore) })
    }
    const eHit = new Set(ec.hitRuleIds)
    const aHit = new Set(ac.hitRuleIds)
    for (const rid of eHit) {
      if (!aHit.has(rid)) diffs.push({ where: `candidates.${ec.candidateId}.hitRuleIds`, expected: rid, actual: '缺失' })
    }
    for (const rid of aHit) {
      if (!eHit.has(rid)) diffs.push({ where: `candidates.${ec.candidateId}.hitRuleIds`, expected: '缺失', actual: rid })
    }
    const key = (e: { ruleId: string; score: number }): string => `${e.ruleId}@${e.score}`
    const eEv = new Set(ec.evidenceChains.map(key))
    const aEv = new Set(ac.evidenceChains.map(key))
    for (const k of eEv) {
      if (!aEv.has(k)) diffs.push({ where: `candidates.${ec.candidateId}.evidenceChains`, expected: k, actual: '缺失' })
    }
    for (const k of aEv) {
      if (!eEv.has(k)) diffs.push({ where: `candidates.${ec.candidateId}.evidenceChains`, expected: '缺失', actual: k })
    }
    if (ec.pendingVerification !== ac.pendingVerification) {
      diffs.push({
        where: `candidates.${ec.candidateId}.pendingVerification`,
        expected: String(ec.pendingVerification),
        actual: String(ac.pendingVerification),
      })
    }
  }
  const exKey = (e: { candidateId: string; ruleId: string }): string => `${e.candidateId}|${e.ruleId}`
  const eEx = new Set(expected.excluded.map(exKey))
  const aEx = new Set(actual.excluded.map(exKey))
  for (const k of eEx) {
    if (!aEx.has(k)) diffs.push({ where: 'excluded', expected: k, actual: '缺失' })
  }
  for (const k of aEx) {
    if (!eEx.has(k)) diffs.push({ where: 'excluded', expected: '缺失', actual: k })
  }
  if (expected.auditPassed !== actual.auditPassed) {
    diffs.push({ where: 'auditPassed', expected: String(expected.auditPassed), actual: String(actual.auditPassed) })
  }
  return diffs
}

export interface ReplayInput {
  versionDir: string
  scenarioId: string
  /** 夹具路径；缺省 fixtures/replay-<scenarioId>.json */
  fixturePath?: string
  /** expected 路径；缺省 fixtures/replay-<scenarioId>.expected.json */
  expectedPath?: string
  /** 越权收权：仅保留这些对象类型（模拟 identity dataScope）。 */
  scopeTypes?: string[]
  sourceId?: string
  /** 对照另一包版本（同夹具双跑，出业务口径 diff）。 */
  againstDir?: string
  check?: boolean
  /** 运行后把稳定投影写回 expected（初始化夹具基线；包须可写=DRAFT/IN_REVIEW）。 */
  writeExpected?: boolean
}

/** 回放：同一映射路径跑场景，出稳定投影 +（可选）对照。 */
export function runReplay(input: ReplayInput): ReplayReport {
  const versionDir = input.versionDir
  const pkg = loadPackage(versionDir)
  const meta = readPackageMeta(versionDir)
  const shape = shapeOf(pkg, input.sourceId)
  const fixtureRel = input.fixturePath ?? `${SOURCE_FILE_LAYOUT.fixturesDir}/replay-${input.scenarioId}.json`
  const expectedRel = input.expectedPath ?? `${SOURCE_FILE_LAYOUT.fixturesDir}/replay-${input.scenarioId}.expected.json`
  const fixtureAbs = input.fixturePath ?? join(versionDir, fixtureRel)
  if (!existsSync(fixtureAbs)) throw new Error(`夹具不存在: ${fixtureAbs}`)
  const body = JSON.parse(readFileSync(fixtureAbs, 'utf8')) as unknown
  let rows = fixtureToRows(body, shape)

  const report: ReplayReport = {
    scenarioId: input.scenarioId,
    fixture: fixtureRel,
    package: { name: meta.name, version: meta.version },
    counts: { objects: 0, relations: 0, candidates: 0, behaviors: 0 },
    businessWindow: { from: '', to: '' },
    diagnostics: [],
    result: {
      scenarioId: input.scenarioId,
      candidates: [],
      excluded: [],
      humanReviewRequired: true,
      auditPassed: false,
    },
  }

  // 越权收权：对象映射的 objectType 不在 scope → 整集合不出数（对齐部署侧 scopeDataQuery 收窄）
  if (input.scopeTypes !== undefined) {
    const scope = new Set(input.scopeTypes)
    const droppedTypes = new Set<string>()
    const scopedRows: SourceRows = {}
    let objectsDropped = 0
    let candidatesDropped = 0
    for (const [c, rs] of Object.entries(rows)) {
      const owning = (pkg.sourceMaps ?? []).find(
        (m) => m.collection === c && (m.kind === undefined || m.kind === 'object'),
      ) as { objectType?: string } | undefined
      if (owning !== undefined && owning.objectType !== undefined && !scope.has(owning.objectType)) {
        droppedTypes.add(owning.objectType)
        objectsDropped += rs.length
        continue
      }
      const cand = (pkg.sourceMaps ?? []).find(
        (m) => m.collection === c && m.kind === 'candidate',
      ) as { objectType?: string } | undefined
      if (cand !== undefined && cand.objectType !== undefined && !scope.has(cand.objectType)) {
        droppedTypes.add(cand.objectType)
        candidatesDropped += rs.length
        continue
      }
      scopedRows[c] = rs
    }
    rows = scopedRows
    report.scopedOut = {
      objectTypes: [...droppedTypes].sort(),
      objectsDropped,
      candidatesDropped,
    }
  }

  const run = (dir: string): { transform: SourceMapTransformResult; result: ScenarioRunResult } => {
    const p = loadPackage(dir)
    const transform = transformSourceRows({ rows, maps: p.sourceMaps ?? [] })
    return { transform, result: runScenario(dir, input.scenarioId, transform.dataset) }
  }

  const main = run(versionDir)
  report.counts = {
    objects: main.transform.dataset.objects.length,
    relations: main.transform.dataset.relations.length,
    candidates: main.transform.dataset.candidates.length,
    behaviors: (main.transform.dataset.behaviors ?? []).length,
  }
  report.businessWindow = main.transform.businessWindow
  report.diagnostics = main.transform.diagnostics
  report.result = projectResult(input.scenarioId, main.result)

  if (input.writeExpected === true) {
    writeSourceFile(versionDir, expectedRel, `${JSON.stringify(report.result, null, 2)}\n`)
    // 基线是随包源文件：写后重派生，否则加载门禁按 DERIVED_DRIFT 拒绝（新文件不在 manifest）
    derivePackage(versionDir)
  }

  if (input.check === true) {
    const expectedAbs = input.expectedPath ?? join(versionDir, expectedRel)
    if (!existsSync(expectedAbs)) {
      report.comparison = { ok: false, diffs: [{ where: expectedRel, expected: '基线存在', actual: '缺失' }] }
    } else {
      const expected = JSON.parse(readFileSync(expectedAbs, 'utf8')) as ReplayExpected
      const diffs = compareExpected(expected, report.result)
      report.comparison = { ok: diffs.length === 0, diffs }
    }
  }

  if (input.againstDir !== undefined) {
    const other = run(input.againstDir)
    const oMeta = readPackageMeta(input.againstDir)
    const mainIds = new Set(report.result.candidates.map((c) => c.candidateId))
    const otherIds = new Set(other.result.candidates.map((c) => c.candidateId))
    const scoreDeltas: Array<{ candidateId: string; from: number; to: number }> = []
    const hitRuleChanges: Array<{ candidateId: string; added: string[]; removed: string[] }> = []
    for (const c of report.result.candidates) {
      const o = other.result.candidates.find((x) => x.candidateId === c.candidateId)
      if (o === undefined) continue
      if (Math.abs(o.riskScore - c.riskScore) > SCORE_EPS) {
        scoreDeltas.push({ candidateId: c.candidateId, from: c.riskScore, to: o.riskScore })
      }
      const added = o.hitRuleIds.filter((r) => !c.hitRuleIds.includes(r))
      const removed = c.hitRuleIds.filter((r) => !o.hitRuleIds.includes(r))
      if (added.length > 0 || removed.length > 0) {
        hitRuleChanges.push({ candidateId: c.candidateId, added, removed })
      }
    }
    report.against = {
      package: { name: oMeta.name, version: oMeta.version },
      candidatesAdded: [...otherIds].filter((id) => !mainIds.has(id)).sort(),
      candidatesRemoved: [...mainIds].filter((id) => !otherIds.has(id)).sort(),
      scoreDeltas,
      hitRuleChanges,
      auditPassed: { from: report.result.auditPassed, to: other.result.audit.passed === true },
    }
  }

  return report
}
