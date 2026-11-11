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

**⓪ 对话前选人、对话中派活（前置）。** 新会话 hero 芯片可预选三位业务专家（preset：反洗钱 AML / 税务 TAX / 医疗 MED）——Host 把选择应用到空白会话，`persona.prefix` 携带聚焦约束（模型可见），会话头部 `AgentPresetLabel` 常显当前专家。**已开聊的会话组合不可热切**（Host 锁定首回合后的工具面）：对话中途要用专家，要么 `expert_agent` 把任务**派给专家 preset 下的子 agent**（`agent_preset` 选人，完成通知带回原文），要么新建会话换身份（可带交接摘要）。

**① 构建期——一句话创建模型。** 用户在主对话口述意图（「我想识别信用卡套现行为，帮我建个本体包」），agent 查重建包（`create_package`，必须 `humanApproved`——用户明确要求才准建），给出**骨架提案**（全量 ID 清单 + 规模预算 + 取舍理由），用户确认后 `save_skeleton` 落盘；随后按 O1→O2→O3 分片 `draft_elements` 起草——草案只入队、不写包，画布（面板 + 对话右栏常驻图谱）长出虚线节点；人在节点内嵌 ✓/✕ 或检视器逐条/批量批准，物化过 **I6 骨架门**（骨架外 ID 拒绝并把原因上墙）。最后校验 → 派生 → 加载门禁 → 提交评审 → **人工签发**：签发门禁要求 0 校验错、至少 1 张场景卡 + 1 条打分规则、派生与门禁全绿；签发/送审后同事务重派生，签完即可加载。

**② 应用期——基于模型跑真实业务（这就是"使用"）。** 签发后的包是只读可复用的"应用"：agent 一句话 `run_scenario` / `invoke_expert` 跑批，Web「场景运行」贴数据执行，CLI `dsh-onto run` 直跑；每轮产出候选名单、风险分、命中规则、证据链、待核实点，恒带 `humanReviewRequired=true`——机器筛查线索与组装证据，人只在复核队列里做认定。

**③ 应用期的经营循环。** 每次业务使用自动转一圈：运行留痕（三层审计 + 禁语扫描 + 数据指纹）→ 经验签名（`ruleShape` 语义指纹：同 ID 改权重/表达式即不同构，防复用过期结论）→ 下轮同场景 `recall_experience` 自动召回上轮提示（只提示、不改分）→ 人回填结论 / 误迁移判定（必填判定人）/ 复核关注（结构位白名单，自由文本进不了方法论）→ 同构经验聚簇 `abstract_experience` 抽象成技能模板草案（`humanApproved` 入队）→ 人审批准物化，方法论完成一次进化。**写回边界**：ISSUED 只读，方法论升级须 fork 新版本重走构建期（`abstract_experience` 对 ISSUED 包直接跳过、不入队）；知识旁路持续喂料——对话轮次自动入 CONVERSATION 原料，上传的旧系统/政策/接口文档经 LLM 解析成候选，人审批准后并入包。

## 能力

| 能力 | 入口 |
|---|---|
| 包管理：创建 / 导入导出 / 版本 fork / 签发状态机（DRAFT→IN_REVIEW→ISSUED，ISSUED 只读）+ **签发硬门禁**（0 错 + 场景/规则非空 + 派生/门禁） | `dsh-onto package *` / Web「包管理」 |
| **对话式建模**：口述 → 骨架提案（humanApproved）→ 分片起草 → 画布虚线生长 → 节点/检视器人审（单条或批量）→ 物化（I6 骨架门） | 主对话 / Web「建模」（面板 + 右栏常驻图谱） |
| 知识库：六类原料上传 + LLM 解析（词面启发 / DeepSeek API）+ 候选队列 + 人审（批准 / 驳回 / 编辑 / 标记并入；红线候选只能并入场景） | `dsh-onto knowledge *` / Web「知识库」 |
| 校验器：引用闭合 / 权重=1.0 / 字典 / 事件口径 / 属性解析 + 质量分 | `dsh-onto validate` / Web「校验派生」 |
| 派生器：`derived/**` + manifest 指纹 + 加载门禁（`DERIVED_DRIFT`）；物化 / 保存 / YAML 写入 / 状态迁移后同事务重派生 | `dsh-onto derive` / `dsh-onto gate` |
| 规则引擎：排除（before-scoring）→ 打分（权重来自 O2），每分回指 ruleId | `core` 规则引擎 |
| 场景执行：pipeline 最小步派发 + 三层审计闭合 + 人审字段 + 运行历史 A/B 对比 + 审计导出 | `dsh-onto run` / `dsh-onto runs *` / Web「场景运行」 |
| **经验闭环**：运行留痕 → 召回提示 → 人审回填（误迁移 by、结构位复核关注）→ 抽象技能模板草案 → 方法论进化 | `dsh-onto exp *` / Web「经验」 / agent `recall_experience` · `annotate_experience` · `abstract_experience` |
| **专家身份层**：`list_experts` 省参 = 全局业务本体专家索引（一包一卡：包@版本 · 域 · 状态 · 首场景目标 · 场景/技能清单，ISSUED 优先），点名后会话软聚焦该包；技能目录描述自带【包@版本 · 域】前缀；**preset 对话前选择**（hero 芯片三专家 → Host 应用 → 头部标签常显） | 主对话（开场/问「有哪些业务本体」先列卡）/ 新会话 hero 芯片 |
| Agent 工具面：建包 / 骨架 / 起草 / 人审、`run_scenario` · `compare_runs` · `export_audit`、`list_runs` · `list_drafts`、`invoke_expert`（场景 1:1 执行）、**`expert_agent`**（专家子 agent 派发，`agent_preset` 选专家） | 主对话（grant 白名单，签发不开放给 agent） |
| 第二域零改引擎：AML（反洗钱）+ MED（医疗）+ TAX（税务）只换包内容 | `packages/` |

## 目录

```
dsh-onto/
  core/       @dsh-onto/core — 纯引擎库 + CLI（零 harness 依赖，159 项 node --test 验收测试）
  backend/    @dsh-onto/backend — dsh bundle：onto* wire 服务（唯一后端落点，168 项测试）
  workbench/  @dsh-onto/workbench — dsh bundle：Web UI 六 tab + 右栏常驻本体图谱
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

## 产品纪律

1. 业务判定内容只活在 O2/O3；规则引擎是唯一判分路径，**禁止 LLM 参与打分**。
2. LLM 只起草草案（带置信度）；**原料永不直写包**，人审 approved 后才物化。
3. 结论性表述（认定/确定为/已构成…）只允许落 `forbiddenPhrases` 红线，**禁止进输出契约**。
4. **认定永远在人工**：输出恒为 `humanReviewRequired=true`；签发端点仅人工（issuedBy 为 human）。
5. 派生物只读可再生成；手改 → `DERIVED_DRIFT` 拒绝加载；重新派生恢复。
6. 输出必含：候选名单、风险分、命中规则 ID、证据链、待核实点；禁语零容忍扫描。
7. **签发硬门禁**：0 校验错、≥1 场景卡、≥1 打分规则、派生 + 加载门禁通过；状态迁移同事务重派生，签完即可加载。
8. **对话写动作挂 `humanApproved`**（建包、落骨架、起草、抽象）；骨架先行，物化过 I6 骨架门，跳过原因必须上墙。

## 验收

- `core/tests/`：**159 项**（`node --test tests/*.test.mjs`）——校验拦截、六类原料解析、结论不进 O3、
  强制人审、ISSUED 只读、fork、派生漂移拒绝与恢复、端到端场景字段齐全、ruleId/证据链/禁语零命中、
  经验签名（ruleShape 防假同构 + 旧版签名诚实兼容）、签发门禁（空壳/坏包拒绝）、第二域零改引擎。
- `backend/tests/`：**168 项**（`pnpm run test`）——agent 工具契约（humanApproved、骨架先行、
  list_runs/list_drafts）、源断言（重派生 / 门禁 / 人审上墙）等。
- 改动后验证阶梯：core/backend/workbench `pnpm run build` + `node --check` → `scripts/dump-config.ps1`
  → `scripts/dev-web.ps1` + 浏览器冒烟（侧栏五流程 + 自然语言 agent 跑批）。

## 边界（如实声明）

- 知识库 LLM 解析默认走词面启发（确定性）；DeepSeek API 路径需 `DEEPSEEK_API_KEY`（如 `~/.dsh/.env`）。
- 对话式建模是主入口；画布是「状态 + 人审」面（虚线 = 待审草案），**非自由拖拽建模**（非目标）。
- 平台只做线索筛查与证据组装；认定与处置在人工（设计如此，不是待补功能）。
- 会话 preset **不可热切**（首回合后 Host 拒绝切换，头部标签只读）；换专家身份 = 新会话 hero 选择，或 `expert_agent` 派子 agent。
- 技能按 preset 作用域隔离未做（技能提供方为单例服务，进隔离域有单例边界，Phase 2）；当前靠 persona 约束 + 工具面聚焦。
- **0.2.0 经验签名升级**：`ruleShape` 语义指纹为新增字段；升级前落盘的旧笔记（`exp list` 中 `legacySignature=true`）
  **不会** digest 短路，差异表诚实标「旧版签名、无法确认语义同构」并转人工——不静默放行、也不谎称规则已变。
  对该条执行 `exp annotate`（或 agent `annotate_experience`）时按**当前包**升版补指纹；规则若在落盘后已改且未经人确认，请勿升版。

## 当前进展（2026-11-10）

- 版本 **0.2.1**；全链路图谱：场景 `behaviorRefs`/`scoreRefs`/`exclusionRefs` 入图（缺省=全部，与运行时一致），O3→O2→O1 可追踪、排除规则不再孤立；画布跨层边加粗、图例含新 kind。读侧构图，已签发包零迁移。
- **0.2.0**；已合入经验闭环（PR#6）与 closed-loop（PR#7，含画布内嵌人审、批量物化、正文更新通道）。
- Tabbit 全功能自然语言实测走通全流程（六 tab + 右栏图谱 + agent 工具链），据此修复：
  签发门禁（空壳/坏包不再可签）、状态迁移同事务重派生（送审/签发不再 `DERIVED_DRIFT`）、
  物化跳过原因上墙（不再绿勾吞 I6）、经验回填误迁移 by 前端必拦、画布人审按钮二遍绘制防遮挡、
  红线候选并入须场景载体。
- **专家身份层（L4）**：`list_experts` 省参出全局专家索引（一包一卡、ISSUED 优先、无场景显式回退、
  卡上带点名聚焦提示）；技能目录描述带【包@版本 · 域】前缀；建模引导写入「开场先列卡、点名即软聚焦」约定。
- **对话级专家选择（preset 层）**：`setup-profile.ps1` 幂等生成 profile 的专家 preset 块
  （`ensure-expert-presets.ps1` + `expert-presets.json` + `preset-plugins.standard.yaml` 模板）——
  新会话 hero 芯片可选「反洗钱 AML / 税务 TAX / 医疗 MED 专家」，Host 应用到空白会话，
  `persona.prefix` 携带聚焦约束（模型可见），会话头部 `AgentPresetLabel` 显示当前专家。
- **专家子 agent 派发**：顶层注册 `expert_agent`（dsh-tool-subagent，`allowedAgentPresets`
  暴露 onto-aml/onto-tax/onto-med）——标准会话**不热切**（Host 锁定已开聊组合）即可把任务派给
  专家 preset 下的子 agent，异步完成通知带回原文；建模引导含推荐-交接口径。
- 验证全绿：core 159/159 · backend 168/168 · dump-config 2/2 · dev-web + 浏览器冒烟通过。

## 许可证

[MIT](LICENSE)
