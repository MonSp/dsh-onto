/**
 * aml-review-workbench T3/T4 — 治理面板源码契约：
 * 列表筛选、证据详情、复核表单直写、待对账只读、无重新执行引导。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const appSrc = readFileSync(join(REPO, 'apps', 'aml', 'src', 'client', 'app.ts'), 'utf8')
const clientSrc = readFileSync(join(REPO, 'apps', 'aml', 'src', 'client.ts'), 'utf8')
const localeSrc = readFileSync(join(REPO, 'apps', 'aml', 'src', 'client', 'locale.ts'), 'utf8')

test('列表：reviewStatus 筛选与 pending 排序呈现', () => {
  assert.ok(appSrc.includes("setFilter"), '状态筛选存在')
  assert.ok(appSrc.includes("reviewStatus"), '读取 reviewStatus')
  assert.ok(appSrc.includes("filterPending") || appSrc.includes('pending'), '待复核筛选项')
  assert.ok(localeSrc.includes('待复核'), 'zh 待复核文案')
})

test('证据详情：showRun + 证据链/缺数/审计可见', () => {
  assert.ok(appSrc.includes('showRun'), '调用 showRun')
  assert.ok(appSrc.includes('evidenceChains'), '证据链')
  assert.ok(appSrc.includes('pendingChecks'), '缺数/待核实')
  assert.ok(appSrc.includes('pendingVerification'), '待核实标记')
  assert.ok(appSrc.includes('ruleHitLog'), '规则命中日志')
  assert.ok(appSrc.includes('auditChecks') || appSrc.includes('audit.checks'), '审计检查')
  assert.ok(appSrc.includes('amli-warnbox'), 'warn 呈现分支')
  // 只读：无重跑入口
  assert.ok(!appSrc.includes('runScenario('), '详情区不得触发重跑')
})

test('复核表单：recordReviewDecision 直写 + 候选多选', () => {
  assert.ok(clientSrc.includes("desc('ontoRuntime', 'recordReviewDecision'"), '描述符已登记')
  assert.ok(appSrc.includes('recordReviewDecision'), 'UI 调用 wire')
  assert.ok(appSrc.includes('selectedIds'), '候选多选')
  assert.ok(appSrc.includes("decision === 'approved'"), '批准/拒绝切换')
  assert.ok(appSrc.includes('submitReview'), '提交入口')
  // 不收自报 reviewer：recordReviewDecision 请求体不含 reviewer（类型字段 reviewer: string 不算）
  const rrdCall = appSrc.slice(appSrc.indexOf('recordReviewDecision('), appSrc.indexOf('recordReviewDecision(') + 500)
  assert.ok(!rrdCall.includes('reviewer'), 'recordReviewDecision 请求体不含 reviewer')
})

test('治理链：待对账展示且无重新执行按钮', () => {
  assert.ok(appSrc.includes('pendingReconcile') || appSrc.includes('待对账'), '待对账文案')
  assert.ok(appSrc.includes("status === 'unknown'"), 'unknown 判定')
  assert.ok(appSrc.includes("phase === 'dispatched'") || appSrc.includes("status === 'dispatched'"), 'dispatched 判定')
  assert.ok(appSrc.includes('proposalNotApproval') || appSrc.includes('提案 ≠ 执行批准'), '提案≠批准文案')
  // 无重新执行/重试按钮文案
  assert.ok(!/重新执行|re-?execute|retryAction|重试执行/.test(appSrc), '不得出现重新执行引导')
  // 对账/执行工具不进 UI 描述符
  assert.ok(!clientSrc.includes('reconcile_action'), 'reconcile 不进 UI desc')
  assert.ok(!clientSrc.includes('execute_behavior_action'), 'execute 不进 UI desc')
  assert.ok(!clientSrc.includes('create_action_proposal'), 'proposal 不进 UI desc')
})

test('双语 locale 键齐全（zh/en 对称核心键）', () => {
  const keys = [
    'filterPending', 'evidence', 'reviewForm', 'submitReview',
    'pendingReconcile', 'proposalNotApproval', 'noRetry', 'openDetail',
  ]
  for (const k of keys) {
    assert.ok(localeSrc.includes(`${k}:`), `locale 缺 ${k}`)
  }
})
