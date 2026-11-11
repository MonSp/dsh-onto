# dsh-onto 业务本体建模平台 — 架构

> 本文件自成一体：平台的目标、概念、规则与结构在此完整定义，阅读不依赖任何外部文档。
> 一句话：**把专家脑子里的业务口径写成机器可校验、可签发、可派生的结构；判定在规则引擎，认定在人工。**

## 1. 定位与原则

同一业务对象在不同系统里名字/含义不同、判定口径散落代码、AI 先说结论后补合规——本平台把业务口径收敛为
**业务本体包**（O1 对象 / O2 行为规则 / O3 场景），并围绕它提供：包管理与签发、建模、知识库解析人审、
校验、派生、规则引擎与场景执行。四条产品纪律：

1. **业务判定内容只活在 O2/O3**（阈值、权重、排除项、输出契约、禁用表述）；规则引擎是唯一判分路径。
2. **LLM 只起草草案**（带置信度）；原料永不直写包，人审批准后才物化；LLM 不参与打分、不改已签发内容。
3. **认定永远在人工**：输出恒为 `humanReviewRequired=true`；签发（ISSUED）是人审动作。
4. **派生物可再生成、带指纹**：手改派生物 → 运行时拒绝加载（`DERIVED_DRIFT`）；重新派生即恢复。

## 2. 总体结构

```
浏览器 ── dsh Web UI（未改动）
            │  slots: main / sidebar.panellist
            ▼
  @dsh-onto/workbench（Web UI bundle：包管理|建模|知识库|校验派生|场景运行）
            │  ctx.remote.dsh-onto{Workspace,Model,Validate,Derive,Knowledge,Runtime}
            ▼
  dsh Host（profile=dsh-onto = web 模板 + @dsh-onto/backend + @dsh-onto/workbench）
            │  @dsh-onto/backend 注册 dsh-onto* wire 服务（唯一后端落点）
            │  工作区 <profile>/onto/workspace/packages/<name>/<version>/
            ▼
  @dsh-onto/core（纯 TypeScript 引擎库 + CLI，零 harness 依赖）
```

- **deepseek-harness 只读**：以官方扩展点接入（`dsh.bundle.patch` 注册 bundle、`dsh.client` 进启动图、
  `TypertRemoteService` + `@Remote` 自建 wire），不改 harness 一行代码。
- **core 可独立运行**：CLI 与单元测试（`node --test`）不依赖浏览器与 dsh。
- 业务本体包是**一等交付物**：YAML 目录树，可导出/导入 JSON 归档，跨部署搬运。

## 3. 核心概念

### 3.1 三层本体（O1 / O2 / O3）

| 层 | 元素 | 回答 |
|---|---|---|
| **O1 对象层** | 对象类型、属性、关系类型、稳定 ID 规则、值域字典 | 业务世界里有什么、怎么关联 |
| **O2 行为规则层** | 行为类型、打分规则、排除规则、方法论模板 | 对象能做什么、怎么判断 |
| **O3 场景层** | 场景卡：目标、边界、输入/输出、编排步骤、输出契约、复核门禁、审计项 | 解决什么问题、能说什么 |

**事件不是本体 Schema 要素**。事件是 O2 行为类型的运行时发生记录（行为实例）与规则命中消息，落在
行为实例表、事件流与审计日志中；包内出现 `events` 建模元素是校验错误。

### 3.2 ID 语法

```
<TYPE>-<PKG_TAG>-<NAME>     例：OBJ-AML-ACCOUNT、RULE-AML-SCORE-FANOUT
dict-<slug>                 例：dict-txn-type
属性引用：<OBJ|REL ID>.<attrName>     例：OBJ-AML-ACCOUNT.acctNo

TYPE ∈ {PKG, OBJ, REL, BHV, RULE, SKL, SCN, TOOL, FM, SRC, AGT, AUD}
```

全包 ID 唯一；引用必须闭合（场景 → 模板 → 规则 → 对象，每层都能解析）。跨包引用必须在
`package.yaml` 的 `externalRefs` 声明，未声明的外部 ID 视为未闭合。

### 3.3 签发状态机

```
DRAFT → IN_REVIEW → ISSUED
```

- **签发 = 人审通过**。`issuedBy` 必须是人工身份（agent/llm 被拒）；ISSUED 后源文件只读。
- 要改：**fork 出新版本**（DRAFT），禁止直接改已签发内容；issueRecord 记录版本沿革。

## 4. 包目录与文件要素

```
packages/<name>/<version>/
  package.yaml                  # 名称、版本、域、状态、签发记录、externalRefs
  o1-objects/
    object-types.yaml           # { kind: O1ObjectTypes, objects: [...] }
    relation-types.yaml         # { kind: O1RelationTypes, relations: [...] }
    dictionaries/*.yaml         # { kind: O1Dictionary, id: dict-*, values: [...] }
  o2-behavior-rules/
    behavior-types.yaml         # { kind: O2BehaviorTypes, behaviors: [...] }
    rules/score-rules.yaml      # { kind: O2ScoreRules, rules: [...] }
    rules/exclusion-rules.yaml  # { kind: O2ExclusionRules, rules: [...] }
    skill-templates/*.yaml      # { kind: O2SkillTemplate, template: {...} }
  o3-scenarios/*.yaml           # { kind: O3ScenarioCard, scenario: {...} }
  bindings/
    field-maps.yaml             # 源字段 → O1 属性引用
    api-sources.yaml            # 数据源清单
  derived/**                    # 派生物（只读、可再生成、带指纹）
  quality-report.json           # 校验器生成，不手改
```

要素示意（完整类型见 `core/src/types.ts`）：

```yaml
# o1-objects/object-types.yaml
kind: O1ObjectTypes
objects:
  - id: OBJ-AML-ACCOUNT
    name: 账户
    idRule: "<bank_code>:<acct_no>"
    attributes:
      - { name: acctType, type: enum, enumValuesRef: dict-acct-type }
      - { name: openDate, type: date }
    lifecycle: [active, closed]

# o2-behavior-rules/rules/score-rules.yaml（全部 weight 合计必须 = 1.0）
kind: O2ScoreRules
rules:
  - id: RULE-AML-SCORE-FANOUT
    name: 分散转入集中转出
    weight: 0.25
    expression: "min(1, inboundCount/10) * min(1, outboundAmount/100000)"
    threshold: 0.6
    evidenceTemplate: "近 {windowDays} 日转入 {inboundCount} 笔"

# o2-behavior-rules/rules/exclusion-rules.yaml（打分前执行）
kind: O2ExclusionRules
rules:
  - id: RULE-AML-EXCL-SALARY
    name: 代发工资降权
    action: downweight          # drop | downweight
    factor: 0.3
    condition: "tag == 'salary'"

# o3-scenarios/*.yaml
kind: O3ScenarioCard
scenario:
  id: SCN-AML-FIND-CLUES
  name: 识别可疑交易线索
  goal: 从客户/账户出发识别可疑交易线索
  boundary: 仅输出候选线索；报送与否人工决定
  inputs: [{ name: customerId, type: string, required: true }]
  outputs: { fields: [candidateId, riskScore, hitRuleIds, evidenceChains, pendingChecks] }
  pipeline:
    - { stepId: s1, stepType: DATA_INGEST }
    - { stepId: s2, stepType: BEHAVIOR_CALL }
    - { stepId: s3, stepType: RULE_EVALUATE, order: before-scoring }   # 排除段
    - { stepId: s4, stepType: RULE_EVALUATE }                          # 打分段
    - { stepId: s5, stepType: SKILL_RUN, skillRefs: [SKL-AML-NARRATIVE] }
    - { stepId: s6, stepType: AUDIT_CHECK }
    - { stepId: s7, stepType: HUMAN_REVIEW }
  output_contract:
    mustInclude: [candidateList, riskScore, evidenceChains, pendingChecks]
    forbiddenPhrases: [认定洗钱, 确定为地下钱庄, 已构成犯罪]
  review_gate: { required: true, threshold: 0.75 }
  auditChecks: [O1_CLOSED, O2_CLOSED, O3_CLOSED]
```

## 5. 校验与质量分

| 级别 | 规则 |
|---|---|
| error | **引用闭合**：包内所有 ID 引用必须有定义（场景→模板→规则→对象；派生→源）；externalRefs 除外 |
| error | **属性可解析**：`OBJ.attr` / `REL.attr` 必须落在属性表 |
| error | **权重合计**：打分规则 weight 合计 = 1.0；方法论模板权重集合与规则集合一致（同 ID 同权重） |
| error | **字典可解析**：`enumValuesRef` / `dict-*` 必须存在 |
| error | **事件不进 Schema**：不得出现 `events` 建模元素 |
| warn | ID 未被引用（派生端点 AGT-/AUD-/TOOL- 除外） |
| info | 覆盖统计（对象/关系/行为/规则/场景计数） |

`score = clamp(0, 100, 100 - 10×errors - 2×warnings)`；报告落 `quality-report.json`，由校验器生成。

## 6. 派生链与加载门禁

签发后从源生成运行时契约（`derived/**`，只读、可再生成）：

| 源 | 派生物 | 用途 |
|---|---|---|
| O1 | `tool-contracts/`（工具契约、ID 规范、对象粒度收权） | 取数与工具调用 |
| O2 | `rule-engine-config/`（exclusion 先于 scoring；权重来自 O2；`llmForbidden: true`） | 打分执行 |
| O3 | `scenario-orchestration.yaml` + `audit-checks.yaml`（含禁语）+ `agent-duties.yaml`（阶段职责/人工门禁） | 编排与闸门 |
| 全部 | `manifest.yaml`（源与派生逐文件 sha256 + sourceDigest） | 防漂移 |

**加载门禁**：运行时加载前必须校验 manifest——缺 manifest / 指纹不符 / 源清单不一致 → 拒绝加载
（`DERIVED_DRIFT`）。派生物被手改 → 拒绝；重新派生 → 恢复。ISSUED 包派生后把 manifest 的 sha256
记入签发记录（库外锚点），防「改派生物 + 改 manifest」双改。

## 7. 规则引擎

```
输入：候选列表（特征值 + 标签）
1. 排除段（before-scoring）：drop 剔除 / downweight 降权
2. 打分段：每条规则表达式映射到 [0,1]，按 weight 加权汇总
3. 缺失特征 → pendingVerification=true（待核实，不硬判）
输出：{ candidateId, riskScore, hitRuleIds[], evidenceChains[], pendingChecks[] }
```

- **每一分必须回指规则 ID**；证据链用 `evidenceTemplate` 以特征值回填。
- **禁止 LLM 参与打分**；输出永远不含「认定」。
- 表达式语言自研（无 eval）：数值/字符串字面量、`+ - * /`、括号、`min/max/abs/clamp`、
  比较与逻辑运算、`tag == 'x'` 标签成员判断；标识符解析为候选特征值。

## 8. 场景执行与输出契约

场景解释器按 pipeline 做**最小步派发**（不引入重型工作流引擎）：

| stepType | 语义 |
|---|---|
| `DATA_INGEST` | 数据归一、建图（对照 O1 校验实例） |
| `BEHAVIOR_CALL` | 行为实例生成与关系聚合 |
| `RULE_EVALUATE` | 规则引擎；`order=before-scoring` 为排除段，否则打分段 |
| `SKILL_RUN` | 方法论模板叙述（只回填模板，禁认定） |
| `AUDIT_CHECK` | 三层闭合闸门 |
| `HUMAN_REVIEW` | 人工复核标记 |

**输出契约（所有场景必含）**：候选名单、风险分、命中规则 ID、证据链、待核实点；
`humanReviewRequired = true`；禁用表述（场景卡 `forbiddenPhrases`）零容忍扫描。

**三层审计闭合**（防幻觉闸门）：O1 闭合（引用的对象/关系真实存在）、O2 闭合（行为实例与规则命中
真实发生）、O3 闭合（未越出输出契约且禁语零命中）。不闭合 → 降级为待核实点；审计链带时间戳可回放。

## 9. 知识库管线（LLM 边界）

```
上传原料(sha256 幂等) → 按类型路由 LLM 解析 → 草案候选(层/类型/名称/载荷/置信度/依据)
  → 候选队列(同 包+层+类型+名称 幂等跳过) → 人工: 批准/合并/驳回 → 物化进包 → 校验 → 签发
```

六类原料与抽取重点：`LEGACY_SYS`（旧系统算法/标签 → O2 判定口径）、`CASE_SAMPLE`（样例 → O1 + 统计口径）、
`POLICY`（制度 → 阈值/排除/红线）、`SCHEMA_API`（表结构/接口 → O1 属性/绑定）、`WORK_ORDER`（工单 → O3 场景骨架）、
`CONVERSATION`（对话轮次 → 草案留痕与溯源，conversational-modeling P3）。

| LLM 可以 | LLM 不可以 |
|---|---|
| 字段归一、别名消歧建议 | 规则判定 / 打分 |
| 起草草案（带置信度） | 修改已签发 Schema |
| 解释与叙述证据 | 绕过对象 ID 编造关系 |
| 意图翻译成规则参数 | 把候选写成认定 |

硬规则：原料永不直写包；**结论性表述（认定/确定为/已构成…）只允许落 `forbiddenPhrases` 红线，
禁止进入输出契约**；置信度 < 0.75 强制人审；LLM 失败回落词面启发（结果标注 `engine: deepseek|heuristic`）；
物化仅发生在人工批准后，且拒写 ISSUED 包。

## 10. 多域适配

| 不变（骨架） | 可变（内容） |
|---|---|
| O1/O2/O3 语法、校验、评分 | 对象/规则/场景的具体定义 |
| 签发状态机、派生指纹 | 禁用表述（红线） |
| LLM 边界、人审门禁 | 绑定的数据源、字段 |
| 三层审计闭合 | 领域词典 |

引擎代码不含任何领域常量：`packages/aml`（反洗钱）、`packages/med`（医疗）与 `packages/tax`（税务）
只是包内容，换包即换域，引擎零修改（`core/tests/multi-domain.test.mjs` 三域证明）。

## 11. 模块地图与测试

| 模块 | 职责 | 测试 |
|---|---|---|
| `core/src/types.ts` `ids.ts` | 模型类型；ID 与属性引用语法 | — |
| `core/src/store.ts` | 包存储、签发状态机、fork、导入导出 | `tests/store.test.mjs` |
| `core/src/validate.ts` | 校验全规则 + 质量分 | `tests/validate.test.mjs` |
| `core/src/derive.ts` `loadgate.ts` | 派生链、manifest 指纹、加载门禁 | `tests/derive.test.mjs` |
| `core/src/rules.ts` | 表达式求值、排除→打分 | `tests/scenario.test.mjs` |
| `core/src/scenario.ts` `audit.ts` | 场景派发、三层审计、禁语扫描 | `tests/scenario.test.mjs` |
| `core/src/runstore.ts` | RunRecord 运行留痕、两轮对比、审计归档（`workspace/runs/`） | `tests/runstore.test.mjs` |
| `core/src/knowledge.ts` `llm.ts` | 六类原料解析、人审队列、物化、对话草案与骨架门 | `tests/knowledge.test.mjs` |
| `core/src/graph.ts` | 图谱构建（画布数据源）与 issue 节点定位；场景 `behaviorRefs`/`scoreRefs`/`exclusionRefs` 入图（缺省=全部，与 `scenario.ts` 一致） | `tests/graph.test.mjs` |
| `core/src/cli.ts` | `dsh-onto package/validate/derive/gate/run/runs/knowledge` | — |
| `backend/` | dsh-onto* wire 服务 + agent 工具/skill 面（`run_scenario` 等 17 工具、SKL provider） | `tests/agent-*.test.mjs` `tests/model-face.test.mjs` |
| `workbench/` | Web UI 五 tab | — |
