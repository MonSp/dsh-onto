/** 测试共用工具：临时工作区 + 最小合法包模型。 */
import { mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PackageWorkspace, savePackage, loadPackage, derivePackage } from '../dist/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = join(HERE, '..', '..')

export function mkWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'caliber-test-'))
  return new PackageWorkspace(root)
}

export function rmWorkspace(root) {
  rmSync(root, { recursive: true, force: true })
}

/** 最小合法包模型（校验应 0 error）。 */
export function minimalPkg(overrides = {}) {
  const base = {
    meta: {
      kind: 'BusinessOntologyPackage',
      name: 'test-pkg',
      version: '1.0.0',
      domain: 'TST',
      metaFrameworkVersion: '1.0',
      status: 'DRAFT',
      issueRecord: [],
      externalRefs: [],
    },
    objects: [
      {
        id: 'OBJ-TST-A',
        name: '甲',
        idRule: '<c>:<a>',
        attributes: [
          { name: 'a1', type: 'string' },
          { name: 'a2', type: 'enum', enumValuesRef: 'dict-tst-k' },
        ],
      },
      { id: 'OBJ-TST-B', name: '乙', attributes: [{ name: 'b1', type: 'float' }] },
    ],
    relations: [
      {
        id: 'REL-TST-AB',
        name: '关联',
        from: 'OBJ-TST-A',
        to: 'OBJ-TST-B',
        attributes: [{ name: 'r1', type: 'string' }],
      },
    ],
    dictionaries: [{ id: 'dict-tst-k', name: '字典K', values: ['x', 'y'] }],
    behaviors: [{ id: 'BHV-TST-X', name: '行为X', anchor: 'OBJ-TST-A', relations: ['REL-TST-AB'] }],
    scoreRules: [
      {
        id: 'RULE-TST-S1',
        name: '规则一',
        weight: 1,
        expression: 'min(1, f1)',
        threshold: 0.5,
        evidenceTemplate: '特征 f1 = {f1}',
      },
    ],
    exclusionRules: [
      { id: 'RULE-TST-E1', name: '排除一', action: 'downweight', factor: 0.5, condition: "tag == 't'" },
    ],
    skillTemplates: [
      {
        id: 'SKL-TST-N',
        name: '叙述',
        weights: { 'RULE-TST-S1': 1 },
        steps: ['候选 {candidateId}'],
        outputTemplate: '摘要：{riskScore}',
      },
    ],
    scenarios: [
      {
        id: 'SCN-TST-1',
        name: '测试场景',
        goal: '测试',
        boundary: '只输出候选',
        inputs: [{ name: 'p1', type: 'string', required: true }],
        outputs: { fields: ['candidateId', 'riskScore', 'hitRuleIds', 'evidenceChains', 'pendingChecks'] },
        pipeline: [
          { stepId: 's1', stepType: 'DATA_INGEST' },
          { stepId: 's2', stepType: 'BEHAVIOR_CALL' },
          { stepId: 's3', stepType: 'RULE_EVALUATE', order: 'before-scoring' },
          { stepId: 's4', stepType: 'RULE_EVALUATE' },
          { stepId: 's5', stepType: 'SKILL_RUN', skillRefs: ['SKL-TST-N'] },
          { stepId: 's6', stepType: 'AUDIT_CHECK' },
          { stepId: 's7', stepType: 'HUMAN_REVIEW' },
        ],
        outputContract: {
          mustInclude: ['candidateList', 'riskScore', 'evidenceChains', 'pendingChecks'],
          forbiddenPhrases: ['认定违规'],
        },
        reviewGate: { required: true, threshold: 0.75 },
        auditChecks: ['O1_CLOSED', 'O2_CLOSED', 'O3_CLOSED'],
      },
    ],
    fieldMaps: [{ id: 'FM-TST-1', source: 's.f', target: 'OBJ-TST-A.a1' }],
    apiSources: [{ id: 'SRC-TST-1', name: '源', sourceType: 'SCHEMA_API' }],
  }
  return { ...base, ...overrides }
}

/** 创建一个装好最小包的工作区，返回 { ws, dir, root, pkg }。 */
export function mkWorkspaceWithPkg(overrides = {}) {
  const ws = mkWorkspace()
  const dir = ws.createPackage({ name: 'test-pkg', version: '1.0.0', domain: 'TST' })
  const pkg = minimalPkg(overrides)
  savePackage(dir, pkg)
  return { ws, dir, root: ws.root, pkg }
}

/** 把仓库示例包复制到临时工作区（带派生），返回版本目录。 */
export function copyExamplePackage(domain) {
  const ws = mkWorkspace()
  const src = join(REPO_ROOT, 'packages', domain, '1.0.0')
  const dir = ws.versionDir(domain === 'aml' ? 'aml-analysis' : 'med-safety', '1.0.0')
  cpSync(src, dir, { recursive: true })
  derivePackage(dir)
  return { ws, dir, root: ws.root }
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function writeRaw(dir, rel, text) {
  writeFileSync(join(dir, rel), text, 'utf8')
}

export function exampleData(name) {
  return readJson(join(REPO_ROOT, 'examples', name))
}

export { existsSync, loadPackage, savePackage, derivePackage }
