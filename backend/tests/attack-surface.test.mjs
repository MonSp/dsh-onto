/**
 * 攻击面回归清单（round-13）：把 12 轮评审固化过的变体与本轮修复收进单表，
 * 防线改动必须全表重放。覆盖：收权 deny-by-default、出口契约、禁语脱敏组合、
 * 派生门禁、skills 去重确定性。末节按 tool-face-policy 不变量（I1–I5）穷举
 * 路径/禁语同族等价类——发现一类问题即整族补测，不再逐旁路点名。
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  AgentToolError,
  assertBatchContract,
  assertDiffContract,
  assertNoForbiddenPhrases,
  assertRunContract,
  asToolError,
  collectPhrases,
  enforceOutputPolicy,
  rememberPhrases,
  renderBatchText,
  renderExportText,
  renderRunDiffText,
  renderRunText,
  retreatPhraseEcho,
  toolExecute,
} from '../dist/agent-policy.js'
import {
  assertDatasetGranted,
  grantGuardDecision,
  readToolContracts,
} from '../dist/agent-grants.js'
import {
  exportSummaryOf,
  loadDatasetFromArgs,
  loadToolPackage,
  redlinesForRuns,
  runScenarioBatch,
  validateDatasetShape,
} from '../dist/agent-tools.js'
import { dedupeSkillNames, isCurrentWinner, pickSkillSources } from '../dist/agent-skills.js'
import {
  PackageStoreError,
  PackageWorkspace,
  buildRunRecord,
  compareRunRecords,
  derivePackage,
  loadPackage,
  loadRunRecord,
  runScenario,
  saveRunRecord,
  writeSourceFile,
} from '@dsh-onto/core'

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const AML_DIR = join(REPO, 'packages', 'aml', '1.0.0')
const AML_RUN = join(REPO, 'examples', 'aml-run.json')
// datasetPath 工作目录围栏（tool-face-policy P2.1）：测试显式指定围栏根为仓库根。
const BASE = { baseDir: REPO }

function expectCode(fn, code) {
  try {
    fn()
  } catch (e) {
    assert.ok(e instanceof AgentToolError, `期望 AgentToolError，得到 ${e}`)
    assert.equal(e.code, code)
    return
  }
  assert.fail(`期望抛出 ${code}`)
}

/* ── 出口契约：非有限证据分拦截 ─────────────────────────────────────── */

test('出口契约：evidenceChains score 为 Infinity/NaN 即 INVALID_TOOL_OUTPUT', () => {
  const dataset = loadDatasetFromArgs({ datasetPath: AML_RUN }, BASE)
  const good = runScenario(AML_DIR, 'SCN-AML-FIND-CLUES', dataset)
  assert.doesNotThrow(() => assertRunContract(good))
  for (const bad of [Number.POSITIVE_INFINITY, Number.NaN]) {
    const tampered = {
      ...good,
      candidates: good.candidates.map((c, i) =>
        i === 0
          ? { ...c, evidenceChains: c.evidenceChains.map((e, j) => (j === 0 ? { ...e, score: bad } : e)) }
          : c,
      ),
    }
    expectCode(() => assertRunContract(tampered), 'INVALID_TOOL_OUTPUT')
  }
  const nullEntry = {
    ...good,
    candidates: good.candidates.map((c, i) => (i === 0 ? { ...c, evidenceChains: [null] } : c)),
  }
  expectCode(() => assertRunContract(nullEntry), 'INVALID_TOOL_OUTPUT')
})

/* ── 类型段伪托：形状校验 + 收权兜底双层 ───────────────────────────── */

test('类型段伪托：dataset 声明 type 夹冒号（object/relation/behavior）一律 INVALID_ARGS', () => {
  expectCode(
    () => validateDatasetShape({ objects: [{ id: 'g1', type: 'OBJ-AML-ACCOUNT:PWNED' }], relations: [], candidates: [] }),
    'INVALID_ARGS',
  )
  expectCode(
    () =>
      validateDatasetShape({
        objects: [],
        relations: [{ id: 'r1', type: 'REL-AML-HOLDS:X', from: 'a', to: 'b' }],
        candidates: [],
      }),
    'INVALID_ARGS',
  )
  expectCode(
    () =>
      validateDatasetShape({
        objects: [],
        relations: [],
        behaviors: [{ id: 'b1', type: 'BHV-AML-TRANSFER:Y', anchorRef: 'a', objectRef: 'a', occurredAt: 't' }],
        candidates: [],
      }),
    'INVALID_ARGS',
  )
})

test('类型段伪托兜底：绕过形状校验直调收权（声明类型夹冒号）→ OBJECT_NOT_GRANTED', () => {
  const contracts = readToolContracts(AML_DIR)
  const ds = {
    // 攻击形态：实例 g1 声明已收权类型 + 冒号尾巴；grantSubject 二次剥段会截成已收权前缀
    objects: [{ id: 'g1', type: 'OBJ-AML-ACCOUNT:PWNED' }],
    relations: [],
    candidates: [{ candidateId: 'c1', objectRef: 'g1', features: {}, tags: [] }],
  }
  expectCode(() => assertDatasetGranted(ds, contracts), 'OBJECT_NOT_GRANTED')
})

/* ── 禁语脱敏：组合路径（execute 深脱敏 → render 幂等） ──────────────── */

test('禁语组合：canonical 深走全字段 + render 不回显 + 二次脱敏幂等', () => {
  const dataset = loadDatasetFromArgs({ datasetPath: AML_RUN }, BASE)
  const base = runScenario(AML_DIR, 'SCN-AML-FIND-CLUES', dataset)
  const phrase = '确定为洗钱'
  const raw = {
    ...base,
    candidates: base.candidates.map((c, i) =>
      i === 0
        ? {
            ...c,
            narrative: [...c.narrative, `叙述${phrase}`],
            evidenceChains: [...c.evidenceChains, { ruleId: 'RULE-AML-SCORE-FANOUT', score: 0.5, evidence: `证据${phrase}` }],
            pendingChecks: [...c.pendingChecks, { note: `待核实${phrase}` }],
          }
        : c,
    ),
    audit: {
      ...base.audit,
      checks: [{ check: 'X', closed: false, detail: `明细${phrase}`, ts: 't' }],
      forbiddenPhraseHits: [{ phrase, where: 'candidates[0].narrative[0]' }],
    },
  }

  const masked = enforceOutputPolicy(raw)
  // canonical 全字段深走：结构面任何字符串面都不回显短语本体
  assert.ok(!JSON.stringify(masked).includes(phrase), 'canonical 结构面泄漏短语')
  // count/where 保留
  assert.equal(masked.audit.forbiddenPhraseHits.length, 1)
  assert.equal(masked.audit.forbiddenPhraseHits[0].where, 'candidates[0].narrative[0]')
  assert.equal(masked.humanReviewRequired, true)
  // 输入（core/wire 人审面）不被改写
  assert.ok(JSON.stringify(raw).includes(phrase), '入参不得被改写（core/wire 保留原文）')

  // render 接 execute 脱敏后的值（组合路径）：不再回显，标记在场
  const text = renderRunText(masked)
  assert.ok(!text.includes(phrase), 'render 组合路径泄漏短语')
  assert.ok(text.includes('【禁语已脱敏】'), '脱敏标记在场')
  assert.match(text, /禁语扫描: 1 命中/)

  // 幂等：二次脱敏同引用（全部命中已是标记），render 不改写标记
  assert.equal(enforceOutputPolicy(masked), masked)
  assert.equal(renderRunText(masked), text)
})

test('禁语自嵌：短语为标记子串（如「脱敏」）时换标记仍零残留', () => {
  const phrase = '脱敏'
  const raw = {
    scenarioId: 'S', runId: 'R', startedAt: 't',
    candidates: [{
      candidateId: 'C1', objectRef: 'g1', riskScore: 0.5, hitRuleIds: [],
      evidenceChains: [], pendingChecks: [{ note: `含${phrase}的备注` }],
      pendingVerification: false, narrative: [`含${phrase}的叙述`],
    }],
    excluded: [], humanReviewRequired: true,
    reviewGate: { threshold: 0.5, required: true, requireReviewFor: [] },
    ruleHitLog: [],
    audit: {
      checks: [],
      forbiddenPhraseHits: [{ phrase, where: 'candidates[0].narrative[0]' }],
      passed: false,
    },
  }
  const masked = enforceOutputPolicy(raw)
  assert.ok(!JSON.stringify(masked).includes(phrase), '标记含短语子串时必须换标记，不得自嵌残留')
  const text = renderRunText(masked)
  assert.ok(!text.includes(phrase))
  // 默认标记含「脱敏」→ 必须选中备选标记
  assert.ok(!JSON.stringify(masked).includes('【禁语已脱敏】'), '默认标记含命中短语时须退避')
})

/* ── round-13 复审修复：ID 回指面 / 嵌套幂等 / 标记短语 ─────────────────── */

const rawRun = (phrase, extra = {}) => ({
  scenarioId: 'S', runId: 'R', startedAt: 't',
  candidates: [{
    candidateId: 'C1', objectRef: 'g1', riskScore: 0.5, hitRuleIds: ['RULE-AML-001'],
    evidenceChains: [], pendingChecks: [],
    pendingVerification: false, narrative: [`叙述${phrase}`],
  }],
  excluded: [], humanReviewRequired: true,
  reviewGate: { threshold: 0.5, required: true, requireReviewFor: [] },
  ruleHitLog: [],
  audit: {
    checks: [],
    forbiddenPhraseHits: [{ phrase, where: 'candidates[0].narrative[0]' }],
    passed: false,
  },
  ...extra,
})

test('ID 回指面不改写：ruleId/objectRef/candidateId 脱敏后原样（工具层不改写命中）', () => {
  const phrase = '确定为洗钱'
  const raw = rawRun(phrase)
  const masked = enforceOutputPolicy(raw)
  assert.deepEqual(masked.candidates[0].hitRuleIds, ['RULE-AML-001'], 'hitRuleIds 不得被脱敏改写')
  assert.equal(masked.candidates[0].objectRef, 'g1', 'objectRef 不得被脱敏改写')
  assert.equal(masked.candidates[0].candidateId, 'C1', 'candidateId 不得被脱敏改写')
  assert.ok(!JSON.stringify(masked).includes(phrase), '叙述面仍须脱敏')
})

test('禁语撞入 ID 面（禁语⊂ruleId）fail-loud：拒绝产出且错误消息不回显短语', () => {
  const phrase = 'AML' // 构造形态：禁语为 ruleId 子串
  const raw = rawRun(phrase)
  let err
  try {
    enforceOutputPolicy(raw)
  } catch (e) {
    err = e
  }
  assert.ok(err instanceof AgentToolError, '不改写与零容忍不可兼得时必须受控失败')
  assert.equal(err.code, 'INVALID_TOOL_OUTPUT')
  assert.ok(!err.message.includes(phrase), `错误消息不得回显短语: ${err.message}`)
})

test('嵌套禁语：长短语对同现整字段重遮（不留「该+标记」残片），二次脱敏同引用', () => {
  const shortP = '账户涉嫌洗钱'
  const longP = '该账户涉嫌洗钱'
  const raw = rawRun(longP, {
    audit: {
      checks: [],
      forbiddenPhraseHits: [
        { phrase: shortP, where: 'a' },
        { phrase: longP, where: 'b' },
      ],
      passed: false,
    },
  })
  raw.candidates[0].narrative = [`短语 ${shortP} 与长语 ${longP} 同现`]
  const masked = enforceOutputPolicy(raw)
  const json = JSON.stringify(masked)
  assert.ok(!json.includes(shortP) && !json.includes(longP), '嵌套短语对均须清除')
  assert.ok(!json.includes('该【'), '长语优先替换，不得留「该+标记」残片')
  assert.equal(enforceOutputPolicy(masked), masked, '二次脱敏同引用（phrase 空化锚点）')
})

test('禁语恰为占位标记时仍脱敏（不因标记过滤而原样留存）', () => {
  const phrase = '【禁语已脱敏】' // 构造形态：禁语字面即默认标记
  const raw = rawRun(phrase)
  const masked = enforceOutputPolicy(raw)
  const json = JSON.stringify(masked)
  assert.ok(!json.includes(phrase), '标记字面作为禁语时必须换标记清除')
  const text = renderRunText(masked)
  assert.ok(!text.includes(phrase))
})

/* ── 派生门禁：工具面单一收口（loadToolPackage） ────────────────────── */

test('门禁：干净包加载成功；未派生/篡改源/不存在分别受控失败', () => {
  const repoWs = new PackageWorkspace(REPO)
  const pkg = loadToolPackage(repoWs, 'aml-analysis', '1.0.0')
  assert.equal(pkg.meta.name, 'aml-analysis')

  // 未派生：复制源但去掉 derived/ → DERIVED_DRIFT（missing manifest）；不存在 → NOT_FOUND
  const baseNever = mkdtempSync(join(tmpdir(), 'onto-gate-never-'))
  try {
    const ws = new PackageWorkspace(baseNever)
    const never = ws.versionDir('aml-analysis', '1.0.0')
    cpSync(AML_DIR, never, { recursive: true })
    rmSync(join(never, 'derived'), { recursive: true, force: true })
    expectCode(() => loadToolPackage(ws, 'aml-analysis', '1.0.0'), 'DERIVED_DRIFT')
    expectCode(() => loadToolPackage(ws, 'no-such-pkg', '9.9.9'), 'NOT_FOUND')
  } finally {
    rmSync(baseNever, { recursive: true, force: true })
  }

  // 篡改源（派生后改 package.yaml）→ DERIVED_DRIFT（fingerprint mismatch），不泄绝对路径
  const baseTamper = mkdtempSync(join(tmpdir(), 'onto-gate-tamper-'))
  try {
    const ws = new PackageWorkspace(baseTamper)
    const dir = ws.versionDir('aml-analysis', '1.0.0')
    cpSync(AML_DIR, dir, { recursive: true })
    // 注释不参与（package.yaml 走 YAML 规范化指纹）——改实质字段触发 mismatch
    writeFileSync(join(dir, 'package.yaml'), 'xTamper: 1\n', { flag: 'a' })
    let gateErr
    try {
      loadToolPackage(ws, 'aml-analysis', '1.0.0')
    } catch (e) {
      gateErr = e
    }
    assert.ok(gateErr instanceof AgentToolError, '篡改源应触发门禁')
    assert.equal(gateErr.code, 'DERIVED_DRIFT')
    assert.ok(!gateErr.message.includes(baseTamper), '门禁错误不得回显绝对路径')
  } finally {
    rmSync(baseTamper, { recursive: true, force: true })
  }
})

/* ── 收权 deny-by-default 变体矩阵（12 轮固化） ─────────────────────── */

test('收权矩阵：objectId/objectRef 变体（空/非串/未收权/实例段/多级段）', () => {
  const contracts = readToolContracts(AML_DIR)
  const reader = () => contracts
  const granted = 'OBJ-AML-ACCOUNT'
  const args = (extra) => ({ name: 'aml-analysis', version: '1.0.0', ...extra })

  const denied = [
    ['', '空 objectId'],
    [':x', '空类型段'],
    ['OBJ-NOPE', '未收权裸类型'],
    ['OBJ-NOPE:x', '未收权类型实例段'],
    ['OBJ-NOPE:a:b', '未收权多级段'],
    ['obj-aml-account', '大小写变体（精确匹配，不折叠）'],
    [' OBJ-AML-ACCOUNT', '前导空白'],
    ['OBJ-AML-ACCOUNT ', '尾随空白'],
  ]
  for (const [value, desc] of denied) {
    assert.match(
      String(grantGuardDecision('list_tool_contracts', args({ objectId: value }), reader)),
      /OBJECT_NOT_GRANTED/,
      `${desc} 应拒绝: ${value}`,
    )
  }
  const allowed = [
    [granted, '裸已收权类型'],
    [`${granted}:x`, '已收权类型实例段'],
    [`${granted}:a:b`, '已收权多级实例段'],
  ]
  for (const [value, desc] of allowed) {
    assert.equal(
      grantGuardDecision('list_tool_contracts', args({ objectId: value }), reader),
      undefined,
      `${desc} 应放行: ${value}`,
    )
  }
  // 双字段：任一未收权即拒
  assert.match(
    String(grantGuardDecision('list_tool_contracts', args({ objectId: granted, objectRef: 'OBJ-NOPE' }), reader)),
    /OBJECT_NOT_GRANTED/,
  )
  // 缺 name/version 无法核对清单 → 拒
  assert.match(
    String(grantGuardDecision('list_tool_contracts', { objectId: granted }, reader)),
    /OBJECT_NOT_GRANTED/,
  )
  // 非字符串/空串 → 受控拒绝（不静默跳过）；null 视为未提供（与 guard 口径一致）
  assert.equal(
    grantGuardDecision('list_tool_contracts', { objectId: null, name: 'aml-analysis', version: '1.0.0' }, reader),
    undefined,
  )
  for (const bad of [123, {}, []]) {
    assert.match(
      String(grantGuardDecision('list_tool_contracts', { objectId: bad, name: 'aml-analysis', version: '1.0.0' }, reader)),
      /OBJECT_NOT_GRANTED/,
      `非法 objectId 应拒绝: ${String(bad)}`,
    )
  }
})

/* ── skills：去重确定性与胜出者复核 ────────────────────────────────── */

test('skills 去重：等价版本/撞名平局与输入序无关（readdir 序不得泄漏）', () => {
  const tpl = (id) => ({ id, name: id, weights: {} })
  const src = (id, versionDir, version, status) => ({
    versionDir,
    status,
    version,
    template: tpl(id),
  })

  // 等价版本（build 元数据被 semver 忽略）→ 按版本原始串收口，双序同胜者
  const a = src('SKL-TSP-N', '/d/a', '1.0.0+a', 'DRAFT')
  const b = src('SKL-TSP-N', '/d/b', '1.0.0+b', 'DRAFT')
  const pick1 = pickSkillSources([a, b]).get('SKL-TSP-N')
  const pick2 = pickSkillSources([b, a]).get('SKL-TSP-N')
  assert.equal(pick1.versionDir, pick2.versionDir, '等价版本平局必须与输入序无关')

  // 跨 id 撞名（SKL-TSP_X ↔ SKL-TSP-X）→ 按模板 id 收口，双序同胜者
  const x = src('SKL-TSP_X', '/d/x', '1.0.0', 'ISSUED')
  const y = src('SKL-TSP-X', '/d/y', '1.0.0', 'ISSUED')
  const d1 = dedupeSkillNames([x, y]).get('skl-tsp-x')
  const d2 = dedupeSkillNames([y, x]).get('skl-tsp-x')
  assert.ok(d1 && d2)
  assert.equal(d1.versionDir, d2.versionDir, '撞名平局必须与输入序无关')
  assert.equal(d1.template.id, d2.template.id)

  // 同 versionDir+同模板 id 但模板内容不同（round-13 nit：JSON 判别收口）→ 双序同胜者
  const t1 = { versionDir: '/d/t', status: 'DRAFT', version: '1.0.0', template: { id: 'SKL-TSP-T', name: '甲', weights: {} } }
  const t2 = { versionDir: '/d/t', status: 'DRAFT', version: '1.0.0', template: { id: 'SKL-TSP-T', name: '乙', weights: {} } }
  const w1 = pickSkillSources([t1, t2]).get('SKL-TSP-T')
  const w2 = pickSkillSources([t2, t1]).get('SKL-TSP-T')
  assert.equal(w1.template.name, w2.template.name, '同目录同 id 撞名平局必须与输入序无关')

  // 四源乱序 → 同一胜者（全序稳定）
  const pool = [a, b, x, y]
  const orders = [pool, [...pool].reverse(), [pool[1], pool[3], pool[0], pool[2]]]
  const winners = orders.map((o) => dedupeSkillNames(o).get('skl-tsp-x'))
  assert.equal(winners[0].template.id, winners[1].template.id)
  assert.equal(winners[1].template.id, winners[2].template.id)
})

test('skills 胜出者复核：stale/落选/异名 locator 一律拒载', () => {
  const tpl = (id) => ({ id, name: id, weights: {} })
  const src = (id, versionDir, version, status) => ({ versionDir, status, version, template: tpl(id) })
  const winners = dedupeSkillNames([src('SKL-TSP-N', '/d/new', '1.1.0', 'ISSUED')])
  assert.equal(isCurrentWinner(winners, 'skl-tsp-n', '/d/new', 'SKL-TSP-N'), true)
  // 旧版 locator（目录存在但已落选）
  assert.equal(isCurrentWinner(winners, 'skl-tsp-n', '/d/old', 'SKL-TSP-N'), false)
  // 伪造 sklId
  assert.equal(isCurrentWinner(winners, 'skl-tsp-n', '/d/new', 'SKL-TSP-EVIL'), false)
  // 名字不在当前快照
  assert.equal(isCurrentWinner(winners, 'skl-tsp-gone', '/d/new', 'SKL-TSP-N'), false)
  // 空快照
  assert.equal(isCurrentWinner(new Map(), 'skl-tsp-n', '/d/new', 'SKL-TSP-N'), false)
})

/* ── tool-face-policy 不变量（I1–I5）：路径与禁语同族穷举 ────────────────── */

test('I3 datasetPath 围栏：越界/穿越/ADS/junction 逃逸一律拒（I2：错误只回显原文）', () => {
  const base = mkdtempSync(join(tmpdir(), 'onto-fence-'))
  const outside = mkdtempSync(join(tmpdir(), 'onto-fence-out-'))
  try {
    const ds = JSON.stringify({ objects: [], relations: [], candidates: [] })
    writeFileSync(join(base, 'ok.json'), ds)
    writeFileSync(join(outside, 'secret.json'), ds)
    // 合法：围栏内
    assert.equal(loadDatasetFromArgs({ datasetPath: join(base, 'ok.json') }, { baseDir: base }).candidates.length, 0)
    // 越界：围栏外绝对路径
    expectCode(() => loadDatasetFromArgs({ datasetPath: join(outside, 'secret.json') }, { baseDir: base }), 'INVALID_ARGS')
    // 穿越：`..` 逃出
    expectCode(() => loadDatasetFromArgs({ datasetPath: join(base, '..', 'x.json') }, { baseDir: base }), 'INVALID_ARGS')
    // ADS 冒号段（NTFS 隐藏流）
    expectCode(() => loadDatasetFromArgs({ datasetPath: join(base, 'a:b.json') }, { baseDir: base }), 'INVALID_ARGS')
    // junction 逃逸：围栏内链接指向围栏外
    const link = join(base, 'link')
    symlinkSync(outside, link, 'junction')
    expectCode(() => loadDatasetFromArgs({ datasetPath: join(link, 'secret.json') }, { baseDir: base }), 'INVALID_ARGS')
    // I2：围栏拒绝回显调用方原文，不回显 resolve 后绝对路径
    const raw = 'no-such-relative.json'
    try {
      loadDatasetFromArgs({ datasetPath: raw }, { baseDir: base })
      assert.fail('期望 INVALID_ARGS')
    } catch (e) {
      assert.ok(e instanceof AgentToolError && e.code === 'INVALID_ARGS')
      assert.ok(e.message.includes(raw), `应回显调用方原文: ${e.message}`)
      assert.ok(!e.message.includes(resolve(raw)), `不得回显 resolve 后绝对路径: ${e.message}`)
    }
  } finally {
    rmSync(base, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('I3 写源围栏：writeSourceFile 本体拒绝穿越/ADS/绝对路径/junction 写穿（与 importVersion 同口径）', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'onto-wsrc-'))
  const outside = mkdtempSync(join(tmpdir(), 'onto-wsrc-out-'))
  try {
    const dir = join(tmp, 'pkg', '1.0.0')
    mkdirSync(dir, { recursive: true })
    const bad = (rel) => {
      try {
        writeSourceFile(dir, rel, 'x')
        assert.fail(`期望拒绝: ${rel}`)
      } catch (e) {
        assert.ok(e instanceof PackageStoreError, `期望 PackageStoreError，得到 ${e}`)
        assert.equal(e.code, 'PACKAGE_MALFORMED')
      }
    }
    bad('../escape.yaml')
    bad('a:b.yaml')
    bad('sub/../../up.yaml')
    bad('C:\\abs.yaml')
    // junction 写穿：子目录指外也不得落盘
    symlinkSync(outside, join(dir, 'sub'), 'junction')
    bad('sub/evil.yaml')
    assert.ok(!existsSync(join(outside, 'evil.yaml')), 'junction 指外不得写穿')
    // 合法写入
    writeSourceFile(dir, 'o1-objects/x.yaml', 'ok: true')
    assert.ok(existsSync(join(dir, 'o1-objects', 'x.yaml')))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('I1 断言闸门：模型面残留短语即受控失败（错误不回显短语）', () => {
  const phrase = '确定为洗钱'
  assert.doesNotThrow(() => assertNoForbiddenPhrases({ narrative: ['clean'] }, [phrase]))
  expectCode(() => assertNoForbiddenPhrases({ narrative: [`x${phrase}`] }, [phrase]), 'INVALID_TOOL_OUTPUT')
  try {
    assertNoForbiddenPhrases({ nested: [{ deep: phrase }] }, [phrase])
    assert.fail('期望 INVALID_TOOL_OUTPUT')
  } catch (e) {
    assert.ok(e instanceof AgentToolError && e.code === 'INVALID_TOOL_OUTPUT')
    assert.ok(!e.message.includes(phrase), `错误消息不得回显短语: ${e.message}`)
  }
})

/* ── 第十四轮挂点病同族补测：render 闸可达性（I1）+ 错误信封（I2）+ 验形（I5） ── */

const cleanRun = (runId, extra = {}) => ({
  scenarioId: 'S', runId, startedAt: 't',
  candidates: [{
    candidateId: 'C1', objectRef: 'g1', riskScore: 0.5, hitRuleIds: ['RULE-AML-001'],
    evidenceChains: [], pendingChecks: [],
    pendingVerification: false, narrative: ['干净叙述'],
  }],
  excluded: [], humanReviewRequired: true,
  reviewGate: { threshold: 0.5, required: true, requireReviewFor: [] },
  ruleHitLog: [],
  audit: { checks: [], forbiddenPhraseHits: [], passed: true },
  ...extra,
})

test('I1 模板字面碰撞（红线双源）：命中为空、短语仅存场景红线 → 渲染模板碰撞仍整段兜底', () => {
  const phrase = '命中' // 构造形态：红线短语 ⊂ render 模板固定字面（「命中规则」「N 命中」）
  const raw = cleanRun('R-tpl')
  const phrases = collectPhrases(raw, [phrase])
  assert.deepEqual(phrases, [phrase], '清单双源：命中为空时场景红线补入')
  // 生产路径：注册 → value 闸 → render 闸（经 runId 注册表取回清单）
  rememberPhrases(raw.runId, phrases)
  const masked = enforceOutputPolicy(raw, phrases)
  const text = renderRunText(masked)
  assert.ok(!text.includes(phrase), `模板碰撞不得泄漏: ${text}`)
  assert.match(text, /^【.+】$/, '拼接后检出短语 → 整段渲染文本替换为标记')
  // 反证挂点病：清单丢失（旧实现从空化 value 反推）→ 兜底失效、模板字面原样泄漏
  const blind = renderRunText(masked, [])
  assert.ok(blind.includes(phrase), '空清单失去兜底——清单必须由 execute 传递，不得从 value 反推')
})

test('I1 跨分隔符重组：短语横跨 ID 面字段与模板分隔符 → 整段退避为标记', () => {
  const phrase = 'C1（g1' // candidateId=C1 + 分隔符（ + objectRef=g1 拼成
  const raw = cleanRun('R-x')
  const phrases = collectPhrases(raw, [phrase])
  const masked = enforceOutputPolicy(raw, phrases)
  // 单字段均不含短语（ID 面直通）：value 闸放行且不改写 ID
  assert.equal(masked.candidates[0].candidateId, 'C1')
  assert.equal(masked.candidates[0].objectRef, 'g1')
  const text = renderRunText(masked, phrases)
  assert.ok(!text.includes(phrase), `跨段重组不得泄漏: ${text}`)
  assert.match(text, /^【.+】$/, '拼接后检出短语 → 整段渲染文本替换为标记')
})

test('I1 幂等（copy-on-write）：带清单二次执行同引用，不依赖空化短路', () => {
  const phrase = '确定为洗钱'
  const raw = rawRun(phrase)
  const phrases = collectPhrases(raw, [phrase])
  const masked = enforceOutputPolicy(raw, phrases)
  assert.equal(enforceOutputPolicy(masked, phrases), masked, '带清单二次执行必须同引用')
  assert.equal(enforceOutputPolicy(masked), masked, '清单缺省（命中已空化）同样同引用')
})

test('I2 错误信封：原生 fs 错误只留机器码；受控错误保留语义并剥服务端目录', () => {
  // 原生 fs（errno/syscall 或 errno 词形码）：原文含绝对路径，只留机器码
  const fsErr = Object.assign(
    new Error(`ENOENT: no such file or directory, open 'D:\\data\\knowledge\\sources\\x.json'`),
    { code: 'ENOENT', errno: -4058, syscall: 'open', path: 'D:\\data\\knowledge\\sources\\x.json' },
  )
  const wrapped = asToolError(fsErr)
  assert.equal(wrapped.code, 'ENOENT')
  assert.ok(!wrapped.message.includes('D:\\data'), `fs 原文不得回显绝对路径: ${wrapped.message}`)
  assert.ok(!wrapped.message.includes('no such file'), `fs 错误原文不得回显: ${wrapped.message}`)
  // errno 词形码（无 errno 属性的同形错误）同样只留码
  const word = asToolError(Object.assign(new Error('EACCES: permission denied, open \'C:\\x\''), { code: 'EACCES' }))
  assert.equal(word.code, 'EACCES')
  assert.ok(!word.message.includes('C:\\x'))
  // 受控业务错误：语义保留、服务端目录剥除
  const dir = 'D:\\secret\\workspace\\aml\\1.0.0'
  const biz = Object.assign(new Error(`missing package.yaml meta in ${dir}`), { code: 'PACKAGE_MALFORMED' })
  const kept = asToolError(biz, [dir])
  assert.equal(kept.code, 'PACKAGE_MALFORMED')
  assert.ok(kept.message.includes('<pkg>'), '业务语义保留（目录占位）')
  assert.ok(!kept.message.includes('D:\\secret'), '服务端目录不得回显')
  // 非 Error → RUN_FAILED 受控
  assert.equal(asToolError('boom').code, 'RUN_FAILED')
})

test('I1 错误面：入参回显含红线短语 → 整段退避且保留机器码（toolExecute/asToolError）', async () => {
  const phrase = '确定为洗钱'
  // asToolError 直传清单
  const raw = new AgentToolError('OBJECT_NOT_GRANTED', `objectRef ${phrase} 不在收权清单`)
  const retreated = asToolError(raw, [], [phrase])
  assert.equal(retreated.code, 'OBJECT_NOT_GRANTED', '机器码必须保留')
  assert.ok(!retreated.message.includes(phrase), `错误面不得回显短语: ${retreated.message}`)
  assert.ok(retreated.message.includes('已整段脱敏'), retreated.message)
  // 无短语命中时业务语义原样保留
  const plain = asToolError(new AgentToolError('NOT_FOUND', '包不存在: no-pkg@1.0.0'), [], [phrase])
  assert.equal(plain.message, '包不存在: no-pkg@1.0.0')
  // toolExecute 惰性 getter：仅 catch 时求值
  const exec = toolExecute(
    () => {
      throw new AgentToolError('INVALID_ARGS', `candidate ${phrase} 缺少 features 对象`)
    },
    [],
    () => [phrase],
  )
  await assert.rejects(
    () => exec({}),
    (e) => {
      assert.ok(e instanceof AgentToolError)
      assert.equal(e.code, 'INVALID_ARGS')
      assert.ok(!e.message.includes(phrase), e.message)
      return true
    },
  )
  // 无清单时退化为原语义（与修复前等价，不误伤）
  assert.equal(retreatPhraseEcho(`x ${phrase} y`, []), `x ${phrase} y`)
  assert.equal(retreatPhraseEcho('safe', [phrase]), 'safe')
})

test('I5 契约验形：evidence/missing/hits 错型落 INVALID_TOOL_OUTPUT，render 不再可能裸抛', () => {
  const dataset = loadDatasetFromArgs({ datasetPath: AML_RUN }, BASE)
  const good = runScenario(AML_DIR, 'SCN-AML-FIND-CLUES', dataset)
  const first = (mut) => ({
    ...good,
    candidates: good.candidates.map((c, i) => (i === 0 ? mut(c) : c)),
  })
  const cases = [
    first((c) => ({ ...c, evidenceChains: [{ ruleId: 123, evidence: 'x', score: 0.5 }] })),
    first((c) => ({ ...c, evidenceChains: [{ ruleId: 'R', evidence: null, score: 0.5 }] })),
    first((c) => ({ ...c, pendingChecks: [{ note: 'n', missing: 'not-an-array' }] })),
    first((c) => ({ ...c, pendingChecks: [{ note: 'n', missing: [1, 2] }] })),
    first((c) => ({ ...c, pendingChecks: [{ missing: [] }] })),
    first((c) => ({ ...c, hitRuleIds: [42] })),
    first((c) => ({ ...c, narrative: [null] })),
    {
      ...good,
      audit: { ...good.audit, forbiddenPhraseHits: [{ phrase: 'x' }] },
    },
  ]
  for (const bad of cases) {
    expectCode(() => assertRunContract(bad), 'INVALID_TOOL_OUTPUT')
  }
})

/* ── run-insight 新出口同族穷举（I1–I5）：compare_runs / run_scenarios / export_audit ── */

const PHRASE = '认定洗钱' // aml 场景红线实词

const diffBase = () => ({
  runIdA: 'run-aaaaaaaa',
  runIdB: 'run-bbbbbbbb',
  scenarioA: 'SCN-A',
  scenarioB: 'SCN-B',
  packageA: { name: 'p', version: '1.0.0' },
  packageB: { name: 'p', version: '1.1.0' },
  sameDataset: true,
  candidates: [{
    candidateId: 'C1', riskScoreA: 0.4, riskScoreB: 0.7, riskScoreDelta: 0.3,
    hitRuleIdsAdded: ['R2'], hitRuleIdsRemoved: [],
    pendingChecksAdded: [`疑似${PHRASE}待核实`], pendingChecksRemoved: [],
  }],
  excludedAdded: [], excludedRemoved: [],
  auditPassedA: true, auditPassedB: true,
  humanReviewRequired: true,
})

test('I1 compare 出口：value/render 双闸整值重遮；ID 面撞短语 fail-loud；模板拼接碰撞整段兜底', () => {
  const diff = diffBase()
  const masked = enforceOutputPolicy(diff, [PHRASE])
  assert.equal(masked.candidates[0].pendingChecksAdded[0], '【禁语已脱敏】')
  assert.equal(masked.candidates[0].candidateId, 'C1', 'ID 面不改写')
  const text = renderRunDiffText(masked, [PHRASE])
  assert.ok(!text.includes(PHRASE), `compare render 不得泄漏短语: ${text}`)
  // ID 面（runIdA）撞短语：fail-loud，拒绝产出，错误不回显短语
  const bad = { ...diff, runIdA: `run-${PHRASE}` }
  try {
    enforceOutputPolicy(bad, [PHRASE])
    assert.fail('期望 INVALID_TOOL_OUTPUT')
  } catch (e) {
    assert.ok(e instanceof AgentToolError && e.code === 'INVALID_TOOL_OUTPUT')
    assert.ok(!e.message.includes(PHRASE), e.message)
  }
  // 模板拼接碰撞（同族：短语由 render 分隔符拼接成句，单字段均不含）→ 拼接后整段兜底
  const collide = '0.4 → 0.7'
  const recombined = renderRunDiffText(diff, [collide])
  assert.ok(!recombined.includes(collide), `拼接成句不得泄漏: ${recombined}`)
  assert.match(recombined, /^【.+】$/, '拼接后检出短语 → 整段渲染文本替换为标记')
})

test('I1 batch 出口：假场景 ID 回显撞红线 → 错误面整段退避；ID 面 fail-loud 拒产出', () => {
  const root = mkdtempSync(join(tmpdir(), 'onto-as-batch-'))
  try {
    const ws = new PackageWorkspace(root)
    const dir = ws.versionDir('aml-analysis', '1.0.0')
    cpSync(AML_DIR, dir, { recursive: true })
    derivePackage(dir)
    const pkg = loadPackage(dir)
    const dataset = loadDatasetFromArgs({ datasetPath: AML_RUN }, BASE)
    const out = runScenarioBatch({ ws, pkg, versionDir: dir, dataset, ids: ['SCN-AML-FIND-CLUES', `X-${PHRASE}`] })
    const [good, bad] = out.results
    assert.equal(good.status, 'ok')
    assert.equal(bad.status, 'error')
    assert.equal(bad.error.code, 'NOT_FOUND')
    // 错误面：message 整段退避（机器码保留）
    assert.ok(!bad.error.message.includes(PHRASE), `error.message 须整段退避: ${bad.error.message}`)
    // 工具出口闸：scenarioId 撞红线（ID 面）→ fail-loud 拒绝产出，不回显短语（S2.3 口径）
    try {
      enforceOutputPolicy(out, [PHRASE])
      assert.fail('期望 INVALID_TOOL_OUTPUT')
    } catch (e) {
      assert.ok(e instanceof AgentToolError && e.code === 'INVALID_TOOL_OUTPUT')
      assert.ok(!e.message.includes(PHRASE), e.message)
    }
    // 干净场景 ID（含真不存在项）：出口经 value 闸后零短语
    const cleanOut = runScenarioBatch({ ws, pkg, versionDir: dir, dataset, ids: ['SCN-AML-FIND-CLUES', 'SCN-NOPE'] })
    assert.equal(cleanOut.results[1].error.code, 'NOT_FOUND')
    const masked = enforceOutputPolicy(cleanOut, [PHRASE])
    assert.ok(!JSON.stringify(masked).includes(PHRASE), '出口零短语')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('I1 export 出口：摘要零短语；runId 撞红线（ID 面）fail-loud，locator 不回显绝对路径', () => {
  const rec = buildRunRecord({
    package: { name: 'p', version: '1.0.0' },
    dataset: { objects: [], relations: [], candidates: [] },
    result: {
      ...cleanRun(`run-${PHRASE}`),
      audit: {
        checks: [],
        forbiddenPhraseHits: [{ phrase: PHRASE, where: '$.x' }],
        passed: true,
      },
    },
    redlines: [PHRASE],
  })
  const summary = exportSummaryOf({ locator: `runs/exports/${rec.runId}.json`, archive: { ...rec, archivedAt: 't' } })
  try {
    enforceOutputPolicy(summary, [PHRASE])
    assert.fail('期望 INVALID_TOOL_OUTPUT')
  } catch (e) {
    assert.ok(e instanceof AgentToolError && e.code === 'INVALID_TOOL_OUTPUT')
    assert.ok(!e.message.includes(PHRASE), e.message)
  }
  const clean = exportSummaryOf({
    locator: 'runs/exports/run-abc12345.json',
    archive: { ...rec, runId: 'run-abc12345', archivedAt: 't' },
  })
  const masked = enforceOutputPolicy(clean, [PHRASE])
  assert.ok(!JSON.stringify(masked).includes(PHRASE))
  assert.ok(!masked.locator.includes(':\\') && !masked.locator.startsWith('/'), 'locator 恒 workspace 相对')
})

test('I2/I3 runstore 围栏：新记录面非法 runId/穿越全拒，消息零绝对路径', () => {
  const root = mkdtempSync(join(tmpdir(), 'onto-as-rec-'))
  try {
    for (const evil of ['../evil', 'a\\b', 'a:b', '..', 'C:\\x', '/abs']) {
      assert.throws(
        () => loadRunRecord(root, evil),
        (e) => {
          assert.ok(e instanceof PackageStoreError)
          assert.equal(e.code, 'INVALID_ARGS')
          assert.ok(!e.message.includes(root), `不得回显服务端根: ${e.message}`)
          return true
        },
      )
    }
    // NOT_FOUND 只回显调用方 runId，不回显 resolve 后路径
    try {
      loadRunRecord(root, 'run-none000')
      assert.fail('期望 NOT_FOUND')
    } catch (e) {
      assert.ok(e instanceof PackageStoreError && e.code === 'NOT_FOUND')
      assert.ok(e.message.includes('run-none000'))
      assert.ok(!e.message.includes(root) && !e.message.includes('\\runs\\'), e.message)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('I4 收权：新工具面 objectId/objectRef 入参同过 guard，未命中即拒（deny-by-default 不旁路）', () => {
  // 新工具未带对象面：guard 空过
  assert.equal(grantGuardDecision('compare_runs', { runIdA: 'run-a', runIdB: 'run-b' }, () => []), undefined)
  assert.equal(grantGuardDecision('export_audit', { runId: 'run-a' }, () => []), undefined)
  // 注入 objectId：同 guard 收口，未收权即拒
  for (const tool of ['compare_runs', 'run_scenarios', 'export_audit']) {
    const denial = grantGuardDecision(tool, { runId: 'run-a', objectId: 'OBJ-NOPE' }, () => [])
    assert.ok(typeof denial === 'string' && denial.includes('OBJECT_NOT_GRANTED'), `${tool} 应拒: ${String(denial)}`)
  }
})

test('I5 新出口契约验形：diff/batch 畸形落 INVALID_TOOL_OUTPUT（不裸抛 TypeError）', () => {
  const badDiff = [
    { ...diffBase(), candidates: 'not-array' },
    { ...diffBase(), candidates: [{ candidateId: 'C', riskScoreA: NaN, riskScoreB: 1, riskScoreDelta: null, hitRuleIdsAdded: [], hitRuleIdsRemoved: [], pendingChecksAdded: [], pendingChecksRemoved: [] }] },
    { ...diffBase(), humanReviewRequired: false },
    { ...diffBase(), excludedAdded: [{ candidateId: 1, ruleId: 'R' }] },
    // packageA/packageB 漏验会让 renderRunDiffText 裸抛 TypeError——I5 须兜住
    { ...diffBase(), packageA: null },
    { ...diffBase(), packageB: { name: 1, version: '1.0.0' } },
  ]
  for (const d of badDiff) {
    assert.throws(() => assertDiffContract(d), (e) => {
      assert.ok(e instanceof AgentToolError, `不得裸抛: ${e}`)
      assert.equal(e.code, 'INVALID_TOOL_OUTPUT')
      return true
    })
  }
  const badBatch = [
    { results: 'not-array', humanReviewRequired: true },
    { results: [{ scenarioId: 'S', status: 'ok', runId: 'run-a', summary: { candidateCount: 1, hitRuleCount: 1, excludedCount: 0, auditPassed: true, forbiddenPhraseHitCount: 0, humanReviewRequired: true } }], humanReviewRequired: true },
    { results: [{ scenarioId: 'S', status: 'ok', runId: 'run-a', summary: { candidateCount: 1, hitRuleCount: 1, excludedCount: 0, auditPassed: true, forbiddenPhraseHitCount: 0, humanReviewRequired: false } }], humanReviewRequired: true },
    { results: [], humanReviewRequired: 'yes' },
  ]
  // 第二个是合法形（control）；其余拒
  assertBatchContract(badBatch[1])
  for (const b of [badBatch[0], badBatch[2], badBatch[3]]) {
    assert.throws(() => assertBatchContract(b), (e) => {
      assert.ok(e instanceof AgentToolError, `不得裸抛: ${e}`)
      assert.equal(e.code, 'INVALID_TOOL_OUTPUT')
      return true
    })
  }
  // render 不因错型裸抛（已验形后仍防）
  assert.doesNotThrow(() => renderBatchText(badBatch[1]))
  assert.doesNotThrow(() => renderRunDiffText(diffBase(), []))
})

/* ── 评审收敛同族补测：三新出口 render 闸 + 错误面退避完整性（I1） ── */

const exportBase = () => ({
  exported: true,
  runId: 'run-abc12345',
  locator: 'runs/exports/run-abc12345.json',
  auditPassed: true,
  candidateCount: 3,
  hitRuleCount: 4,
  excludedCount: 1,
  forbiddenPhraseHitCount: 0,
  humanReviewRequired: true,
})

test('I1 export render 闸：模板固定字面碰撞整段兜底；locator 重遮；runId 撞短语 fail-loud', () => {
  // 模板碰撞：红线短语 ⊂ render 固定字面（「审计导出」「归档」）
  const collide = '审计导出'
  const text = renderExportText(exportBase(), [collide])
  assert.ok(!text.includes(collide), `模板碰撞不得泄漏: ${text}`)
  assert.match(text, /^【.+】$/, '拼接后检出短语 → 整段渲染文本替换为标记')
  // locator 自由段重遮
  const ph = '认定洗钱'
  const poisonedLoc = renderExportText({ ...exportBase(), locator: `runs/exports/认定洗钱.json` }, [ph])
  assert.ok(!poisonedLoc.includes(ph), 'locator 含短语须重遮')
  assert.ok(poisonedLoc.includes('humanReviewRequired=true'))
  // runId（ID 面）撞短语 → fail-loud 且不回显
  try {
    renderExportText({ ...exportBase(), runId: `run-${ph}` }, [ph])
    assert.fail('期望 INVALID_TOOL_OUTPUT')
  } catch (e) {
    assert.ok(e instanceof AgentToolError && e.code === 'INVALID_TOOL_OUTPUT')
    assert.ok(!e.message.includes(ph), e.message)
  }
})

test('I1 batch render 清单 = 显式（包级全红线）∪ recall：失败/未跑场景红线也可兜底', () => {
  const ph = '批量运行' // render 固定字面（标题）
  const out = {
    results: [{ scenarioId: 'SCN-A', status: 'error', error: { code: 'NOT_FOUND', message: '场景 SCN-A 不存在' } }],
    humanReviewRequired: true,
  }
  // 仅 recall（无 ok 项 → 空）：失去兜底——反证清单必须显式带包级红线
  const blind = renderBatchText(out, [])
  assert.ok(blind.includes(ph), '空清单失去兜底——挂点病同族')
  // 显式包级红线：模板碰撞整段兜底
  const gated = renderBatchText(out, [ph])
  assert.ok(!gated.includes(ph), `模板碰撞不得泄漏: ${gated}`)
  assert.match(gated, /^【.+】$/)
  // recall 与显式合并：ok 项 recall 补充命中短语（同样可撞模板「候选=」）
  rememberPhrases('run-rc111111', ['候选='])
  const merged = renderBatchText(
    {
      results: [
        { scenarioId: 'SCN-A', status: 'ok', runId: 'run-rc111111', summary: { candidateCount: 1, hitRuleCount: 1, excludedCount: 0, auditPassed: true, forbiddenPhraseHitCount: 0, humanReviewRequired: true } },
      ],
      humanReviewRequired: true,
    },
    [],
  )
  assert.ok(!merged.includes('候选='), 'recall 源并入遮蔽')
  assert.match(merged, /^【.+】$/, '拼接后检出 → 整段退避')
})

test('I1 compare/export 错误面：runId 撞红线且记录不存在 → 工作区全红线退避（不漏出）', () => {
  const root = mkdtempSync(join(tmpdir(), 'onto-as-fallback-'))
  try {
    const ws = new PackageWorkspace(root)
    const dir = ws.versionDir('aml-analysis', '1.0.0')
    cpSync(AML_DIR, dir, { recursive: true })
    // 目标记录不存在：per-run 清单取不到，退避源必须是工作区全场景红线
    const list = redlinesForRuns(ws, { runId: `run-${PHRASE}` })
    assert.ok(list.includes(PHRASE), `退避清单须含工作区红线: ${JSON.stringify(list)}`)
    // NOT_FOUND 回显撞红线的 runId → 整段退避且保留机器码
    const err = asToolError(new AgentToolError('NOT_FOUND', `run run-${PHRASE} not found`), [], list)
    assert.equal(err.code, 'NOT_FOUND')
    assert.ok(!err.message.includes(PHRASE), `错误面不得泄漏短语: ${err.message}`)
    assert.ok(err.message.includes('已整段脱敏'), err.message)
    // 无短语时不误伤
    const clean = asToolError(new AgentToolError('NOT_FOUND', 'run run-none000 not found'), [], list)
    assert.ok(clean.message.includes('run-none000'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
