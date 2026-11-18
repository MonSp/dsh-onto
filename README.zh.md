# dsh-onto — 业务本体建模平台

[English](README.md) | [中文](README.zh.md)

> 以 DeepSeek Harness（dsh）为宿主的**业务本体建模 + AI 辅助决策**平台：
> 把专家的业务口径写成机器可校验、可签发、可派生的结构；**判定在规则引擎，认定在人工**。
> 概念、规则与结构的完整定义见 [docs/architecture.md](docs/architecture.md)（自包含）。

## 总览

通用链路：**知识库 → 本体 → 平台装配 → 辅助决策**。任意领域只换包内容，不换骨架。

![通用版：知识库 → 本体 → 平台装配 → 辅助决策](docs/overview-pipeline.zh.svg)

> 英文版见 [README.md](README.md) / [docs/overview-pipeline.en.svg](docs/overview-pipeline.en.svg)。

## 从一句话到自运转

**⓪ 对话前选人。** 新会话 hero 芯片预选专家 preset（反洗钱 AML / 税务 TAX / 医疗 MED），头部标签常显当前专家。**已开聊的会话组合不可热切**——要用专家就 `expert_agent` 派子 agent，或新建会话换身份。

**① 构建期。** 一句话建模：`create_package`（须 `humanApproved`）→ 骨架提案 → `save_skeleton` → 分片 `draft_elements` 起草（草案只入队、不写包）→ 画布人审 → 物化过 **I6 骨架门** → 校验 → 派生 → 加载门禁 → 人工签发（0 校验错 + ≥1 场景卡 + ≥1 打分规则；送审/签发同事务重派生）。

**② 应用期。** 签发后的包是只读应用——`run_scenario` / `invoke_expert`、Web「场景运行」或 CLI。每轮产出候选、风险分、命中规则、证据链、待核实点，恒带 `humanReviewRequired=true`：机器筛查线索与组装证据，人做认定。

**③ 经营循环。** 每轮转一圈：运行留痕 → 经验签名 → 召回提示（只提示不改分）→ 人工回填 → 技能模板草案 → 人审批准物化。ISSUED 只读，升级须 fork 新版本；知识旁路（对话轮次、上传文档）经人审批准入包。

## 能力

- **包管理** —— 建包 / 导入 / 导出 / 版本 fork / 人工签发（`DRAFT → IN_REVIEW → ISSUED`，ISSUED 只读）·
  `dsh-onto package *` · Web
- **对话式建模** —— 一句话 → 骨架 → 分片草案 → 人审 → 物化（I6 骨架门）· 主对话 · Web
- **知识管线** —— 六类原料 → LLM 解析 → 候选队列 → 人审批准 · `dsh-onto knowledge *` · Web
- **校验与派生** —— 引用闭合、权重、`derived/**` 指纹、加载门禁（`DERIVED_DRIFT`）·
  `dsh-onto validate` / `derive` / `gate`
- **规则引擎** —— 先排除后加权打分，每一分都回指规则 ID · core
- **场景运行** —— pipeline 派发、三层审计、运行历史 A/B 对比、审计导出 · `dsh-onto run` / `runs *` · Web
- **可信业务执行** —— 三状态数据面、六元组鉴权、决定→提案台账、外部回执与对账（无回执 ⇒ `unknown`）、
  ticket-sim 与测试适配器 · `record_review_decision` / `create_action_proposal` /
  `execute_behavior_action` / `reconcile_action`
- **经验循环** —— 运行留痕 → 召回提示 → 人工回填 → 技能模板升级 · `dsh-onto exp *` · Web
- **专家 preset** —— 对话前选 AML / TAX / MED；`expert_agent` 派专家子 agent · hero 芯片 · 主对话
- **第二域零改引擎** —— AML + MED + TAX 只换包内容 · `packages/`

## 目录

```
dsh-onto/
  core/       @dsh-onto/core — 纯引擎库 + CLI（零 harness 依赖，236 项 node --test 验收测试）
  backend/    @dsh-onto/backend — dsh bundle：onto* wire 服务（唯一后端落点，289 项测试）
  workbench/  @dsh-onto/workbench — dsh bundle：Web UI 六 tab + 右栏常驻本体图谱
  mock-services/ ticket-sim —— 独立工单模拟服务（SQLite 自身持久化、跨进程幂等、
              故障注入、对账补偿；回执恒为 simulated）
  packages/   业务本体包示例（一等交付物）：aml/1.0.0、med/1.0.0、tax/1.0.0
  examples/   场景运行样例数据（aml-run.json / med-run.json / tax-run.json）
  scripts/    setup-profile.ps1 / dev-web.ps1 / dump-config.ps1
              ensure-expert-presets.ps1（+ expert-presets.json、preset-plugins.standard.yaml：专家 preset 块幂等管理）
  docs/       architecture.md（自包含架构与规则）
              overview-pipeline.{zh,en}.svg（端到端链路图）
```

## 快速开始

前置（一次性）：Node ≥ 24.9 + pnpm 11.x；
作为兄弟目录放置的 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 已完成
`pnpm install && pnpm run build`（harness **只读**依赖，本项目不改其一行代码）。

```powershell
# 1. 创建 dsh-onto profile 并安装 @dsh-onto/backend + @dsh-onto/workbench，播种示例包
dsh-onto\scripts\setup-profile.ps1
# 2. 核对组合配置（硬断言两个 @dsh-onto/* bundle 都在）
dsh-onto\scripts\dump-config.ps1
# 3. 启动 Web UI（浏览器访问打印的 dsh web URL）→ 侧栏「dsh-onto」
dsh-onto\scripts\dev-web.ps1
```

工作台六个 tab：**包管理 · 建模 · 知识库 · 校验派生 · 场景运行 · 经验**（右栏另有常驻「本体图谱」）。

## CLI（不经浏览器）

```powershell
cd dsh-onto\core
pnpm install; pnpm run build

node dist\cli.js package create --name demo --version 1.0.0 --domain DEMO --root ..\workspace
node dist\cli.js package issue --name demo --version 1.0.0 --by <human> --root ..\workspace
node dist\cli.js validate ..\packages\aml\1.0.0
node dist\cli.js derive   ..\packages\aml\1.0.0
node dist\cli.js gate     ..\packages\aml\1.0.0
node dist\cli.js run      ..\packages\aml\1.0.0 SCN-AML-FIND-CLUES --data ..\examples\aml-run.json --out result.json
node dist\cli.js runs compare <runA> <runB> --root ..\workspace
node dist\cli.js knowledge upload --package demo --type LEGACY_SYS --name algo --file algo.txt --root ..\workspace
node dist\cli.js knowledge parse --source <id> --llm deepseek --root ..\workspace
node dist\cli.js exp recall --dir ..\packages\aml\1.0.0 --scenario SCN-AML-FIND-CLUES --data ..\examples\aml-run.json
```

## 验收

- `core/tests/`：**236 项**（`node --test tests/*.test.mjs`）——校验、知识解析、禁语、ISSUED 只读 +
  fork、派生漂移、场景输出契约、经验签名、签发门禁，以及可信数据面（dataStatus fail-closed、
  特征来源治理、动作契约进派生链）。
- `backend/tests/`：**289 项**（`pnpm run test`）——agent 工具契约、动作台账（跨进程互斥占位、
  kill-restart 恢复、提案单次消费）、回答守卫、鉴权接线、attack-surface 不变量表（行为断言）。
- `mock-services/ticket-sim/ticket-sim.test.mjs`：**12 项**——真子进程 + 真 HTTP：跨进程幂等、
  SIGKILL 重启持久化、故障注入、对账。
- 改动后验证阶梯：build + `node --check` → `scripts/dump-config.ps1` → `scripts/dev-web.ps1` + 浏览器冒烟。

## 边界（如实声明）

- 知识库 LLM 解析默认走词面启发（确定性）；DeepSeek API 路径需 `DEEPSEEK_API_KEY`（如 `~/.dsh/.env`）。
- 对话式建模是主入口；画布是「状态 + 人审」面（虚线 = 待审草案），**非自由拖拽建模**（非目标）。
- 平台只做线索筛查与证据组装；认定与处置在人工（设计如此，不是待补功能）。
- 会话 preset **不可热切**（首回合后 Host 拒绝切换，头部标签只读）；换专家身份 = 新会话 hero 选择，或 `expert_agent` 派子 agent。
- 技能按 preset 作用域隔离未做（技能提供方为单例服务，进隔离域有单例边界，Phase 2）；当前靠 persona 约束 + 工具面聚焦。

## 许可证

[MIT](LICENSE)
