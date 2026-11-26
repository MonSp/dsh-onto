/**
 * 旅程 J4 —— 对象面（真实用户：浏览实体 → 看邻域 → 发起动作）。
 *
 * 用户自然语言意图：
 *  1. 「我想浏览实体，按类型看有哪些桶。」
 *  2. 「点开一个桶看它的邻域关系；缺种子/截断必须显式提示，不能装作完整。」
 *  3. 「从对象直接跳去发起动作，对象引用要帮我填好。」
 */
import { TABS, openBusinessPage, switchTab, panelText, scanForbidden, PANEL_JS } from '../lib/wst-page.mjs'

export default {
  id: 'object-explore',
  title: '对象面：实体浏览 → 邻域跳转 → 按对象发起动作',
  userIntents: [
    '我想浏览实体，按类型看有哪些桶',
    '点开一个桶看它的邻域关系；缺种子/截断必须显式提示，不能装作完整',
    '从对象直接跳去发起动作，对象引用要帮我填好',
  ],
  async run(c, env) {
    await openBusinessPage(c, env.token)
    await switchTab(c, TABS.objects)

    await c.step('用户选正式源通道并浏览实体', async () => {
      await c.program(`
        ${PANEL_JS}
        await panel.getByRole('button', { name: '正式（受控数据源）', exact: true }).click()
        await page.waitForTimeout(300)
        await panel.getByRole('button', { name: '浏览', exact: true }).click()
        await page.waitForTimeout(3000)
        return { ok: true }
      `, { fatal: true, timeoutMs: 60000 })
      await c.shot('browsed')
    })

    const text1 = await panelText(c)
    c.expect('实体表或空态可见（对象计数）', text1.includes('对象'), text1.slice(0, 300))

    await c.step('用户用「特征投影」调试候选特征投影（issue #33 缺口2 双入口对称）', async () => {
      const r = await c.program(`
        ${PANEL_JS}
        const btn = panel.locator('button[data-e2e="project-features"]')
        await btn.waitFor({ timeout: 10000 })
        await btn.click()
        await page.waitForTimeout(3000)
        const out = panel.locator('[data-e2e="project-out"]')
        const n = await out.count()
        const t = n > 0 ? await out.first().innerText() : ''
        return { rendered: n > 0, snippet: t.slice(0, 200) }
      `, { fatal: true, timeoutMs: 45000 })
      await c.shot('project-features')
      return r
    })

    const textP = await panelText(c)
    c.expect('投影调试卡可见（统计/投影特征键/派生配方/事实覆盖）',
      textP.includes('特征投影调试') && textP.includes('投影特征键')
        && textP.includes('派生配方') && textP.includes('事实覆盖'), textP.slice(-300))
    c.expect('投影卡零 attrs 正文泄漏之外无禁语', scanForbidden(textP).length === 0, scanForbidden(textP).join(','))

    await c.step('用户展开第一个实体的邻域', async () => {
      const r = await c.program(`
        ${PANEL_JS}
        const ex = panel.getByRole('button', { name: '展开', exact: true })
        if (await ex.count() === 0) return { skipped: 'no rows' }
        await ex.first().click()
        await page.waitForTimeout(2500)
        return { ok: true }
      `, { fatal: false })
      await c.shot('expanded')
      return r
    })

    const text2 = await panelText(c)
    if (text2.includes('邻域') || text2.includes('hops')) {
      c.expect('邻域卡可见且统计显式（对象/关系/候选）',
        /对象:\s*\d+/.test(text2) || /hops/.test(text2), '')
      c.expect('truncated/缺失种子若触发则显式打标（不静默吞）',
        !text2.includes('truncated') || text2.includes('触及跳数上限'), '')
    } else {
      c.expect('无实体行时给出诚实空态', text2.includes('（尚未运行）') || text2.includes('对象'), '')
    }

    await c.step('用户从实体行「按对象发起动作」', async () => {
      const r = await c.program(`
        ${PANEL_JS}
        const act = panel.getByRole('button', { name: '发起动作', exact: true })
        const n = await act.count()
        if (n === 0) return { skipped: 'no rows' }
        let switched = false
        for (let i = 0; i < n; i++) {
          await panel.getByRole('button', { name: '发起动作', exact: true }).nth(i).click()
          await page.waitForTimeout(1000)
          for (let k = 0; k < 8; k++) {
            const t = await panel.innerText()
            if (t.includes('动作（提案')) { switched = true; break }
            await page.waitForTimeout(400)
          }
          if (switched) break
        }
        const t = await panel.innerText()
        const prefilled = await panel.locator('input[type="text"]').nth(1).inputValue().catch(() => '')
        return { switched, prefilled, tabTitle: t.slice(0, 100) }
      `, { fatal: false, timeoutMs: 60000 })
      await c.shot('act-from-object')
      return r
    })

    const text3 = await panelText(c)
    c.expect('跳到动作面（页签标题可见）', text3.includes('动作（提案'), text3.slice(0, 200))
  },
}
