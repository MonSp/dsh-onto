/** 信任根与离线验签验收（spec signed-delivery S2.1–S2.3）：keygen/sign/verify + 吊销 fail-closed。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildRunRecord,
  exportAuditPackage,
  generateTrustKeyPair,
  isRevoked,
  saveRunRecord,
  signAuditPackage,
  signManifest,
  verifyAuditPackage,
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
    ruleHitLog: [{ ruleId: 'RULE-TST-S1', candidateId: 'CAND-001', score: 0.5, ts: 't' }],
    audit: { checks: [], forbiddenPhraseHits: [], passed: true },
    ...overrides,
  }
}

function fakeDataset() {
  return {
    objects: [{ id: 'OBJ-TST-A:1', type: 'OBJ-TST-A', attrs: {} }],
    relations: [],
    candidates: [{ candidateId: 'CAND-001', objectRef: 'OBJ-TST-A:1', features: { f1: 1 }, tags: [] }],
    provenance: 'file',
  }
}

function mkSignedPackage() {
  const ws = mkWorkspace()
  const rec = buildRunRecord({
    package: { name: 'test-pkg', version: '1.0.0' },
    dataset: fakeDataset(),
    result: fakeResult(),
    redlines: [],
    savedAt: '2026-11-05T01:00:00.000Z',
  })
  saveRunRecord(ws.root, rec)
  const out = exportAuditPackage(ws.root, 'run-abc12345', {
    chain: {
      decisions: [{
        decisionId: 'dec-1',
        runId: 'run-abc12345',
        decision: 'approved',
        reviewer: 'host:alice',
        ruleFingerprint: 'x'.repeat(64),
        snapshotDigest: 'y'.repeat(64),
      }],
      proposals: [],
      actions: [],
    },
  })
  const keys = generateTrustKeyPair({ keyId: 'key-test01' })
  const dir = join(ws.root, 'runs', 'exports')
  const signed = signAuditPackage(dir, 'run-abc12345', {
    privateKeyPem: keys.privateKeyPem,
    keyId: keys.keyId,
  })
  return { ws, dir, out, keys, signed }
}

test('trust keygen：Ed25519 密钥对 + 信任根文档（公钥可发布、私钥不入根）', () => {
  const gen = generateTrustKeyPair({ keyId: 'key-abc123', publishedBy: 'test-channel' })
  assert.equal(gen.keyId, 'key-abc123')
  assert.ok(gen.privateKeyPem.includes('PRIVATE KEY'))
  assert.ok(gen.publicKeyPem.includes('PUBLIC KEY'))
  assert.equal(gen.trustRoot.kind, 'TrustRoot')
  assert.equal(gen.trustRoot.publishedBy, 'test-channel')
  assert.equal(gen.trustRoot.keys.length, 1)
  assert.equal(gen.trustRoot.keys[0].status, 'active')
  assert.ok(!JSON.stringify(gen.trustRoot).includes('PRIVATE'), '信任根不得含私钥')
  assert.throws(() => generateTrustKeyPair({ keyId: '../evil' }), (e) => e.code === 'INVALID_ARGS')
})

test('签名往返：signAuditPackage 后离线验签全链 ok（含人审覆盖与指纹重算）', () => {
  const { ws, dir, keys } = mkSignedPackage()
  try {
    const result = verifyAuditPackage(dir, keys.trustRoot)
    assert.equal(result.ok, true, JSON.stringify(result.checks))
    assert.equal(result.keyId, 'key-test01')
    const names = result.checks.map((c) => c.name)
    for (const n of [
      'manifest-present', 'manifest-shape', 'signature-present', 'sig-meta-consistent', 'signed-sha256',
      'key-trusted', 'signature-valid', 'members-intact', 'no-unlisted-members',
      'human-decision-covered', 'rule-fingerprint-recompute',
    ]) {
      assert.ok(names.includes(n), `缺检查行 ${n}`)
      assert.equal(result.checks.find((c) => c.name === n)?.ok, true, `${n} 未过`)
    }
    // manifest.signature 标记 + signed 可验模板
    const manifest = JSON.parse(readFileSync(join(dir, 'run-abc12345-manifest.json'), 'utf8'))
    assert.equal(manifest.signature.keyId, 'key-test01')
    assert.equal(manifest.signature.file, 'run-abc12345-manifest.sig.json')
    assert.ok(manifest.verifiability.canVerify.some((s) => s.includes('Ed25519')))
    assert.ok(!manifest.verifiability.cannotVerify.some((s) => s.includes('无平台签名')))
  } finally {
    rmWorkspace(ws.root)
  }
})

test('篡改检测：manifest 被改 / 成员被改 / 签名块被改 → 验签拒', () => {
  // manifest 篡改
  {
    const { ws, dir, keys } = mkSignedPackage()
    try {
      const p = join(dir, 'run-abc12345-manifest.json')
      const m = JSON.parse(readFileSync(p, 'utf8'))
      m.scenarioId = 'SCN-EVIL'
      writeFileSync(p, JSON.stringify(m, null, 2), 'utf8')
      const result = verifyAuditPackage(dir, keys.trustRoot)
      assert.equal(result.ok, false)
      assert.equal(result.checks.find((c) => c.name === 'signed-sha256')?.ok, false)
    } finally {
      rmWorkspace(ws.root)
    }
  }
  // 成员篡改（run 归档被改，sha256 不符）
  {
    const { ws, dir, keys } = mkSignedPackage()
    try {
      const p = join(dir, 'run-abc12345.json')
      const run = JSON.parse(readFileSync(p, 'utf8'))
      run.datasetDigest = '0'.repeat(64)
      writeFileSync(p, JSON.stringify(run, null, 2), 'utf8')
      const result = verifyAuditPackage(dir, keys.trustRoot)
      assert.equal(result.ok, false)
      assert.equal(result.checks.find((c) => c.name === 'members-intact')?.ok, false)
    } finally {
      rmWorkspace(ws.root)
    }
  }
  // 签名块篡改（sig 值被换）
  {
    const { ws, dir, keys } = mkSignedPackage()
    try {
      const p = join(dir, 'run-abc12345-manifest.sig.json')
      const sig = JSON.parse(readFileSync(p, 'utf8'))
      sig.sig = Buffer.from('fake').toString('base64')
      writeFileSync(p, JSON.stringify(sig, null, 2), 'utf8')
      const result = verifyAuditPackage(dir, keys.trustRoot)
      assert.equal(result.ok, false)
      assert.equal(result.checks.find((c) => c.name === 'signature-valid')?.ok, false)
    } finally {
      rmWorkspace(ws.root)
    }
  }
})

test('吊销 fail-closed：revoked keyId 签的包拒（status 与 revoked 列表并集）', () => {
  const { ws, dir, keys } = mkSignedPackage()
  try {
    const revokedByList = { ...keys.trustRoot, revoked: ['key-test01'] }
    assert.equal(isRevoked(revokedByList, 'key-test01'), true)
    const r1 = verifyAuditPackage(dir, revokedByList)
    assert.equal(r1.ok, false)
    assert.equal(r1.checks.find((c) => c.name === 'key-trusted')?.ok, false)
    const revokedByStatus = {
      ...keys.trustRoot,
      keys: [{ ...keys.trustRoot.keys[0], status: 'revoked' }],
    }
    assert.equal(isRevoked(revokedByStatus, 'key-test01'), true)
    const r2 = verifyAuditPackage(dir, revokedByStatus)
    assert.equal(r2.ok, false)
    // retired 不影响历史验签
    const retired = {
      ...keys.trustRoot,
      keys: [{ ...keys.trustRoot.keys[0], status: 'retired' }],
    }
    assert.equal(isRevoked(retired, 'key-test01'), false)
    assert.equal(verifyAuditPackage(dir, retired).ok, true)
  } finally {
    rmWorkspace(ws.root)
  }
})

test('错钥拒签：非信任根公钥验不过；未知 keyId 不在信任根 → 拒', () => {
  const { ws, dir, keys } = mkSignedPackage()
  try {
    const other = generateTrustKeyPair({ keyId: 'key-test01' }) // 同 keyId 异密钥
    const r1 = verifyAuditPackage(dir, other.trustRoot)
    assert.equal(r1.ok, false)
    assert.equal(r1.checks.find((c) => c.name === 'signature-valid')?.ok, false)
    const unknown = generateTrustKeyPair({ keyId: 'key-zzzzzzzz' })
    const r2 = verifyAuditPackage(dir, unknown.trustRoot)
    assert.equal(r2.ok, false)
    assert.equal(r2.checks.find((c) => c.name === 'key-trusted')?.ok, false)
  } finally {
    rmWorkspace(ws.root)
  }
})

test('未签包：显式 unsigned 行（P1a 可复核口径），members-intact 仍可复验', () => {
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
    const keys = generateTrustKeyPair()
    const result = verifyAuditPackage(join(ws.root, 'runs', 'exports'), keys.trustRoot)
    assert.equal(result.ok, false)
    const sig = result.checks.find((c) => c.name === 'signature-present')
    assert.equal(sig?.ok, false)
    assert.ok(sig?.detail.includes('未签包'))
    assert.equal(result.checks.find((c) => c.name === 'members-intact')?.ok, true)
  } finally {
    rmWorkspace(ws.root)
  }
})

test('未签→已签升级：verifiability 切 signed 模板；升级后离线验签全过', () => {
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
    const dir = join(ws.root, 'runs', 'exports')
    const before = JSON.parse(readFileSync(join(dir, 'run-abc12345-manifest.json'), 'utf8'))
    assert.ok(before.verifiability.cannotVerify.some((s) => s.includes('无平台签名')))
    assert.equal(before.signature, undefined)
    const keys = generateTrustKeyPair({ keyId: 'key-upgrade1' })
    signAuditPackage(dir, 'run-abc12345', { privateKeyPem: keys.privateKeyPem, keyId: 'key-upgrade1' })
    const after = JSON.parse(readFileSync(join(dir, 'run-abc12345-manifest.json'), 'utf8'))
    assert.ok(after.verifiability.canVerify.some((s) => s.includes('Ed25519')))
    assert.ok(!after.verifiability.cannotVerify.some((s) => s.includes('无平台签名')))
    assert.equal(after.signature.keyId, 'key-upgrade1')
    assert.equal(verifyAuditPackage(dir, keys.trustRoot).ok, true)
  } finally {
    rmWorkspace(ws.root)
  }
})

test('游离未登记成员拒（no-unlisted-members，本包 runId 前缀内）', () => {
  const { ws, dir, keys } = mkSignedPackage()
  try {
    // 本包前缀内游离文件（如伪造的 <runId>-chain 备份）→ 拒
    writeFileSync(join(dir, 'run-abc12345-stale.json'), '{"x":1}', 'utf8')
    const result = verifyAuditPackage(dir, keys.trustRoot)
    assert.equal(result.ok, false)
    const row = result.checks.find((c) => c.name === 'no-unlisted-members')
    assert.equal(row?.ok, false)
    assert.ok(row?.detail.includes('run-abc12345-stale.json'))
    // 非本包前缀文件（多包目录兄弟文件）不属本包清单——不影响本包验签
    writeFileSync(join(dir, 'other-notes.txt'), 'x', 'utf8')
    rmSync(join(dir, 'run-abc12345-stale.json'))
    const result2 = verifyAuditPackage(dir, keys.trustRoot)
    assert.equal(result2.checks.find((c) => c.name === 'no-unlisted-members')?.ok, true)
  } finally {
    rmWorkspace(ws.root)
  }
})

test('多包导出目录：未指定 runId 给歧义说明；指定 runId 精确验单包', () => {
  const { ws, dir, keys } = mkSignedPackage()
  try {
    // 再造第二份 manifest（伪造另一包的导出物）
    writeFileSync(join(dir, 'run-zzzzzzzz-manifest.json'), '{"kind":"RunExportManifest","runId":"run-zzzzzzzz","files":[],"fingerprints":{"ruleFingerprint":"x","datasetDigest":"y"},"humanReviewRequired":true}', 'utf8')
    const vague = verifyAuditPackage(dir, keys.trustRoot)
    assert.equal(vague.ok, false)
    assert.ok(vague.checks[0].detail.includes('2 份 manifest'))
    assert.ok(vague.checks[0].detail.includes('指定 runId'))
    const precise = verifyAuditPackage(dir, keys.trustRoot, { runId: 'run-abc12345' })
    assert.equal(precise.ok, true, JSON.stringify(precise.checks))
    const missing = verifyAuditPackage(dir, keys.trustRoot, { runId: 'run-none000' })
    assert.equal(missing.ok, false)
    assert.ok(missing.checks[0].detail.includes('run-none000-manifest.json'))
  } finally {
    rmWorkspace(ws.root)
  }
})

test('坏形 manifest 出检查行不裸抛（manifest-shape）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-onto-badman-'))
  try {
    writeFileSync(join(dir, 'run-abc12345-manifest.json'), '{"kind":"RunExportManifest"}', 'utf8')
    const keys = generateTrustKeyPair()
    const result = verifyAuditPackage(dir, keys.trustRoot)
    assert.equal(result.ok, false)
    const row = result.checks.find((c) => c.name === 'manifest-shape')
    assert.equal(row?.ok, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('signManifest：签名块字段完整；改 signedFile 参数可控', () => {
  const keys = generateTrustKeyPair({ keyId: 'key-f0000001' })
  const bytes = Buffer.from('{"hello":"world"}\n', 'utf8')
  const sig = signManifest(bytes, keys.privateKeyPem, 'key-f0000001', { signedFile: 'm.json' })
  assert.equal(sig.kind, 'ManifestSignature')
  assert.equal(sig.signedFile, 'm.json')
  assert.equal(sig.alg, 'ed25519')
  assert.equal(sig.keyId, 'key-f0000001')
  assert.equal(typeof sig.signedSha256, 'string')
  assert.equal(sig.signedSha256.length, 64)
  assert.ok(sig.sig.length > 0)
  assert.throws(() => signManifest(bytes, 'not-a-pem', 'key-f0000001'), (e) => e.code === 'INVALID_ARGS')
  assert.throws(() => signManifest(bytes, keys.privateKeyPem, '../evil'), (e) => e.code === 'INVALID_ARGS')
})
