# 浏览器 E2E 测试链（真实用户自然语言旅程）

对生成业务页（`plugin generate` 产物）与 Agent 对话面做**真实浏览器**验收：
旅程以「用户自然语言意图为一等公民」书写（每个旅程文件顶部的 `userIntents`），
驱动真实 Chromium（Tabbit/Playwright）走完 查询 → 分析 → 动作（批准卡）→ 复核 → 报表
与「开口要分析」的自然语言对话全链，并对红线口径做回归断言
（humanReviewRequired 上墙、批准卡回显上下文摘要、演练/模拟如实标注、禁语零命中、
missingSeedIds/truncated 显式）。

## 运行

```powershell
node tests/browser-e2e/run.mjs                # 全链：重生成 wst-app → 重启宿主(3081) → 六旅程 → 报告
node tests/browser-e2e/run.mjs --list          # 列旅程
node tests/browser-e2e/run.mjs --journey action-approval
node tests/browser-e2e/run.mjs --reuse-host    # 复用在跑宿主（死则拉起，不重生成）
node tests/browser-e2e/run.mjs --skip-regen    # 不重生成插件（仍重启宿主）
node tests/browser-e2e/run.mjs --stop-host     # 跑完停宿主（默认保留）
```

结果：`.out/report.md` + `.out/report.json` + 逐步截图（`.out/shots/<journey>/`）。
退出码非 0 = 有失败或工作区完整性告警。

## 依赖与运维口径（项目记忆固化）

- **node**：`D:\nvm\v24.22.1\node.exe`（harness boot 指纹校验拒 MIMO_NODE）；pnpm 走
  `deepseek-harness/node_modules/.bin`。
- **Tabbit CLI**：`%LOCALAPPDATA%\Tabbit\LocalAgent\bin\tabbit-cli.exe`；每次运行用**全新任务名**
  （跨次复用会带上一实例的冻结/残留状态），结束 `finish` 释放。
- **宿主**：`deepseek-harness` 下 `node --import tsx/esm apps/cli/src/bin.ts --profile dsh-wst --no-open --port 3081`；
  启动用**文件 fd 直落日志**（pipe 会在父进程退出后 EPIPE 拖死宿主）；token 从本次日志解析。
- **mock**：`mock-services/wst-api/server.mjs --port 3912`（缺失自动拉起）。
- **导航**：`127.0.0.1`（`localhost` 有卡死史，以实测为准）；宿主重启后 hero 若停在
  「选择工作区」，重开页面即恢复。

## 结构

```
run.mjs                  # 编排入口（预检 → 插件/宿主 → 旅程 → 报告 → 完整性守卫）
lib/env.mjs              # 插件重生成/宿主起停/token/mock/工作区完整性守卫
lib/tabbit.mjs           # Tabbit 驱动（program/截图/旅程上下文 step·expect）
lib/wst-page.mjs         # 业务页公共操作（开面板/切页签/面板内文本/禁语扫描）
lib/report.mjs           # 报告落盘
journeys/01..06-*.mjs    # 六段旅程（意图 → 步骤 → 期望）
```

## 完整性守卫（铁律）

收尾断言 `deepseek-harness` 工作区干净且 `vendor/cordis/lib` 在位、`core/dist` 在位——
测试基建曾因「junction 穿透 rmSync 误删真身」出过事故；本链所有删树走摘链清理。
