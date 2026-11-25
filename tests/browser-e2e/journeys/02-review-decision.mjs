/**
 * 旅程 J2 —— 复核面（真实用户：看证据 → 立决定）。
 *
 * 用户自然语言意图：
 *  1. 「我要在复核页看到待审运行和完整证据链。」
 *  2. 「勾选候选、写清理由、提交复核——这是我的人审决定，须留痕。」
 *  3. 「治理链里要能看到决定、复核人和人审提示。」
 */
import { TABS, openBusinessPage, switchTab, panelText, scanForbidden, PANEL_JS } from '../lib/wst-page.mjs'

export default {
  id: 'review-decision',
  title: '复核面：证据链 → 勾选候选 → 提交决定 → 治理链留痕',
  userIntents: [
    '我要在复核页看到待审运行和完整证据链',
    '勾选候选、写清理由、提交复核——这是我的人审决定，须留痕',
    '治理链里要能看到决定、复核人和人审提示',
  ],
  async run(c, env) {
    await openBusinessPage(c, env.token)
    await switchTab(c, TABS.review)

    await c.step('用户刷新复核队列并打开最近一条含候选的运行', async () => {
      const r = await c.program(`
        ${PANEL_JS}
        const refresh = panel.getByRole('button', { name: '刷新', exact: true })
        if (await refresh.count()) { await refresh.first().click(); await page.waitForTimeout(1500) }
        // 队首可能是「本轮无候选」的对照批——逐条查看直到找到含候选的运行
        const opens = panel.getByRole('button', { name: '查看', exact: true })
        const n = Math.min(await opens.count(), 6)
        let opened = null
        for (let i = 0; i < n; i++) {
          await panel.getByRole('button', { name: '查看', exact: true }).nth(i).click()
          await page.waitForTimeout(1500)
          const t = await panel.innerText()
          if (!t.includes('本轮无候选')) { opened = t.slice(0, 120); break }
        }
        if (!opened) return { fatal: '队列里没有含候选的运行', rows: n }
        return { opened }
      `, { fatal: true, timeoutMs: 60000 })
      await c.shot('evidence')
      return r
    })

    const text = await panelText(c)
    c.expect('证据链区可见（证据链/规则命中/审计项）',
      text.includes('证据链') && text.includes('规则命中') && text.includes('审计项'), text.slice(0, 300))
    c.expect('候选区可见', text.includes('候选'), '')
    c.expect('证据面无禁语', scanForbidden(text).length === 0, scanForbidden(text).join(','))

    await c.step('用户勾选候选、填写理由并提交复核', async () => {
      const r = await c.program(`
        ${PANEL_JS}
        // 候选勾选框按模板 data-e2e 稳定定位（经验回填反例框同为 checkbox，位置选择器会漂移）
        const cb = panel.locator('input[data-e2e="cand-check"]').first()
        await cb.waitFor({ timeout: 10000 })
        await cb.check()
        // 理由框按 data-e2e 定位（placeholder 与 zh 文案耦合，换语言/改文案即失效）
        const reason = panel.locator('input[data-e2e="review-reason"]')
        await reason.fill('browser-e2e：证据链齐全，同意进入动作面')
        await panel.getByRole('button', { name: '提交复核', exact: true }).click()
        await page.waitForTimeout(2500)
        const t = await panel.innerText()
        const lines = t.split('\\n').filter((l) => /已提交|REVIEW_|DEC-|错误/.test(l)).slice(-3)
        return { feedback: lines.join(' | ') }
      `, { fatal: true, timeoutMs: 45000 })
      await c.shot('submitted')
      return r
    })

    const text2 = await panelText(c)
    c.expect('提交回执可见（已提交/DEC-）', /已提交|DEC-/.test(text2), text2.slice(-300))
    c.expect('治理链出现决定行（approved + 复核人）', text2.includes('治理链') && text2.includes('approved'), '')
    c.expect('人审提示仍在', text2.includes('humanReviewRequired=true'), '')
  },
}
