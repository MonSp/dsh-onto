/** 审计包验收（spec audit-package S2.1–S2.3）：映射校验回执 + 统一导出 + 包清单指纹。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildRunRecord,
  exportAuditPackage,
  loadRunRecord,
  ruleBasisDigest,
  saveRunRecord,
} from '../dist/index.js'
import { mkWorkspace, rmWorkspace } from './helpers.mjs'

function fakeResult(overrides = {}) {
  return {
    scenarioId: 'SCN-TST-1',
    runId: 'run-abc12345',
    startedAt: '2026-11-05T00:00:00.000Z',
    candidates: [
      {
        candidateId: 'CAND-001',
        objectRef: 'OBJ-TST-A:1',
        riskScore: 0.5,
        hitRuleIds: ['RULE-TST-S1'],
        evidenceChains: [{ ruleId: 'RULE-TST-S1', score: 0.5, evidence: '特征 f1 = 1' }],
        narrative: ['摘要：0.5'],
        pendingChecks: [],
        pendingVerification: false,
      },
    ],
    excluded: [],
    humanReviewRequired: true,
    reviewGate: { threshold: 0.75, required: true, requireReviewFor: [] },
    ruleHitLog: [
      { ruleId: 'RULE-TST-S1', candidateId: 'CAND-001', score: 0.5, ts: '2026-11-05T00:00:01.000Z' },
    ],
    audit: { checks: [], forbiddenPhraseHits: [], passed: true },
    ...overrides,
  }
}

function fakeDataset(provenance) {
  return {
    objects: [{ id: 'OBJ-TST-A:1', type: 'OBJ-TST-A', attrs: {} }],
    relations: [],
    behaviors: [],
    candidates: [
      { candidateId: 'CAND-001', objectRef: 'OBJ-TST-A:1', features: { f1: 1 }, tags: [] },
    ],
    ...(provenance === undefined ? {} : { provenance }),
  }
}

test('MappingReceipt：connector+证据 → mappingApplied:true 且诊断归并计数', () => {
  const rec = buildRunRecord({
    package: { name: 'test-pkg', version: '1.0.0' },
    dataset: fakeDataset('connector'),
    result: fakeResult(),
    redlines: [],
    savedAt: '2026-11-05T01:00:00.000Z',
    mappingEvidence: {
      mappingApplied: true,
      mapBasis: {
        package: { name: 'test-pkg', version: '1.0.0' },
        mapsDigest: 'aa'.repeat(32),
        sourceDigest: 'bb'.repeat(32),
      },
      sourceAnchor: {
        snapshotId: 'snap-12345678',
        sourceId: 'SRC-TST-1',
        queryDigest: 'cc'.repeat(32),
        connectorVersion: 'mapped-data-1.0.0',
        nature: 'simulated',
      },
      diagnostics: [
        { level: 'error', code: 'SM_FIELD_MISSING', message: 'x', where: '$' },
        { level: 'warn', code: 'SM_TYPE_MISMATCH', message: 'y', where: '$' },
        { level: 'warn', code: 'SM_TYPE_MISMATCH', message: 'z', where: '$' },
      ],
      businessWindow: { from: '2026-11-01', to: '2026-11-05' },
    },
  })
  const r = rec.mappingReceipt
  assert.ok(r !== undefined)
  assert.equal(r.receiptVersion, 1)
  assert.equal(r.provenance, 'connector')
  assert.equal(r.mappingApplied, true)
  assert.equal(r.mapBasis?.mapsDigest, 'aa'.repeat(32))
  assert.equal(r.mapBasis?.sourceDigest, 'bb'.repeat(32))
  assert.equal(r.sourceAnchor?.snapshotId, 'snap-12345678')
  assert.equal(r.diagnostics?.errors, 1)
  assert.equal(r.diagnostics?.warnings, 2)
  assert.deepEqual(
    r.diagnostics?.codes,
    [
      { code: 'SM_FIELD_MISSING', level: 'error', count: 1 },
      { code: 'SM_TYPE_MISMATCH', level: 'warn', count: 2 },
    ],
  )
  assert.deepEqual(r.counts, { objects: 1, relations: 0, behaviors: 0, candidates: 1 })
  assert.deepEqual(r.businessWindow, { from: '2026-11-01', to: '2026-11-05' })
  // 对账锚 === RunRecord.datasetDigest
  assert.equal(r.datasetDigest, rec.datasetDigest)
})

test('MappingReceipt：inline/file → mappingApplied:false（直入数据无映射环节）', () => {
  for (const prov of ['inline', 'file']) {
    const rec = buildRunRecord({
      package: { name: 'test-pkg', version: '1.0.0' },
      dataset: fakeDataset(prov),
      result: fakeResult(),
      redlines: [],
      savedAt: '2026-11-05T01:00:00.000Z',
    })
    const r = rec.mappingReceipt
    assert.ok(r !== undefined)
    assert.equal(r.provenance, prov)
    assert.equal(r.mappingApplied, false)
    assert.equal(r.diagnostics, undefined)
    assert.equal(r.datasetDigest, rec.datasetDigest)
  }
})

test('MappingReceipt：connector 无证据（手写连接器）→ mappingApplied:false 显式无回执', () => {
  const rec = buildRunRecord({
    package: { name: 'test-pkg', version: '1.0.0' },
    dataset: fakeDataset('connector'),
    result: fakeResult(),
    redlines: [],
    savedAt: '2026-11-05T01:00:00.000Z',
  })
  const r = rec.mappingReceipt
  assert.ok(r !== undefined)
  assert.equal(r.provenance, 'connector')
  assert.equal(r.mappingApplied, false)
})

test('MappingReceipt：未声明 provenance 且无证据 → 不落键（零回归）', () => {
  const rec = buildRunRecord({
    package: { name: 'test-pkg', version: '1.0.0' },
    dataset: fakeDataset(),
    result: fakeResult(),
    redlines: [],
    savedAt: '2026-11-05T01:00:00.000Z',
  })
  assert.equal('mappingReceipt' in rec, false)
})

test('ruleBasisDigest：同 run 同指纹；ruleHitLog 顺序无关', () => {
  const base = fakeResult()
  const shuffled = fakeResult({
    ruleHitLog: [
      { ruleId: 'RULE-TST-S2', candidateId: 'CAND-001', score: 0.3, ts: 'x' },
      { ruleId: 'RULE-TST-S1', candidateId: 'CAND-001', score: 0.5, ts: 'y' },
    ],
  })
  const sameOrder = fakeResult({
    ruleHitLog: [
      { ruleId: 'RULE-TST-S1', candidateId: 'CAND-001', score: 0.5, ts: 'y' },
      { ruleId: 'RULE-TST-S2', candidateId: 'CAND-001', score: 0.3, ts: 'x' },
    ],
  })
  const mk = (r) =>
    buildRunRecord({
      package: { name: 'test-pkg', version: '1.0.0' },
      dataset: fakeDataset(),
      result: r,
      redlines: [],
      savedAt: '2026-11-05T01:00:00.000Z',
    })
  assert.equal(ruleBasisDigest(mk(base)), ruleBasisDigest(mk(base)))
  assert.equal(ruleBasisDigest(mk(shuffled)), ruleBasisDigest(mk(sameOrder)))
  assert.notEqual(ruleBasisDigest(mk(base)), ruleBasisDigest(mk(shuffled)))
})

test('exportAuditPackage：四件套落盘 + manifest 逐文件 sha256 可复验', () => {
  const ws = mkWorkspace()
  try {
    const rec = buildRunRecord({
      package: { name: 'test-pkg', version: '1.0.0' },
      dataset: fakeDataset('connector'),
      result: fakeResult(),
      redlines: ['认定违规'],
      savedAt: '2026-11-05T01:00:00.000Z',
      mappingEvidence: {
        mappingApplied: true,
        mapBasis: { sourceDigest: 'bb'.repeat(32) },
      },
    })
    saveRunRecord(ws.root, rec)
    const out = exportAuditPackage(ws.root, 'run-abc12345', {
      chain: {
        decisions: [{ decisionId: 'dec-1', runId: 'run-abc12345', decision: 'approved' }],
        proposals: [],
        actions: [],
      },
    })
    assert.equal(out.locator, 'runs/exports/run-abc12345.json')
    assert.equal(out.reportLocator, 'runs/exports/run-abc12345-report.json')
    assert.equal(out.chainLocator, 'runs/exports/run-abc12345-chain.json')
    assert.equal(out.manifestLocator, 'runs/exports/run-abc12345-manifest.json')
    const dir = join(ws.root, 'runs', 'exports')
    for (const name of [
      'run-abc12345.json',
      'run-abc12345-report.json',
      'run-abc12345-chain.json',
      'run-abc12345-manifest.json',
    ]) {
      assert.ok(existsSync(join(dir, name)), `缺 ${name}`)
    }
    // manifest 逐文件 sha256 对照实文件字节
    const manifest = JSON.parse(readFileSync(join(dir, 'run-abc12345-manifest.json'), 'utf8'))
    assert.equal(manifest.kind, 'RunExportManifest')
    assert.equal(manifest.humanReviewRequired, true)
    assert.equal(manifest.files.length, 3) // run/report/chain——manifest 不自列
    for (const f of manifest.files) {
      const text = readFileSync(join(dir, f.name), 'utf8')
      assert.equal(f.sha256, createHash('sha256').update(text).digest('hex'), `${f.name} 指纹不符`)
      assert.equal(f.bytes, Buffer.byteLength(text, 'utf8'))
    }
    // 指纹面
    assert.equal(manifest.fingerprints.datasetDigest, rec.datasetDigest)
    assert.equal(manifest.fingerprints.ruleFingerprint, ruleBasisDigest(rec))
    assert.equal(manifest.fingerprints.mapSourceDigest, 'bb'.repeat(32))
    // 责任分层与可验边界（合同语言同构）
    assert.equal(manifest.responsibility.process.owner, 'platform')
    assert.equal(manifest.responsibility.determination.owner, 'human-reviewer')
    assert.equal(manifest.responsibility.data.owner, 'customer')
    assert.ok(manifest.verifiability.canVerify.length > 0)
    assert.ok(
      manifest.verifiability.cannotVerify.some((s) => s.includes('P1b')),
      '不可验清单须显式 P1b 边界',
    )
    // chain 文件含 runId + 治理链
    const chain = JSON.parse(readFileSync(join(dir, 'run-abc12345-chain.json'), 'utf8'))
    assert.equal(chain.runId, 'run-abc12345')
    assert.equal(chain.decisions.length, 1)
    // report 文件是 RunReport 投影
    const report = JSON.parse(readFileSync(join(dir, 'run-abc12345-report.json'), 'utf8'))
    assert.equal(report.runRef.runId, 'run-abc12345')
    assert.equal(report.summary.humanReviewRequired, true)
  } finally {
    rmWorkspace(ws.root)
  }
})

test('exportAuditPackage：无治理链数据源时 chain 缺席、manifest 如实登记两成员', () => {
  const ws = mkWorkspace()
  try {
    const rec = buildRunRecord({
      package: { name: 'test-pkg', version: '1.0.0' },
      dataset: fakeDataset(),
      result: fakeResult(),
      redlines: [],
      savedAt: '2026-11-05T01:00:00.000Z',
    })
    saveRunRecord(ws.root, rec)
    const out = exportAuditPackage(ws.root, 'run-abc12345')
    assert.equal(out.chainLocator, undefined)
    const manifest = JSON.parse(
      readFileSync(join(ws.root, 'runs', 'exports', 'run-abc12345-manifest.json'), 'utf8'),
    )
    assert.deepEqual(manifest.files.map((f) => f.name), ['run-abc12345.json', 'run-abc12345-report.json'])
  } finally {
    rmWorkspace(ws.root)
  }
})

test('exportAuditPackage：覆盖幂等 + runId 围栏 + 不存在 fail-loud', () => {
  const ws = mkWorkspace()
  try {
    const rec = buildRunRecord({
      package: { name: 'test-pkg', version: '1.0.0' },
      dataset: fakeDataset(),
      result: fakeResult(),
      redlines: [],
      savedAt: '2026-11-05T01:00:00.000Z',
    })
    saveRunRecord(ws.root, rec)
    exportAuditPackage(ws.root, 'run-abc12345')
    const again = exportAuditPackage(ws.root, 'run-abc12345')
    assert.equal(again.manifest.runId, 'run-abc12345')
    assert.throws(() => exportAuditPackage(ws.root, '../evil'), (e) => e.code === 'INVALID_ARGS')
    assert.throws(() => exportAuditPackage(ws.root, 'run-none000'), (e) => e.code === 'NOT_FOUND')
  } finally {
    rmWorkspace(ws.root)
  }
})
