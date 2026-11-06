/** 派生链与加载门禁验收（规范 §8 / §11.3）：手改派生物 → 拒绝加载；重派生恢复。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { derivePackage, verifyDerived, readManifest, loadPackage, loadYaml } from '../dist/index.js'
import { mkWorkspaceWithPkg, rmWorkspace, writeRaw, minimalPkg } from './helpers.mjs'

test('派生后门禁通过；manifest 登记源与派生指纹', () => {
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    const manifest = derivePackage(dir)
    assert.ok(manifest.sources.length > 0)
    assert.ok(manifest.derived.length >= 5)
    assert.ok(manifest.sourceDigest.length === 64)
    const gate = verifyDerived(dir)
    assert.equal(gate.ok, true)
  } finally {
    rmWorkspace(root)
  }
})

test('未派生（缺 manifest）→ DERIVED_DRIFT 拒绝加载', () => {
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    const gate = verifyDerived(dir)
    assert.equal(gate.ok, false)
    assert.equal(gate.code, 'DERIVED_DRIFT')
  } finally {
    rmWorkspace(root)
  }
})

test('手改派生物 → DERIVED_DRIFT；重新派生可恢复', () => {
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    derivePackage(dir)
    const target = join(dir, 'derived/rule-engine-config/rule-engine-config.yaml')
    const text = readFileSync(target, 'utf8')
    writeFileSync(target, text.replace('llmForbidden: true', 'llmForbidden: false'), 'utf8')
    const gate = verifyDerived(dir)
    assert.equal(gate.ok, false)
    assert.equal(gate.code, 'DERIVED_DRIFT')
    assert.match(gate.reason, /derived fingerprint mismatch/)
    // 重新派生恢复
    derivePackage(dir)
    assert.equal(verifyDerived(dir).ok, true)
  } finally {
    rmWorkspace(root)
  }
})

test('改源文件 → DERIVED_DRIFT（源指纹不符）', () => {
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    derivePackage(dir)
    // 语义性篡改（域被改），规范化哈希必须察觉
    writeRaw(dir, 'package.yaml', 'kind: BusinessOntologyPackage\nname: test-pkg\nversion: 1.0.0\ndomain: HACKED\nmetaFrameworkVersion: "1.0"\nstatus: DRAFT\nissueRecord: []\nexternalRefs: []\n')
    const gate = verifyDerived(dir)
    assert.equal(gate.ok, false)
    assert.equal(gate.code, 'DERIVED_DRIFT')
    assert.match(gate.reason, /source fingerprint mismatch/)
  } finally {
    rmWorkspace(root)
  }
})

test('删除派生文件 → DERIVED_DRIFT', () => {
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    derivePackage(dir)
    rmSync(join(dir, 'derived/agent-duties.yaml'))
    const gate = verifyDerived(dir)
    assert.equal(gate.ok, false)
    assert.match(gate.reason, /derived file missing/)
  } finally {
    rmWorkspace(root)
  }
})

test('派生内容口径：规则配置 llmForbidden、审计含禁语、分工含人工门禁', () => {
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    derivePackage(dir)
    const ruleCfg = readFileSync(join(dir, 'derived/rule-engine-config/rule-engine-config.yaml'), 'utf8')
    assert.match(ruleCfg, /llmForbidden: true/)
    assert.match(ruleCfg, /order: before-scoring/)
    const audit = readFileSync(join(dir, 'derived/audit-checks.yaml'), 'utf8')
    assert.match(audit, /forbiddenPhrases/)
    assert.match(audit, /认定违规/)
    assert.match(audit, /O1_CLOSED/)
    const duties = readFileSync(join(dir, 'derived/agent-duties.yaml'), 'utf8')
    assert.match(duties, /humanGate: true/)
    assert.match(duties, /llm: forbidden/)
    const tools = readFileSync(join(dir, 'derived/tool-contracts/tool-contracts.yaml'), 'utf8')
    assert.match(tools, /TOOL-TST-/)
  } finally {
    rmWorkspace(root)
  }
})

test('ISSUED 包派生记录 manifest 锚点；改 manifest 被锚点拦下', () => {
  const { ws, dir, root } = mkWorkspaceWithPkg()
  try {
    ws.transition('test-pkg', '1.0.0', 'IN_REVIEW')
    ws.transition('test-pkg', '1.0.0', 'ISSUED', '张三')
    derivePackage(dir)
    const meta = readFileSync(join(dir, 'package.yaml'), 'utf8')
    assert.ok(meta.includes('manifestDigest'))
    assert.equal(verifyDerived(dir).ok, true)
    // 改派生物 + 改 manifest 的「双改」：锚点对不上
    const manifestPath = join(dir, 'derived/manifest.yaml')
    const mtext = readFileSync(manifestPath, 'utf8')
    writeFileSync(manifestPath, `${mtext}# tampered manifest\n`, 'utf8')
    const gate = verifyDerived(dir)
    assert.equal(gate.ok, false)
    assert.match(gate.reason, /anchor mismatch/)
  } finally {
    rmWorkspace(root)
  }
})

test('派生物独立于包加载（loadPackage 不含 derived）', () => {
  const { dir, root } = mkWorkspaceWithPkg()
  try {
    derivePackage(dir)
    const pkg = loadPackage(dir)
    assert.equal(pkg.meta.name, 'test-pkg')
    assert.ok(readManifest(dir) !== null)
  } finally {
    rmWorkspace(root)
  }
})

test('scenario-orchestration 下发 behaviorRefs/exclusionRefs/scoreRefs（缺省不落键）', () => {
  const sc = { ...minimalPkg().scenarios[0], behaviorRefs: ['BHV-TST-X'], exclusionRefs: ['RULE-TST-E1'], scoreRefs: ['RULE-TST-S1'] }
  const a = mkWorkspaceWithPkg({ scenarios: [sc] })
  try {
    derivePackage(a.dir)
    const doc = loadYaml(readFileSync(join(a.dir, 'derived/scenario-orchestration.yaml'), 'utf8'))
    assert.deepEqual(doc.scenarios[0].behaviorRefs, ['BHV-TST-X'])
    assert.deepEqual(doc.scenarios[0].exclusionRefs, ['RULE-TST-E1'])
    assert.deepEqual(doc.scenarios[0].scoreRefs, ['RULE-TST-S1'])
  } finally {
    rmWorkspace(a.root)
  }
  const b = mkWorkspaceWithPkg()
  try {
    derivePackage(b.dir)
    const doc = loadYaml(readFileSync(join(b.dir, 'derived/scenario-orchestration.yaml'), 'utf8'))
    assert.ok(!('behaviorRefs' in doc.scenarios[0]), '缺省不落键（向后兼容）')
    assert.ok(!('exclusionRefs' in doc.scenarios[0]))
    assert.ok(!('scoreRefs' in doc.scenarios[0]))
  } finally {
    rmWorkspace(b.root)
  }
})
