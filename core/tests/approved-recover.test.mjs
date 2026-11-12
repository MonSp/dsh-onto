/**
 * 已批未写（approved 未 materialize）恢复路径：
 * - reject 允许 approved → rejected（不卡 CANDIDATE_FINALIZED）
 * - merge 仍仅 pending
 * - approve 仍仅 pending（幂等跳过在 apply_draft 工具层）
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { KnowledgeStore } from '../dist/knowledge.js'

function mkStore() {
  const root = mkdtempSync(join(tmpdir(), 'onto-approved-reject-'))
  const store = new KnowledgeStore(root)
  return { root, store }
}

function rm(root) {
  rmSync(root, { recursive: true, force: true })
}

function addDict(store, packageId, id, name) {
  return store.addDraft({
    packageId,
    item: {
      layer: 'O1',
      targetKind: 'Dictionary',
      name,
      payload: { id, name, values: ['x'] },
      confidence: 0.9,
      rationale: 't',
    },
    provenance: { turnId: 't-rec' },
  })
}

test('reject：approved（已批未物化）可驳回——中断残留恢复路径', () => {
  const { root, store } = mkStore()
  try {
    const c = addDict(store, 'pkg-r', 'dict-r-a', '字典甲')
    store.reviewCandidate(c.id, 'approve', { reviewedBy: 'workbench' })
    assert.equal(store.getCandidate(c.id).status, 'approved')
    const done = store.reviewCandidate(c.id, 'reject', { reviewedBy: 'agent-tool' })
    assert.equal(done.status, 'rejected')
    assert.equal(done.reviewedBy, 'agent-tool')
    // 驳回覆盖 reviewedBy 前，原批准留痕挪到 approvedBy/approvedAt
    assert.equal(done.approvedBy, 'workbench')
    assert.ok(typeof done.approvedAt === 'string' && done.approvedAt !== '', 'approvedAt 有值')
    const again = store.reviewCandidate(c.id, 'reject')
    assert.equal(again.status, 'rejected')
    assert.equal(again.approvedBy, 'workbench', '幂等 reject 不丢批准留痕')
  } finally {
    rm(root)
  }
})

test('approve：已 approved 再 approve → CANDIDATE_FINALIZED（工具层负责跳过）', () => {
  const { root, store } = mkStore()
  try {
    const c = addDict(store, 'pkg-r2', 'dict-r-b', '字典乙')
    store.reviewCandidate(c.id, 'approve')
    assert.throws(
      () => store.reviewCandidate(c.id, 'approve'),
      (e) => e.code === 'CANDIDATE_FINALIZED' && /already approved/.test(e.message),
    )
  } finally {
    rm(root)
  }
})

test('merge：仅 pending 可 merge；approved 拒', () => {
  const { root, store } = mkStore()
  try {
    const c = addDict(store, 'pkg-r3', 'dict-r-c', '字典丙')
    store.reviewCandidate(c.id, 'approve')
    assert.throws(
      () => store.reviewCandidate(c.id, 'merge', { mergeIntoName: 'other' }),
      (e) => e.code === 'CANDIDATE_FINALIZED',
    )
  } finally {
    rm(root)
  }
})
