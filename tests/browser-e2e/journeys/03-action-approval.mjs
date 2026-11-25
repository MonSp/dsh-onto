/**
 * 旅程 J3 —— 动作面（真实用户：提案 → 两段式批准卡 → 执行 → 留痕）。
 *
 * 用户自然语言意图：
 *  1. 「对已批准的候选发起一笔受治理的业务动作提案。」
 *  2. 「批准前我要能看到这次批准绑定的上下文摘要——确认没被换包才点确认。」
 *  3. 「执行结果必须如实标注演练/模拟，不许冒充真实业务成功。」
 */
import { TABS, openBusinessPage, switchTab, panelText, scanForbidden, PANEL_JS } from '../lib/wst-page.mjs'

export default {
  id: 'action-approval',
  title: '动作面：立提案 → 批准卡回显摘要 → 执行如实上墙',
  userIntents: [
    '对已批准的候选发起一笔受治理的业务动作提案',
    '批准前我要能看到这次批准绑定的上下文摘要——确认没被换包才点确认',
    '执行结果必须如实标注演练/模拟，不许冒充真实业务成功',
  ],
  async run(c, env) {
    await openBusinessPage(c, env.token)
    await switchTab(c, TABS.action)

    await c.step('用户选已批准决定与候选，填写行为/对象/载荷，立提案', async () => {
      const r = await c.program(`
        ${PANEL_JS}
        // 运行下拉：选第一条（已批准 run）
        const runSel = panel.locator('select').first()
        await runSel.waitFor({ timeout: 15000 })
        await runSel.selectOption({ index: 0 })
        await page.waitForTimeout(1500)
        const selects = panel.locator('select')
        const decSel = selects.nth(1)
        const candSel = selects.nth(2)
        const decOpts = await decSel.locator('option').count()
        if (decOpts === 0) return { fatal: '决定下拉无已批准决定（复核面未落决定？）', decOpts }
        await decSel.selectOption({ index: 0 })
        await page.waitForTimeout(300)
        const candOpts = await candSel.locator('option').count()
        if (candOpts === 0) return { fatal: '候选下拉为空', decOpts, candOpts }
        await candSel.selectOption({ index: 0 })
        // 行为 / 对象（面板内文本框，勿打到外壳搜索框）
        const inputs = panel.locator('input[type="text"]')
        await inputs.nth(0).fill('BHV-WST-MIX')
        await inputs.nth(1).fill('OBJ-WST-BIN:BIN-01')
        await panel.locator('textarea').first().fill(JSON.stringify({ note: 'browser-e2e', amount: 1 }))
        // 等按钮变可用再点
        const createBtn = panel.getByRole('button', { name: '立提案', exact: true })
        for (let i = 0; i < 20 && await createBtn.isDisabled(); i++) await page.waitForTimeout(300)
        await createBtn.click()
        await page.waitForTimeout(2500)
        return { decOpts, candOpts, panelTail: (await panel.innerText()).slice(-400) }
      `, { fatal: true, timeoutMs: 60000 })
      await c.shot('proposal-created')
      return r
    })

    const text1 = await panelText(c)
    c.expect('提案回执可见（PROP-/操作）', /PROP-|操作/.test(text1), text1.slice(-300))

    await c.step('用户对新提案点「批准执行」，打开批准卡核对摘要', async () => {
      await c.program(`
        ${PANEL_JS}
        const btn = panel.getByRole('button', { name: '批准执行', exact: true })
        await btn.first().waitFor({ timeout: 15000 })
        await btn.first().click()
        await page.waitForTimeout(2500)
        return { ok: true }
      `, { fatal: true, timeoutMs: 45000 })
      await c.shot('approval-card')
    })

    // —— B1 回归：批准卡必须回显挑战与上下文摘要 ——
    const cardText = await panelText(c)
    c.expect('批准卡显示「上下文摘要」并带 64 位摘要值',
      cardText.includes('上下文摘要') && /[0-9a-f]{32,}/i.test(cardText), cardText.slice(0, 500))
    c.expect('批准卡显示挑战号（uiac-）', /uiac-[0-9a-z]+/i.test(cardText), '')

    await c.step('用户确认执行（批准卡单次消费）', async () => {
      await c.program(`
        ${PANEL_JS}
        await panel.getByRole('button', { name: '确认执行', exact: true }).click()
        await page.waitForTimeout(4000)
        return { ok: true }
      `, { fatal: true, timeoutMs: 45000 })
      await c.shot('executed')
    })

    const text2 = await panelText(c)
    // —— M3 回归：结果分色 + note 上墙 ——
    c.expect('执行回执含动作号与状态', /act-|succeeded|unknown|compensated/.test(text2), text2.slice(-400))
    // —— M2 回归：演练/模拟显式上墙 ——
    c.expect('演练/模拟性质显式标注（不冒充真实成功）',
      text2.includes('演练') || text2.includes('simulated'), '')
    c.expect('治理链动作行带连接器与演练标（若有动作行）',
      text2.includes('连接器') || text2.includes('dryrun') || text2.includes('simulated'), '')
    c.expect('动作面无禁语', scanForbidden(text2).length === 0, scanForbidden(text2).join(','))
  },
}
