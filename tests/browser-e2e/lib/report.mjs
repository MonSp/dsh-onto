/**
 * 浏览器 E2E 测试链 —— 结果汇总与报告落盘（.out/report.md + report.json）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { OUT_DIR } from './env.mjs'

export function writeReport({ journeys, meta }) {
  mkdirSync(OUT_DIR, { recursive: true })
  const totals = { steps: 0, stepsFailed: 0, expects: 0, expectsFailed: 0 }
  for (const j of journeys) {
    totals.steps += j.steps.length
    totals.stepsFailed += j.steps.filter((s) => !s.ok).length
    totals.expects += j.expects.length
    totals.expectsFailed += j.expects.filter((e) => !e.ok).length
  }
  const verdict = totals.stepsFailed + totals.expectsFailed === 0 ? 'PASS' : 'FAIL'

  const md = [
    `# 浏览器 E2E（真实用户自然语言旅程）报告`,
    ``,
    `- 判定：**${verdict}** · 步骤 ${totals.steps - totals.stepsFailed}/${totals.steps} · 期望 ${totals.expects - totals.expectsFailed}/${totals.expects}`,
    `- 宿主：${meta.hostUrl ?? '(未起)'}`,
    `- 生成插件：${meta.pluginDir}`,
    `- 时间：${new Date().toISOString()}`,
    ``,
    ...journeys.flatMap((j) => [
      `## ${j.id} — ${j.title}`,
      ``,
      `用户意图：`,
      ...j.userIntents.map((s, i) => `${i + 1}. ${s}`),
      ``,
      `| # | 步骤 | 结果 |`,
      `|---|---|---|`,
      ...j.steps.map((s, i) => `| S${i + 1} | ${s.desc} | ${s.ok ? '✅' : `❌ ${String(s.error ?? '').split('\n')[0]}`} |`),
      ``,
      `| 期望 | 结果 |`,
      `|---|---|`,
      ...j.expects.map((e) => `| ${e.desc} | ${e.ok ? '✅' : `❌ ${e.detail}`} |`),
      ``,
    ]),
  ].join('\n')

  writeFileSync(join(OUT_DIR, 'report.md'), md, 'utf8')
  writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify({ verdict, totals, meta, journeys }, null, 2), 'utf8')
  return { verdict, totals, md }
}
