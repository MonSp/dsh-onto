/** 多域验收（规范 §10 / §11.3）：换包不改引擎代码即可跑通（aml / med / tax 三域）。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runScenario, verifyDerived, buildQualityReport } from '../dist/index.js'
import { copyExamplePackage, exampleData, rmWorkspace } from './helpers.mjs'

const DOMAINS = [
  { dir: 'aml', pkg: 'aml-analysis', scenario: 'SCN-AML-FIND-CLUES', data: 'aml-run.json' },
  { dir: 'med', pkg: 'med-safety', scenario: 'SCN-MED-RISK-NOTICE', data: 'med-run.json' },
  { dir: 'tax', pkg: 'tax-risk', scenario: 'SCN-TAX-FAKE-INVOICE', data: 'tax-run.json' },
]

test('AML 域跑通', () => {
  const { dir, root } = copyExamplePackage('aml')
  try {
    assert.equal(verifyDerived(dir).ok, true)
    const result = runScenario(dir, 'SCN-AML-FIND-CLUES', exampleData('aml-run.json'))
    assert.equal(result.audit.passed, true)
    assert.ok(result.candidates.length > 0)
  } finally {
    rmWorkspace(root)
  }
})

test('MED 第二域跑通（引擎零修改，只换包内容）', () => {
  const { dir, root } = copyExamplePackage('med')
  try {
    assert.equal(verifyDerived(dir).ok, true)
    const result = runScenario(dir, 'SCN-MED-RISK-NOTICE', exampleData('med-run.json'))
    assert.equal(result.audit.passed, true)
    assert.ok(result.candidates.length > 0)
    assert.equal(result.humanReviewRequired, true)
    // 医疗域红线零命中
    for (const phrase of ['确诊', '属医疗事故', '该用药必然导致']) {
      assert.ok(!JSON.stringify(result).includes(phrase), `leaked: ${phrase}`)
    }
  } finally {
    rmWorkspace(root)
  }
})

test('TAX 第三域跑通（引擎零修改，只换包内容）', () => {
  const { dir, root } = copyExamplePackage('tax')
  try {
    assert.equal(verifyDerived(dir).ok, true)
    const result = runScenario(dir, 'SCN-TAX-FAKE-INVOICE', exampleData('tax-run.json'))
    assert.equal(result.audit.passed, true)
    assert.ok(result.candidates.length > 0)
    assert.equal(result.humanReviewRequired, true)
    // 高风险候选命中规则；白名单排除件进 excluded
    const hit = result.candidates.find((c) => c.candidateId === 'TAX-CAND-001')
    assert.ok(hit, 'TAX-CAND-001 应在候选中')
    assert.ok(hit.hitRuleIds.length > 0, `应命中规则: ${JSON.stringify(hit.hitRuleIds)}`)
    assert.ok(
      result.excluded.some((e) => e.candidateId === 'TAX-CAND-002'),
      '白名单候选应被排除',
    )
    // 税务域红线零命中
    for (const phrase of ['认定虚开增值税专用发票', '确定为虚开发票', '已构成虚开增值税专用发票罪', '该纳税人系虚开发票企业']) {
      assert.ok(!JSON.stringify(result).includes(phrase), `leaked: ${phrase}`)
    }
  } finally {
    rmWorkspace(root)
  }
})

test('三域 MULTI-DOMAIN PASS：换包零改引擎，各自场景全过', () => {
  const summary = []
  for (const d of DOMAINS) {
    const { dir, root } = copyExamplePackage(d.dir)
    try {
      assert.equal(verifyDerived(dir).ok, true, `${d.pkg} gate`)
      const result = runScenario(dir, d.scenario, exampleData(d.data))
      assert.equal(result.audit.passed, true, `${d.pkg} audit: ${JSON.stringify(result.audit.checks)}`)
      assert.ok(result.candidates.length > 0, `${d.pkg} candidates`)
      assert.equal(result.humanReviewRequired, true, `${d.pkg} humanReviewRequired`)
      assert.equal(result.audit.forbiddenPhraseHits.length, 0, `${d.pkg} 禁语零命中`)
      summary.push(`${d.pkg}:${result.candidates.length}cand/${result.excluded.length}excl`)
    } finally {
      rmWorkspace(root)
    }
  }
  assert.equal(summary.length, 3)
  // 打印便于台账引用
  console.log(`MULTI-DOMAIN PASS (${summary.join(', ')})`)
})

test('三域禁语互不串域', () => {
  const med = copyExamplePackage('med')
  try {
    const result = runScenario(med.dir, 'SCN-MED-RISK-NOTICE', exampleData('med-run.json'))
    assert.equal(result.audit.forbiddenPhraseHits.length, 0)
  } finally {
    rmWorkspace(med.root)
  }
  const tax = copyExamplePackage('tax')
  try {
    const result = runScenario(tax.dir, 'SCN-TAX-FAKE-INVOICE', exampleData('tax-run.json'))
    assert.equal(result.audit.forbiddenPhraseHits.length, 0)
  } finally {
    rmWorkspace(tax.root)
  }
})

test('三域校验均可通过（0 error）', () => {
  for (const domain of ['aml', 'med', 'tax']) {
    const { dir, root } = copyExamplePackage(domain)
    try {
      const report = buildQualityReport(dir)
      assert.equal(report.errors.length, 0, `${domain}: ${JSON.stringify(report.errors)}`)
      assert.equal(report.passed, true)
    } finally {
      rmWorkspace(root)
    }
  }
})
