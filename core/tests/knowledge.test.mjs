/** 知识库管线验收（规范 §5 / §11.3）：五类原料、结论不进 O3、强制人审、LLM 不直写。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KnowledgeStore, HeuristicLlm, applyDraftToPackage, loadPackage, savePackage, readPackageMeta } from '../dist/index.js'
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
