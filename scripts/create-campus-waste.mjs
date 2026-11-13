/**
 * 新建 campus-waste 包：写源 → validate → review → issue(人审) → derive → gate
 *
 * 用法：
 *   node scripts/create-campus-waste.mjs [--workspace <dir>] [--issue]
 *
 * - --workspace：包工作区根（缺省 = 环境变量 DSH_ONTO_WORKSPACE，再缺省报错退出——
 *   不写死本机绝对路径）。
 * - --issue：显式人审签发开关。缺省只走到 IN_REVIEW + assertIssueReady 演练，
 *   不落 ISSUED；传入才执行 transition(ISSUED)。**正式签发必须由人在工作台完成**，
 *   本开关仅限本地示例/回归（AGENTS.md：ISSUED 只读、签发端点仅人工）。
 */
import { writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  PackageWorkspace,
  savePackage,
  loadPackage,
  writeQualityReport,
  derivePackage,
  verifyDerived,
  assertIssueReady,
} from '../core/dist/index.js'

const argv = process.argv.slice(2)
function flagValue(flag) {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : undefined
}
const root = flagValue('--workspace') ?? process.env.DSH_ONTO_WORKSPACE
if (!root) {
  console.error('missing workspace: pass --workspace <dir> or set DSH_ONTO_WORKSPACE')
  process.exit(2)
}
const issueHuman = argv.includes('--issue')
const ws = new PackageWorkspace(root)
const name = 'campus-waste'
const version = '1.0.0'
const domain = 'WST'
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
        { name: 'zone', type: 'enum', enumValuesRef: 'dict-wst-zone' },
        { name: 'wasteType', type: 'enum', enumValuesRef: 'dict-wst-waste-type' },
        { name: 'fillLevel', type: 'float' },
        { name: 'lastEmptiedAt', type: 'string' },
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
    {
      // 混投事件类型（subgraph-expansion P4）：适配层把快照 mixEvents 物化为该类型行为，
      // hazardMixCount = count(behaviors, type=BHV-WST-MIX)；挂入 behaviorRefs 消
      // ID_UNREFERENCED（审计面可见其锚点，计数由 deriveFeatures 直读 dataset.behaviors）。
      id: 'BHV-WST-MIX',
      name: '混投',
      anchor: 'OBJ-WST-BIN',
      states: ['idle', 'flagged'],
      trigger: 'hazardous mix reported',
      description: '危化混投事件（计数特征数据源）',
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
      // overdueHours 由 BIN.lastEmptiedAt 回算，挂接对象是桶不是路线
      featureSources: { overdueHours: 'OBJ-WST-BIN' },
    },
    {
      id: 'RULE-WST-HAZARD',
      name: '危化混投',
      weight: 0.3,
      expression: 'min(1, hazardMixCount)',
      threshold: 0.5,
      evidenceTemplate: '混投 {hazardMixCount} 次',
      // hazardMixCount 由 BIN.mixEvents 计数，挂接对象是桶不是袋
      featureSources: { hazardMixCount: 'OBJ-WST-BIN' },
    },
  ],
  exclusionRules: [
    {
      id: 'RULE-WST-EX-MAINT', name: '维护中', action: 'drop',
      condition: "zone == 'maintenance'", featureSources: { zone: 'OBJ-WST-BIN' },
    },
    {
      id: 'RULE-WST-EX-LAB', name: '实验室专线', action: 'downweight', factor: 0.5,
      condition: "zone == 'lab'", featureSources: { zone: 'OBJ-WST-BIN' },
    },
    {
      id: 'RULE-WST-EX-WHITELIST', name: '已清运白名单', action: 'drop',
      condition: "tag == 'cleared-whitelist'",
    },
  ],
  skillTemplates: [
    {
      id: 'SKL-WST-TRIAGE',
      name: '满溢分级',
      weights: { 'RULE-WST-FILL': 0.4, 'RULE-WST-OVERDUE': 0.3, 'RULE-WST-HAZARD': 0.3 },
      steps: ['桶 {binNo} 综合风险分 {riskScore}（等级 {riskLevel}）'],
      outputTemplate: '{binNo} 综合风险分 {riskScore} · 等级 {riskLevel}',
    },
  ],
  // 包级特征配方（scenario-prep S2.2 / PR#18 P6）：prep.features=true 时由执行层注入 now 后派生
  featureRecipes: [
    { name: 'overdueHours', kind: 'since', attr: 'lastEmptiedAt' },
    { name: 'hazardMixCount', kind: 'count', source: 'behaviors', filter: { type: 'BHV-WST-MIX' } },
  ],
  scenarios: [
    {
      id: 'SCN-WST-FILL-TRIAGE',
      name: '垃圾桶满溢分级',
      goal: '识别需优先清运的垃圾桶并给出分级候选',
      boundary: '只输出候选；是否加派由后勤人工决定',
      inputs: [
        { name: 'zone', type: 'string', required: false },
        { name: 'fillLevel', type: 'float', required: false },
        { name: 'overdueHours', type: 'float', required: false },
        { name: 'hazardMixCount', type: 'int', required: false },
      ],
      outputs: {
        fields: ['candidateId', 'binNo', 'riskScore', 'riskLevel', 'hitRuleIds', 'evidenceChains', 'pendingChecks'],
      },
      // 场景内含数据准备（S2.1）：种子由 run_scenario.seedIds 传入
      prep: {
        expand: { hops: 1 },
        features: true,
      },
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
      behaviorRefs: ['BHV-WST-DUMP', 'BHV-WST-COLLECT', 'BHV-WST-MIX'],
      exclusionRefs: ['RULE-WST-EX-MAINT', 'RULE-WST-EX-LAB', 'RULE-WST-EX-WHITELIST'],
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

// 3) assertIssueReady 演练（不论是否 --issue 都跑，验证签发门禁）
const gate = assertIssueReady(dir)
if (issueHuman) {
  // 仅限本地示例：显式 --issue 才落 ISSUED（正式签发走工作台人审）
  ws.transition(name, version, 'ISSUED', 'human-reviewer@campus', '本地示例 --issue 签发（非正式人审通道）')
  derivePackage(dir)
  const g2 = verifyDerived(dir)
  console.log('ISSUE', JSON.stringify({ status: loadPackage(dir).meta.status, gateOk: !!gate, loadGate: g2.ok, reason: g2.reason ?? null }))
} else {
  console.log('GATE_ONLY', JSON.stringify({ gateOk: !!gate, status: loadPackage(dir).meta.status, hint: 'pass --issue to issue locally (demo only)' }))
}
console.log('DIR', dir)

// 模拟运行数据：纯结构适配面（features 留空，投影/派生交给 prep.features 执行层）
const runData = {
  objects: [
    { id: 'BIN-01', type: 'OBJ-WST-BIN', attrs: { binNo: 'B01', zone: 'canteen', wasteType: 'kitchen', fillLevel: 0.92, lastEmptiedAt: '2026-11-11T02:00:00Z' } },
    { id: 'BIN-02', type: 'OBJ-WST-BIN', attrs: { binNo: 'B02', zone: 'dorm', wasteType: 'recyclable', fillLevel: 0.35, lastEmptiedAt: '2026-11-12T06:00:00Z' } },
    { id: 'BIN-03', type: 'OBJ-WST-BIN', attrs: { binNo: 'B03', zone: 'lab', wasteType: 'hazardous', fillLevel: 0.8, lastEmptiedAt: '2026-11-12T02:00:00Z' } },
    { id: 'ROUTE-1', type: 'OBJ-WST-ROUTE', attrs: { routeId: 'R01', stopCount: 12, plannedMinutes: 45 } },
  ],
  relations: [
    { id: 'R1', type: 'REL-WST-COVERS', from: 'ROUTE-1', to: 'BIN-01' },
  ],
  behaviors: [
    { id: 'B1', type: 'BHV-WST-DUMP', anchorRef: 'BIN-01', objectRef: 'BIN-01', occurredAt: '2026-11-12T08:00:00Z' },
    { id: 'B-MIX-3-1', type: 'BHV-WST-MIX', anchorRef: 'BIN-03', objectRef: 'BIN-03', occurredAt: '2026-11-12T11:20:00Z' },
    { id: 'B-MIX-3-2', type: 'BHV-WST-MIX', anchorRef: 'BIN-03', objectRef: 'BIN-03', occurredAt: '2026-11-12T13:05:00Z' },
  ],
  candidates: [
    { candidateId: 'CAND-BIN-01', objectRef: 'BIN-01', features: {}, tags: [] },
    { candidateId: 'CAND-BIN-02', objectRef: 'BIN-02', features: {}, tags: [] },
    { candidateId: 'CAND-BIN-03', objectRef: 'BIN-03', features: {}, tags: [] },
    { candidateId: 'CAND-BIN-04', objectRef: 'BIN-02', features: {}, tags: ['cleared-whitelist'] },
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
