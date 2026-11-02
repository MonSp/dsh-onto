/** 知识库管线验收（规范 §5 / §11.3）：五类原料、结论不进 O3、强制人审、LLM 不直写。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KnowledgeStore, HeuristicLlm, applyDraftToPackage, loadPackage, savePackage, readPackageMeta, validateDraftItem } from '../dist/index.js'
import { minimalPkg, mkWorkspaceWithPkg, rmWorkspace, mkWorkspace } from './helpers.mjs'

const llm = new HeuristicLlm()

function mkStore() {
  const ws = mkWorkspace()
  const store = new KnowledgeStore(ws.root)
  return { ws, store, root: ws.root }
}

test('五类原料均可解析出候选', async () => {
  const { store, root } = mkStore()
  try {
    const samples = {
      LEGACY_SYS: '风控算法第3节：分散转入集中转出权重 0.25，夜间交易阈值 0.6。\n代发工资客户降权 0.3。\n该账户涉嫌洗钱。',
      CASE_SAMPLE: 'acct_no,amount,channel\n6222,90000,mobile\n6223,120,counter',
      POLICY: '制度规定：单日累计转出不得超过 500000 元。\n严禁为身份不明客户开立账户。',
      SCHEMA_API: 'acct_no: string\nacct_type: string\nPOST /api/txn/query',
      WORK_ORDER: '目标：识别可疑交易线索\n输出：候选名单、风险分\n边界：仅输出候选',
    }
    for (const [sourceType, content] of Object.entries(samples)) {
      const src = store.uploadSource({ packageId: 'pkg-x', sourceType, name: `s-${sourceType}`, content })
      const { added } = await store.parseSource(src.id, llm)
      assert.ok(added.length > 0, `${sourceType} should yield candidates`)
    }
    assert.equal(store.listSources('pkg-x').length, 5)
  } finally {
    rmWorkspace(root)
  }
})

test('结论性表述只落 RedLine 红线，禁止进 O3 输出契约（§5.3.2）', async () => {
  const { store, root } = mkStore()
  try {
    const src = store.uploadSource({
      packageId: 'pkg-x',
      sourceType: 'LEGACY_SYS',
      name: 'legacy-algo',
      content: '该账户涉嫌洗钱。\n判定：该客户系诈骗分子。\n权重 0.4 的归集特征。',
    })
    const { added } = await store.parseSource(src.id, llm)
    const conclusions = added.filter((c) => c.conclusionLike)
    assert.ok(conclusions.length > 0)
    for (const c of conclusions) {
      assert.equal(c.targetKind, 'RedLine')
    }
    // 非 RedLine 的结论候选禁止批准
    const nonRed = added.find((c) => c.name.includes('归集'))
    assert.ok(nonRed)
  } finally {
    rmWorkspace(root)
  }
})

test('结论性候选批准为非 RedLine 目标被拒（CONCLUSION_BLOCKED）', async () => {
  const { store, root } = mkStore()
  try {
    const src = store.uploadSource({
      packageId: 'pkg-x',
      sourceType: 'LEGACY_SYS',
      name: 'legacy',
      content: '权重 0.5 归集特征。\n该客户系诈骗分子。',
    })
    const { added } = await store.parseSource(src.id, llm)
    const red = added.find((c) => c.conclusionLike)
    // 结论 → RedLine 可以批准
    const approved = store.reviewCandidate(red.id, 'approve')
    assert.equal(approved.status, 'approved')
    // 防御：即便 LLM 把结论编成 ScoreRule 候选，批准也必须被拒
    const queuePath = join(store.root, 'queue.json')
    const queue = JSON.parse(readFileSync(queuePath, 'utf8'))
    queue.push({
      id: 'dc-forced-conclusion',
      packageId: 'pkg-x',
      sourceId: src.id,
      layer: 'O2',
      targetKind: 'ScoreRule',
      name: '洗钱判定规则',
      payload: { name: '洗钱判定规则', weight: 0.1, expression: '1' },
      confidence: 0.9,
      rationale: '该账户认定洗钱',
      status: 'pending',
      forcedReview: false,
      conclusionLike: true,
      createdAt: new Date().toISOString(),
    })
    writeFileSync(queuePath, JSON.stringify(queue, null, 2))
    assert.throws(() => store.reviewCandidate('dc-forced-conclusion', 'approve'), /结论|CONCLUSION/)
  } finally {
    rmWorkspace(root)
  }
})

test('confidence < 0.75 强制人审；LLM 永不直写生效版', async () => {
  const { store, root } = mkStore()
  try {
    const src = store.uploadSource({
      packageId: 'pkg-x',
      sourceType: 'CASE_SAMPLE',
      name: 'sample',
      content: 'col_amount,col_channel\n100,mobile\n200,counter',
    })
    const { added } = await store.parseSource(src.id, llm)
    const low = added.filter((c) => c.confidence < 0.75)
    assert.ok(low.length > 0, 'low-confidence drafts exist')
    for (const c of low) assert.equal(c.forcedReview, true)
    // 全部候选初始 pending —— 解析从不产生 approved
    for (const c of added) assert.equal(c.status, 'pending')
  } finally {
    rmWorkspace(root)
  }
})

test('幂等：同 (包+层+kind+name) 二次解析跳过', async () => {
  const { store, root } = mkStore()
  try {
    const src = store.uploadSource({
      packageId: 'pkg-x',
      sourceType: 'LEGACY_SYS',
      name: 'algo',
      content: '权重 0.3 的集中转出特征。',
    })
    const { added: first } = await store.parseSource(src.id, llm)
    const { added: second } = await store.parseSource(src.id, llm)
    assert.ok(first.length > 0)
    assert.equal(second.length, 0)
  } finally {
    rmWorkspace(root)
  }
})

test('原料同 sha256 上传幂等', () => {
  const { store, root } = mkStore()
  try {
    const a = store.uploadSource({ packageId: 'pkg-x', sourceType: 'POLICY', name: 'p1', content: '禁止X' })
    const b = store.uploadSource({ packageId: 'pkg-x', sourceType: 'POLICY', name: 'p2', content: '禁止X' })
    assert.equal(a.id, b.id)
    assert.equal(store.listSources('pkg-x').length, 1)
  } finally {
    rmWorkspace(root)
  }
})

test('物化：pending 不得物化；approved 才落包；ISSUED 拒写', async () => {
  const { ws, dir, root } = mkWorkspaceWithPkg()
  try {
    const store = new KnowledgeStore(ws.root)
    const src = store.uploadSource({
      packageId: 'test-pkg',
      sourceType: 'LEGACY_SYS',
      name: 'algo',
      content: '夜间交易权重 0.2。',
    })
    const { added } = await store.parseSource(src.id, llm)
    const scoreDraft = added.find((c) => c.targetKind === 'ScoreRule')
    assert.ok(scoreDraft)
    // pending → 物化跳过
    let res = store.materialize(dir, [scoreDraft.id])
    assert.equal(res.applied.length, 0)
    assert.ok(res.skipped.some((s) => s.id === scoreDraft.id))
    // approve → 物化进包
    store.reviewCandidate(scoreDraft.id, 'approve')
    const before = loadPackage(dir).scoreRules.length
    res = store.materialize(dir, [scoreDraft.id])
    assert.deepEqual(res.applied, [scoreDraft.id])
    assert.equal(loadPackage(dir).scoreRules.length, before + 1)
    // 签发后物化拒绝
    ws.transition('test-pkg', '1.0.0', 'IN_REVIEW')
    ws.transition('test-pkg', '1.0.0', 'ISSUED', '张三')
    assert.equal(readPackageMeta(dir).status, 'ISSUED')
    const src2 = store.uploadSource({
      packageId: 'test-pkg',
      sourceType: 'LEGACY_SYS',
      name: 'algo2',
      content: '快进快出权重 0.25。',
    })
    const { added: added2 } = await store.parseSource(src2.id, llm)
    const draft2 = added2.find((c) => c.targetKind === 'ScoreRule')
    if (draft2) {
      store.reviewCandidate(draft2.id, 'approve')
      assert.throws(() => store.materialize(dir, [draft2.id]), /已签发|PACKAGE_READONLY|readonly/i)
    }
  } finally {
    rmWorkspace(root)
  }
})

test('RedLine 物化只进 forbiddenPhrases（含 mustInclude 清洗）', async () => {
  const { ws, dir, root } = mkWorkspaceWithPkg()
  try {
    const store = new KnowledgeStore(ws.root)
    const src = store.uploadSource({
      packageId: 'test-pkg',
      sourceType: 'POLICY',
      name: 'policy',
      content: '严禁认定洗钱。\n不得确定为地下钱庄。',
    })
    const { added } = await store.parseSource(src.id, llm)
    const red = added.filter((c) => c.targetKind === 'RedLine')
    assert.ok(red.length > 0)
    for (const c of red) store.reviewCandidate(c.id, 'approve')
    const res = store.materialize(dir, red.map((c) => c.id))
    assert.equal(res.applied.length, red.length)
    const pkg = loadPackage(dir)
    const phrases = pkg.scenarios[0].outputContract.forbiddenPhrases
    assert.ok(phrases.length > 1)
    // 输出契约必含项里不得出现结论性表述
    for (const m of pkg.scenarios[0].outputContract.mustInclude) {
      assert.ok(!/认定|确定为|已构成/.test(m))
    }
  } finally {
    rmWorkspace(root)
  }
})

test('LLM 失败回落词面启发（parseWithFallback 语义）', async () => {
  const { store, root } = mkStore()
  try {
    const broken = {
      async parseSource() {
        throw new Error('network down')
      },
    }
    const src = store.uploadSource({
      packageId: 'pkg-x',
      sourceType: 'LEGACY_SYS',
      name: 'algo',
      content: '名单命中权重 0.3。',
    })
    const { added } = await store.parseSource(src.id, broken)
    assert.ok(added.length > 0, 'heuristic fallback yields candidates')
  } finally {
    rmWorkspace(root)
  }
})

test('validateDraftItem：逐条结构校验 layer/targetKind/name/payload/confidence', () => {
  const good = { layer: 'O2', targetKind: 'ScoreRule', name: '规则', payload: { weight: 0.1 }, confidence: 0.8, rationale: 'r' }
  assert.equal(validateDraftItem(good), null)
  assert.equal(validateDraftItem({ ...good, layer: 'O9' }), 'bad layer')
  assert.equal(validateDraftItem({ ...good, targetKind: 'Nope' }), 'bad targetKind')
  assert.equal(validateDraftItem({ ...good, name: '  ' }), 'bad name')
  assert.equal(validateDraftItem({ ...good, payload: null }), 'bad payload')
  assert.equal(validateDraftItem({ ...good, payload: [] }), 'bad payload')
  assert.equal(validateDraftItem({ ...good, confidence: 1.5 }), 'bad confidence')
  assert.equal(validateDraftItem({ ...good, confidence: '0.8' }), 'bad confidence')
  assert.equal(validateDraftItem(null), 'not an object')
  assert.equal(validateDraftItem('x'), 'not an object')
})

test('parseSource 报告：received/accepted/idempotentSkipped/invalidDropped + engine', async () => {
  const { store, root } = mkStore()
  try {
    // 合法 + 非法混杂的假 LLM
    const mixed = {
      async parseSource() {
        return {
          items: [
            { layer: 'O2', targetKind: 'ScoreRule', name: '有效规则', payload: { weight: 0.2, expression: '1' }, confidence: 0.9, rationale: 'ok' },
            { layer: 'O2', targetKind: 'ScoreRule', name: '', payload: {}, confidence: 0.9, rationale: 'bad name' },
            { layer: 'OX', targetKind: 'ScoreRule', name: '坏层', payload: {}, confidence: 0.5, rationale: 'bad layer' },
            { layer: 'O1', targetKind: 'ObjectType', name: '样本对象', payload: { name: '样本对象' }, confidence: 'high', rationale: 'bad conf' },
          ],
        }
      },
    }
    const src = store.uploadSource({ packageId: 'pkg-x', sourceType: 'LEGACY_SYS', name: 'algo', content: '权重 0.2 的特征。' })
    const r1 = await store.parseSource(src.id, mixed)
    assert.equal(r1.report.received, 4)
    assert.equal(r1.report.accepted, 1)
    assert.equal(r1.report.invalidDropped, 3)
    assert.equal(r1.report.idempotentSkipped, 0)
    assert.equal(r1.report.engine, 'heuristic') // 假 LLM 非 DeepSeek 实例 → heuristic 标注
    // 二次解析：同名幂等跳过
    const r2 = await store.parseSource(src.id, mixed)
    assert.equal(r2.report.accepted, 0)
    assert.equal(r2.report.idempotentSkipped, 1)
    assert.equal(r2.report.invalidDropped, 3)
    // heuristic 引擎也带报告
    const r3 = await store.parseSource(src.id, new HeuristicLlm())
    assert.ok(r3.report.engine === 'heuristic' || r3.report.engine === 'deepseek')
    assert.equal(typeof r3.report.received, 'number')
  } finally {
    rmWorkspace(root)
  }
})

test('updateCandidate：批准前可编辑载荷；finalized 拒绝；confidence 重算 forcedReview', async () => {
  const { store, root } = mkStore()
  try {
    const src = store.uploadSource({
      packageId: 'pkg-x',
      sourceType: 'LEGACY_SYS',
      name: 'algo',
      content: '权重 0.4 的归集特征。',
    })
    const { added } = await store.parseSource(src.id, new HeuristicLlm())
    const draft = added.find((c) => c.targetKind === 'ScoreRule')
    assert.ok(draft)
    const updated = store.updateCandidate(draft.id, {
      payload: { ...draft.payload, weight: 0.35, expression: 'min(1, f1)' },
      confidence: 0.9,
    })
    assert.equal(updated.payload.weight, 0.35)
    assert.equal(updated.confidence, 0.9)
    assert.equal(updated.forcedReview, false)
    // 非法 confidence 拒绝
    assert.throws(() => store.updateCandidate(draft.id, { confidence: 2 }), /confidence/)
    // 批准后不可再改
    store.reviewCandidate(draft.id, 'approve')
    assert.throws(() => store.updateCandidate(draft.id, { name: 'x' }), /already/)
  } finally {
    rmWorkspace(root)
  }
})

test('previewMaterialize：干跑返回将物化的元素，不落盘', async () => {
  const { ws, dir, root } = mkWorkspaceWithPkg()
  try {
    const store = new KnowledgeStore(ws.root)
    const before = loadPackage(dir)
    const beforeRules = before.scoreRules.length
    const beforePhrases = before.scenarios[0].outputContract.forbiddenPhrases.length
    const src = store.uploadSource({
      packageId: 'test-pkg',
      sourceType: 'LEGACY_SYS',
      name: 'algo',
      content: '夜间交易权重 0.2。\n该账户认定洗钱。',
    })
    const { added } = await store.parseSource(src.id, new HeuristicLlm())
    const ids = added.map((c) => c.id)
    const previews = store.previewMaterialize(dir, ids)
    assert.equal(previews.length, added.length)
    // 未批准也能预览
    const scoreP = previews.find((p) => p.targetKind === 'ScoreRule')
    assert.ok(scoreP && scoreP.ok, scoreP?.error)
    assert.ok(scoreP.summary.includes('ScoreRule'))
    assert.ok(scoreP.element && typeof scoreP.element === 'object')
    const redP = previews.find((p) => p.targetKind === 'RedLine')
    if (redP) {
      assert.ok(redP.ok, redP.error)
      assert.ok(redP.summary.includes('禁语'))
      assert.ok(Array.isArray(redP.element.phrases))
    }
    // 干跑不落盘
    const after = loadPackage(dir)
    assert.equal(after.scoreRules.length, beforeRules)
    assert.equal(after.scenarios[0].outputContract.forbiddenPhrases.length, beforePhrases)
    // 不存在的候选 → ok:false
    const miss = store.previewMaterialize(dir, ['dc-nope'])
    assert.equal(miss[0].ok, false)
  } finally {
    rmWorkspace(root)
  }
})
