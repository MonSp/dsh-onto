/** 新建 campus-waste 包：写源 → validate → review → issue(人审) → derive → gate */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PackageWorkspace,
  savePackage,
  loadPackage,
  validatePackageDir,
  writeQualityReport,
  derivePackage,
  verifyDerived,
  assertIssueReady,
} from '../core/dist/index.js'

const root = 'C:/Users/qgh13/.dsh/profiles/dsh-onto/dsh-onto/workspace'
const ws = new PackageWorkspace(root)
const name = 'campus-waste'
const version = '1.0.0'
const domain = 'WST'

// 若已存在则先删（幂等重跑）
import { rmSync, existsSync } from 'node:fs'
const existing = ws.versionDir(name, version)
if (existsSync(join(existing, 'package.yaml'))) {
  rmSync(existing, { recursive: true, force: true })
}

const dir = ws.createPackage({ name, version, domain })

const pkg = {
  meta: {
    kind: 'BusinessOntologyPackage',
    name,
    version,
    domain,
    metaFrameworkVersion: '1.0',
    status: 'DRAFT',
    issueRecord: [],
    externalRefs: [],
  },
  objects: [
    {
      id: 'OBJ-WST-BIN',
      name: '垃圾桶',
      idRule: '<campus>:<bin_no>',
      attributes: [
        { name: 'binNo', type: 'string', required: true },
        { name: 'zone', type: 'string' },
        { name: 'wasteType', type: 'enum', enumValuesRef: 'dict-wst-waste-type' },
        { name: 'fillLevel', type: 'float' },
      ],
      lifecycle: ['active', 'maintenance', 'retired'],
      description: '校园分类垃圾桶',
    },
    {
      id: 'OBJ-WST-BAG',
      name: '垃圾袋',
      attributes: [
        { name: 'bagId', type: 'string', required: true },
        { name: 'wasteType', type: 'enum', enumValuesRef: 'dict-wst-waste-type' },
        { name: 'weightKg', type: 'float' },
        { name: 'binRef', type: 'ref', refObject: 'OBJ-WST-BIN' },
      ],
    },
    {
      id: 'OBJ-WST-ROUTE',
      name: '清运路线',
      attributes: [
        { name: 'routeId', type: 'string', required: true },
        { name: 'stopCount', type: 'int' },
        { name: 'plannedMinutes', type: 'int' },
      ],
    },
  ],
  relations: [
    {
      id: 'REL-WST-FILLS',
      name: '装入',
      from: 'OBJ-WST-BAG',
      to: 'OBJ-WST-BIN',
      attributes: [{ name: 'loadedAt', type: 'string' }],
    },
    {
      id: 'REL-WST-COVERS',
      name: '覆盖',
      from: 'OBJ-WST-ROUTE',
      to: 'OBJ-WST-BIN',
      attributes: [],
    },
  ],
  dictionaries: [
    { id: 'dict-wst-waste-type', name: '垃圾类型', values: ['recyclable', 'hazardous', 'kitchen', 'residual'] },
    { id: 'dict-wst-zone', name: '区域', values: ['dorm', 'canteen', 'lab', 'office'] },
  ],
  behaviors: [
    {
      id: 'BHV-WST-DUMP',
      name: '投放垃圾',
      anchor: 'OBJ-WST-BIN',
      relations: ['REL-WST-FILLS'],
      states: ['idle', 'filled'],
      trigger: 'bag deposited',
    },
    {
      id: 'BHV-WST-COLLECT',
      name: '清运收集',
      anchor: 'OBJ-WST-ROUTE',
      relations: ['REL-WST-COVERS'],
      states: ['planned', 'done'],
      trigger: 'route start',
    },
  ],
  scoreRules: [
    {
      id: 'RULE-WST-FILL',
      name: '满溢程度',
      weight: 0.4,
      expression: 'min(1, fillLevel)',
      threshold: 0.7,
      evidenceTemplate: '填充率 {fillLevel}',
      featureSources: { fillLevel: 'OBJ-WST-BIN' },
    },
    {
      id: 'RULE-WST-OVERDUE',
      name: '超时未清',
      weight: 0.3,
      expression: 'min(1, overdueHours / 24)',
      threshold: 0.5,
      evidenceTemplate: '超时 {overdueHours}h',
      featureSources: { overdueHours: 'OBJ-WST-ROUTE' },
    },
    {
      id: 'RULE-WST-HAZARD',
      name: '危化混投',
      weight: 0.3,
      expression: 'min(1, hazardMixCount)',
      threshold: 0.5,
      evidenceTemplate: '混投 {hazardMixCount} 次',
      featureSources: { hazardMixCount: 'OBJ-WST-BAG' },
    },
  ],
  exclusionRules: [
    { id: 'RULE-WST-EX-MAINT', name: '维护中', action: 'drop', condition: "zone == 'maintenance'" },
    { id: 'RULE-WST-EX-LAB', name: '实验室专线', action: 'downweight', factor: 0.5, condition: "zone == 'lab'" },
  ],
  skillTemplates: [
    {
      id: 'SKL-WST-TRIAGE',
      name: '满溢分级',
      weights: { 'RULE-WST-FILL': 0.4, 'RULE-WST-OVERDUE': 0.3, 'RULE-WST-HAZARD': 0.3 },
      steps: ['桶 {candidateId} 满溢 {riskScore}'],
      outputTemplate: '分级摘要：{riskScore}',
    },
  ],
  scenarios: [
    {
      id: 'SCN-WST-FILL-TRIAGE',
      name: '垃圾桶满溢分级',
      goal: '识别需优先清运的垃圾桶并给出分级候选',
      boundary: '只输出候选；是否加派由后勤人工决定',
      inputs: [{ name: 'zone', type: 'string', required: false }],
      outputs: { fields: ['candidateId', 'riskScore', 'hitRuleIds', 'evidenceChains', 'pendingChecks'] },
      pipeline: [
        { stepId: 's1', stepType: 'DATA_INGEST' },
        { stepId: 's2', stepType: 'BEHAVIOR_CALL' },
        { stepId: 's3', stepType: 'RULE_EVALUATE', order: 'before-scoring' },
        { stepId: 's4', stepType: 'RULE_EVALUATE' },
        { stepId: 's5', stepType: 'SKILL_RUN', skillRefs: ['SKL-WST-TRIAGE'] },
        { stepId: 's6', stepType: 'AUDIT_CHECK' },
        { stepId: 's7', stepType: 'HUMAN_REVIEW' },
      ],
      outputContract: {
        mustInclude: ['candidateList', 'riskScore', 'evidenceChains', 'pendingChecks'],
        forbiddenPhrases: ['认定该桶违规投放', '已构成环保违法', '确定为危废'],
      },
      reviewGate: { required: true, threshold: 0.6 },
      exclusionRefs: ['RULE-WST-EX-MAINT', 'RULE-WST-EX-LAB'],
      auditChecks: ['O1_CLOSED', 'O2_CLOSED', 'O3_CLOSED'],
    },
  ],
  fieldMaps: [],
  apiSources: [],
}

savePackage(dir, pkg)

// 1) validate + quality-report
const report = writeQualityReport(dir)
console.log('VALIDATE', JSON.stringify({ score: report.score, errors: report.errors.length, warnings: report.warnings.length }))
if (report.errors.length > 0) {
  console.log('ERRORS', JSON.stringify(report.errors, null, 2))
  process.exit(1)
}

// 2) 人审送审 DRAFT → IN_REVIEW（模拟）
ws.transition(name, version, 'IN_REVIEW')
derivePackage(dir)
console.log('REVIEW ok status=IN_REVIEW')

// 3) 人审通过签发 ISSUED（issuedBy 必须人工）
const gate = assertIssueReady(dir)
ws.transition(name, version, 'ISSUED', 'human-reviewer@campus', '模拟人审通过：校验满分、场景/规则齐备')
derivePackage(dir)
const g2 = verifyDerived(dir)
console.log('ISSUE', JSON.stringify({ status: loadPackage(dir).meta.status, gateOk: !!gate, loadGate: g2.ok, reason: g2.reason ?? null }))
console.log('DIR', dir)

// 模拟运行数据
const runData = {
  objects: [
    { id: 'BIN-01', type: 'OBJ-WST-BIN', attrs: { binNo: 'B01', zone: 'canteen', wasteType: 'kitchen', fillLevel: 0.92 } },
    { id: 'BIN-02', type: 'OBJ-WST-BIN', attrs: { binNo: 'B02', zone: 'dorm', wasteType: 'recyclable', fillLevel: 0.35 } },
    { id: 'BIN-03', type: 'OBJ-WST-BIN', attrs: { binNo: 'B03', zone: 'lab', wasteType: 'hazardous', fillLevel: 0.8 } },
  ],
  relations: [
    { id: 'R1', type: 'REL-WST-COVERS', from: 'ROUTE-1', to: 'BIN-01' },
  ],
  behaviors: [
    { id: 'B1', type: 'BHV-WST-DUMP', anchorRef: 'BIN-01', objectRef: 'BIN-01', occurredAt: '2026-11-12T08:00:00Z' },
  ],
  candidates: [
    {
      candidateId: 'CAND-BIN-01',
      objectRef: 'BIN-01',
      features: { fillLevel: 0.92, overdueHours: 30, hazardMixCount: 0 },
      tags: [],
    },
    {
      candidateId: 'CAND-BIN-02',
      objectRef: 'BIN-02',
      features: { fillLevel: 0.35, overdueHours: 2, hazardMixCount: 0 },
      tags: [],
    },
    {
      candidateId: 'CAND-BIN-03',
      objectRef: 'BIN-03',
      features: { fillLevel: 0.8, overdueHours: 6, hazardMixCount: 2 },
      tags: [],
    },
    {
      candidateId: 'CAND-BIN-04',
      objectRef: 'BIN-02',
      features: { fillLevel: 0.5, overdueHours: 1, hazardMixCount: 0 },
      tags: ['cleared-whitelist'],
    },
  ],
}
const out = join(root, 'campus-waste-run.json')
writeFileSync(out, JSON.stringify(runData, null, 2), 'utf8')
console.log('RUNDATA', out)

// 4) CLI 同源：gate + run（派生物可用性）
import { execFileSync } from 'node:child_process'
const cli = join(process.cwd(), 'core', 'dist', 'cli.js')
const r1 = execFileSync(process.execPath, [cli, 'gate', dir], { encoding: 'utf8' })
console.log('GATE', r1.trim())
const r2 = execFileSync(process.execPath, [cli, 'run', dir, 'SCN-WST-FILL-TRIAGE', '--data', out], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 })
const parsed = JSON.parse(r2)
console.log('RUN', JSON.stringify({
  runId: parsed.runId ?? parsed.result?.runId,
  humanReviewRequired: parsed.humanReviewRequired ?? parsed.result?.humanReviewRequired,
  candidates: (parsed.candidates ?? parsed.result?.candidates ?? []).map((c) => ({
    id: c.candidateId, score: c.riskScore, hits: c.hitRuleIds,
  })),
  excluded: (parsed.excluded ?? parsed.result?.excluded ?? []).map((e) => ({ id: e.candidateId ?? e.id, reason: e.reason ?? e.action })),
  auditPassed: (parsed.audit ?? parsed.result?.audit)?.passed,
  redlineHits: (parsed.audit ?? parsed.result?.audit)?.forbiddenPhraseHits?.length ?? 0,
}))
