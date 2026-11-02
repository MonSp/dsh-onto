/** 多域验收（规范 §10 / §11.3）：第二域不改引擎代码，只换包内容即可跑通。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runScenario, verifyDerived, buildQualityReport } from '../dist/index.js'
import { copyExamplePackage, exampleData, rmWorkspace } from './helpers.mjs'

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

test('两域禁语互不串域', () => {
  const med = copyExamplePackage('med')
  try {
    const result = runScenario(med.dir, 'SCN-MED-RISK-NOTICE', exampleData('med-run.json'))
    // AML 红线不在 MED 契约里，但输出仍不得含 MED 自己的禁语
    assert.equal(result.audit.forbiddenPhraseHits.length, 0)
  } finally {
    rmWorkspace(med.root)
  }
})

test('两域校验均可通过（0 error）', () => {
  for (const domain of ['aml', 'med']) {
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
