/** 知识库管线验收（规范 §5 / §11.3）：五类原料、结论不进 O3、强制人审、LLM 不直写。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KnowledgeStore, HeuristicLlm, applyDraftToPackage, draftCandidateId, knowledgeSourceId, loadPackage, savePackage, readPackageMeta, validateDraftItem, derivePackage, verifyDerived, readManifest } from '../dist/index.js'
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

test('uploadSource packageId 归一：name@version 入库剥成裸名，listSources 双形态可见', () => {
  const { store, root } = mkStore()
  try {
    const rec = store.uploadSource({
      packageId: 'pkg-x@1.0.0',
      sourceType: 'POLICY',
      name: 'p1',
      content: '唯一内容ABC',
    })
    assert.equal(rec.packageId, 'pkg-x')
    assert.equal(store.listSources('pkg-x').length, 1)
    assert.equal(store.listSources('pkg-x@1.0.0').length, 1)
    // 幂等：同内容换写法再传不重复（归一后比对）
    const again = store.uploadSource({
      packageId: 'pkg-x',
      sourceType: 'POLICY',
      name: 'p2',
      content: '唯一内容ABC',
    })
    assert.equal(again.id, rec.id)
    assert.equal(store.listSources().length, 1)
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

test('validateDraftItem：逐条结构校验 layer/targetKind/name/payload/confidence + 数值字段', () => {
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
  // rationale：可缺省，出现即须字符串
  assert.equal(validateDraftItem({ ...good, rationale: undefined }), null)
  assert.equal(validateDraftItem({ ...good, rationale: 123 }), 'bad rationale')
  assert.equal(validateDraftItem({ ...good, rationale: { a: 1 } }), 'bad rationale')
  // 数值字段：出现即须有限数字（weight/threshold/factor）
  assert.equal(validateDraftItem({ ...good, payload: { weight: 'abc' } }), 'bad payload.weight')
  assert.equal(validateDraftItem({ ...good, payload: { weight: NaN } }), 'bad payload.weight')
  assert.equal(validateDraftItem({ ...good, payload: { weight: Infinity } }), 'bad payload.weight')
  assert.equal(validateDraftItem({ ...good, payload: { weight: 0.1, threshold: '0.5' } }), 'bad payload.threshold')
  assert.equal(validateDraftItem({ ...good, payload: { weight: 0.1, threshold: null } }), null)
  assert.equal(validateDraftItem({ ...good, payload: {} }), null)
  const ex = { layer: 'O2', targetKind: 'ExclusionRule', name: '排除', payload: {}, confidence: 0.8, rationale: 'r' }
  assert.equal(validateDraftItem({ ...ex, payload: { factor: 'x' } }), 'bad payload.factor')
  assert.equal(validateDraftItem({ ...ex, payload: { factor: 0.3 } }), null)
  // ScenarioCard 嵌套数值：reviewGate.threshold 出现即须有限数字
  const sc = { layer: 'O3', targetKind: 'ScenarioCard', name: '场景', payload: {}, confidence: 0.8, rationale: 'r' }
  assert.equal(validateDraftItem({ ...sc, payload: { reviewGate: { threshold: NaN } } }), 'bad payload.reviewGate.threshold')
  assert.equal(validateDraftItem({ ...sc, payload: { reviewGate: { threshold: Infinity } } }), 'bad payload.reviewGate.threshold')
  assert.equal(validateDraftItem({ ...sc, payload: { reviewGate: 'x' } }), 'bad payload.reviewGate')
  assert.equal(validateDraftItem({ ...sc, payload: { reviewGate: { threshold: 0.5 } } }), null)
  assert.equal(validateDraftItem({ ...sc, payload: { reviewGate: {} } }), null)
  // scoreRefs 显式空数组起草即拒（与 validate 同口径）
  assert.match(
    String(validateDraftItem({ ...sc, payload: { scoreRefs: [] } })),
    /scoreRefs/,
  )
  assert.equal(validateDraftItem({ ...sc, payload: { scoreRefs: ['RULE-TST-S1'] } }), null)
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
            { layer: 'O2', targetKind: 'ScoreRule', name: '坏权重', payload: { weight: 'abc' }, confidence: 0.9, rationale: 'bad weight' },
          ],
        }
      },
    }
    const src = store.uploadSource({ packageId: 'pkg-x', sourceType: 'LEGACY_SYS', name: 'algo', content: '权重 0.2 的特征。' })
    const r1 = await store.parseSource(src.id, mixed)
    assert.equal(r1.report.received, 5)
    assert.equal(r1.report.accepted, 1)
    assert.equal(r1.report.invalidDropped, 4)
    assert.equal(r1.report.idempotentSkipped, 0)
    assert.equal(r1.report.engine, 'heuristic') // 假 LLM 非 DeepSeek 实例 → heuristic 标注
    // 二次解析：同名幂等跳过
    const r2 = await store.parseSource(src.id, mixed)
    assert.equal(r2.report.accepted, 0)
    assert.equal(r2.report.idempotentSkipped, 1)
    assert.equal(r2.report.invalidDropped, 4)
    // heuristic 引擎也带报告
    const r3 = await store.parseSource(src.id, new HeuristicLlm())
    assert.equal(r3.report.engine, 'heuristic')
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
    // 合入后复检：空 name / 非法数值字段 / 非对象 payload 拒存
    assert.throws(() => store.updateCandidate(draft.id, { name: '  ' }), /invalid/)
    assert.throws(() => store.updateCandidate(draft.id, { name: 'x', payload: { weight: 'abc' } }), /invalid/)
    assert.throws(() => store.updateCandidate(draft.id, { payload: { weight: NaN } }), /invalid/)
    assert.throws(() => store.updateCandidate(draft.id, { payload: null }), /invalid/)
    // 拒存后原草案不动
    assert.equal(store.getCandidate(draft.id).payload.weight, 0.35)
    // 批准后不可再改
    store.reviewCandidate(draft.id, 'approve')
    assert.throws(() => store.updateCandidate(draft.id, { name: 'x' }), /already/)
  } finally {
    rmWorkspace(root)
  }
})

test('改名不破坏同源幂等：sourceName 稳定键', async () => {
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
    assert.equal(draft.sourceName, draft.name)
    store.updateCandidate(draft.id, { name: '改名后的规则' })
    assert.equal(store.getCandidate(draft.id).name, '改名后的规则')
    // 改名同步 payload.name（与旧名一致的自动副本）——物化写入用的是它
    assert.equal(store.getCandidate(draft.id).payload.name, '改名后的规则')
    // 同源二次解析仍按解析原始名去重，不再造新候选
    const r2 = await store.parseSource(src.id, new HeuristicLlm())
    assert.equal(r2.report.accepted, 0)
    assert.ok(r2.report.idempotentSkipped >= 1)
    assert.equal(store.listCandidates({ packageId: 'pkg-x' }).length, added.length)
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
    assert.ok(redP, 'RedLine 预览应存在（夹具含结论句）')
    assert.ok(redP.ok, redP.error)
    assert.ok(redP.summary.includes('禁语'))
    assert.ok(Array.isArray(redP.element.phrases))
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

test('跨包候选：materialize/previewMaterialize 按 packageId 拒绝', async () => {
  const { ws, dir, root } = mkWorkspaceWithPkg() // meta.name = 'test-pkg'
  try {
    const otherDir = ws.createPackage({ name: 'other-pkg', version: '1.0.0', domain: 'TST' })
    const other = minimalPkg()
    other.meta = { ...other.meta, name: 'other-pkg' }
    savePackage(otherDir, other)

    const store = new KnowledgeStore(ws.root)
    const src = store.uploadSource({
      packageId: 'test-pkg',
      sourceType: 'LEGACY_SYS',
      name: 'algo',
      content: '权重 0.2 的特征。',
    })
    const { added } = await store.parseSource(src.id, new HeuristicLlm())
    const draft = added.find((c) => c.targetKind === 'ScoreRule')
    assert.ok(draft)
    store.reviewCandidate(draft.id, 'approve')

    // 预览进 other-pkg → 拒绝
    const pvOther = store.previewMaterialize(otherDir, [draft.id])
    assert.equal(pvOther[0].ok, false)
    assert.match(pvOther[0].error, /other-pkg/)
    // 物化进 other-pkg → skipped（不落盘）
    const rOther = store.materialize(otherDir, [draft.id])
    assert.equal(rOther.applied.length, 0)
    assert.ok(rOther.skipped[0].reason.includes('test-pkg'), rOther.skipped[0].reason)
    assert.equal(loadPackage(otherDir).scoreRules.length, 1)
    // 同包预览/物化仍正常
    const pvSame = store.previewMaterialize(dir, [draft.id])
    assert.equal(pvSame[0].ok, true, pvSame[0].error)
    const rSame = store.materialize(dir, [draft.id])
    assert.deepEqual(rSame.applied, [draft.id])
  } finally {
    rmWorkspace(root)
  }
})

test('updateCandidate 改名同步 payload.name；故意分叉的 payload.name 不覆盖', async () => {
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
    assert.equal(draft.payload.name, draft.name)
    // 与旧名一致（自动副本）→ 改名同步
    store.updateCandidate(draft.id, { name: '新名' })
    assert.equal(store.getCandidate(draft.id).payload.name, '新名')
    // 故意分叉的 payload.name 不被改名覆盖（payload.name 保持权威）
    store.updateCandidate(draft.id, { payload: { ...store.getCandidate(draft.id).payload, name: '专用名' } })
    store.updateCandidate(draft.id, { name: '另一个名' })
    assert.equal(store.getCandidate(draft.id).name, '另一个名')
    assert.equal(store.getCandidate(draft.id).payload.name, '专用名')
  } finally {
    rmWorkspace(root)
  }
})

test('previewMaterialize：新建带禁语的 ScenarioCard 显示整元素，不误判为 RedLine 增量', async () => {
  const { ws, dir, root } = mkWorkspaceWithPkg()
  try {
    const store = new KnowledgeStore(ws.root)
    const queuePath = join(store.root, 'queue.json')
    writeFileSync(queuePath, JSON.stringify([{
      id: 'dc-new-scn',
      packageId: 'test-pkg',
      sourceId: 'src-x',
      layer: 'O3',
      targetKind: 'ScenarioCard',
      name: '新场景',
      payload: {
        name: '新场景',
        goal: '识别线索',
        boundary: '只输出候选',
        outputContract: { forbiddenPhrases: ['认定洗钱'] },
      },
      confidence: 0.9,
      rationale: '',
      status: 'pending',
      forcedReview: false,
      conclusionLike: false,
      createdAt: new Date().toISOString(),
    }], null, 2))
    const previews = store.previewMaterialize(dir, ['dc-new-scn'])
    assert.equal(previews.length, 1)
    assert.ok(previews[0].ok, previews[0].error)
    // 完整新元素（含 id/name），不是 { scenarioId, phrases } 禁语增量
    assert.equal(previews[0].element.name, '新场景')
    assert.ok(String(previews[0].element.id).startsWith('SCN-'))
    assert.ok(!previews[0].summary.includes('禁语 +'), previews[0].summary)
    // 干跑不落盘
    assert.equal(loadPackage(dir).scenarios.length, 1)
  } finally {
    rmWorkspace(root)
  }
})

test('previewMaterialize 累积干跑：与 materialize 同语义，后者可见前者的插入', async () => {
  const { ws, dir, root } = mkWorkspaceWithPkg()
  try {
    const store = new KnowledgeStore(ws.root)
    const queuePath = join(store.root, 'queue.json')
    const now = new Date().toISOString()
    writeFileSync(queuePath, JSON.stringify([
      {
        id: 'dc-obj-new',
        packageId: 'test-pkg',
        sourceId: 'src-x',
        layer: 'O1',
        targetKind: 'ObjectType',
        name: '新对象',
        payload: { name: '新对象', attributes: [] },
        confidence: 0.9,
        rationale: '',
        status: 'pending',
        forcedReview: false,
        conclusionLike: false,
        createdAt: now,
      },
      {
        id: 'dc-attr-new',
        packageId: 'test-pkg',
        sourceId: 'src-x',
        layer: 'O1',
        targetKind: 'Attribute',
        name: '新属性',
        payload: { ownerName: '新对象', name: '新属性', type: 'string' },
        confidence: 0.9,
        rationale: '',
        status: 'pending',
        forcedReview: false,
        conclusionLike: false,
        createdAt: now,
      },
    ], null, 2))
    // 累积：第二条（Attribute）能看到第一条刚插入的 owner
    const previews = store.previewMaterialize(dir, ['dc-obj-new', 'dc-attr-new'])
    assert.equal(previews[0].ok, true, previews[0].error)
    assert.equal(previews[1].ok, true, previews[1].error)
    // 孤立预览第二条则失败（owner 尚不存在）——对照旧的逐条独立干跑
    const solo = store.previewMaterialize(dir, ['dc-attr-new'])
    assert.equal(solo[0].ok, false)
    assert.match(solo[0].error, /ATTR_OWNER|owner/)
    // 干跑不落盘
    assert.equal(loadPackage(dir).objects.length, 2)
  } finally {
    rmWorkspace(root)
  }
})

test('payload.id 与包内已有 ID 冲突 → 拒绝，不产生重复 ID', async () => {
  const { ws, dir, root } = mkWorkspaceWithPkg()
  try {
    const store = new KnowledgeStore(ws.root)
    const queuePath = join(store.root, 'queue.json')
    writeFileSync(queuePath, JSON.stringify([{
      id: 'dc-dup-id',
      packageId: 'test-pkg',
      sourceId: 'src-x',
      layer: 'O1',
      targetKind: 'ObjectType',
      name: '撞车对象',
      payload: { id: 'OBJ-TST-A', name: '撞车对象', attributes: [] },
      confidence: 0.9,
      rationale: '',
      status: 'pending',
      forcedReview: false,
      conclusionLike: false,
      createdAt: new Date().toISOString(),
    }], null, 2))
    const previews = store.previewMaterialize(dir, ['dc-dup-id'])
    assert.equal(previews[0].ok, false)
    assert.match(previews[0].error, /重复/)
    store.reviewCandidate('dc-dup-id', 'approve')
    const r = store.materialize(dir, ['dc-dup-id'])
    assert.equal(r.applied.length, 0)
    assert.equal(r.skipped.length, 1)
    assert.match(r.skipped[0].reason, /重复/)
    // 包内仍是原有两个对象，未产生重复 ID
    assert.equal(loadPackage(dir).objects.length, 2)
  } finally {
    rmWorkspace(root)
  }
})

test('物化侧数值兜底：reviewGate.threshold/weight 的 NaN 不入库，回退默认', () => {
  const pkg = minimalPkg()
  applyDraftToPackage(pkg, {
    layer: 'O3', targetKind: 'ScenarioCard', name: '新场景',
    payload: { name: '新场景', reviewGate: { threshold: NaN } },
    confidence: 0.9, rationale: '', conclusionLike: false,
  })
  assert.equal(pkg.scenarios[pkg.scenarios.length - 1].reviewGate.threshold, 0.75)
  applyDraftToPackage(pkg, {
    layer: 'O2', targetKind: 'ScoreRule', name: '新规则',
    payload: { weight: NaN, expression: '1', threshold: Infinity },
    confidence: 0.9, rationale: '', conclusionLike: false,
  })
  const rule = pkg.scoreRules[pkg.scoreRules.length - 1]
  assert.equal(rule.weight, 0)
  assert.equal(rule.threshold, undefined)
})

test('E1-3 SkillTemplate 物化接线：append SKL 到对应场景 pipeline.skillRefs', () => {
  const pkg = minimalPkg()
  const before = pkg.scenarios[0].pipeline.flatMap((s) => s.skillRefs ?? [])
  assert.ok(!before.includes('SKL-TST-EXP-1'))
  const id = applyDraftToPackage(pkg, {
    layer: 'O2', targetKind: 'SkillTemplate', name: '经验模板',
    payload: {
      id: 'SKL-TST-EXP-1',
      scenarioId: 'SCN-TST-1',
      weights: { 'RULE-TST-S1': 1 },
      steps: ['候选 {candidateId}'],
    },
    confidence: 0.9, rationale: '', conclusionLike: false,
  })
  assert.equal(id, 'SKL-TST-EXP-1')
  const after = pkg.scenarios[0].pipeline.flatMap((s) => s.skillRefs ?? [])
  assert.ok(after.includes('SKL-TST-EXP-1'), `skillRefs 应含新 SKL: ${after.join(',')}`)
  // 已有 SKILL_RUN 步上追加，不新建步（duties 对齐不破）
  const skillSteps = pkg.scenarios[0].pipeline.filter((s) => s.stepType === 'SKILL_RUN')
  assert.equal(skillSteps.length, 1)
  assert.deepEqual(skillSteps[0].skillRefs, ['SKL-TST-N', 'SKL-TST-EXP-1'])
  // 显式错误 scenarioId → fail-loud（resolve 在 push 前，不得留下半成品）
  assert.throws(
    () => applyDraftToPackage(pkg, {
      layer: 'O2', targetKind: 'SkillTemplate', name: '坏接线',
      payload: { id: 'SKL-TST-EXP-2', scenarioId: 'SCN-NOPE', weights: {} },
      confidence: 0.9, rationale: '', conclusionLike: false,
    }),
    /WIRE_SCENARIO_NOT_FOUND|接线场景不存在/,
  )
  assert.ok(!pkg.skillTemplates.some((s) => s.id === 'SKL-TST-EXP-2'), '失败接线不得留下模板')
})

test('E1-3 materialize 接线失败回滚：模板与 skillRefs 均不落盘', async () => {
  const { ws, dir, root } = mkWorkspaceWithPkg()
  try {
    const store = new KnowledgeStore(ws.root)
    const now = new Date().toISOString()
    const queuePath = join(store.root, 'queue.json')
    writeFileSync(queuePath, JSON.stringify([{
      id: 'dc-skl-wire-fail',
      packageId: 'test-pkg',
      sourceId: 'src-x',
      layer: 'O2',
      targetKind: 'SkillTemplate',
      name: '坏接线模板',
      payload: { id: 'SKL-TST-WIRE-FAIL', scenarioId: 'SCN-GHOST', weights: {} },
      confidence: 0.9,
      rationale: '',
      status: 'approved',
      forcedReview: false,
      conclusionLike: false,
      createdAt: now,
    }], null, 2))
    const r = store.materialize(dir, ['dc-skl-wire-fail'])
    assert.equal(r.applied.length, 0)
    assert.ok(r.skipped.some((s) => /接线场景不存在/.test(s.reason)))
    const pkg = loadPackage(dir)
    assert.ok(!pkg.skillTemplates.some((s) => s.id === 'SKL-TST-WIRE-FAIL'))
    const refs = pkg.scenarios[0].pipeline.flatMap((s) => s.skillRefs ?? [])
    assert.ok(!refs.includes('SKL-TST-WIRE-FAIL'))
  } finally {
    rmWorkspace(root)
  }
})

test('E1-3 多场景无 scenarioId 不猜接线；单场景缺省接线', () => {
  const base = minimalPkg()
  const sc2 = JSON.parse(JSON.stringify(base.scenarios[0]))
  sc2.id = 'SCN-TST-2'
  sc2.name = '第二场景'
  const multi = minimalPkg({ scenarios: [base.scenarios[0], sc2] })
  applyDraftToPackage(multi, {
    layer: 'O2', targetKind: 'SkillTemplate', name: '无目标',
    payload: { id: 'SKL-TST-EXP-M', weights: {} },
    confidence: 0.9, rationale: '', conclusionLike: false,
  })
  for (const sc of multi.scenarios) {
    const refs = sc.pipeline.flatMap((s) => s.skillRefs ?? [])
    assert.ok(!refs.includes('SKL-TST-EXP-M'), `多场景无 scenarioId 不应接线到 ${sc.id}`)
  }
  const single = minimalPkg()
  applyDraftToPackage(single, {
    layer: 'O2', targetKind: 'SkillTemplate', name: '单场景缺省',
    payload: { id: 'SKL-TST-EXP-S', weights: {} },
    confidence: 0.9, rationale: '', conclusionLike: false,
  })
  const refs = single.scenarios[0].pipeline.flatMap((s) => s.skillRefs ?? [])
  assert.ok(refs.includes('SKL-TST-EXP-S'))
})

/* ── RedLine 定位：targetId / payload.scenarioId；多场景不猜 ────────────── */

test('RedLine 物化：targetId 与 payload.scenarioId 等价定位；单场景缺省仍可落', () => {
  const viaTarget = minimalPkg()
  applyDraftToPackage(viaTarget, {
    layer: 'O3', targetKind: 'RedLine', name: '禁语A',
    targetId: 'SCN-TST-1',
    payload: { phrases: ['认定甲违规'] },
    confidence: 0.9, rationale: '', conclusionLike: true,
  })
  assert.ok(viaTarget.scenarios[0].outputContract.forbiddenPhrases.includes('认定甲违规'))

  const viaPayload = minimalPkg()
  applyDraftToPackage(viaPayload, {
    layer: 'O3', targetKind: 'RedLine', name: '禁语B',
    payload: { scenarioId: 'SCN-TST-1', phrases: ['确定为乙'] },
    confidence: 0.9, rationale: '', conclusionLike: true,
  })
  assert.ok(viaPayload.scenarios[0].outputContract.forbiddenPhrases.includes('确定为乙'))

  const single = minimalPkg()
  applyDraftToPackage(single, {
    layer: 'O3', targetKind: 'RedLine', name: '禁语C',
    payload: { phrases: ['已构成丙'] },
    confidence: 0.9, rationale: '', conclusionLike: true,
  })
  assert.ok(single.scenarios[0].outputContract.forbiddenPhrases.includes('已构成丙'))
})

test('RedLine 多场景：无显式场景 ID fail-loud；显式 targetId 落对场景', () => {
  const base = minimalPkg()
  const sc2 = JSON.parse(JSON.stringify(base.scenarios[0]))
  sc2.id = 'SCN-TST-2'
  sc2.name = '第二场景'
  sc2.outputContract = { mustInclude: ['candidateList'], forbiddenPhrases: [] }
  const multi = minimalPkg({ scenarios: [base.scenarios[0], sc2] })

  assert.throws(
    () => applyDraftToPackage(multi, {
      layer: 'O3', targetKind: 'RedLine', name: '无定位',
      payload: { phrases: ['认定错挂'] },
      confidence: 0.9, rationale: '', conclusionLike: true,
    }),
    /REDLINE_NEEDS_SCENARIO|多场景包红线须显式/,
  )
  assert.ok(!multi.scenarios[0].outputContract.forbiddenPhrases.includes('认定错挂'), '不得静默挂首场景')
  assert.ok(!multi.scenarios[1].outputContract.forbiddenPhrases.includes('认定错挂'))

  applyDraftToPackage(multi, {
    layer: 'O3', targetKind: 'RedLine', name: '挂二场景',
    targetId: 'SCN-TST-2',
    payload: { phrases: ['认定错挂'] },
    confidence: 0.9, rationale: '', conclusionLike: true,
  })
  assert.ok(multi.scenarios[1].outputContract.forbiddenPhrases.includes('认定错挂'))
  assert.ok(!multi.scenarios[0].outputContract.forbiddenPhrases.includes('认定错挂'))

  assert.throws(
    () => applyDraftToPackage(multi, {
      layer: 'O3', targetKind: 'RedLine', name: '坏场景',
      targetId: 'SCN-NOPE',
      payload: { phrases: ['认定不存在'] },
      confidence: 0.9, rationale: '', conclusionLike: true,
    }),
    /红线目标场景不存在/,
  )
})

test('ScenarioCard create：outputContract.mustInclude 与顶层 mustInclude 同源归一', () => {
  const top = minimalPkg()
  top.scenarios = []
  applyDraftToPackage(top, {
    layer: 'O3', targetKind: 'ScenarioCard', name: '场景顶',
    payload: {
      id: 'SCN-TST-NEW-T', name: '顶', goal: 'g', boundary: 'b',
      inputs: [], outputs: { fields: [] }, pipeline: [],
      mustInclude: ['candidateList', 'riskScore', 'evidenceChains', 'pendingChecks'],
    },
    confidence: 0.9, rationale: '', conclusionLike: false,
  })
  assert.deepEqual(
    top.scenarios[0].outputContract.mustInclude,
    ['candidateList', 'riskScore', 'evidenceChains', 'pendingChecks'],
  )

  const nested = minimalPkg()
  nested.scenarios = []
  applyDraftToPackage(nested, {
    layer: 'O3', targetKind: 'ScenarioCard', name: '场景嵌',
    payload: {
      id: 'SCN-TST-NEW-N', name: '嵌', goal: 'g', boundary: 'b',
      inputs: [], outputs: { fields: [] }, pipeline: [],
      outputContract: {
        mustInclude: ['candidateList', 'riskScore', 'hitRuleIds', 'evidenceChains', 'pendingChecks'],
        forbiddenPhrases: [],
      },
    },
    confidence: 0.9, rationale: '', conclusionLike: false,
  })
  assert.deepEqual(
    nested.scenarios[0].outputContract.mustInclude,
    ['candidateList', 'riskScore', 'hitRuleIds', 'evidenceChains', 'pendingChecks'],
    'outputContract.mustInclude 须生效而非默认四键',
  )
  assert.deepEqual(nested.scenarios[0].outputContract.forbiddenPhrases, [])

  const def = minimalPkg()
  def.scenarios = []
  applyDraftToPackage(def, {
    layer: 'O3', targetKind: 'ScenarioCard', name: '场景缺',
    payload: { id: 'SCN-TST-NEW-D', name: '缺', goal: 'g', boundary: 'b', inputs: [], outputs: { fields: [] }, pipeline: [] },
    confidence: 0.9, rationale: '', conclusionLike: false,
  })
  assert.deepEqual(
    def.scenarios[0].outputContract.mustInclude,
    ['candidateList', 'riskScore', 'evidenceChains', 'pendingChecks'],
  )
})

/* ── P3-3：SkillTemplate 接线结果经 materialize notes 上墙 ── */

test('P3-3：多场景无 scenarioId 物化回执 notes 提示未接线；带 scenarioId 则接线且无 notes', () => {
  const { ws, dir, root } = mkWorkspaceWithPkg({
    scenarios: (() => {
      const base = minimalPkg().scenarios[0]
      const sc2 = JSON.parse(JSON.stringify(base))
      sc2.id = 'SCN-TST-2'
      sc2.name = '第二场景'
      return [base, sc2]
    })(),
  })
  try {
    const store = new KnowledgeStore(ws.root)
    const now = new Date().toISOString()
    const queuePath = join(store.root, 'queue.json')
    writeFileSync(queuePath, JSON.stringify([
      {
        id: 'dc-skl-nowire',
        packageId: 'test-pkg',
        sourceId: '',
        layer: 'O2',
        targetKind: 'SkillTemplate',
        name: '未接线模板',
        payload: { id: 'SKL-TST-NOWIRE', weights: { 'RULE-TST-S1': 1 } },
        confidence: 0.9,
        rationale: '',
        status: 'approved',
        forcedReview: false,
        conclusionLike: false,
        createdAt: now,
      },
      {
        id: 'dc-skl-wired',
        packageId: 'test-pkg',
        sourceId: '',
        layer: 'O2',
        targetKind: 'SkillTemplate',
        name: '已接线模板',
        payload: { id: 'SKL-TST-WIRED', scenarioId: 'SCN-TST-1', weights: { 'RULE-TST-S1': 1 } },
        confidence: 0.9,
        rationale: '',
        status: 'approved',
        forcedReview: false,
        conclusionLike: false,
        createdAt: now,
      },
    ], null, 2))
    const r1 = store.materialize(dir, ['dc-skl-nowire'])
    assert.deepEqual(r1.applied, ['dc-skl-nowire'])
    assert.ok(Array.isArray(r1.notes) && r1.notes.length === 1, `须有未接线 notes: ${JSON.stringify(r1.notes)}`)
    assert.match(r1.notes[0], /未接线/)
    assert.match(r1.notes[0], /SCN-TST-1|scenarioId/)

    const r2 = store.materialize(dir, ['dc-skl-wired'])
    assert.deepEqual(r2.applied, ['dc-skl-wired'])
    assert.equal(r2.notes, undefined, '已接线不得带 notes')
    const pkg = loadPackage(dir)
    const wired = pkg.skillTemplates.find((s) => s.id === 'SKL-TST-WIRED')
    assert.ok(wired)
    const refs = pkg.scenarios.find((s) => s.id === 'SCN-TST-1').pipeline.flatMap((s) => s.skillRefs ?? [])
    assert.ok(refs.includes('SKL-TST-WIRED'))
  } finally {
    rmWorkspace(root)
  }
})

/* ── P2-2：物化后重派生失败 → 回滚源与候选，可重试 ── */

test('P2-2：derive 失败回滚包源、清 appliedAs、候选保持 approved（可重试不 DUP_ID）', () => {
  const { ws, dir, root } = mkWorkspaceWithPkg()
  try {
    derivePackage(dir)
    assert.equal(verifyDerived(dir).ok, true)
    const store = new KnowledgeStore(ws.root)
    const now = new Date().toISOString()
    const queuePath = join(store.root, 'queue.json')
    writeFileSync(queuePath, JSON.stringify([{
      id: 'dc-derive-fail',
      packageId: 'test-pkg',
      sourceId: '',
      layer: 'O2',
      targetKind: 'ScoreRule',
      name: '派生失败规则',
      payload: { id: 'RULE-TST-DERIVE-FAIL', weight: 0.5, expression: '1', threshold: 0.5 },
      confidence: 0.9,
      rationale: '',
      status: 'approved',
      forcedReview: false,
      conclusionLike: false,
      createdAt: now,
    }], null, 2))

    const beforePkg = JSON.stringify(loadPackage(dir))
    assert.throws(
      () => store.materialize(dir, ['dc-derive-fail'], { derive: () => { throw new Error('inject derive boom') } }),
      (e) => e?.code === 'DERIVE_FAILED' && /inject derive boom/.test(e.message),
      '须抛 DERIVE_FAILED 且含原因',
    )

    // 包源回滚：无新规则、与物化前一致
    const afterPkg = loadPackage(dir)
    assert.ok(!afterPkg.scoreRules.some((r) => r.id === 'RULE-TST-DERIVE-FAIL'), 'derive 失败须回滚新规则')
    assert.equal(JSON.stringify(afterPkg), beforePkg, '包源须回到物化前快照')

    // 候选：approved、无 appliedAs、未 merged —— 可重试
    const c = store.getCandidate('dc-derive-fail')
    assert.equal(c.status, 'approved')
    assert.equal(c.appliedAs, undefined)

    // 恢复 derive 后重试成功（不撞 DUP_ID）
    const retry = store.materialize(dir, ['dc-derive-fail'])
    assert.deepEqual(retry.applied, ['dc-derive-fail'])
    assert.equal(store.getCandidate('dc-derive-fail').status, 'merged')
    assert.equal(verifyDerived(dir).ok, true)
  } finally {
    rmWorkspace(root)
  }
})

test('字典 ID 自动生成加盐：同名 CJK 字典同批可共存；显式 payload.id 撞车仍拒绝', async () => {
  const { ws, dir, root } = mkWorkspaceWithPkg()
  try {
    const store = new KnowledgeStore(ws.root)
    const now = new Date().toISOString()
    const queuePath = join(store.root, 'queue.json')
    const dictCand = (id, name, values, payloadId) => ({
      id,
      packageId: 'test-pkg',
      sourceId: 'src-x',
      layer: 'O1',
      targetKind: 'Dictionary',
      name,
      payload: payloadId ? { id: payloadId, name, values } : { name, values },
      confidence: 0.9,
      rationale: '',
      status: 'pending',
      forcedReview: false,
      conclusionLike: false,
      createdAt: now,
    })
    writeFileSync(queuePath, JSON.stringify([
      dictCand('dc-dict-1', '状态字典', ['a']),
      dictCand('dc-dict-2', '状态字典', ['b']),
      dictCand('dc-dict-3', '显式撞车', ['c'], 'dict-tst-k'),
    ], null, 2))
    for (const id of ['dc-dict-1', 'dc-dict-2', 'dc-dict-3']) store.reviewCandidate(id, 'approve')
    const r = store.materialize(dir, ['dc-dict-1', 'dc-dict-2', 'dc-dict-3'])
    assert.equal(r.applied.length, 2)
    assert.equal(r.skipped.length, 1)
    assert.match(r.skipped[0].reason, /重复/)
    const dicts = loadPackage(dir).dictionaries
    assert.equal(dicts.length, 3) // 原 dict-tst-k + 两本同名新字典
    assert.equal(new Set(dicts.map((d) => d.id)).size, 3)
  } finally {
    rmWorkspace(root)
  }
})

test('updateCandidate：patch.payload 显式带 name 键时视为故意保留，不被改名同步覆盖', async () => {
  const { ws, dir, root } = mkWorkspaceWithPkg()
  try {
    const store = new KnowledgeStore(ws.root)
    const now = new Date().toISOString()
    const queuePath = join(store.root, 'queue.json')
    writeFileSync(queuePath, JSON.stringify([{
      id: 'dc-rename',
      packageId: 'test-pkg',
      sourceId: 'src-x',
      layer: 'O2',
      targetKind: 'ScoreRule',
      name: '旧名',
      payload: { name: '旧名', weight: 0.2, expression: '1' },
      confidence: 0.9,
      rationale: '',
      status: 'pending',
      forcedReview: false,
      conclusionLike: false,
      createdAt: now,
    }], null, 2))
    // 显式 payload.name 恰与旧名一致 → 故意保留，不随 name 同步
    store.updateCandidate('dc-rename', {
      name: '新名',
      payload: { name: '旧名', weight: 0.3, expression: '1' },
    })
    const c = store.getCandidate('dc-rename')
    assert.equal(c.name, '新名')
    assert.equal(c.payload.name, '旧名')
  } finally {
    rmWorkspace(root)
  }
})

test('packageId 守卫：非 string/写入空串 → BAD_PACKAGE_ID；读路径 listSources("") 不抛（round-13）', () => {
  const { store, root } = mkStore()
  try {
    assert.throws(
      () => store.uploadSource({ packageId: 123, sourceType: 'POLICY', name: 'n', content: 'c' }),
      (e) => e.name === 'KnowledgeError' && e.code === 'BAD_PACKAGE_ID',
      '非字符串 packageId 必须受控失败（不得裸抛 TypeError）',
    )
    assert.throws(
      () => store.uploadSource({ packageId: '', sourceType: 'POLICY', name: 'n', content: 'c' }),
      (e) => e.name === 'KnowledgeError' && e.code === 'BAD_PACKAGE_ID',
      '写入空 packageId 拒绝',
    )
    // 读路径空串保持原语义（过滤无匹配返回 []），不因守卫破坏 wire 读
    assert.equal(store.listSources('').length, 0)
    assert.equal(store.listSources(undefined).length, 0)
  } finally {
    rmWorkspace(root)
  }
})

test('记录 ID 派生：sha256 截断 128-bit，确定且不同 seed 不撞（round-13：原 32-bit FNV 可定向碰撞覆盖）', () => {
  const a = knowledgeSourceId('pkg-x|POLICY|n1|abc')
  assert.match(a, /^ks-[0-9a-f]{32}$/)
  assert.equal(a, knowledgeSourceId('pkg-x|POLICY|n1|abc'), '同 seed 必须确定')
  assert.notEqual(a, knowledgeSourceId('pkg-x|POLICY|n2|abc'), '不同 name 不得同 id')
  assert.notEqual(a, knowledgeSourceId('pkg-y|POLICY|n1|abc'), '不同包不得同 id')
  const d = draftCandidateId('seed-1')
  assert.match(d, /^dc-[0-9a-f]{32}$/)
  assert.notEqual(draftCandidateId('seed-2'), d, '不同候选 key 不得同 id')
})

test('materialize 归一比较：旧数据 packageId 为 name@version 不再误判 mismatch（round-13）', () => {
  const { ws, dir, root } = mkWorkspaceWithPkg()
  try {
    const store = new KnowledgeStore(ws.root)
    const queuePath = join(store.root, 'queue.json')
    writeFileSync(
      queuePath,
      JSON.stringify([
        {
          id: 'dc-oldfmt',
          packageId: 'test-pkg@1.0.0',
          sourceId: 'src-x',
          layer: 'O2',
          targetKind: 'ScoreRule',
          name: '旧格式候选',
          payload: { name: '旧格式候选', weight: 0.1, expression: '1' },
          confidence: 0.9,
          rationale: '',
          status: 'pending',
          forcedReview: false,
          conclusionLike: false,
          createdAt: new Date().toISOString(),
        },
        {
          id: 'dc-otherpkg',
          packageId: 'other-pkg',
          sourceId: 'src-x',
          layer: 'O2',
          targetKind: 'ScoreRule',
          name: '他包候选',
          payload: { name: '他包候选', weight: 0.1, expression: '1' },
          confidence: 0.9,
          rationale: '',
          status: 'approved',
          forcedReview: false,
          conclusionLike: false,
          createdAt: new Date().toISOString(),
        },
      ], null, 2),
    )
    const r = store.materialize(dir, ['dc-oldfmt', 'dc-otherpkg'])
    const oldfmt = r.skipped.find((s) => s.id === 'dc-oldfmt')
    const other = r.skipped.find((s) => s.id === 'dc-otherpkg')
    // 旧格式 packageId 归一后应过包名比对，落到 status=pending 跳过（而非 mismatch）
    assert.ok(oldfmt, JSON.stringify(r))
    assert.ok(oldfmt.reason.includes('status='), oldfmt.reason)
    assert.ok(!oldfmt.reason.includes('package mismatch'), oldfmt.reason)
    // 真他包仍按 mismatch 拒（fail-safe 保留）
    assert.ok(other && other.reason.includes('package mismatch'), JSON.stringify(other))
  } finally {
    rmWorkspace(root)
  }
})

test('D5：CONCLUSION_BLOCKED 出口内联 RedLine 正确路径（targetKind + payload.phrases）', () => {
  // 1) 批准路径（reviewCandidate approve）
  const { store, root } = mkStore()
  try {
    const queuePath = join(store.root, 'queue.json')
    const queue = JSON.parse(readFileSync(queuePath, 'utf8'))
    queue.push({
      id: 'dc-d5-approve',
      packageId: 'pkg-x',
      sourceId: '',
      layer: 'O2',
      targetKind: 'ScoreRule',
      name: '结论规则',
      payload: { name: '结论规则', weight: 0.1, expression: '1' },
      confidence: 0.9,
      rationale: '该客户系诈骗分子',
      status: 'pending',
      forcedReview: false,
      conclusionLike: true,
      createdAt: new Date().toISOString(),
    })
    writeFileSync(queuePath, JSON.stringify(queue, null, 2))
    assert.throws(
      () => store.reviewCandidate('dc-d5-approve', 'approve'),
      (e) => e.code === 'CONCLUSION_BLOCKED'
        && e.message.includes('targetKind=RedLine')
        && e.message.includes('payload.phrases'),
      '批准拒绝须内联 RedLine 正确路径',
    )
  } finally {
    rmWorkspace(root)
  }

  // 2) 物化 create / update 路径（applyDraftToPackage）
  const pkg = minimalPkg()
  const base = {
    id: 'dc-d5-apply',
    packageId: 'test-pkg',
    sourceId: '',
    sourceName: '结论规则',
    layer: 'O2',
    targetKind: 'ScoreRule',
    name: '结论规则',
    confidence: 0.9,
    rationale: '该客户系诈骗分子',
    status: 'pending',
    forcedReview: false,
    conclusionLike: true,
    provenance: {},
    createdAt: new Date().toISOString(),
  }
  const check = (e) => e.code === 'CONCLUSION_BLOCKED'
    && e.message.includes('targetKind=RedLine')
    && e.message.includes('payload.phrases')
  assert.throws(
    () => applyDraftToPackage(pkg, { ...base, op: 'create', payload: { name: '结论规则', weight: 0.1, expression: '1' } }),
    check,
    'create 物化拒绝须内联 RedLine 正确路径',
  )
  assert.throws(
    () => applyDraftToPackage(pkg, { ...base, op: 'update', targetId: 'RULE-TST-S1', payload: { description: '认定骗贷' } }),
    check,
    'update 物化拒绝须内联 RedLine 正确路径',
  )
})

/* ── D6 物化后自动重派生（闭环轮 5） ── */

test('D6：物化成功即自动重派生，loadgate 不再 DERIVED_DRIFT；未物化不重派生', async () => {
  const { ws, dir, root } = mkWorkspaceWithPkg()
  try {
    derivePackage(dir)
    assert.equal(verifyDerived(dir).ok, true)
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
    // pending 物化：无写入 → 不重派生，既有 manifest 仍绿
    store.materialize(dir, [scoreDraft.id])
    assert.equal(verifyDerived(dir).ok, true)
    // approve → 物化改写源 → 自动重派生（修复前此处 DERIVED_DRIFT）
    store.reviewCandidate(scoreDraft.id, 'approve')
    const res = store.materialize(dir, [scoreDraft.id])
    assert.deepEqual(res.applied, [scoreDraft.id])
    const gate = verifyDerived(dir)
    assert.equal(gate.ok, true, `物化后须自动重派生过闸: ${JSON.stringify(gate)}`)
    const manifest = readManifest(dir)
    assert.ok(manifest, '重派生须落 manifest')
    assert.ok(
      manifest.sources.some((e) => e.path.includes('scoreRules') || e.path.includes('rules/')),
      '新源文件须进 manifest 指纹',
    )
  } finally {
    rmWorkspace(root)
  }
})

test('ScoreRule 草案 featureSources 形状（v0.2.1）', () => {
  const ok = validateDraftItem({
    layer: 'O2',
    targetKind: 'ScoreRule',
    name: 'with-source',
    payload: { weight: 0.2, expression: '1', featureSources: { f1: 'OBJ-TST-A' } },
    confidence: 0.9,
  })
  assert.equal(ok, null)
  const bad = validateDraftItem({
    layer: 'O2',
    targetKind: 'ScoreRule',
    name: 'bad-source',
    payload: { weight: 0.2, expression: '1', featureSources: { f1: 'nope' } },
    confidence: 0.9,
  })
  assert.match(String(bad), /featureSources/)
})
