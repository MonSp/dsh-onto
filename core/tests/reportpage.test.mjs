/** report-page 存储（spec chat-run-report S2.7）：围栏、surface 闸、损坏容错、列表排序。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildDefaultReportSurface,
  isSafePageId,
  listReportPages,
  loadReportPage,
  saveReportPage,
} from '../dist/index.js'

function runRef(runId = 'run-abc12345') {
  return {
    runId,
    package: { name: 'wst-ops', version: '1.0.0' },
    scenarioId: 'SCN-WST-HAZARD-MIX',
    startedAt: '2026-11-22T00:00:00.000Z',
    savedAt: '2026-11-22T00:01:00.000Z',
  }
}

function mkRoot() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-onto-reportpage-'))
  mkdirSync(join(root, 'reports'), { recursive: true })
  return root
}

test('save/load：surface 过闸保存并回读', () => {
  const root = mkRoot()
  try {
    const page = {
      pageId: 'rp-test00000001',
      name: '异常候选报表',
      surface: buildDefaultReportSurface({ surfaceId: 's1' }),
      createdFrom: runRef(),
      savedAt: '2026-11-22T00:02:00.000Z',
      accessBinding: 'abc',
    }
    const file = saveReportPage(root, page)
    assert.ok(file.includes('reports'))
    const back = loadReportPage(root, 'rp-test00000001')
    assert.equal(back.name, '异常候选报表')
    assert.equal(back.accessBinding, 'abc')
    assert.equal(back.surface.surfaceId, 's1')
    assert.equal(back.createdFrom.package.name, 'wst-ops')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('surface 闸：数据槽位字面量拒存', () => {
  const root = mkRoot()
  try {
    const bad = buildDefaultReportSurface()
    bad.root = { id: 'cheat', type: 'Stat', props: { label: 'x', value: 0.01 } }
    assert.throws(
      () =>
        saveReportPage(root, {
          pageId: 'rp-bad000000001',
          name: 'bad',
          surface: bad,
          createdFrom: runRef(),
          savedAt: '2026-11-22T00:02:00.000Z',
        }),
      (e) => e.code === 'INVALID_ARGS' && /surface/.test(e.message),
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('围栏：非法 pageId 与缺失/损坏容错', () => {
  const root = mkRoot()
  try {
    assert.equal(isSafePageId('rp-ok'), true)
    assert.equal(isSafePageId('../x'), false)
    assert.equal(isSafePageId(''), false)
    assert.equal(isSafePageId('a/b'), false)
    for (const bad of ['../x', '', 'a/b', 'C:x']) {
      assert.throws(
        () =>
          saveReportPage(root, {
            pageId: bad,
            name: 'n',
            surface: buildDefaultReportSurface(),
            createdFrom: runRef(),
            savedAt: '2026-11-22T00:02:00.000Z',
          }),
        (e) => e.code === 'INVALID_ARGS',
      )
    }
    assert.throws(() => loadReportPage(root, 'rp-missing0000'), (e) => e.code === 'NOT_FOUND')
    assert.throws(() => loadReportPage(root, '../x'), (e) => e.code === 'INVALID_ARGS')
    writeFileSync(join(root, 'reports', 'rp-corrupt0000.json'), '{ not json', 'utf8')
    assert.throws(() => loadReportPage(root, 'rp-corrupt0000'), (e) => e.code === 'PACKAGE_MALFORMED')
    // 列表跳过损坏条目
    saveReportPage(root, {
      pageId: 'rp-good00000001',
      name: 'good',
      surface: buildDefaultReportSurface(),
      createdFrom: runRef(),
      savedAt: '2026-11-22T00:03:00.000Z',
    })
    const pages = listReportPages(root)
    assert.equal(pages.length, 1)
    assert.equal(pages[0].pageId, 'rp-good00000001')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('列表按 savedAt 倒序', () => {
  const root = mkRoot()
  try {
    for (const [id, at] of [['rp-a00000000001', '2026-11-22T00:01:00.000Z'], ['rp-b00000000002', '2026-11-22T00:05:00.000Z']]) {
      saveReportPage(root, {
        pageId: id,
        name: id,
        surface: buildDefaultReportSurface(),
        createdFrom: runRef(),
        savedAt: at,
      })
    }
    assert.deepEqual(listReportPages(root).map((p) => p.pageId), ['rp-b00000000002', 'rp-a00000000001'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('读盘闸：手改 surface 的报表页拒载、列表跳过', () => {
  const root = mkRoot()
  try {
    saveReportPage(root, {
      pageId: 'rp-tamper000001',
      name: 'x',
      surface: buildDefaultReportSurface(),
      createdFrom: runRef(),
      savedAt: '2026-11-22T00:02:00.000Z',
    })
    const file = join(root, 'reports', 'rp-tamper000001.json')
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    raw.surface.root = { id: 'cheat', type: 'Stat', props: { label: 'x', value: 0.01 } }
    writeFileSync(file, JSON.stringify(raw), 'utf8')
    assert.throws(() => loadReportPage(root, 'rp-tamper000001'), (e) => e.code === 'PACKAGE_MALFORMED')
    assert.equal(listReportPages(root).length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('读盘闸：内嵌 pageId 与文件名不符拒载', () => {
  const root = mkRoot()
  try {
    saveReportPage(root, {
      pageId: 'rp-mismatch0001',
      name: 'x',
      surface: buildDefaultReportSurface(),
      createdFrom: runRef(),
      savedAt: '2026-11-22T00:02:00.000Z',
    })
    const file = join(root, 'reports', 'rp-mismatch0001.json')
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    raw.pageId = 'rp-evil00000001'
    writeFileSync(file, JSON.stringify(raw), 'utf8')
    assert.throws(() => loadReportPage(root, 'rp-mismatch0001'), (e) => e.code === 'PACKAGE_MALFORMED')
    assert.equal(listReportPages(root).length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
