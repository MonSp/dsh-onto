---
feature: run-insight
status: delivered
updated: 2026-11-05
source: https://github.com/MonSp/dsh-onto/pull/3
---

# 运行时场景/规则体验深化（Run Insight）

## Report

**What was built** — 运行留痕与对比闭环落地：core 新增 `runstore.ts`（RunRecord 落盘
`<workspace>/runs/`、datasetDigest、runId 围栏、`compareRunRecords`、`exportRunArchive`），
phraseRegistry 经 `configurePhraseStore` 回读 RunRecord.redlines（关掉 backlog #2，跨进程
render 遮蔽）；工具面新增 `compare_runs` / `run_scenarios`（失败隔离+上限 32）/
`export_audit`（固定导出目录、相对 locator、人审面归档/模型面摘要双口径），三出口全部过
P2 策略层（value 闸+render 闸+错误信封）并补 I1–I5 同族攻击面用例；`OntoRuntime` 扩
listRuns/showRun/compareRuns/exportAudit 四 wire 方法（含 backend/src/client.ts 手工
描述符表登记）；workbench 场景运行 tab 增运行记录/两轮对比/导出薄视图；CLI 增
`runs list|show|compare|export` 且 `run` 落盘 RunRecord；版本 0.2.0，AGENTS.md 验证阶梯
增第 5 步。评审 1 critical + 2 major（export render 缺闸、batch render 清单窄于全红线、
runId-only 错误面退避空清单）修复后聚焦复审「五项同族全封，可合并」。

**Verification** — core：`pnpm run build` + `node --test tests/*.test.mjs` 82/82 PASS；
backend：`pnpm run build` + `node --check dist/index.js dist/client.js` + `pnpm run test`
110/110 PASS（含 attack-surface I1–I5 扩表 9 例）；workbench：`pnpm run build` +
`node --check` PASS；`scripts/dump-config.ps1 -ProfileName dsh-onto-v020` 2/2 PASS。
阶梯 5 冒烟 PASS：CLI fork 1.0.1 改权重（FANOUT 0.25→0.4）两轮 compare 出真实 delta
（CAND-001 +0.038 / CAND-002 −0.005433 / CAND-004 +0.060），export 归档含
ruleId/证据链/审计项/humanReviewRequired=true；dev-web + Tabbit：五 tab、aml 场景运行
字段齐全、运行记录列表两行、两轮对比表、导出 locator `runs/exports/run-bc00378c.json`；
会话内 agent 实调 run_scenario（humanReviewRequired=true、禁语 0、三层闭合 passed、
ruleId/证据链齐全）/ run_scenarios（候选=3 命中=4 排除=1）/ compare_runs（跨版本 delta）/
export_audit（exported=true），工具面零禁语。

## [S1] Problem

run_scenario 是一次性调用：结果不落盘，调权前后/版本前后无法对比；多场景只能逐个跑，
无批量面；审计链（ruleHitLog、audit.checks、时间戳）只活在当次返回值里，人审复盘与
合规留痕没有导出通道——AML 场景下审计归档近乎标配，目前当次即焚。phraseRegistry 只在
同进程 execute→render 有效（backlog #2），跨进程/跨会话复盘时 render 侧取不到清单。

验收基准（用户给定）：**对 examples/aml-run.json 两轮运行（第二轮 fork 改权重）→
compare 给出 hitRuleIds 增删与 riskScore delta；导出含 ruleId/证据链/审计项/
humanReviewRequired=true；模型面产物禁语零命中；aml+med 全场景批量全过装配断言。**

## [S2] Design

### [S2.1] RunRecord 持久化与运行注册表（core）

- 新模块 `core/src/runstore.ts`：`buildRunRecord` / `saveRunRecord` / `loadRunRecord` /
  `listRunRecords` / `compareRunRecords` / `exportRunArchive`。`runScenario` 保持纯执行
  （签名不动），持久化由调用方（agent 工具 execute、CLI run、wire ontoRuntime）显式落盘。
- 落点 `<workspaceRoot>/runs/<runId>.json`（workspaceRoot = PackageWorkspace 根；
  CLI 由 versionDir 按 `packages/<name>/<version>` 上溯，`--root` 显式覆盖（CLI 既有约定），
  推导失败则跳过落盘并在输出标注 `runRecord: skipped`——不破坏既有 `run` 契约）。
  归档落 `<workspaceRoot>/runs/exports/<runId>.json`（S2.4）。
- **RunRecord 形状**（人审面存盘：完整短语、完整证据链，不经过 enforceOutputPolicy）：

  ```ts
  interface RunRecord {
    runId: string                       // 复用 run-${uuid8}（scenario.ts 既有）
    package: { name: string; version: string }
    scenarioId: string
    startedAt: string
    datasetDigest: string               // sha256(canonicalJson(dataset))，键序稳定
    datasetSummary: { objects: number; relations: number; behaviors: number; candidates: number }
    redlines: string[]                  // 当轮双源短语清单（命中 ∪ 场景红线，去重非空）
    result: ScenarioRunResult           // 掩蔽前完整结果
    savedAt: string
  }
  ```

- **路径围栏**：runId 单段校验（同 versionDir 口径：非空、无 `/\\`、无 `.`/`..`、无 `:`），
  非法 → `INVALID_ARGS`；读写经 `isSafeRelPath` + `isInsideDir` 同族；不存在 → `NOT_FOUND`，
  错误不回显 resolve 后绝对路径。`runs/`、`runs/exports/` 目录不存在时按需创建（围栏内）。
- **phraseRegistry 落盘（关掉 backlog #2）**：`agent-policy.ts` 增加可选持久后端
  `configurePhraseStore(recall)`（插件装配时注入 `loadRunRedlines(ws.root, ·)`）。
  **RunRecord.redlines 是清单的落盘面**（保存时写入，单源不双写）；`rememberPhrases`
  写内存；`recallPhrases` 内存未命中 → 持久后端回读 → 仍无则既有「命中源回退」。
  未配置持久后端时行为不变（纯函数测试路径不回归）。清单仅用于遮蔽，永不随渲染文本
  出模型面。
- 持久化时机：execute 路径在 `runScenario` 之后、`enforceOutputPolicy` 之前
  （存掩蔽前完整结果）；工具返回值仍走掩蔽。CLI/wire 为人审面，返回完整结果（现状不变）。

### [S2.2] `compare_runs` 工具（两轮对比）

- 参数 `{ runIdA, runIdB }`（只认 runId——包/场景/版本都可不同，跨版本 fork 对比正是
  本意；runId 形态校验同 S2.1）。不带 objectId/objectRef，收权 guard 空过（与
  `list_packages` 同类；对象收权语义不适用，diff 只含候选自身字段）。
- 输出 `RunDiff`（全字段类型断言，riskScore 数值 `Number.isFinite` 拒 NaN/Infinity）：

  ```ts
  interface RunDiff {
    runIdA: string; runIdB: string
    scenarioA: string; scenarioB: string
    packageA: { name: string; version: string }
    packageB: { name: string; version: string }
    sameDataset: boolean                // datasetDigest 相等
    candidates: Array<{
      candidateId: string
      riskScoreA: number | null; riskScoreB: number | null
      riskScoreDelta: number | null     // B − A；单侧缺失为 null
      hitRuleIdsAdded: string[]         // B 相对 A
      hitRuleIdsRemoved: string[]
      pendingChecksAdded: string[]      // 按 ruleId+note 归一集合的增删
      pendingChecksRemoved: string[]
    }>
    excludedAdded: Array<{ candidateId: string; ruleId: string }>
    excludedRemoved: Array<{ candidateId: string; ruleId: string }>
    auditPassedA: boolean; auditPassedB: boolean
    humanReviewRequired: true
  }
  ```

- 候选集按 candidateId 并集；仅单侧存在的候选另一侧分数为 null、增删按全量入列。
- **模型面口径**：输出只含结构化字段（ID、数值、布尔），不含证据链正文/narrative/短语；
  仍整体过 `enforceOutputPolicy`（双 RunRecord.redlines 并集为清单）+ render 闸 +
  `asToolError`。runId 不存在 → `NOT_FOUND`；非法 → `INVALID_ARGS`；记录损坏
  （JSON/形状不符）→ `RUN_FAILED`/`PACKAGE_MALFORMED` 受控信封，不裸抛。
- render：逐候选一行摘要（candidateId、分数 A→B（Δ）、命中 ±、待核实 ±）＋页脚
  humanReviewRequired=true、audit passed A/B。

### [S2.3] `run_scenarios` 批量执行

- 参数 `{ name, version, scenarioIds?: string[], datasetPath?, dataset? }`；
  dataset 双通道与互斥规则、装载校验、`assertDatasetGranted` 复用 `run_scenario` 既有
  口径（一次批次一份数据，多场景是同一数据的多视角）。`scenarioIds` 缺省/空数组 =
  包内全部场景；显式列表含未知 ID → 该项 `NOT_FOUND`，其余照跑。
- 批量上限 32 个场景（含缺省全量；超限 `INVALID_ARGS`），防上下文与耗时爆炸。
- **失败隔离**：逐项 try/catch——单项错误落该项 `{ scenarioId, status: 'error', error: { code, message } }`
  （message 过 `asToolError` 信封：机器码＋禁语退避，不泄路径），不中断批次；
  成功项 `{ scenarioId, status: 'ok', runId, summary: { candidateCount, hitRuleCount,
  excludedCount, auditPassed, forbiddenPhraseHitCount, humanReviewRequired: true } }`。
  完整结果不进工具返回（防上下文爆炸），以 RunRecord 落盘（S2.1），follow-up 走
  compare/export。每项照走 `assertRunContract` + `enforceOutputPolicy` +
  `rememberPhrases`（各 runId 自己的清单）。
- 包级前置失败（加载门禁 `DERIVED_DRIFT`、包不存在、dataset 非法、收权未命中）是批次
  整体失败——fail-loud，不做半跑；这与「单项运行失败隔离」是两层。

### [S2.4] `export_audit` 审计导出

- 参数 `{ runId }`。导出目录固定 `<workspaceRoot>/runs/exports/`，**不接受调用方路径**
  （无路径面可攻击）；同 runId 重复导出 = 覆盖（内容确定，仅 archivedAt 变化）。
- 落盘文件（人审面归档，供复核/合规留痕）＝ RunRecord 全量 ＋ `{ archivedAt }` 页脚：
  完整 result（含 evidenceChains、narrative、ruleHitLog、audit.checks 时间戳）、
  redlines、datasetDigest/Summary、包身份。审计链时间线（startedAt → ruleHitLog[].ts →
  audit.checks[].ts → archivedAt）可回放。
- 工具返回（模型面摘要）：`{ exported: true, runId, locator: 'runs/exports/<runId>.json',
  auditPassed, candidateCount, hitRuleCount, forbiddenPhraseHitCount,
  humanReviewRequired: true }`——locator 是 workspace 相对路径，零短语、零绝对路径。
- CLI `runs export` 与 wire `exportAudit` 同走 `exportRunArchive`，人审面（CLI/wire）
  可回显完整摘要。

### [S2.5] workbench 运行历史/对比薄视图（人审面）

- `OntoRuntime` wire 扩展（同服务加方法，不新建服务）：`listRuns()`（时间倒序：runId、
  scenarioId、package、datasetDigest 短摘要、audit.passed、startedAt/savedAt）、
  `showRun(runId)`、`compareRuns(runIdA, runIdB)`、`exportAudit(runId)`。
  wire 是人审面：compare/show 可含完整证据链与短语（供复核定位）；路径面仍走
  S2.1 围栏。**签发/审阅端点不变，依旧永不进工具面**。
- workbench 场景运行 tab 增「运行历史」区：列表 → 勾选两个 → diff 表（分数 A→B、
  命中 ±、待核实 ±、audit 结论）；导出按钮调 exportAudit 显示相对 locator。
  只读展示；不做删除/重跑/编辑（CLI 足够）。双语内联 `ctx.locale.register`。
- 薄视图边界：建模表单、质量分解释、禁语管理不在本特性（归 C 方向）。

### [S2.6] CLI `runs` 组

- 新增 `dsh-onto runs <sub> …`：`list` / `show <runId>` / `compare <runIdA> <runIdB>` /
  `export <runId>`（`--root <ws>` 沿用 CLI 既有约定，默认 `./workspace`；全部输出 JSON，人审面）。
- 既有 `run <versionDir> <scenarioId> --data <file>` 行为不变，新增 RunRecord 落盘
  （S2.1 的上溯/跳过规则）。

### [S2.7] 测试与验证边界

- core 新增 `tests/runstore.test.mjs`：RunRecord 形状、datasetDigest 稳定性（键序无关）、
  runId 单段/穿越/ADS 拒绝（I3 同族）、load 缺失/损坏信封、compare 纯函数（增删/delta/
  单侧候选/同数据标记）、export 归档形状与人审面完整性。
- backend 新增 `tests/agent-runs.test.mjs`：三工具 schema/装配断言、批量失败隔离
  （坏场景不污染好场景）、批量上限、摘要投影零短语、export 摘要零绝对路径、
  phraseStore 写盘/回读/未配置不变性。
- `tests/attack-surface.test.mjs` 扩表：compare_runs / run_scenarios / export_audit 三
  新出口的 **I1–I5 同族穷举**（短语不入 render/value/错误、路径不回显、runId 穿越全拒、
  畸形输入受控信封不裸抛、批次错误信封含 CODE 前缀）——新防线必须补同族用例，只增不减。
- **验证阶梯**：1–4 不变；新增第 5 步「运行历史与审计留痕冒烟」——examples/aml-run.json
  两轮运行（第二轮 fork 改权重）→ `compare_runs` 出命中增删与分数 delta →
  `export_audit` 落盘且人审面含 ruleId/证据链/审计项 → 工具 content + render 禁语
  零命中 → `run_scenarios` 批量 aml+med 全场景过装配断言 → workbench 历史/diff 视图
  可见。测试基线地板 core 73 / backend 87 只增不减（预期 ≥85 / ≥100，以实测为准）。

### [S2.8] 版本

- core / backend / workbench 0.1.2 → 0.2.0（新特性）。`engines.dsh` 范围不变。
  architecture.md 模块地图加 `runstore.ts` 行；AGENTS.md 验证阶梯扩写（S2.7 第 5 步）。

## [S3] Out of Scope 与不变量

**Out of Scope**

- 签发/人审/物化端点工具化（永远人工，不预留接口）。
- L2 api-sources 取数、parseSource 工具化（B 方向）。
- 质量分解释 UI、禁语管理 UI、O1–O3 建模大改（C 方向）；workbench 只留 S2.5 薄视图。
- 规则引擎语义变更（表达式语法、打分公式、排除语义不动）。
- backlog #1（get_rule/get_package evidenceTemplate/expression 禁语闸）不顺带修。
- deepseek-harness 任何代码变更；HTTP 实网取数与凭据管理。
- 运行记录删除/保留策略 UI、跨工作区搬运 runs/。

**不变量（不得回退）**

- 判定在规则引擎（`rules.ts` 唯一打分路径）、认定在人工（`humanReviewRequired` 恒
  true；工具层不改写分数/命中；RunRecord 不得被工具面当认定出口）。
- ISSUED 只读；签发端点仅人工（issuedBy 非 agent/llm）。
- 派生防漂移：manifest 指纹 + sourceDigest，`DERIVED_DRIFT` 门禁——runScenario 既有
  门禁不因落盘/批量/对比而绕过。
- bundle 纪律：backend 只 named `apply`、client 零 runtime import/export、client
  `inject` 列全 `remote.dsh-onto*`、跨 bundle 只走 cordis 服务注入、文案双语内联
  `ctx.locale.register`。
- tool-face-policy I1–I5 不回退：三个新工具全过 P2 三出口载体（value 闸 + render 闸 +
  错误信封）；模型面零短语、零绝对路径；deny-by-default 收权；新防线补 attack-surface
  同族用例。
- deepseek-harness 只读（link: 依赖 + 官方扩展点）。
- 测试基线只增不减（core 73 / backend 87 为地板）。

## Tasks

- [x] T1: core runstore（RunRecord 构建/存取/列表、datasetDigest、runId 围栏）+ phraseRegistry 持久后端 — acceptance: `tests/runstore.test.mjs` 覆盖形状/围栏/损坏信封；recallPhrases 经持久后端回读 RunRecord.redlines（跨进程）、未配置行为不变（covers: S2.1）
- [x] T2: `compare_runs` 工具 + `compareRunRecords` 纯函数 — acceptance: 单测覆盖增删/delta/单侧候选/sameDataset；输出零短语且过 enforceOutputPolicy；I1–I5 同族用例补齐（covers: S2.2）（depends: T1）
- [x] T3: `run_scenarios` 批量 — acceptance: 失败隔离（坏场景单项 error 不污染其余）、批量上限、缺省全场景、包级前置失败整体拒；每项走 assertRunContract + RunRecord 落盘（covers: S2.3）（depends: T1）
- [x] T4: `export_audit` 工具 + `exportRunArchive` — acceptance: 归档含完整审计/证据链/时间线；工具返回摘要零短语、locator 相对路径；重复导出覆盖幂等（covers: S2.4）（depends: T1）
- [x] T5: OntoRuntime wire 四方法 + workbench 运行历史/diff 薄视图 — acceptance: dev-web 冒烟可见历史列表、两轮 diff 表、导出 locator；wire 人审面完整短语可见（covers: S2.5）（depends: T2）
- [x] T6: CLI `runs` 组 + 版本 0.2.0 + AGENTS.md/architecture.md 更新 — acceptance: `runs list|show|compare|export` 全命令跑通；既有 `run` 不回归；验证阶梯第 5 步定稿（covers: S2.6, S2.8）（depends: T1, T2, T3, T4）
- [x] T7: attack-surface 扩表 + 验证阶梯 1–5 全绿收口 — acceptance: 三新出口 I1–I5 同族穷举全过；core/backend 测试只增不减（地板 73/87）；阶梯 1–5 全绿（covers: S2.7）（depends: T5, T6）

## Journey log

- **wire 新方法必须双登记**：`backend/src/client.ts` 的 `allDescriptors` 是手工 typert
  描述符表（classic-script bundle 无生成器可依），新 `@Remote` 方法不同步登记 → 客户端
  `api.X is not a function`（冒烟首测即中招）；同族 `agent-grants.ts` `ONTOOL_NAMES`
  漏登记会让 guard 静默跳过新工具 objectId 收权（attack-surface I4 抓到）。两张手工表
  已写入 AGENTS.md 常见故障，新工具/新 wire 方法须双登记 + 重启 host。
- **deepseek-harness 构建产物缺失的恢复**（零源码改动）：`vendor/cordis` 仅有 src 时，
  用 harness 自带 tsc `-b vendor/cordis/tsconfig.json` 出 `lib/types/`，再用其根 tsdown
  `--no-config` 打包 `lib/types/index.js` → `lib/index.js`（CLI 默认出 .mjs，需
  `fixedExtension:false` 落配置文件后改名/直出 .js）。
- **评审 1 critical + 2 major 全是 I1 出口闸同族**：纯序列化 render（JSON.stringify）
  不算 render 闸——跨分隔符重组/模板碰撞是 tool-face-policy 立文之因，三个出口载体逐个
  要有闸；render 清单要「显式（包级全红线）∪ recall」恒合并，「显式覆盖」语义会漏
  失败/未跑场景红线；错误面退避 getter 在目标记录不存在时必须有完整退避源
  （workspaceRedlines 逐包扫描），且 getter 自身不得抛（求值于 catch 内）。
- 反证用例（空清单失去兜底）是验证 render 闸有效性的推荐写法；compare 的跨版本真实
  delta 验收用「fork 改权重」构造（FANOUT 0.25→0.4，Δ≈+0.038）比同参重跑（Δ=0）有效。
