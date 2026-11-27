/** 审计包导出签名接线验收（signed-delivery S2.4）：env 配置自动带签 / 未配置保持未签。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PackageWorkspace,
  buildRunRecord,
  generateTrustKeyPair,
  saveRunRecord,
  verifyAuditPackage,
} from '@dsh-onto/core'
import { exportRunAuditPackage } from '../dist/review-decision.js'

function fakeResult() {
  return {
    scenarioId: 'SCN-TST-1',
    runId: 'run-abc12345',
    startedAt: '2026-11-05T00:00:00.000Z',
    candidates: [],
    excluded: [],
    humanReviewRequired: true,
    reviewGate: { threshold: 0.75, required: true, requireReviewFor: [] },
    ruleHitLog: [],
    audit: { checks: [], forbiddenPhraseHits: [], passed: true },
  }
}

function fakeDataset() {
  return {
    objects: [{ id: 'OBJ-TST-A:1', type: 'OBJ-TST-A', attrs: {} }],
    relations: [],
    candidates: [],
    provenance: 'connector',
  }
}

function mkRun() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-onto-sign-'))
  const ws = new PackageWorkspace(root)
  const rec = buildRunRecord({
    package: { name: 'test-pkg', version: '1.0.0' },
    dataset: fakeDataset(),
    result: fakeResult(),
    redlines: [],
    savedAt: '2026-11-05T01:00:00.000Z',
    mappingEvidence: { mappingApplied: true },
  })
  saveRunRecord(root, rec)
  return { root }
}

test('exportRunAuditPackage：env 配置签名密钥 → 自动带签且离线验签通过', () => {
  const { root } = mkRun()
  const keyDir = mkdtempSync(join(tmpdir(), 'dsh-onto-key-'))
  try {
    const keys = generateTrustKeyPair({ keyId: 'key-envauto1' })
    const keyFile = join(keyDir, 'key.pem')
    writeFileSync(keyFile, keys.privateKeyPem, 'utf8')
    process.env.DSH_ONTO_SIGN_KEY_FILE = keyFile
    process.env.DSH_ONTO_SIGN_KEY_ID = 'key-envauto1'
    const out = exportRunAuditPackage(root, 'run-abc12345')
    assert.equal(out.signed, true)
    assert.equal(out.signatureLocator, 'runs/exports/run-abc12345-manifest.sig.json')
    const result = verifyAuditPackage(join(root, 'runs', 'exports'), keys.trustRoot)
    assert.equal(result.ok, true, JSON.stringify(result.checks))
  } finally {
    delete process.env.DSH_ONTO_SIGN_KEY_FILE
    delete process.env.DSH_ONTO_SIGN_KEY_ID
    rmSync(root, { recursive: true, force: true })
    rmSync(keyDir, { recursive: true, force: true })
  }
})

test('exportRunAuditPackage：env 半配置（只给其一）→ fail-loud 不静默降级', () => {
  const { root } = mkRun()
  try {
    process.env.DSH_ONTO_SIGN_KEY_FILE = 'x.pem'
    delete process.env.DSH_ONTO_SIGN_KEY_ID
    assert.throws(() => exportRunAuditPackage(root, 'run-abc12345'), (e) => e.code === 'INVALID_ARGS')
    delete process.env.DSH_ONTO_SIGN_KEY_FILE
    process.env.DSH_ONTO_SIGN_KEY_ID = 'key-x'
    assert.throws(() => exportRunAuditPackage(root, 'run-abc12345'), (e) => e.code === 'INVALID_ARGS')
  } finally {
    delete process.env.DSH_ONTO_SIGN_KEY_FILE
    delete process.env.DSH_ONTO_SIGN_KEY_ID
    rmSync(root, { recursive: true, force: true })
  }
})

test('exportRunAuditPackage：未配置 env → 未签（P1a 口径，signed=false）', () => {
  const { root } = mkRun()
  try {
    delete process.env.DSH_ONTO_SIGN_KEY_FILE
    delete process.env.DSH_ONTO_SIGN_KEY_ID
    const out = exportRunAuditPackage(root, 'run-abc12345')
    assert.equal(out.signed, false)
    assert.equal(out.signatureLocator, undefined)
    const manifest = JSON.parse(
      readFileSync(join(root, 'runs', 'exports', 'run-abc12345-manifest.json'), 'utf8'),
    )
    assert.equal(manifest.signature, undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
