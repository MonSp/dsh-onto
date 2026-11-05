/**
 * 攻击面回归清单（round-13）：把 12 轮评审固化过的变体与本轮修复收进单表，
 * 防线改动必须全表重放。覆盖：收权 deny-by-default、出口契约、禁语脱敏组合、
 * 派生门禁、skills 去重确定性。
 */
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  AgentToolError,
  assertDatasetGranted,
  assertRunContract,
  grantGuardDecision,
  loadDatasetFromArgs,
  loadToolPackage,
  maskForbiddenPhrases,
  readToolContracts,
  renderRunText,
  validateDatasetShape,
} from '../dist/agent-tools.js'
import { dedupeSkillNames, isCurrentWinner, pickSkillSources } from '../dist/agent-skills.js'
import { PackageWorkspace, runScenario } from '@dsh-onto/core'

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const AML_DIR = join(REPO, 'packages', 'aml', '1.0.0')
const AML_RUN = join(REPO, 'examples', 'aml-run.json')

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
  const dataset = loadDatasetFromArgs({ datasetPath: AML_RUN })
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
  const dataset = loadDatasetFromArgs({ datasetPath: AML_RUN })
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

  const masked = maskForbiddenPhrases(raw)
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
  assert.equal(maskForbiddenPhrases(masked), masked)
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
  const masked = maskForbiddenPhrases(raw)
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
  const masked = maskForbiddenPhrases(raw)
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
    maskForbiddenPhrases(raw)
  } catch (e) {
    err = e
  }
  assert.ok(err instanceof AgentToolError, '不改写与零容忍不可兼得时必须受控失败')
  assert.equal(err.code, 'INVALID_TOOL_OUTPUT')
  assert.ok(!err.message.includes(phrase), `错误消息不得回显短语: ${err.message}`)
})

test('嵌套禁语幂等：长短语对先换长者，二次脱敏同引用', () => {
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
  const masked = maskForbiddenPhrases(raw)
  const json = JSON.stringify(masked)
  assert.ok(!json.includes(shortP) && !json.includes(longP), '嵌套短语对均须清除')
  assert.ok(!json.includes('该【'), '长语优先替换，不得留「该+标记」残片')
  assert.equal(maskForbiddenPhrases(masked), masked, '二次脱敏同引用（phrase 空化锚点）')
})

test('禁语恰为占位标记时仍脱敏（不因标记过滤而原样留存）', () => {
  const phrase = '【禁语已脱敏】' // 构造形态：禁语字面即默认标记
  const raw = rawRun(phrase)
  const masked = maskForbiddenPhrases(raw)
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
