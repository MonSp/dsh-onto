---
feature: dsh-native-integration
status: delivered
updated: 2026-11-03
source: https://github.com/MonSp/dsh-onto/pull/2
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

**Verification** — `core`：`pnpm run build` + `node --test tests/*.test.mjs` 73/73 PASS；
`backend`：`pnpm run build` + `node --check dist/*` + `pnpm run test` 87/87 PASS；
`workbench`：`pnpm run build` + `node --check dist/index.js dist/client.js` PASS；
`scripts/dump-config.ps1 -ProfileName dsh-onto-v012` 2/2 包在组合中 PASS；
会话内验收（dev-web + Tabbit）PASS：对话「帮我跑 AML 线索场景」→ 轨迹可见
`run_scenario{aml-analysis@1.0.0, SCN-AML-FIND-CLUES, datasetPath: examples/aml-run.json}`
工具调用，工具结果含命中规则/证据[RULE-…]、humanReviewRequired=true、
禁语扫描 0 命中（通过）、三层闭合 passed。评审十二轮：首轮 2 critical + 2 major 修复后
复审 PASS，并关死双字段 guard 残余旁路；第三轮补 skill 目录失效漏 fork/transition/
createPackage 写路径、upload_knowledge_source packageId 存在性校验、
readToolContracts 错误包装、objectRef 实例段按类型段判定；第四轮补 list_packages
输出投影、空 subject 授权匹配、prerelease 版本序、加载错误路径回显；第五轮清零
9 项 minor（guard 非法参数拒绝、装配断言类型锐度、错误路径回显口径统一、
guard 保留 DERIVED_DRIFT 码、回执字段对齐 S2.2、prerelease 标识符数值序、
skillNameFromId 空 id 兜底、locator workspace 包容断言）并补测试缺口；
第六轮修 locator 畸形输入防御（locatorInWorkspace 非字符串直接拒绝 +
get() 窄化校验）、装配断言补 narrative 数组、guard catch 非 AgentToolError
回退不回显底层 message；第七轮修 major 级 packageId 口径断层
（upload 入参 `name@version` 校验存在性、入库归一为裸包名，打通上传→解析→
物化闭环）与 idRule 顶层 join（readToolContracts 按 objectId 并入条目）、
guard/execute null 口径统一（pickContracts）、run_scenario 错误包装剥绝对路径
（wrapRunError）、list_packages semver 排序；第八轮修复审两项残留：
run_scenario.dataset 内嵌 objectRef 收权（S2.4 口径明确，双通道解析后
deny-by-default）与 core versionDir 目录穿越面（归一后必须落在 packagesDir 内，
否则 PACKAGE_MALFORMED fail-loud），测试补至 core 62 / backend 50 项。
第九轮清零复审 3 项 nit：grantGuardDecision 保留 PackageStoreError 机器码
（穿越拒绝不再退化 UNKNOWN_ERROR）、isInsideDir/locatorInWorkspace 两侧 realpath
再比（packages 内 junction 指向外部即拒绝，扫描回退 dir 同步兜底，locator 收敛
core 单源）、toolOut 由 `as never` 改为上下文推断出口类型（返回类型即
output.schema 契约值类型），测试补至 core 63 / backend 52 项。
第十轮修复 9 项（3 minor + 6 nit）：validateDatasetShape 元素级校验
（objects/relations/behaviors 畸形元素落 INVALID_ARGS，不裸抛 TypeError）、
readToolContracts 门禁内部读取失败收口 DERIVED_DRIFT（execute 路径不泄绝对路径）、
禁语命中渲染脱敏（S2.3：渲染文本不回显短语，audit 结构面保留供人审）、
versionDir 单段校验（空/多级下钻 fail-loud，防越界不只防逃出）、semver build
metadata 不参与优先级且非数字段不猜 0、S2.8 计数勘误、renderRunText 排除行
与内联 dataset e2e 测试补缺、assertRunContract excluded 形状断言、知识库
packageId 归一收口（uploadSource/listSources/listCandidates 双形态一致），
测试补至 core 65 / backend 58 项。第十一轮（终审）修复 2 major + 1 minor：
dataset 收权双旁路（重复实例 id 消歧 + 类型段伪托拒绝，deny-by-default）、
renderRunText 禁语整体脱敏（叙述/证据行不再回显，测试改为真实命中形态）、
assertRunContract 以 Number.isFinite 拒绝 NaN/Infinity——四探针复核全拒且防误伤
正常路径放行。第十二轮（外部审阅）清零 5 项 + 1 设计收紧：run_scenario 出口
toolOut 收口（去 `as never`）、validateDatasetShape 空串 id/type/objectRef 拒绝
（与顶层 guard 口径对称）、skill 名撞名确定性去重（dedupeSkillNames）与 stale
候选拒载（candidateNameForSkl）、wrapRunError 大小写不敏感剥离（Windows 路径
变体）、工具出口 canonical 值经 maskForbiddenPhrases 统一禁语脱敏（S2.3 结构面
与 render 同口径，core/wire 人审面保留完整短语），测试补至 core 65 / backend 65 项。
第十三轮（round-13 修复批）：1 critical + 2 major + 7 minor/nit 清零并固化回归——
禁语脱敏收口为单一全字段深走（修 execute→render 组合路径短语泄漏，round-11/12
两轮修复叠加回归；自嵌短语换标记、剥离相位不动点、幂等同引用）、dataset 声明
type 夹冒号双层拒绝（形状校验 INVALID_ARGS + 收权解析兜底 OBJECT_NOT_GRANTED，
堵 grantSubject 二次剥段伪托）、core canonPath 两侧同策略（最近存在祖先 realpath
+ 词法尾段，修 junction 数据根下 create/fork 误拒回归）、loadToolPackage 派生
门禁单一收口、evidenceChains score 出口契约有限性、skills 去重平局全序确定化
与 get() 胜出者复核、knowledge packageId 类型/空串守卫与 materialize 归一比较、
记录 ID FNV-32 → sha256 截 128-bit（定向碰撞覆盖不可行）、validate 表达式语法
门禁（EXPR_INVALID，排除规则坏语法不再静默漏到运行时）、importVersion 归档 rel
两遍式逃逸校验（wire 导入面）；新增 backend 攻击面回归清单（attack-surface.test）
与 core 回归（junction create/fork、importVersion 逃逸、EXPR_INVALID、
packageId 守卫/sha256 id/materialize 归一），测试补至 core 72 / backend 74 项；
验证阶梯 1-4 全绿（build/test、node --check、dump-config 2/2、dev-web + Tabbit
冒烟：五 tab、aml-analysis 场景运行 6/6 断言、会话内 run_scenario 调用
humanReviewRequired=true + 禁语 0 命中 + 规则 ID/证据链齐全）。
第十三轮后外部复审收敛判定「已收敛，可合并」（无新 critical/major），并清零其
3 minor + 3 nit：禁语脱敏 ID 回指面不改写（撞短语 fail-loud）、嵌套短语长者优先
消残片 + phrase 字段空化（恢复同引用幂等，兼消「禁语恰为标记」原样留存问题）、
writeSource relPath 与 importVersion 同一口径（isSafeRelPath：ADS 冒号拒绝，
封死 NTFS 隐藏流）、compareSources 全序收口至模板序列化判别、skills list()
包含性过滤（junction 指外不进目录）；测试补至 core 72 / backend 78。
第十五轮（终审修复）：错误面禁语退避——`asToolError`/`toolExecute` 接受红线清单
（按 args 惰性 `loadPackage`，仅 catch 求值），message 含短语整段退避并保留机器码；
guard 字符串拒绝保留 `CODE:` 前缀；`retreatPhraseEcho` 与 render 兜底同口径
（禁子串手术）。Verification 计数勘误为 core 73 / backend 87（与 AGENTS.md 一致）。

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
| `upload_knowledge_source` | `{packageId, sourceType, name, content}` | `{source: {id, sourceType, name, sha256, parseStatus}}` | 知识原料上传（幂等；packageId 须为工作区真实包 `name@version`，否则 `INVALID_ARGS`/`NOT_FOUND`） |

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
- **规范值** = core `ScenarioRunResult`（audit 面经工具出口禁语脱敏，见下）：候选（riskScore、hitRuleIds、
  evidenceChains[].ruleId、pendingChecks、pendingVerification、narrative）、excluded、
  `humanReviewRequired: true`、reviewGate、ruleHitLog、audit{checks, forbiddenPhraseHits, passed}。
  每一分回指 ruleId 由 core 保证，工具层不改写分数与命中。
- **出口禁语脱敏**（S2.3）：canonical 出口与 render 同一口径——`maskForbiddenPhrases`
  **全字段深走**（narrative / evidenceChains / pendingChecks / audit 等任何字符串面命中即
  脱敏；自嵌短语换标记退避、嵌套短语长者优先消残片、剥离相位兜底到不动点）；
  **ID 回指面不改写**（ruleId / hitRuleIds / objectRef / candidateId 等——
  「工具层不改写命中」；短语撞进 ID 面的构造形态下「不改写」与「零容忍」不可兼得，
  fail-loud 抛 `INVALID_TOOL_OUTPUT` 拒绝产出，错误消息不回显短语）；
  `forbiddenPhraseHits[].phrase` 空化（不回显短语本体，兼作幂等锚点——二次调用
  needle 为空即同引用返回）；`where` 保留（字段在场，含短语时其内短语一并脱敏）；
  core/wire 人审面不经过本函数、保留完整短语。
- **render 合规页脚**：候选摘要行（candidateId、riskScore、命中 ruleId、证据链摘要、待核实点）
  之后强制输出：`humanReviewRequired=true`、禁语扫描命中数（0 = 通过）、三层闭合 passed。
  渲染文本自身不得触发场景 `forbiddenPhrases`（narrative 来自 SKL 模板，只回填不认定）。
- 执行路径：core `runScenario` 自带 `verifyDerived` 门禁——漂移包直接抛 `DERIVED_DRIFT`
  工具错误，与工作台行为一致。包状态不限 DRAFT/ISSUED（与工作台场景运行对等）。
  `get_package` / `get_rule` / `list_scenarios` 的包读取经 `loadToolPackage` 单一收口同过
  门禁（§8.1：未派生/指纹不符即 `DERIVED_DRIFT`，不存在仍 `NOT_FOUND`，均不泄绝对路径）。

### [S2.4] 对象粒度收权（规范 §12.4 落实，决策 D1）

- 收权事实源 = 包内派生 `derived/tool-contracts/tool-contracts.yaml`（`loadgate` 校验：
  缺 manifest / 指纹不符 → 该包收权类工具与 run_scenario 一并拒绝，`DERIVED_DRIFT`）。
- `list_tool_contracts` 是对象/属性的唯一读面：条目只含 `grantScope` / `inputs` / `outputs` /
  `idRule`；未契约化的对象与属性不可读——带 `objectId` 的调用由 guard 拒绝（`OBJECT_NOT_GRANTED`），
  不以空列表掩盖越权。
- `ctx.tools.guard()`（monotonic，后置不可翻转）覆盖全部 7 工具：args 含 `objectId` /
  `objectRef` 时必须命中 tool-contracts 的 grantScope（对象或关系 ID），否则拒绝
  （reason: `OBJECT_NOT_GRANTED`）。`objectRef` 允许运行时实例段（`OBJ-AML-ACCOUNT:x`），
  按 `:` 前的类型段匹配 grantScope（收权是对象粒度）；未收权类型带不带实例段一律拒绝。
- **dataset 内嵌收权**（`run_scenario` 双通道，第八轮）：`dataset.candidates[].objectRef`
  在数据装载后、`runScenario` 前逐条过收权——实例 id 先解析到 `objects[].type`（examples
  形态 `ACCT-001` → `OBJ-AML-ACCOUNT`），否则按 `:` 前类型段匹配 grantScope；无法解析的
  ref 一律 `OBJECT_NOT_GRANTED`（deny-by-default，不以放行掩盖越权）。顶层 args 由
  `ctx.tools.guard` 收口、dataset 由执行前置（`assertDatasetGranted`）收口——datasetPath
  通道需文件解析，归 arg 解析阶段统一处理，两层合起来覆盖全部入参面。
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
  天然不冲突）。跨 id 的 skill 名规范化撞名（如 `SKL-AML_X` 与 `SKL-AML-X`）由
  `dedupeSkillNames` 按同一胜出序（ISSUED 优先、版本降序）确定性去重，不再静默遮蔽；
  `get()` 校验候选名与 locator.sklId 归一结果一致，stale/spoofed 候选拒载。
- 正文 markdown：名称、description、steps、weights 集合、outputTemplate、红线声明
  （叙述只回填模板、禁认定性表述、结论性表述只落 forbiddenPhrases）、使用方式
  （配合 run_scenario 的 SKILL_RUN 步骤）。
- invocation：`modelInvocable: true`、`userInvocable: true`。
- 失效：包写入路径（ontoWorkspace.createPackage/forkVersion/transition/importVersion /
  ontoModel.save/writeSource / ontoKnowledge.materialize）调 provider control 的
  `invalidate()`（模块级失效钩子），目录变更无需重启会话。fork/transition 改变版本集合
  与 ISSUED 状态、直接决定 `skl-*` 去重优胜者，与内容写入同等对待。

### [S2.6] 知识上传工具边界

- `upload_knowledge_source` = `KnowledgeStore.uploadSource` 薄封装（sha256 幂等、五类
  sourceType）；只上传草稿原料，**原料永不直写包**（§5.3 硬规则不变）。
  入参 `packageId` 须为工作区真实包的 `name@version`（`requireExistingPackage`，避免落
  孤儿草稿）；**入库归一为裸包名**（`meta.name`）——知识管线（parseSource → 候选 →
  materialize）与工作台 `listSources` 过滤均按裸名比对，带 `@version` 入库会恒判
  package mismatch、上传→物化闭环断裂（第七轮 major 修复）。
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

- core：现有 65 项测试保持全绿（本特性不改引擎语义）。
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
- 第十二轮外部审阅（独立评审）核对过的关键面：收权双通道 deny-by-default、证据/叙述只回填
  候选自身 features（无跨对象泄漏面）、excluded/ruleHitLog 最小结构、路径脱敏闭环、versionDir
  穿越加固、失效钩子全覆盖、harness API 契约（ToolExecution.name/arguments、ToolGuard
  monotonic、registerProvider(control)）逐一比对。修复 5 项 minor/nit + 1 项设计收紧
  （见 Report 第十二轮）。
