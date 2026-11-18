/**
 * M1-B 正式取数通道验收：DataSnapshot 来源证据 / 未登记源拒绝 / 伪造来源拒绝 /
 * 完整性·时效进入 dataBasis / 快照受控存储 + 摘要防换。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DataSourceRegistry, loadSnapshot } from '../dist/data-sources.js'

function mkRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-onto-snap-'))
}

/** 模拟连接器（F1 口径：nature 显式 simulated）。 */
function mockConnector(over = {}) {
  return {
    version: 'mock-1.0',
    nature: 'simulated',
    async fetch(query, scope) {
      return {
        dataset: {
          objects: [{ id: 'A1', type: 'OBJ-TST-A', attrs: { a1: 'x' } }],
          relations: [],
          candidates: [{ candidateId: 'C1', objectRef: 'A1', features: { f1: 1 }, tags: [] }],
        },
        complete: true,
        businessWindow: { from: '2026-11-01T00:00:00Z', to: '2026-11-15T00:00:00Z' },
        ...over,
      }
    },
  }
}

const NOW = () => new Date('2026-11-16T00:00:00Z')

test('B2-1 正式取数：登记连接器 → snapshot + dataBasis + provenance=connector', async () => {
  const root = mkRoot()
  const reg = new DataSourceRegistry()
  reg.register('SRC-TST-1', mockConnector())
  try {
    const res = await reg.fetch({
      sourceId: 'SRC-TST-1',
      query: { objectTypes: ['OBJ-TST-A'] },
      tenant: 'tenant-a',
      root,
      now: NOW,
    })
    assert.equal(res.dataset.provenance, 'connector')
    assert.equal(res.snapshot.sourceId, 'SRC-TST-1')
    assert.equal(res.snapshot.connectorVersion, 'mock-1.0')
    assert.equal(res.snapshot.tenant, 'tenant-a')
    assert.equal(res.snapshot.nature, 'simulated', '模拟来源显式标注')
    assert.equal(res.snapshot.completeness.complete, true)
    assert.equal(res.dataBasis.complete, true)
    assert.equal(res.dataBasis.fresh, true, '窗尾 2026-11-15 距取数 2026-11-16 未超 72h')
    assert.equal(res.dataBasis.snapshotId, res.snapshot.snapshotId)
    // 快照落受控存储
    const file = join(root, 'snapshots', `${res.snapshot.snapshotId}.json`)
    assert.ok(existsSync(file), '快照落 snapshots/')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('B2-2 未登记 sourceId 拒绝（deny-by-default，不回退内联）', async () => {
  const root = mkRoot()
  const reg = new DataSourceRegistry()
  try {
    await assert.rejects(
      () => reg.fetch({ sourceId: 'SRC-NOPE', query: {}, tenant: 't', root, now: NOW }),
      (e) => e.code === 'INVALID_ARGS' && /未登记/.test(e.message),
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('B2-3 完整性/时效进入 dataBasis：截断 → complete=false；超时效 → fresh=false', async () => {
  const root = mkRoot()
  const reg = new DataSourceRegistry()
  reg.register('SRC-CUT', mockConnector({ complete: false, truncatedReason: '分页未走完', paged: true }))
  reg.register('SRC-OLD', mockConnector({
    businessWindow: { from: '2026-01-01T00:00:00Z', to: '2026-01-31T00:00:00Z' },
  }))
  try {
    const cut = await reg.fetch({ sourceId: 'SRC-CUT', query: {}, tenant: 't', root, now: NOW })
    assert.equal(cut.dataBasis.complete, false)
    assert.equal(cut.snapshot.completeness.truncatedReason, '分页未走完')
    const old = await reg.fetch({ sourceId: 'SRC-OLD', query: {}, tenant: 't', root, now: NOW })
    assert.equal(old.dataBasis.fresh, false, '窗尾 2026-01-31 距取数 2026-11-16 超 72h')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('B2-4 快照回查：locator 摘要不符（内容被改）拒绝；正常回查一致', async () => {
  const root = mkRoot()
  const reg = new DataSourceRegistry()
  reg.register('SRC-TST-1', mockConnector())
  try {
    const res = await reg.fetch({ sourceId: 'SRC-TST-1', query: {}, tenant: 't', root, now: NOW })
    const back = loadSnapshot(root, res.snapshot.snapshotId)
    assert.equal(back.snapshot.snapshotId, res.snapshot.snapshotId)
    assert.equal(back.dataset.objects.length, 1)
    // 篡改快照内容
    const file = join(root, 'snapshots', `${res.snapshot.snapshotId}.json`)
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    doc.dataset.objects[0].attrs.a1 = 'TAMPERED'
    writeFileSync(file, JSON.stringify(doc, null, 2), 'utf8')
    assert.throws(
      () => loadSnapshot(root, res.snapshot.snapshotId),
      (e) => /摘要不符/.test(e.message),
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('B2-5 查询摘要入快照：同查询同 queryDigest，不同查询不同', async () => {
  const root = mkRoot()
  const reg = new DataSourceRegistry()
  reg.register('SRC-TST-1', mockConnector())
  try {
    const a = await reg.fetch({ sourceId: 'SRC-TST-1', query: { objectTypes: ['OBJ-TST-A'] }, tenant: 't', root, now: NOW })
    const b = await reg.fetch({ sourceId: 'SRC-TST-1', query: { objectTypes: ['OBJ-TST-A'] }, tenant: 't', root, now: NOW })
    const c = await reg.fetch({ sourceId: 'SRC-TST-1', query: { objectTypes: ['OBJ-TST-B'] }, tenant: 't', root, now: NOW })
    assert.equal(a.snapshot.queryDigest, b.snapshot.queryDigest, '键序无关同摘要')
    assert.notEqual(a.snapshot.queryDigest, c.snapshot.queryDigest)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('B2-6 重复登记拒绝（不覆盖）；注销后可重登', () => {
  const reg = new DataSourceRegistry()
  reg.register('SRC-TST-1', mockConnector())
  assert.throws(() => reg.register('SRC-TST-1', mockConnector()), (e) => /已登记/.test(e.message))
  reg.unregister('SRC-TST-1')
  reg.register('SRC-TST-1', mockConnector())
  assert.equal(reg.has('SRC-TST-1'), true)
})
