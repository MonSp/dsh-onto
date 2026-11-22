/**
 * chat-run-report 工具面/投影面测试（spec chat-run-report S2.3/S2.4）：
 * 精简值无证据叙述、meta 只携引用、surface 校验闸、run→报表动线、wire 同源投影。
 * 不起 dsh host。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import {
  buildRunRecord,
  buildRunReport,
  buildDefaultReportSurface,
  derivePackage,
  loadReportPage,
  loadRunRecord,
  saveReportPage,
  saveRunRecord,
} from '@dsh-onto/core'
import { runtimeContextForHost, businessPolicy, dataSources, enableStrictReleaseMode, runAccessBinding, classifyToolCapability } from '@dsh-onto/runtime'
import {
  configurePhraseStore,
  rememberPhrases,
} from '../dist/agent-policy.js'
import {
  leanRunReport,
  projectRunReportMeta,
  renderRunReportText,
} from '../dist/agent-tools.js'
import { apply as applyTools } from '../dist/agent-tools.js'
import { OntoRuntime } from '../dist/services.js'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const identity = name => ({ userId: name, tenant: name, roles: ['analyst'], dataScope: { objectTypes: [] } })

function fakeResult(runId = 'run-rpt00001') {
  return {
    scenarioId: 'SCN-TST-1',
    runId,
    startedAt: '2026-11-22T00:00:00.000Z',
    candidates: [
      {
        candidateId: 'CAND-001',
        objectRef: 'OBJ-TST-A:1',
        riskScore: 0.5,
        hitRuleIds: ['RULE-TST-S1'],
        evidenceChains: [{ ruleId: 'RULE-TST-S1', score: 0.5, evidence: '证据文本 f1 = 1' }],
        narrative: ['叙述摘要 0.5'],
        pendingChecks: [{ note: '缺 fillLevel' }],
        pendingVerification: true,
      },
    ],
    excluded: [],
    humanReviewRequired: true,
    reviewGate: { threshold: 0.75, required: true, requireReviewFor: [] },
    ruleHitLog: [{ ruleId: 'RULE-TST-S1', candidateId: 'CAND-001', score: 0.5, ts: '2026-11-22T00:00:01Z' }],
    audit: {
      checks: [],
      forbiddenPhraseHits: [{ phrase: '认定违规', where: '$.candidates[0].narrative[0]' }],
      passed: true,
    },
  }
}

function fakeDataset() {
  return {
    objects: [{ id: 'OBJ-TST-A:1', type: 'OBJ-TST-A', attrs: {} }],
    relations: [],
    behaviors: [],
    candidates: [{ candidateId: 'CAND-001', objectRef: 'OBJ-TST-A:1', features: { f1: 1 }, tags: [] }],
  }
}

function reportOf() {
  const rec = buildRunRecord({
    package: { name: 'test-pkg', version: '1.0.0' },
    dataset: fakeDataset(),
    result: fakeResult(),
    redlines: ['认定违规'],
  })
  return buildRunReport(rec)
}

function walkKeys(v, out = new Set()) {
  if (v === null || typeof v !== 'object') return out
  if (Array.isArray(v)) {
    for (const x of v) walkKeys(x, out)
    return out
  }
  for (const [k, x] of Object.entries(v)) {
    out.add(k)
    walkKeys(x, out)
  }
  return out
}

test('leanRunReport：精简值无证据/叙述自由文本', () => {
  const value = leanRunReport(reportOf(), buildDefaultReportSurface(), 'default')
  const keys = walkKeys(value)
  assert.ok(!keys.has('evidenceChains'))
  assert.ok(!keys.has('narrative'))
  assert.ok(!keys.has('evidence'))
  assert.equal(value.summary.humanReviewRequired, true)
  assert.equal(value.humanReviewRequired, true)
  assert.equal(value.candidates[0].candidateId, 'CAND-001')
  assert.equal(value.candidates[0].pendingCheckCount, 1)
  assert.equal(value.surfaceSource, 'default')
  assert.equal(JSON.stringify(value).includes('证据文本'), false)
  assert.equal(JSON.stringify(value).includes('叙述摘要'), false)
})

test('renderRunReportText：回退文本可读且不回显短语', () => {
  const value = leanRunReport(reportOf(), buildDefaultReportSurface(), 'default')
  configurePhraseStore(null)
  rememberPhrases('run-rpt00001', ['认定违规'])
  const text = renderRunReportText(value)
  assert.ok(text.includes('run-rpt00001'))
  assert.ok(text.includes('CAND-001'))
  assert.ok(text.includes('humanReviewRequired=true'))
  assert.equal(text.includes('认定违规'), false)
  configurePhraseStore(null)
})

test('projectRunReportMeta：只携 runRef + 布局引用，无数值无短语', () => {
  const value = leanRunReport(reportOf(), buildDefaultReportSurface(), 'default')
  rememberPhrases('run-rpt00001', ['认定违规'])
  const meta = projectRunReportMeta(value)
  assert.deepEqual(Object.keys(meta).sort(), ['runRef', 'surface', 'surfaceSource'])
  const keys = walkKeys(meta)
  assert.ok(!keys.has('riskScore'))
  assert.ok(!keys.has('evidence'))
  assert.ok(!keys.has('maxRiskScore'))
  assert.equal(meta.runRef.runId, 'run-rpt00001')
  assert.equal(meta.surface.catalogId, 'dsh-onto/report/v1')
  assert.equal(JSON.stringify(meta).includes('认定违规'), false)
  configurePhraseStore(null)
})

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'onto-rpt-'))
  const versionDir = join(dir, 'dsh-onto', 'workspace', 'packages', 'aml-analysis', '1.0.0')
  mkdirSync(join(versionDir, '..'), { recursive: true })
  cpSync(join(repo, 'packages', 'aml', '1.0.0'), versionDir, { recursive: true })
  derivePackage(versionDir)
  const root = { get: key => (key === 'profileContext' ? { dir } : undefined) }
  const tools = new Map()
  const ctx = {
    root,
    on() {},
    tools: { register: tool => tools.set(tool.name, tool), guard() {} },
  }
  const runtime = runtimeContextForHost(root)
  return {
    ctx,
    dir,
    tools,
    runtime,
    dispose() {
      runtime.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

async function runOnce(host) {
  host.runtime.run(() => {
    businessPolicy.setIdentityProvider(() => identity('tester'))
    dataSources.register('rpt-source', {
      version: '1',
      nature: 'simulated',
      async fetch() {
        const dataset = JSON.parse(readFileSync(join(repo, 'examples', 'aml-run.json'), 'utf8'))
        await Promise.resolve()
        return {
          dataset,
          complete: true,
          businessWindow: { from: '2026-11-01', to: new Date().toISOString() },
        }
      },
    })
  })
  applyTools(host.ctx)
  const args = {
    name: 'aml-analysis',
    version: '1.0.0',
    scenarioId: 'SCN-AML-FIND-CLUES',
    sourceId: 'rpt-source',
    analysisMode: 'explore',
  }
  const out = await host.tools.get('run_scenario').execute(args, {})
  return { args, out }
}

test('真实工具：run_scenario 动线提示 + show_run_report 默认/自定义 surface', async () => {
  const host = fixture()
  try {
    const { args, out } = await runOnce(host)
    // 动线：run render 含 show_run_report 提示
    const runText = host.tools.get('run_scenario').output.render(args, out)
    assert.ok(runText[0].text.includes(`show_run_report(runId=${out.runId})`))

    const tool = host.tools.get('show_run_report')
    const value = await tool.execute({ runId: out.runId }, {})
    assert.equal(value.humanReviewRequired, true)
    assert.equal(value.surfaceSource, 'default')
    assert.equal(value.runRef.runId, out.runId)
    assert.equal(value.runRef.package.name, 'aml-analysis')
    const keys = walkKeys(value)
    assert.ok(!keys.has('evidenceChains'))
    assert.ok(!keys.has('narrative'))
    const rendered = tool.output.render({ runId: out.runId }, value)
    assert.ok(rendered[0].text.includes(out.runId))
    const meta = tool.output.presentationMeta({ runId: out.runId }, value)
    assert.equal(meta.runRef.runId, out.runId)
    assert.equal(meta.surfaceSource, 'default')

    // 自定义 surface：模型组织布局（@path 信封绑定）
    const surface = buildDefaultReportSurface({ surfaceId: 'custom-1' })
    surface.root = {
      id: 'only-table',
      type: 'Table',
      props: {
        rowsBind: { '@path': '/candidates' },
        columns: [{ field: 'riskScore', header: '风险分' }],
        sort: { field: 'riskScore', dir: 'desc' },
      },
    }
    const custom = await tool.execute({ runId: out.runId, surface }, {})
    assert.equal(custom.surfaceSource, 'model')
    assert.equal(custom.surface.surfaceId, 'custom-1')
  } finally {
    host.dispose()
    configurePhraseStore(null)
  }
})

test('真实工具：surface 数值字面量被拒（INVALID_ARGS）', async () => {
  const host = fixture()
  try {
    const { out } = await runOnce(host)
    const tool = host.tools.get('show_run_report')
    const bad = buildDefaultReportSurface()
    bad.root = {
      id: 'cheat',
      type: 'Stat',
      props: { label: '风险分', value: 0.01 },
    }
    await assert.rejects(
      () => tool.execute({ runId: out.runId, surface: bad }, {}),
      e => e.code === 'INVALID_ARGS' && /SF_/.test(e.message),
    )
    // 未知名下 run 拒绝（NOT_FOUND 受控错误）
    await assert.rejects(
      () => tool.execute({ runId: 'run-zzzzzzzz' }, {}),
      e => e.code === 'NOT_FOUND',
    )
  } finally {
    host.dispose()
    configurePhraseStore(null)
  }
})

test('wire getRunReport：与 buildRunReport 逐字段一致（人审面）', async () => {
  const host = fixture()
  try {
    const { out } = await runOnce(host)
    const ctx = new Context()
    ctx.reflect.provide('profileContext', { dir: host.dir })
    const runtime = runtimeContextForHost(ctx.root)
    try {
      const service = new OntoRuntime(ctx)
      const { report } = await service.remoteExportGetRunReport({ runId: out.runId })
      const expected = buildRunReport(loadRunRecord(join(host.dir, 'dsh-onto', 'workspace'), out.runId))
      assert.deepEqual(report, expected)
      assert.equal(report.runRef.package.name, 'aml-analysis')
    } finally {
      runtime.dispose()
    }
  } finally {
    host.dispose()
    configurePhraseStore(null)
  }
})

test('wire getRunReport：strict 越权身份拒绝，同身份放行', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'onto-rpt-auth-'))
  try {
    const root = join(dir, 'dsh-onto', 'workspace')
    mkdirSync(root, { recursive: true })
    saveRunRecord(
      root,
      buildRunRecord({
        package: { name: 'aml-analysis', version: '1.0.0' },
        dataset: fakeDataset(),
        result: fakeResult('run-auth0001'),
        redlines: [],
        accessBinding: runAccessBinding(identity('tester')),
      }),
    )
    const ctx = new Context()
    ctx.reflect.provide('profileContext', { dir })
    const runtime = runtimeContextForHost(ctx.root)
    try {
      runtime.run(() => {
        enableStrictReleaseMode()
        businessPolicy.setIdentityProvider(() => identity('someone-else'))
      })
      const service = new OntoRuntime(ctx)
      await assert.rejects(
        () => service.remoteExportGetRunReport({ runId: 'run-auth0001' }),
        (e) => /not accessible|NOT_GRANTED/i.test(String(e && e.message ? e.message : e)),
      )
      runtime.run(() => {
        businessPolicy.setIdentityProvider(() => identity('tester'))
      })
      const { report } = await service.remoteExportGetRunReport({ runId: 'run-auth0001' })
      assert.equal(report.runRef.runId, 'run-auth0001')
      assert.equal(report.summary.humanReviewRequired, true)
    } finally {
      runtime.dispose()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
    configurePhraseStore(null)
  }
})

test('沙箱分类：报表工具登记为 onto 能力（onto 预设放行面）', () => {
  for (const name of ['show_run_report', 'save_report_page', 'list_report_pages']) {
    assert.equal(classifyToolCapability(name), 'onto', `${name} 须归 onto`)
  }
})

test('真实工具：save_report_page 沉淀 + list_report_pages 摘要（同名覆盖）', async () => {
  const host = fixture()
  try {
    const { out } = await runOnce(host)
    const surface = buildDefaultReportSurface({ surfaceId: 'p1' })
    const saved = await host.tools
      .get('save_report_page')
      .execute({ name: 'WST 异常候选报表', runId: out.runId, surface }, {})
    assert.equal(saved.name, 'WST 异常候选报表')
    assert.equal(saved.runId, out.runId)
    assert.match(saved.pageId, /^rp-[0-9a-f]{12}$/)
    let list = await host.tools.get('list_report_pages').execute({}, {})
    assert.equal(list.pages.length, 1)
    assert.equal(list.pages[0].pageId, saved.pageId)
    assert.equal(list.pages[0].runId, out.runId)
    const page = loadReportPage(join(host.dir, 'dsh-onto', 'workspace'), saved.pageId)
    assert.equal(page.surface.surfaceId, 'p1')
    // 同名覆盖同页，列表不膨胀
    const again = await host.tools
      .get('save_report_page')
      .execute({ name: 'WST 异常候选报表', runId: out.runId, surface }, {})
    assert.equal(again.pageId, saved.pageId)
    list = await host.tools.get('list_report_pages').execute({}, {})
    assert.equal(list.pages.length, 1)
    // 坏 surface 拒绝沉淀
    const bad = buildDefaultReportSurface()
    bad.root = { id: 'cheat', type: 'Stat', props: { label: 'x', value: 0.01 } }
    await assert.rejects(
      () => host.tools.get('save_report_page').execute({ name: 'bad', runId: out.runId, surface: bad }, {}),
      (e) => e.code === 'INVALID_ARGS',
    )
  } finally {
    host.dispose()
    configurePhraseStore(null)
  }
})

test('wire 报表页：列表/读取与 store 一致；strict 越权拒、同身份放行', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'onto-rpt-page-'))
  try {
    const root = join(dir, 'dsh-onto', 'workspace')
    mkdirSync(root, { recursive: true })
    saveReportPage(root, {
      pageId: 'rp-auth00000001',
      name: 'auth-page',
      surface: buildDefaultReportSurface({ surfaceId: 'p-auth' }),
      createdFrom: {
        runId: 'run-auth0001',
        package: { name: 'aml-analysis', version: '1.0.0' },
        scenarioId: 'SCN-AML-FIND-CLUES',
        startedAt: '2026-11-22T00:00:00.000Z',
        savedAt: '2026-11-22T00:01:00.000Z',
      },
      savedAt: '2026-11-22T00:02:00.000Z',
      accessBinding: runAccessBinding(identity('tester')),
    })
    // 非 strict wire：列表/读取与 store 一致
    const openCtx = new Context()
    openCtx.reflect.provide('profileContext', { dir })
    const openRuntime = runtimeContextForHost(openCtx.root)
    try {
      const open = new OntoRuntime(openCtx)
      const { pages } = await open.remoteExportListReportPages()
      assert.equal(pages.length, 1)
      assert.equal(pages[0].surface.surfaceId, 'p-auth')
      const { page } = await open.remoteExportGetReportPage({ pageId: 'rp-auth00000001' })
      assert.equal(page.name, 'auth-page')
    } finally {
      openRuntime.dispose()
    }
    // strict wire：越权拒、同身份放行
    const ctx = new Context()
    ctx.reflect.provide('profileContext', { dir })
    const runtime = runtimeContextForHost(ctx.root)
    try {
      runtime.run(() => {
        enableStrictReleaseMode()
        businessPolicy.setIdentityProvider(() => identity('someone-else'))
      })
      const service = new OntoRuntime(ctx)
      await assert.rejects(
        () => service.remoteExportGetReportPage({ pageId: 'rp-auth00000001' }),
        (e) => /not accessible|NOT_GRANTED/i.test(String(e && e.message ? e.message : e)),
      )
      assert.equal((await service.remoteExportListReportPages()).pages.length, 0)
      runtime.run(() => {
        businessPolicy.setIdentityProvider(() => identity('tester'))
      })
      const { page } = await service.remoteExportGetReportPage({ pageId: 'rp-auth00000001' })
      assert.equal(page.pageId, 'rp-auth00000001')
      assert.equal((await service.remoteExportListReportPages()).pages.length, 1)
    } finally {
      runtime.dispose()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
    configurePhraseStore(null)
  }
})

test('save_report_page：strict 写目标收权——跨身份覆写拒、同身份覆盖放行', async () => {
  const host = fixture()
  try {
    const root = join(host.dir, 'dsh-onto', 'workspace')
    for (const [runId, who] of [
      ['run-a0000001', 'a'],
      ['run-b0000001', 'b'],
    ]) {
      saveRunRecord(
        root,
        buildRunRecord({
          package: { name: 'aml-analysis', version: '1.0.0' },
          dataset: fakeDataset(),
          result: fakeResult(runId),
          redlines: [],
          accessBinding: runAccessBinding(identity(who)),
        }),
      )
    }
    host.runtime.run(() => {
      enableStrictReleaseMode()
      businessPolicy.setIdentityProvider(() => identity('a'))
    })
    applyTools(host.ctx)
    const surface = buildDefaultReportSurface()
    const first = await host.tools
      .get('save_report_page')
      .execute({ name: 'shared-page', runId: 'run-a0000001', surface }, {})
    // 同身份覆盖放行
    const again = await host.tools
      .get('save_report_page')
      .execute({ name: 'shared-page', runId: 'run-a0000001', surface }, {})
    assert.equal(again.pageId, first.pageId)
    // 跨身份覆写拒（即使持有自己的 run——写目标另过 accessBinding）
    host.runtime.run(() => {
      businessPolicy.setIdentityProvider(() => identity('b'))
    })
    await assert.rejects(
      () =>
        host.tools
          .get('save_report_page')
          .execute({ name: 'shared-page', runId: 'run-b0000001', surface }, {}),
      (e) => e.code === 'OBJECT_NOT_GRANTED',
    )
    // B 沉淀自己的页（不同 pageId）不受影响
    const bPage = await host.tools
      .get('save_report_page')
      .execute({ name: 'b-page', runId: 'run-b0000001', surface }, {})
    assert.notEqual(bPage.pageId, first.pageId)
  } finally {
    host.dispose()
    configurePhraseStore(null)
  }
})
