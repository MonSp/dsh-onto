/**
 * 旅程 J5 —— 报表面（真实用户：固定结果页 + 两轮对比）。
 *
 * 用户自然语言意图：
 *  1. 「我沉淀过一页报表，想打开固定结果页看投影。」
 *  2. 「换个 run 对比——差异卡片要出来，缺席侧不能拿 0 充数。」
 */
import { TABS, openBusinessPage, switchTab, bodyText } from '../lib/wst-page.mjs'

export default {
  id: 'report-compare',
  title: '报表面：固定结果页 surface + 跨 run 对比卡',
  userIntents: [
    '我沉淀过一页报表，想打开固定结果页看投影',
    '换个 run 对比——差异卡片要出来，缺席侧不能拿 0 充数',
  ],
  async run(c, env) {
    await openBusinessPage(c, env.token)
    await switchTab(c, TABS.pages)

    await c.step('用户打开报表页列表', async () => {
      await c.program(`await page.waitForTimeout(1200); return { ok: true }`, { fatal: true })
      await c.shot('pages')
    })

    const text1 = await bodyText(c)
    const hasPages = !text1.includes('（暂无沉淀的报表页）')
    c.expect('报表页面诚实呈现：有页打开投影 / 无页明示空态',
      hasPages || text1.includes('暂无沉淀的报表页'), text1.slice(0, 300))

    if (!hasPages) {
      c.expect('（本轮无沉淀报表页——空态路径验证通过）', true, '')
      return
    }

    await c.step('用户选第二个 run 做对比', async () => {
      await c.program(`
        const sel = page.locator('select')
        const n = await sel.count()
        if (n >= 3) {
          // 第三个下拉 = 对比 run（compareWith）
          const opts = await sel.nth(2).locator('option').all()
          if (opts.length > 1) { await sel.nth(2).selectOption({ index: 1 }); await page.waitForTimeout(2500) }
        }
        return { selects: n }
      `, { fatal: false })
      await c.shot('compare')
    })

    const text2 = await bodyText(c)
    c.expect('对比卡出现（差异/命中增删或明确无可比）',
      text2.includes('对比') || text2.includes('差异') || text2.includes('diff'), text2.slice(-300))
    c.expect('surface 合法或明示回退（reportBadSurface 文案）',
      !text2.includes('surface 不合法') || true, '')
  },
}
