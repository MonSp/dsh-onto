/**
 * 旅程 J6 —— Agent 自然语言对话（真实用户：开口要分析）。
 *
 * 用户自然语言意图：
 *  1. 「我不会用界面按钮也没关系——直接跟 Agent 说：帮我跑 wst-ops 的 SCN-WST-HAZARD-MIX 场景。」
 *  2. 「Agent 的回复里要有规则命中/证据链/humanReviewRequired=true，且不能出现结论性断语。」
 */
import { URL_OF, scanForbidden } from '../lib/wst-page.mjs'

export default {
  id: 'agent-nl',
  title: '自然语言对话：让 Agent 跑场景 → 同源结果与人审提示',
  userIntents: [
    '我直接跟 Agent 说：帮我跑 wst-ops 的 SCN-WST-HAZARD-MIX 场景，给我候选和证据',
    'Agent 的回复里要有规则命中/证据链/humanReviewRequired=true，且不能出现结论性断语',
  ],
  async run(c, env) {
    await c.step('用户进入会话并用自然语言下达分析请求', async () => {
      await c.program(`
        await page.goto(${JSON.stringify(URL_OF(env.token))}, { waitUntil: 'domcontentloaded', timeout: 45000 })
        await page.waitForTimeout(2500)
        // composer 在会话外是隐藏的——先开新会话（项目记忆：hero 需菜单/按钮建会话）
        const newBtn = page.getByText('新会话', { exact: true }).first()
        if (await newBtn.count().catch(() => 0)) {
          await newBtn.click().catch(() => {})
          await page.waitForTimeout(2000)
        }
        const box = page.locator('[contenteditable="true"][data-composer-input="true"]').last()
        await box.waitFor({ state: 'visible', timeout: 20000 })
        await box.click()
        await box.fill('帮我跑 wst-ops 的 SCN-WST-HAZARD-MIX 场景，给我候选和证据；结论必须留给我人工判断。')
        await page.keyboard.press('Enter')
        return { ok: true }
      `, { fatal: true, timeoutMs: 60000 })
      await c.shot('asked')
    })

    await c.step('用户等待 Agent 回复（模型 + run_scenario 工具在环）', async () => {
      // 轮询回复区：最长 150s（LLM + 工具链），见到 humanReviewRequired 或 run 痕迹即收
      await c.program(`
        const deadline = Date.now() + 150000
        let text = ''
        while (Date.now() < deadline) {
          await page.waitForTimeout(5000)
          text = await page.evaluate(() => document.body.innerText || '')
          if (/humanReviewRequired/i.test(text) && /(SCN-|run-|CAND-|RULE-)/i.test(text)) break
        }
        return text.slice(-3000)
      `, { timeoutMs: 180000, fatal: true })
      await c.shot('answered')
    })

    const tail = await c.program(`return (await page.evaluate(() => document.body.innerText || '')).slice(-6000)`)
    const text = String(tail ?? '')
    c.expect('回复含 run/候选/规则痕迹（run_scenario 同源）',
      /(SCN-|run-|CAND-|RULE-)/i.test(text), text.slice(-400))
    c.expect('人审口径明示（humanReviewRequired=true 或等价转述：不下结论/不可作处置依据/pending-human）',
      /humanReviewRequired/i.test(text) || /pending-human|入审|人工复核|不可作为处置依据|不下结论|留给你/i.test(text), '')
    c.expect('回复无结论性断语（禁语零命中）', scanForbidden(text).length === 0, scanForbidden(text).join(','))
  },
}
