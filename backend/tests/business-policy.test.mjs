/**
 * M1-C 实例级鉴权验收：授权六元组 / 三次独立检查 / 身份可信源 fail-closed /
 * 数据范围收窄 / 批准卡不授予权限（权限判定独立于批准）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BusinessPolicy, authorize, businessPolicy, parseTargetRef } from '../dist/business-policy.js'

/** 真实性检查替身（类型/实例存在性由本体与数据面回答）。 */
const CHECKS = {
  typeExists: (t) => ['OBJ-AML-ACCOUNT', 'OBJ-AML-CUSTOMER'].includes(t),
  instanceExists: (t, i) => i !== 'GHOST',
}

const ANALYST = {
  userId: 'u-1',
  tenant: 'tenant-a',
  roles: ['analyst'],
  dataScope: { objectTypes: ['OBJ-AML-ACCOUNT', 'OBJ-AML-CUSTOMER'] },
}

test('C1-1 三次独立检查：类型不存在 / 实例不存在 / 有权——各自独立拒绝或放行', () => {
  // 类型不存在
  assert.match(
    authorize(ANALYST, 'read', { type: 'OBJ-NOPE', instance: 'x' }, CHECKS) ?? '',
    /类型不存在/,
  )
  // 实例不存在
  assert.match(
    authorize(ANALYST, 'read', { type: 'OBJ-AML-ACCOUNT', instance: 'GHOST' }, CHECKS) ?? '',
    /实例不存在/,
  )
  // 有权
  assert.equal(authorize(ANALYST, 'read', { type: 'OBJ-AML-ACCOUNT', instance: 'ACCT-001' }, CHECKS), undefined)
})

test('C1-2 越权角色：act 需 analyst；无角色拒绝（同类型不同角色不串权）', () => {
  const viewer = { ...ANALYST, roles: ['viewer'] }
  assert.match(
    authorize(viewer, 'act', { type: 'OBJ-AML-ACCOUNT', instance: 'ACCT-001' }, CHECKS) ?? '',
    /需要角色 analyst/,
  )
  assert.equal(authorize(viewer, 'read', { type: 'OBJ-AML-ACCOUNT', instance: 'ACCT-001' }, CHECKS), undefined)
})

test('C1-3 数据范围收窄：类型不在 dataScope 拒绝；实例过滤不满足拒绝', () => {
  const narrow = { ...ANALYST, dataScope: { objectTypes: ['OBJ-AML-ACCOUNT'] } }
  assert.match(
    authorize(narrow, 'read', { type: 'OBJ-AML-CUSTOMER', instance: 'C1' }, CHECKS) ?? '',
    /不在数据范围/,
  )
  const filtered = { ...ANALYST, dataScope: { objectTypes: [], instanceFilter: 'ACCT-' } }
  assert.equal(authorize(filtered, 'read', { type: 'OBJ-AML-ACCOUNT', instance: 'ACCT-001' }, CHECKS), undefined)
  assert.match(
    authorize(filtered, 'read', { type: 'OBJ-AML-ACCOUNT', instance: 'OTHER-1' }, CHECKS) ?? '',
    /不满足数据范围实例过滤/,
  )
})

test('C1-4 身份可信源 fail-closed：提供者缺席/异常/形状非法 → 拒绝开展受控业务', () => {
  const policy = new BusinessPolicy()
  // 未登记提供者
  assert.match(
    policy.authorize('read', { type: 'OBJ-AML-ACCOUNT', instance: 'ACCT-001' }, CHECKS) ?? '',
    /身份不可确认/,
  )
  // 提供者异常
  policy.setIdentityProvider(() => {
    throw new Error('auth service down')
  })
  assert.match(
    policy.authorize('act', { type: 'OBJ-AML-ACCOUNT', instance: 'ACCT-001' }, CHECKS) ?? '',
    /身份不可确认/,
  )
  // 形状非法（自称身份）
  policy.setIdentityProvider(() => ({ userId: '', tenant: '', roles: 'analyst', dataScope: {} }))
  assert.match(
    policy.authorize('act', { type: 'OBJ-AML-ACCOUNT', instance: 'ACCT-001' }, CHECKS) ?? '',
    /身份不可确认/,
  )
  // 正常提供者 → 走完整判定
  policy.setIdentityProvider(() => ANALYST)
  assert.equal(
    policy.authorize('read', { type: 'OBJ-AML-ACCOUNT', instance: 'ACCT-001' }, CHECKS),
    undefined,
  )
})

test('C1-5 目标引用解析：非法形态拒绝（裸类型/空实例段/歧义）', () => {
  assert.deepEqual(parseTargetRef('OBJ-AML-ACCOUNT:ACCT-001'), { type: 'OBJ-AML-ACCOUNT', instance: 'ACCT-001' })
  for (const bad of ['OBJ-AML-ACCOUNT', 'OBJ-AML-ACCOUNT:', 'OBJ-AML-ACCOUNT:a:b', ':x']) {
    assert.throws(() => parseTargetRef(bad), (e) => e.code === 'INVALID_ARGS', bad)
  }
})

test('C1-6 history 操作无实例面也过身份/角色（覆盖运行历史授权）', () => {
  const policy = new BusinessPolicy()
  policy.setIdentityProvider(() => ANALYST)
  assert.equal(policy.authorize('history', null, CHECKS), undefined)
  const policy2 = new BusinessPolicy()
  assert.match(policy2.authorize('history', null, CHECKS) ?? '', /身份不可确认/, '无身份连历史都不放')
})

test('C1-7 共享策略面 businessPolicy 在场（部署适配器接线用）', () => {
  assert.equal(typeof businessPolicy.resolveIdentity, 'function')
  assert.equal(businessPolicy.resolveIdentity(), null, '未接线时身份不可确认（正式模式关闭）')
})
