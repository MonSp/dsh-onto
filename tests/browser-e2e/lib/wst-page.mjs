/**
 * 生成业务页（WST）公共操作层：打开面板、切页签、跑场景、读文本。
 * 选择器以中文标签为准（locale zh）；标签变更会在此集中暴露。
 */

export const TABS = {
  run: '运行',
  review: '复核',
  action: '动作',
  objects: '对象',
  pages: '报表页',
}

export const URL_OF = (token) => `http://127.0.0.1:3081/?token=${token}`

/**
 * 页面打开内联 JS（宿主冷启动自愈）：domcontentloaded 在冷启动时可能 45s 不触发且遗留
 * pending navigation（后续 click 全部卡 "waiting for navigation to finish"）——
 * 用 waitUntil:'commit'（响应体即返回）+ 固定暖机等待 + 一次重试。
 * program 侧注入：`${GOTO_WARM_JS}` 后调 `await gotoWarm(page, url)`。
 */
export const GOTO_WARM_JS = `
  async function gotoWarm(page, url) {
    for (let i = 0; i < 2; i++) {
      try {
        await page.goto(url, { waitUntil: 'commit', timeout: 60000 })
        await page.waitForTimeout(3000)
        return
      } catch (e) { /* 冷启动首跳超时——重试一次 */ }
    }
    throw new Error('页面打开失败（两次尝试）')
  }
`

/** 打开业务页：进 Web UI → 点侧栏「WST 运行」→ 等主面板出现且 wire 健康（场景下拉出选项）。 */
export async function openBusinessPage(c, token) {
  await c.step('用户打开业务页（侧栏「WST 运行」）', async () => {
    await c.program(`
      ${GOTO_WARM_JS}
      await gotoWarm(page, ${JSON.stringify(URL_OF(token))})
      // 宿主重启后 hero 可能停在「选择一个工作区」——重开一次页面即恢复（项目记忆口径）
      const hit = page.getByText('WST 运行', { exact: false }).first()
      if (await hit.count().catch(() => 0) === 0) {
        await gotoWarm(page, ${JSON.stringify(URL_OF(token))})
      }
      await page.getByText('WST 运行', { exact: false }).first().click()
      await page.waitForTimeout(1200)
      // wire 健康闸：场景下拉有选项 = listScenarios 通（否则后续全卡死）
      const scenSel = page.locator('div.txri-gov').last().locator('select').first()
      await scenSel.locator('option').first().waitFor({ state: 'attached', timeout: 30000 })
      return { title: await page.title() }
    `, { fatal: true, timeoutMs: 120000 })
    await c.shot('open')
  })
}

/** 切业务页签。 */
export async function switchTab(c, tabName) {
  await c.step(`用户切到「${tabName}」页签`, async () => {
    await c.program(`
      await page.getByRole('button', { name: ${JSON.stringify(tabName)}, exact: true }).first().click()
      await page.waitForTimeout(500)
      return { ok: true }
    `, { fatal: true })
  })
}

/** 取页面当前可见文本（断言用）。浏览器上下文用 page.evaluate——program 运行在 Node 侧。 */
export async function bodyText(c) {
  const v = await c.program(`return await page.evaluate(() => document.body.innerText || '')`)
  if (typeof v === 'string') return v
  if (v == null) return ''
  return typeof v?.value === 'string' ? v.value : JSON.stringify(v)
}

/** 取业务面板内文本（避免 dsh 外壳（会话列表/搜索框）干扰断言与定位）。 */
export async function panelText(c) {
  const v = await c.program(`
    const panel = page.locator('div.txri-gov').last()
    return await panel.innerText().catch(() => '')
  `)
  return typeof v === 'string' ? v : String(v ?? '')
}

/** 业务面板内定位前缀（程序内统一用 panel.locator(...)，勿打到外壳控件）。 */
export const PANEL_JS = `const panel = page.locator('div.txri-gov').last()`

/** 禁语扫描（红线口径：结论性断语不得出现在用户可见面）。 */
const FORBIDDEN = ['已认定', '构成违规', '确认违法', '事实清楚', '定性为']
export function scanForbidden(text) {
  return FORBIDDEN.filter((p) => text.includes(p))
}
