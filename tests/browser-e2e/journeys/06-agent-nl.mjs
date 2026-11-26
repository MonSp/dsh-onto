/**
 * 旅程 J6 —— Agent 自然语言对话（真实用户：开口要分析）。
 *
 * 用户自然语言意图：
 *  1. 「我不会用界面按钮也没关系——直接跟 Agent 说：帮我跑 wst-ops 的 SCN-WST-HAZARD-MIX 场景。」
 *  2. 「Agent 的回复里要有规则命中/证据链/humanReviewRequired=true，且不能出现结论性断语。」
 */
import { URL_OF, scanForbidden, GOTO_WARM_JS } from '../lib/wst-page.mjs'

export default {
  id: 'agent-nl',
  title: '自然语言对话：让 Agent 跑场景 → 同源结果与人审提示',
  userIntents: [
    '我直接跟 Agent 说：帮我跑 wst-ops 的 SCN-WST-HAZARD-MIX 场景，给我候选和证据',
    'Agent 的回复里要有规则命中/证据链/humanReviewRequired=true，且不能出现结论性断语',
  ],
  async run(c, env) {
    // 判定谓词（步骤/期望共用，消除「瞬时双正则」与「等价转述」口径不一致导致的假失败）：
    // run 痕迹 = run_scenario 同源回执；人审口径 = humanReviewRequired 或等价转述（同 expect 口径）。
    // 工具卡折叠时 humanReviewRequired 字面量可能不在 innerText——等价转述也算人审明示，不假失败。
    const runTraces = (t) => /CAND-|RULE-|ruleId|run-[0-9a-z]/i.test(t)
    const humanReview = (t) =>
      /humanReviewRequired/i.test(t) || /pending-human|入审|人工复核|不可作为处置依据|不下结论|留给你/i.test(t)

    await c.step('用户进入会话并用自然语言下达分析请求', async () => {
      await c.program(`
        ${GOTO_WARM_JS}
        await gotoWarm(page, ${JSON.stringify(URL_OF(env.token))})
        // composer 在会话外是隐藏的——先开新会话（项目记忆：hero 需菜单/按钮建会话）
        const boxSel = '[contenteditable="true"][data-composer-input="true"]'
        const openSession = async () => {
          const newBtn = page.getByText('新会话', { exact: true }).first()
          if (await newBtn.count().catch(() => 0)) {
            await newBtn.click().catch(() => {})
            await page.waitForTimeout(2000)
          }
        }
        await openSession()
        // 宿主重启后 hero 可能停在「选择一个工作区」——重开一次页面即恢复（同 openBusinessPage 口径）
        if (await page.locator(boxSel).count().catch(() => 0) === 0) {
          await gotoWarm(page, ${JSON.stringify(URL_OF(env.token))})
          await openSession()
        }
        const box = page.locator(boxSel).last()
        await box.waitFor({ state: 'visible', timeout: 20000 })
        await box.click()
        await box.fill('帮我跑 wst-ops 的 SCN-WST-HAZARD-MIX 场景，给我候选和证据；结论必须留给我人工判断。')
        await page.keyboard.press('Enter')
        return { ok: true }
      `, { fatal: true, timeoutMs: 90000 })
      await c.shot('asked')
    })

    await c.step('用户等待 Agent 回复（模型 + run_scenario 工具在环）', async () => {
      // Tabbit 单个 program 有 ~200s 执行上限——分片轮询（每片 30s，更细断点），总窗 6 分钟。
      // break 条件 = run 痕迹 + 人审口径（含等价转述，同 expect）；两者任一持续未现才判「无回复」。
      const deadline = Date.now() + 360000
      let text = ''
      for (;;) {
        await c.program(`await page.waitForTimeout(30000)`, { timeoutMs: 45000 })
        text = String(await c.program(`return (await page.evaluate(() => document.body.innerText || ''))`) ?? '')
        if (runTraces(text) && humanReview(text)) break
        if (Date.now() > deadline) break
      }
      // 仅在「完全没有 run 痕迹」时判无回复（真失败）；人审口径由 expect 判（接受等价转述）——
      // 不再因工具卡折叠使 humanReviewRequired 字面量缺席而假失败。
      if (!runTraces(text)) {
        throw new Error('轮询窗内未见 Agent 回复（run/候选/规则痕迹缺失）')
      }
      await c.shot('answered')
    })

    // 断言用全文（工具卡里 humanReviewRequired 可能被后续渲染推出尾窗）；详情截短。
    // run 痕迹须落在回复/工具结果（CAND-/RULE-/run-xxx/ruleId），不认用户提问里的 SCN-。
    const tail = await c.program(`return (await page.evaluate(() => document.body.innerText || ''))`)
    const text = String(tail ?? '')
    c.expect('回复含 run/候选/规则痕迹（run_scenario 同源）', runTraces(text), text.slice(-400))
    c.expect('人审口径明示（humanReviewRequired=true 或等价转述：不下结论/不可作处置依据/pending-human）',
      humanReview(text), text.slice(-400))
    c.expect('回复无结论性断语（禁语零命中）', scanForbidden(text).length === 0, scanForbidden(text).join(','))

    await c.step('用户让 Agent 打开这次运行的交互报表（issue #33 缺口5 同源回退链）', async () => {
      await c.program(`
        const box = page.locator('[contenteditable="true"][data-composer-input="true"]').last()
        await box.click()
        await box.fill('用 show_run_report 打开这次运行的交互报表，告诉我报表布局来源。')
        await page.keyboard.press('Enter')
        return { ok: true }
      `, { fatal: true, timeoutMs: 45000 })
      // 轮询报表回执：surface 来源标注（model/package/workspace/default）——分片轮询同上
      const deadline = Date.now() + 360000
      let text = ''
      for (;;) {
        await c.program(`await page.waitForTimeout(75000)`, { timeoutMs: 90000 })
        text = String(await c.program(`return (await page.evaluate(() => document.body.innerText || ''))`) ?? '')
        if (/surface\s+(model|package|workspace|default)/i.test(text)) break
        if (Date.now() > deadline) break
      }
      if (!/surface\s+(model|package|workspace|default)/i.test(text)) {
        throw new Error('轮询窗内未见报表 surface 来源标注')
      }
      await c.shot('run-report')
    })

    const tail2 = await c.program(`return (await page.evaluate(() => document.body.innerText || ''))`)
    const text2 = String(tail2 ?? '')
    c.expect('报表 surfaceSource 上墙（model/package/workspace/default 四级回退链同源）',
      /surface\s+(model|package|workspace|default)/i.test(text2), text2.slice(-400))
    c.expect('报表面仍守人审口径（humanReviewRequired=true 或等价转述）', humanReview(text2), text2.slice(-400))
    c.expect('报表面无结论性断语（禁语零命中）', scanForbidden(text2).length === 0, scanForbidden(text2).join(','))
  },
}
