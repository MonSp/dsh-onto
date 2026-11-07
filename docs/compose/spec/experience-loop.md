---
feature: experience-loop
status: delivered
updated: 2026-11-07
---

# 经验闭环（Experience Loop）：长在本体基座上的运行/学习层

> 一句话：**本体提供类比的坐标系与验证的红线，经验闭环提供本体的演化动力。**
> 本文是实施方案（delivered，P1–P3 三期 13 片全部落地）：在 dsh-onto 上叠加一个运行/学习层，不新建独立 agent 系统，
> 不破坏「判定在规则引擎，认定在人工」四条产品纪律（docs/architecture.md §1）。

## [S1] 缺口与目标

dsh-onto 现状是单向的：人写口径 → 校验 → 签发 → 派生 → 执行。`runstore.ts` 的 RunRecord
已经把执行留痕（数据指纹、命中规则、证据链、审计、红线清单）落到 `workspace/runs/`，
但留痕不喂养下一次执行——同样的场景跑一百遍，第一百次不会比第一次更聪明、更省人。

经验闭环补的就是这条回程：**经验 → 技能 → 类比 → 验证 → 回写**。八步运行闭环
（接任务 → 结构化检索 → 结构类比 → 差异修正 → 验证 → 本地执行 → 回写记忆 → 巩固）
全部长在既有模块上：

| 闭环步骤 | 既有落位 | 本方案动作 |
|---|---|---|
| 结构化检索 | O3 场景卡 + RunRecord | 新增任务结构签名（[S4.1]） |
| 结构类比 | O2SkillTemplate / RunRecord | 新增差异表（[S4.2]） |
| 差异修正 | `llm.ts`（LLM 边界） | 新增修正 prompt + 启发式回落 |
| 验证 | validate / rules / audit / loadgate | **零改动，直接复用** |
| 本地执行 | `scenario.ts` 六槽派发 | 零改动 |
| 回写记忆 | runstore + knowledge 候选队列 | 新增 ExperienceNote（[S4.3]） |
| 巩固 | knowledge 管线人审物化 | P3 接线（[S6]） |

## [S2] 范围

**MVP（P1）内**

- 垂直域：`packages/aml` 的 `SCN-AML-FIND-CLUES`（复现基准 `examples/aml-run.json`）。
- 三件事：**结构检索、差异修正、验证闸门**。
- 误迁移统计走既有 `compareRunRecords`（CLI `runs compare`）。
- 全离线：本地小模型（`DeepSeekLlm`）或词面启发（`HeuristicLlm`）双路，
  不引 MCP、不上向量库、不加常驻工具目录。

**明确不做（本方案窗口内）**

- 跨域开放类比（类比只在同包、或 `externalRefs` 已声明的范围内）；
- 自动物化（经验产物只以草案进人审队列，approved 后才物化）；
- 独立经验库 / 图库 / 向量索引（MVP 用结构签名字段匹配）；
- 记忆遗忘与压缩策略的实现（[S6] 只留数据口）。

## [S3] 架构：两层耦合

```
经验驱动 Agent（快变 · 增长 · 可遗忘）
  结构检索·类比 → 差异修正 → 验证闸门 → 本地执行 → 回写·巩固
        ↑             ↑           ↑           ↑            ↑
   任务结构签名   技能模板·闭合  闭合/禁语/指纹  工具契约按需  草案→人审→物化
        ↑             ↑           ↑           ↑            ↑
dsh-onto 本体基座（慢变 · 审定 · ISSUED 只读）
  O3 场景卡     O2 规则+技能模板  校验·规则·审计·门禁  tool-contracts  知识库管线
```

两层生命周期不同，**不合并存储**：本体在 `packages/<name>/<version>/`（ISSUED 只读，
fork 改版），经验在 `workspace/runs/` 与 `workspace/experiences/`（增长、可标注、可淘汰）。
连接方式只用 ID 引用（scenarioId / skillRefs / runId / DraftProvenance）。

**新增与接线**

| 落位 | 动作 | 内容 |
|---|---|---|
| `core/src/experience.ts` | **新增** | TaskSignature、DiffTable、ExperienceNote、检索打分、差异表生成 |
| `core/src/runstore.ts` | 零改动 | RunRecord 仍是留痕唯一落点（run-insight 口径不动） |
| `rules.ts` `validate.ts` `audit.ts` `loadgate.ts` | 零改动 | 验证闸门原样复用 |
| `core/src/llm.ts` | 接线 | 差异修正 prompt（draft-only，禁认定/禁打分），失败回落 HeuristicLlm |
| `core/src/types.ts` | 微扩 | `DraftProvenance.runId?`（[S4.4]） |
| `core/src/knowledge.ts` | P3 接线 | 经验产物以 DraftCandidate 入队（targetKind 现成） |
| `core/src/cli.ts` | 接线 | `exp recall` / `exp annotate` / `exp diff` 子命令（MVP 验收面） |
| `backend/` 工具面 | P2 | `recall_experience` 等，按 tool-face-policy 三出口收口 |

## [S4] 数据模型

### [S4.1] 任务结构签名 TaskSignature

结构签名**不是**任务描述文本，而是 O1/O2/O3 引用的结构摘要——类比按它召回，
它同时就是「适用边界」（签名不匹配的域不迁移）。

```ts
interface TaskSignature {
  scenarioId: string
  packageScope: string        // <name>@<version>；跨包参赛须在 externalRefs 声明
  goalClass: string           // scenario.goal 归一（取场景卡原文，不自由发挥）
  stepShape: string           // pipeline 规范串：DATA_INGEST>BEHAVIOR_CALL>RULE_EVALUATE(before-scoring)>…
  ruleRefs: string[]          // scoreRefs/exclusionRefs/全量（排序去重）
  skillRefs: string[]         // pipeline skillRefs 并集（排序去重）
  inputShape: string[]        // inputs 的 `name:type` 排序串
  dataBand: 'S' | 'M' | 'L'   // datasetSummary.candidates 分档（初始：S<50，M<500，L 其余）
  digest: string              // sha256(canonicalJson(以上字段))——精确同构判定
}
```

全部字段可从 `OntologyPackage` + `RunRecord.datasetSummary` 机械导出，
无自由文本、无 embedding。`digest` 复用 runstore 的 canonicalJson 口径（键序稳定）。

### [S4.2] 差异表 DiffTable

类比的产物是差异表，不是新流程。小模型只被允许消费差异表、产出差异表——
「只改差异，不重写全流程」。

```ts
interface DiffTable {
  reusable: Array<{ item: string; note: string }>    // 可直接沿用（装配/技能/注意点）
  mustChange: Array<{ item: string; why: string }>   // 条件变了必须改
  unknown: Array<{ item: string; risk: string }>     // 拿不准 → 低置信度转人工
}
```

`item` 只允许指到结构位：特征名、`OBJ.attr` 引用、ruleId、skillId、reviewFocus 条目。
不接受自由流程步骤描述——pipeline 由 O3 锁死，经验无权改写。

### [S4.3] 经验记录 ExperienceNote

RunRecord 管「发生了什么」（人审面留痕，run-insight 口径不动）；ExperienceNote 管
「经验学到了什么」（学习层标注）。分开存，互不覆盖：

```ts
interface ExperienceNote {
  runId: string                  // 关联 workspace/runs/<runId>.json
  signature: TaskSignature       // 写入时缓存（含源包版本，防换包误召回）
  outcome: 'success' | 'partial' | 'failure' | 'pending-human'
  outcomeReason?: string
  skillRefsUsed: string[]
  reusedFrom?: { runId: string; diff: DiffTable }   // 本轮复用自哪条、差异是什么
  counterexample: boolean        // 反例：类比不参赛，只作警示
  misTransfer?: { judged: boolean; by: string; note: string }  // 人工判定误迁移
  reviewFocus?: string[]         // 上轮 pendingChecks/人审修正的沉淀（下轮检索提示）
  savedAt: string
}
```

落盘 `<workspaceRoot>/experiences/<runId>.json`。runId 围栏与 runstore 同族
（单段、`isSafeRelPath` + `isInsideDir`，非法即 `INVALID_ARGS`）。
**不进包目录**——经验不是本体。

### [S4.4] 回写形状：草案，不是包

经验产物的唯一出口是 knowledge 候选队列的 `DraftCandidate`（`types.ts` 现成）：
`targetKind` 可用 `SkillTemplate` / `ExclusionRule` / `RedLine` / `ScoreRule`（op='update'）；
`confidence < 0.75` 强制人审（forcedReview 现成口径）；物化拒写 ISSUED 包，改须 fork。

溯源扩一处：`DraftProvenance` 增 `runId?: string`（现只有 turnId / sourceId），
把「这条草案来自哪次运行」记进人审面——批准前后都可回放。

## [S5] 运行闭环（MVP 三件事）

### [S5.1] 结构检索

- **参赛集**：同包经验且 `counterexample=false`；跨包仅当对方包在 `externalRefs`
  声明内（默认降权）。`misTransfer.judged=true` 的经验**不参赛**。
- **打分**（初始权重，验收时校准；纯字段匹配，无向量）：

  | 条件 | 分 |
  |---|---|
  | 同 scenarioId | +0.4 |
  | stepShape 完全一致 | +0.2 |
  | ruleRefs ∪ skillRefs 的 Jaccard 相似 | +0.2 × jac |
  | inputShape 一致 | +0.1 |
  | dataBand 一致 | +0.1 |

- **阈值**：原始分 `score ≥ 0.6` 走复用路径（取 top-k ≤ 3 进差异修正）；否则**冷启动**——
  全量执行、不类比、不硬迁移（「低置信度不执行」的检索侧形态）。
  跨包（声明内）按原始分过阈，**展示分 ×0.5 仅降权排序**——否则满分 0.5 永远过不了阈值，跨包检索形同虚设。
- **短路**：`digest` 相同 → 直接复用上轮 DiffTable，跳过差异修正。

### [S5.2] 差异表与差异修正

1. **机械差异**：签名字段逐项比对（dataBand 跨档、ruleRefs 增删、inputShape 不一致），
   直接生成 DiffTable 初稿——不让模型干机器的活。
2. **模型修正**：小模型输入 = 新任务签名 + top-k 旧经验摘要（签名 + outcome +
   reviewFocus + 上轮 DiffTable）+ 初稿；输出 = 修正后的 DiffTable（item 落到
   装配位 / 技能位 / 注意点）。LLM 边界照旧（architecture.md §9）：只起草、禁打分、
   禁认定、禁绕过 ID 编造引用。
3. **启发式回落**：DeepSeekLlm 失败 → HeuristicLlm 词面规则生成保守差异表
   （reusable=空，mustChange=签名差异全量，unknown=其余），结果标注 `engine`。
4. **人工闸**：`unknown` 非空或修正置信度 < 0.75 → 装配提示只作参考，执行走冷启动
   保守路径，unknown 条目列入本轮 reviewFocus。

### [S5.3] 验证闸门（零新增）

| 时点 | 闸门 | 拒绝/降级 |
|---|---|---|
| 装配后 | dataset 对照 O1（对象/属性引用闭合） | 引用不闭合 → 拒绝执行 |
| 加载时 | loadgate manifest 指纹 | `DERIVED_DRIFT` → 拒绝加载 |
| 执行后 | audit 三层闭合 + 禁语扫描 | 不闭合 → 降级待核实；禁语命中 → 零容忍 |
| 出口 | `humanReviewRequired=true` 恒真 | 无例外 |

**经验复用的结果与首跑过完全相同的闸门——没有「经验豁免」。**

### [S5.4] 执行与回写

1. `runScenario` 保持纯执行（签名不动）；调用方落盘 RunRecord（现状口径）。
2. 新写 ExperienceNote：成功 → `outcome='success'` + 本轮 pendingChecks 沉淀
   reviewFocus；部分闭合 → `'partial'`；审计失败 → `'failure'` + `counterexample=true`。
3. 人工复核结论回填：`'pending-human'` 由人改判；误迁移写 `misTransfer`
   （**只由人判**，模型不自评）。
4. 本轮 `reusedFrom` 非空时写入来源 runId 与 DiffTable，供误迁移归因。

### [S5.5] 误迁移统计

- 工具面：既有 `compare_runs` / CLI `runs compare`——来源轮 vs 本轮的 hitRuleIds
  增删、riskScore delta、excluded 变化（`compareRunRecords` 现成）。
- 口径：**误迁移率 = misTransfer.judged=true 的复用执行数 / 复用执行总数**；
  模型无权自判误迁移。

## [S6] 记忆巩固（P3，留口）

- **抽象**：高频同构经验（digest 或 stepShape 聚簇）→ `DraftCandidate`
  （targetKind=SkillTemplate；steps / outputTemplate 从成功轨迹的 reviewFocus
  与证据模板归纳）。
- **反例利用**：`counterexample=true` 聚簇 → ExclusionRule / RedLine 草案
  （结论性表述只落红线——architecture.md §9 硬规则不变）。
- **压缩与遗忘**：experiences/ 保留策略按 outcome 与被引用计数分层
  （成功且被复用 > 一般成功 > 失败反例留警示 > 陈旧未引用可归档淘汰）。
  **P3 前不实现，只保证字段够算**（savedAt / reusedFrom / counterexample 已齐）。
- **吞吐天花板（预先接受）**：巩固产物永远是草案，自动化止步于人审队列。
  这个闭环比「全自动越用越强」慢，用吞吐换可信度——业务判定域值得。

## [S7] 分期与验收

| 期 | 内容 | 出口 | 状态 |
|---|---|---|---|
| **P1 MVP** | experience.ts（签名/检索/差异表/Note）+ 差异修正双路 + 闸门复用 + CLI `exp` | aml 域离线跑通，指标基线 | **达成**（轮 1–6） |
| **P2** | 人审回填（misTransfer/reviewFocus）+ workbench 经验视图 + agent 工具面（过 tool-face-policy）+ med 包多域验证 | 两域指标，人审闭环 | **达成**（轮 7–10） |
| **P3** | 自动技能抽象草案 + 反例利用 + 压缩/遗忘 | 巩固产物进知识库人审流 | **达成**（轮 11–13） |

**交付记录（2026-11-07）**：P1+P2+P3 三期 13 片全部落地并经真实浏览器 + 真实 NL 对话验证；
验收基准三轮（冷启动/复用+delta/不硬迁）与 MULTI-DOMAIN PASS 均过；P4（打磨与增强）见
`docs/compose/notes/experience-loop-iteration-plan.md` §三。

**指标**（P1 起统计，P2 起定基线）：首次成功率、旧经验复用率（`reusedFrom` 非空占比）、
离线完成率、误迁移率、人工介入率（forcedReview + unknown 非空占比）、
记忆增长与压缩比。

**验收基准**：`examples/aml-run.json` 轮次 A（冷启动）→ 轮次 B（fork 改数据/权重，
走复用路径），`runs compare` 出 delta；B 的 ExperienceNote 含 signature / diff /
reusedFrom；再跑轮次 C（签名扰动到 dataBand 跨档且 ruleRefs 变更）验证
「低置信度不执行」——C 应冷启动或转人工，**不得硬迁移**。

## [S8] 纪律与风险

**纪律（不可违背）**

1. 经验产物只出草案，物化必经人审；ISSUED 包 fork 改版——巩固也不例外。
2. 两层不合并存储：经验不进 `packages/`，本体不引用经验文件（只 ID 引用
   runId / scenarioId / skillRefs）。
3. 类比范围 = 同包 ∪ externalRefs 声明内；签名不匹配 → 冷启动，不硬迁。
4. 验证闸门零豁免；`humanReviewRequired=true` 恒真；禁语零容忍。
5. LLM 边界照旧：不打分、不认定、不改已签发内容、失败回落启发式并标注 engine。

**风险**

| 风险 | 口径 |
|---|---|
| 类比引擎是瓶颈 | 收窄到结构签名字段匹配 + 同包域；开放类比明确不做 |
| 吞吐天花板 | 草案必审，接受节奏慢；P3 折叠的只是草案生产成本 |
| 小模型误改差异 | 输出限 DiffTable 结构位；unknown 全量转人工 |
| 经验库膨胀 | P3 压缩策略；字段已预留 |
