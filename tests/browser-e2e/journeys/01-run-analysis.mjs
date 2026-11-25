/**
 * 旅程 J1 —— 运行面（真实用户：跑批看证据）。
 *
 * 用户自然语言意图：
 *  1. 「我想跑一遍危险废物排查场景，用正式受控数据源取数。」
 *  2. 「跑完我要能看到 runId、数据依据、审计结论，以及『必须人审』的提示。」
 *  3. 「页面给我的只能是候选与证据，不能是定性结论。」
 */
import { TABS, openBusinessPage, switchTab, panelText, scanForbidden, PANEL_JS } from '../lib/wst-page.mjs'

export default {
  id: 'run-analysis',
  title: '运行面：正式源跑批 → 候选/证据/人审提示',
  userIntents: [
    '我想跑一遍危险废物排查场景，用正式受控数据源取数',
    '跑完我要能看到 runId、数据依据、审计结论，以及「必须人审」的提示',
    '页面给我的只能是候选与证据，不能是定性结论',
  ],
  async run(c, env) {
    await openBusinessPage(c, env.token)
    await switchTab(c, TABS.run)

    await c.step('用户选「正式（受控数据源）」通道并运行场景', async () => {
      const r = await c.program(`
        ${PANEL_JS}
        await panel.getByRole('button', { name: '正式（受控数据源）', exact: true }).click()
        await page.waitForTimeout(300)
        await panel.getByRole('button', { name: '运行', exact: true }).first().click()
        // 等运行结束（busy 清除）或结果/错误落屏，最长 120s
        for (let i = 0; i < 60; i++) {
          await page.waitForTimeout(2000)
          const t = await panel.innerText()
          if (/runId:/.test(t) || /错误/.test(t)) break
        }
        return (await panel.innerText()).slice(0, 1500)
      `, { fatal: true, timeoutMs: 150000 })
      await c.shot('after-run')
      return r
    })

    const text = await panelText(c)
    c.expect('跑完能看到 runId', /runId:\s*\S+/.test(text), text.slice(0, 500))
    c.expect('能看到数据依据（dataTrust）', text.includes('数据依据'), '')
    c.expect('审计结论以标签呈现（通过/未过）', text.includes('审计') && (text.includes('通过') || text.includes('未过')), '')
    c.expect('「必须人审」上墙（humanReviewRequired=true）', text.includes('humanReviewRequired=true'), '')
    c.expect('结论不是定性断语（禁语零命中）', scanForbidden(text).length === 0, scanForbidden(text).join(','))

    // 探索（内联数据）通道对照：同一场景、最小内联数据也能跑（降级轴标注）
    await c.step('用户改用「探索（内联数据）」通道跑对照批', async () => {
      await c.program(`
        ${PANEL_JS}
        await panel.getByRole('button', { name: '探索（内联数据）', exact: true }).click()
        await page.waitForTimeout(300)
        const box = panel.locator('textarea').first()
        await box.fill(JSON.stringify({
          objects: [{ id: 'BIN-01', type: 'OBJ-WST-BIN', attrs: { fillLevel: 0.95 } }],
          relations: [], behaviors: [], candidates: [],
        }))
        await panel.getByRole('button', { name: '运行', exact: true }).first().click()
        await page.waitForTimeout(5000)
        for (let i = 0; i < 30; i++) {
          const t = await panel.innerText()
          if (/runId:/.test(t) || /错误/.test(t)) break
          await page.waitForTimeout(2500)
        }
        return { ok: true }
      `, { fatal: true, timeoutMs: 120000 })
      await c.shot('explore-run')
    })
    const text2 = await panelText(c)
    c.expect('探索批跑完也有人审提示', text2.includes('humanReviewRequired=true'), text2.slice(0, 300))
  },
}
