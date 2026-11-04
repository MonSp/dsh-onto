/**
 * agent-skills 纯函数测试（SKL → skill 命名、版本去重、正文渲染）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadPackage } from '@dsh-onto/core'
import {
  collectSkillSources,
  locatorInWorkspace,
  parseSkillLocator,
  pickSkillSources,
  renderSkillBody,
  skillNameFromId,
} from '../dist/agent-skills.js'
import { invalidateSkillCatalog, registerSkillInvalidator } from '../dist/agent-hooks.js'

const AML_DIR = fileURLToPath(new URL('../../packages/aml/1.0.0', import.meta.url))
const MED_DIR = fileURLToPath(new URL('../../packages/med/1.0.0', import.meta.url))

test('skill 命名：SKL id → kebab-case', () => {
  assert.equal(skillNameFromId('SKL-AML-NARRATIVE'), 'skl-aml-narrative')
  assert.match(skillNameFromId('SKL-AML-NARRATIVE'), /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  assert.equal(skillNameFromId('SKL-AML-'), 'skl-aml')
  assert.match(skillNameFromId('SKL-AML-'), /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
})

test('版本去重：ISSUED 优先，同状态版本号降序', () => {
  const tpl = (id) => ({ id, name: id, weights: {} })
  const draft = { versionDir: '/a/1.0.1', status: 'DRAFT', version: '1.0.1', template: tpl('SKL-AML-N') }
  const issuedOld = { versionDir: '/a/1.0.0', status: 'ISSUED', version: '1.0.0', template: tpl('SKL-AML-N') }
  const picked = pickSkillSources([draft, issuedOld])
  assert.equal(picked.get('SKL-AML-N').status, 'ISSUED')

  const d1 = { versionDir: '/a/1.0.0', status: 'DRAFT', version: '1.0.0', template: tpl('SKL-MED-N') }
  const d2 = { versionDir: '/a/1.1.0', status: 'DRAFT', version: '1.1.0', template: tpl('SKL-MED-N') }
  assert.equal(pickSkillSources([d1, d2]).get('SKL-MED-N').version, '1.1.0')
})

test('正文渲染：红线段与权重集合在场', () => {
  const body = renderSkillBody(
    {
      id: 'SKL-AML-NARRATIVE',
      name: '线索叙述模板',
      weights: { 'RULE-AML-SCORE-FANOUT': 0.25 },
      steps: ['回填证据模板', '汇总待核实点'],
      outputTemplate: '候选 {candidateId}',
      description: '用于 AML 线索叙述',
    },
    { name: 'aml-analysis', version: '1.0.0', domain: 'AML' },
  )
  assert.match(body, /## 红线/)
  assert.match(body, /禁止认定性表述/)
  assert.match(body, /RULE-AML-SCORE-FANOUT: 0\.25/)
  assert.match(body, /线索叙述模板/)
  assert.match(body, /SKL-AML-NARRATIVE/)
})

test('aml 包 SKL 模板可渲染成 skill', () => {
  const pkg = loadPackage(AML_DIR)
  assert.ok(pkg.skillTemplates.length > 0, 'aml 包应含 SKL 方法论模板')
  for (const t of pkg.skillTemplates) {
    const name = skillNameFromId(t.id)
    assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    const body = renderSkillBody(t, {
      name: pkg.meta.name,
      version: pkg.meta.version,
      domain: pkg.meta.domain,
    })
    assert.match(body, /## 红线/)
  }
})

test('provider 扫描：aml/med 包均返回 skl-* skill', () => {
  const collected = collectSkillSources([
    { dir: AML_DIR, status: 'DRAFT', version: '1.0.0' },
    { dir: MED_DIR, status: 'DRAFT', version: '1.0.0' },
  ])
  const names = [...collected.values()].map((s) => skillNameFromId(s.template.id))
  assert.ok(names.includes('skl-aml-narrative'), `aml skill 缺失: ${names}`)
  assert.ok(names.includes('skl-med-narrative'), `med skill 缺失: ${names}`)
  for (const n of names) assert.match(n, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
})

test('版本去重：预发布版本排在同号正式版之前（1.0.0-rc1 < 1.0.0）', () => {
  const tpl = (id) => ({ id, name: id, weights: {} })
  const pre = { versionDir: '/a/1.0.0-rc1', status: 'DRAFT', version: '1.0.0-rc1', template: tpl('SKL-AML-N') }
  const rel = { versionDir: '/a/1.0.0', status: 'DRAFT', version: '1.0.0', template: tpl('SKL-AML-N') }
  assert.equal(pickSkillSources([pre, rel]).get('SKL-AML-N').version, '1.0.0')
  assert.equal(pickSkillSources([rel, pre]).get('SKL-AML-N').version, '1.0.0')
})

test('版本去重：预发布标识符按数值序（rc.10 > rc.2）', () => {
  const tpl = (id) => ({ id, name: id, weights: {} })
  const rc2 = { versionDir: '/a/1.0.0-rc.2', status: 'DRAFT', version: '1.0.0-rc.2', template: tpl('SKL-AML-N') }
  const rc10 = { versionDir: '/a/1.0.0-rc.10', status: 'DRAFT', version: '1.0.0-rc.10', template: tpl('SKL-AML-N') }
  assert.equal(pickSkillSources([rc2, rc10]).get('SKL-AML-N').version, '1.0.0-rc.10')
  assert.equal(pickSkillSources([rc10, rc2]).get('SKL-AML-N').version, '1.0.0-rc.10')
  // 数字段低于字母段（semver）
  const rcA = { versionDir: '/a/1.0.0-alpha', status: 'DRAFT', version: '1.0.0-alpha', template: tpl('SKL-AML-N') }
  const rc1 = { versionDir: '/a/1.0.0-1', status: 'DRAFT', version: '1.0.0-1', template: tpl('SKL-AML-N') }
  assert.equal(pickSkillSources([rcA, rc1]).get('SKL-AML-N').version, '1.0.0-alpha')
})

test('skill 命名：空/全非法 id 返回空串（调用方跳过）', () => {
  assert.equal(skillNameFromId(''), '')
  assert.equal(skillNameFromId('___'), '')
  assert.equal(skillNameFromId('---'), '')
  assert.match(skillNameFromId('SKL-AML-NARRATIVE'), /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
})

test('locator：versionDir 必须落在 workspace 内', () => {
  assert.equal(locatorInWorkspace('/ws/pkg/1.0.0', '/ws'), true)
  assert.equal(locatorInWorkspace('/ws', '/ws'), false)
  assert.equal(locatorInWorkspace('/other/pkg', '/ws'), false)
  assert.equal(locatorInWorkspace('/ws/../etc', '/ws'), false)
  assert.equal(locatorInWorkspace('/wsfoo/pkg', '/ws'), false)
  // 非字符串 / 空串输入直接拒绝，不抛 TypeError
  assert.equal(locatorInWorkspace(undefined, '/ws'), false)
  assert.equal(locatorInWorkspace(null, '/ws'), false)
  assert.equal(locatorInWorkspace(123, '/ws'), false)
  assert.equal(locatorInWorkspace('', '/ws'), false)
})

test('locator 窄化：畸形输入返回 undefined，合法输入解构出字段', () => {
  assert.equal(parseSkillLocator(undefined), undefined)
  assert.equal(parseSkillLocator(null), undefined)
  assert.equal(parseSkillLocator('x'), undefined)
  assert.equal(parseSkillLocator(42), undefined)
  assert.equal(parseSkillLocator({}), undefined)
  assert.equal(parseSkillLocator({ versionDir: 1, sklId: 'SKL-X' }), undefined)
  assert.equal(parseSkillLocator({ versionDir: '/ws/p', sklId: null }), undefined)
  assert.deepEqual(parseSkillLocator({ versionDir: '/ws/p', sklId: 'SKL-X' }), {
    versionDir: '/ws/p',
    sklId: 'SKL-X',
  })
})

test('失效钩子：注册/注销生命周期（dispose 后不泄漏、不再触发）', () => {
  let n = 0
  const un1 = registerSkillInvalidator(() => {
    n += 1
  })
  const un2 = registerSkillInvalidator(() => {
    n += 1
  })
  invalidateSkillCatalog()
  assert.equal(n, 2)
  un1()
  invalidateSkillCatalog()
  assert.equal(n, 3)
  un2()
  invalidateSkillCatalog()
  assert.equal(n, 3)
})
