---
feature: dsh-native-integration
status: delivered
updated: 2026-11-03
source: feat/v0.1.2-dsh-native-integration
---

# v0.1.2 dsh 原生集成 — 生态差异化

## Report

**What was built** — dsh 原生 agent 面落地在 `@dsh-onto/backend`：7 个工具
（`list_packages` / `get_package` / `get_rule` / `list_tool_contracts` / `list_scenarios` /
`run_scenario` / `upload_knowledge_source`）经 `ctx.tools.register(defineTool)` 注册，
`run_scenario` 返回完整 `ScenarioRunResult`（命中规则 ID、证据链、humanReviewRequired=true、
禁语扫描与三层闭合页脚）；对象粒度收权以派生 tool-contracts 为事实源
（`grantGuardDecision` guard + `projectByContract` 输出投影，未收权对象一律
`OBJECT_NOT_GRANTED`，签发/审阅端点不进工具面）；每个 SKL 模板经
`onto-skill-templates` provider 暴露为 `skl-*` skill（版本去重 ISSUED 优先），
知识上传仅入草稿原料（sha256 幂等、不回显 content）。版本 0.1.2。

**Verification** — `core`：`pnpm run build` + `node --test tests/*.test.mjs` 61/61 PASS；
`backend`：`pnpm run build` + `node --check dist/*` + `pnpm run test` 20/20 PASS；
`workbench`：`pnpm run build` + `node --check dist/index.js dist/client.js` PASS；
`scripts/dump-config.ps1 -ProfileName dsh-onto-v012` 2/2 包在组合中 PASS；
会话内验收（dev-web + Tabbit）PASS：对话「帮我跑 AML 线索场景」→ 轨迹可见
`run_scenario{aml-analysis@1.0.0, SCN-AML-FIND-CLUES, datasetPath: examples/aml-run.json}`
工具调用，工具结果含命中规则/证据[RULE-…]、humanReviewRequired=true、
禁语扫描 0 命中（通过）、三层闭合 passed。评审两轮：首轮 2 critical + 2 major 修复后
复审 PASS，并关死双字段 guard 残余旁路。

## [S1] Problem

dsh-onto v0.1.1 的能力（场景执行、规则口径、派生收权、知识库）只在 Web 工作台的
wire 服务里可达；dsh 会话中的 agent 无法消费：用户不能在对话里说「帮我跑 AML 线索场景」
并拿到合规输出，查口径、引用方法论模板、传知识原料都要离开会话去工作台操作。
本特性把场景执行、只读查询、SKL 方法论、知识上传注册为 dsh 原生 agent 工具/skill，
让业务本体包成为 agent 会话里可直接调用的生态能力。

验收基准（用户给定）：**会话内完成一次场景调用，输出契约与禁语扫描在工具结果里成立。**

## [S2] Design

### [S2.1] 集成拓扑与注册位置

- 全部能力注册在 `@dsh-onto/backend`（唯一 dsh bundle 后端落点），只走 harness 官方扩展点：
  `ctx.tools.register(defineTool(...))`（`@deepseek-ai/dsh-tools`）与
  `ctx.skills.registerProvider(...)`（`@deepseek-ai/dsh-skill`）；deepseek-harness 保持只读。
- `backend/src/agent-tools.ts`：Cordis 函数插件，`inject = ['tools']`，由 `index.ts` `apply()`
  挂载；注册 7 个工具（S2.2）与 1 个收权 guard（S2.4）。纯函数（校验/投影/渲染）与插件
  装配分离导出，供 `backend/tests` 直接测试。
- `backend/src/agent-skills.ts`：Cordis 函数插件，`inject = ['skills']`，注册 SKL provider（S2.5）。
  与 tools 插件分离挂载：任一服务缺席只跳过对应能力，不拖死整个 bundle。
- 数据目录复用 `resolveDataDir(ctx)`（`<profileDir>/dsh-onto/workspace/`），与 wire 服务同源同根。

### [S2.2] 工具面（7 个；签发/审阅端点永不注册）

| 工具 | 参数 | 规范值（output.schema） | 语义 |
|---|---|---|---|
| `list_packages` | 无 | `{ packages: [{name, version, status, domain}] }` | 查包 |
| `get_package` | `{name, version}` | `{ meta, counts, scenarioIds, ruleIds }` | 查包摘要，不倾倒属性 |
| `get_rule` | `{name, version, ruleId?}` | 全量 `{scoreRules, exclusionRules}` 或单条规则 | 查规则口径 |
| `list_tool_contracts` | `{name, version, objectId?}` | `{contracts: [{id, objectId?, relationId?, grantScope, idRule?, inputs, outputs}]}` | 对象粒度收权清单 |
| `list_scenarios` | `{name, version}` | `{scenarios: [{id, name, goal, boundary, inputs, outputFields}]}` | 场景发现 |
| `run_scenario` | `{name, version, scenarioId, datasetPath?, dataset?}` | `ScenarioRunResult`（S2.3） | 场景执行 |
| `upload_knowledge_source` | `{packageId, sourceType, name, content}` | `{source: {id, sourceType, name, sha256, parseStatus}}` | 知识原料上传（幂等） |

- 命名 snake_case、无前缀（任务书点名 `run_scenario` / `list_scenarios`，查询工具同风格）。
  注册撞名 fail-loud（dsh 注册表同层重复抛错），不做自动改名。
- 每个工具声明 `output.schema`（对象根）+ `render()`（面向模型的摘要文本）；工具主体
  不调 LLM、不生成叙述、不改写分数。
- `upload_knowledge_source` 为唯一写工具（幂等草稿原料），其余全部只读。

### [S2.3] run_scenario 输出契约与禁语扫描（验收面）

- **数据输入二选一必填**（决策 D2）：`datasetPath`（JSON 文件路径，绝对或相对进程 cwd，
  如 `examples/aml-run.json`）或 `dataset`（内联 `RuntimeDataset`：objects / relations /
  behaviors? / candidates）。两者同给或都不给 → `INVALID_ARGS`；文件读取或 JSON 解析失败
  → isError，不半跑。内联形态定为完整 `RuntimeDataset`——examples 证明仅有 candidates
  无法通过 `DATA_INGEST`（决策 D2 的「candidates 内联」落为 dataset 对象内联，机制不变）。
- **装配断言**（防御核心回归，断言失败 → isError `INVALID_TOOL_OUTPUT`，不产出残缺结果）：
  `candidates` 为数组；每条含 `riskScore` / `hitRuleIds` / `evidenceChains` / `pendingChecks`；
  `humanReviewRequired === true`；`audit` 含 `forbiddenPhraseHits` 数组。
- **规范值** = core `ScenarioRunResult` 原样：候选（riskScore、hitRuleIds、
  evidenceChains[].ruleId、pendingChecks、pendingVerification、narrative）、excluded、
  `humanReviewRequired: true`、reviewGate、ruleHitLog、audit{checks, forbiddenPhraseHits, passed}。
  每一分回指 ruleId 由 core 保证，工具层不改写。
- **render 合规页脚**：候选摘要行（candidateId、riskScore、命中 ruleId、证据链摘要、待核实点）
  之后强制输出：`humanReviewRequired=true`、禁语扫描命中数（0 = 通过）、三层闭合 passed。
  渲染文本自身不得触发场景 `forbiddenPhrases`（narrative 来自 SKL 模板，只回填不认定）。
- 执行路径：core `runScenario` 自带 `verifyDerived` 门禁——漂移包直接抛 `DERIVED_DRIFT`
  工具错误，与工作台行为一致。包状态不限 DRAFT/ISSUED（与工作台场景运行对等）。

### [S2.4] 对象粒度收权（规范 §12.4 落实，决策 D1）

- 收权事实源 = 包内派生 `derived/tool-contracts/tool-contracts.yaml`（`loadgate` 校验：
  缺 manifest / 指纹不符 → 该包收权类工具与 run_scenario 一并拒绝，`DERIVED_DRIFT`）。
- `list_tool_contracts` 是对象/属性的唯一读面：条目只含 `grantScope` / `inputs` / `outputs` /
  `idRule`；未契约化的对象与属性不可读——带 `objectId` 的调用由 guard 拒绝（`OBJECT_NOT_GRANTED`），
  不以空列表掩盖越权。
- `ctx.tools.guard()`（monotonic，后置不可翻转）覆盖全部 7 工具：args 含 `objectId` /
  `objectRef` 时必须命中 tool-contracts 的 grantScope（对象或关系 ID），否则拒绝
  （reason: `OBJECT_NOT_GRANTED`）。
- 输出投影 `projectByContract()`：契约类输出逐字段裁剪到 inputs/outputs/idRule/grantScope，
  防御意外扩面。
- **签发/审阅端点永不注册为工具**：transition/issue、reviewCandidate、materialize、
  writeSource 仅工作台/人工（§12.4「签发/审阅端点仅人工管理员」）。

### [S2.5] SKL 方法论模板 → agent skill（决策 D3）

- `ctx.skills.registerProvider` 注册 `onto-skill-templates` provider：`list()` 扫描
  `<dataDir>/workspace/packages/*/*/` 的全部 O2SkillTemplate；`get()` 渲染 markdown 正文。
- skill name = `skl-` + SKL id 小写（`SKL-AML-NARRATIVE` → `skl-aml-narrative`，满足
  kebab-case）。
- 同一 SKL id 多版本并存：优先 ISSUED，再按版本号降序取一条（不同包的 ID 含 PKG_TAG，
  天然不冲突）。
- 正文 markdown：名称、description、steps、weights 集合、outputTemplate、红线声明
  （叙述只回填模板、禁认定性表述、结论性表述只落 forbiddenPhrases）、使用方式
  （配合 run_scenario 的 SKILL_RUN 步骤）。
- invocation：`modelInvocable: true`、`userInvocable: true`。
- 失效：包写入路径（ontoModel.save/writeSource / ontoKnowledge.materialize /
  ontoWorkspace.importVersion）调 provider control 的 `invalidate()`（模块级失效钩子），
  目录变更无需重启会话。

### [S2.6] 知识上传工具边界

- `upload_knowledge_source` = `KnowledgeStore.uploadSource` 薄封装（sha256 幂等、五类
  sourceType）；只上传草稿原料，**原料永不直写包**（§5.3 硬规则不变）。
- LLM 解析（parseSource）、人审（reviewCandidate）、物化（materialize）留在工作台 wire，
  不进工具面。
- 返回摘要不回显 content（大块敏感数据不进模型上下文，§12.3）。

### [S2.7] 版本与依赖

- core / backend / workbench 版本 0.1.1 → 0.1.2。
- backend 新增 link 依赖：`@deepseek-ai/dsh-tools`
  （`link:../../deepseek-harness/packages/core/tools`）、`@deepseek-ai/dsh-skill`
  （`link:../../deepseek-harness/packages/skill/skill`）；lockfile 随 install 更新。
- `engines.dsh` 范围不变（`>=0.2.1-rc.2 <0.3.0`）。

### [S2.8] 测试边界

- core：现有 61 项测试保持全绿（本特性不改引擎语义）。
- backend：新增 `backend/tests/*.test.mjs`（`node --test`）覆盖纯函数：数据集双通道校验、
  装配断言、契约输出投影、SKL 正文渲染、收权 guard 判定、幂等上传摘要。测试不起 dsh host。
- 端到端：AGENTS.md 验证阶梯 1–3 不变；第 4 步扩展会话内验收（见 T8）。

## [S3] Out of Scope

- 签发 / 人审 / 物化端点工具化（永远人工；本版不做也不预留接口）。
- L2 外部数据源工具（api-sources 对接）；per-object 独立工具注册（决策 D1 已排除）。
- 会话内 LLM 解析（parseSource 工具化）。
- workbench UI 变更、deepseek-harness 代码变更、规则引擎语义变更。

## Tasks

- [x] T1: backend agent-tools 插件骨架 + `list_packages` / `get_package` / `list_scenarios` — acceptance: backend build + `node --check` 通过；三工具 schema 形状由单测断言（covers: S2.1, S2.2）
- [x] T2: `run_scenario`（数据双通道 + 装配断言 + 合规 render）— acceptance: 单测覆盖双通道校验、断言与 render 合规页脚；对 `examples/aml-run.json` 跑出完整 `ScenarioRunResult`（covers: S2.3）
- [x] T3: 对象粒度收权（`list_tool_contracts` + guard + `projectByContract`）— acceptance: 未契约化 objectId 被 guard 拒；投影不漏 inputs/outputs 之外字段；漂移包拒绝（covers: S2.4）
- [x] T4: `get_rule` 口径工具 — acceptance: 单测断言 score/exclusion 口径字段完整（covers: S2.2）
- [x] T5: SKL provider（扫描 / 命名 / 版本去重 / 正文渲染 / 失效）— acceptance: 单测覆盖命名去重与正文红线段；provider `list()` 对 aml/med 包返回 `skl-*`（covers: S2.5）
- [x] T6: `upload_knowledge_source` — acceptance: 单测断言 sha256 幂等跳过与摘要不回显 content（covers: S2.6）
- [x] T7: 版本 bump 0.1.2 + 依赖 lockfile + AGENTS.md / architecture.md 模块地图更新 — acceptance: 三包 version=0.1.2；验证阶梯 1–3 全绿（covers: S2.7）
- [x] T8: 会话内验收（dev-web + Tabbit）：「帮我跑 AML 线索场景」→ `run_scenario` 工具结果含 ruleId / 证据链 / humanReviewRequired / 禁语扫描 — acceptance: 浏览器会话完成一次场景调用，工具结果可见合规字段，禁语零命中（covers: S2.3）

依赖：T2/T3/T4/T5/T6 ← T1；T7 ← T2…T6；T8 ← T7。

## Journey log

- Workspace 落点覆盖：默认 `.worktrees/{{slug}}` 内的 `link:../../deepseek-harness` 会断
  （harness 是 `D:\trunk\Inv\deepseek-harness` 同级目录），故在 `.worktrees/` 下补了一个
  `deepseek-harness` junction 指向物理路径，worktree 仍在默认位置。
- 运行 dsh host 时 PATH 上的 Node 必须是纯 Node（如 `D:\nvm\v24.22.1`）；MiMo Desktop
  自带的 node 是 Electron 内嵌运行时（V8 带 `-electron` 指纹），harness 原生插件启动即拒
  （`unsupported Electron runtime fingerprint`），且长驻进程的 stdout 经管道/文件是块缓冲，
  验收脚本要靠逐行落盘 + 端口轮询判断存活，不能以「日志为空」判死。
- defineTool 的 output.schema 推断与 core 的 interface 返回类型不兼容（interface 无隐式
  索引签名）；工具出口统一走 `toolOut` 收窄，运行时由 output.schema + 装配断言兜底。
