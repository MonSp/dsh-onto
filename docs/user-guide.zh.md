# 用户指南：建模 → 运行时 → 业务应用 / 智能问答

> 目标读者：要用本体插件**构建本体模型**，再基于运行时做**业务应用**或**智能业务问答**的接入方与业务用户。
> 概念与规则自包含见 [architecture.md](architecture.md)；第二域冷启动步骤见 [plugin-authoring.zh.md](plugin-authoring.zh.md)。
>
> 英文版：[user-guide.en.md](user-guide.en.md)

## 0. 一句话总览

**业务口径写进本体包（可校验、可签发）→ 插件把运行时挂进 dsh → 页面或 Agent 调同一场景、同一数据源 → 规则引擎打分 → 恒 `humanReviewRequired=true` 交人认定。**

```text
建模期：知识/编辑 → O1/O2/O3 → validate/derive/gate → 人工签发 ISSUED
运行期：业务插件（连接器 + RUN 工具）+ 部署登记 sourceId → OntoRuntime
消费期：业务应用页面 ║ 智能问答 run_scenario  ──同一执行路径──► 人审认定
```

四条纪律（不可违背）：

1. **判定在规则引擎**：打分只在 `core/src/rules.ts`；页面/连接器/LLM 不改分。
2. **认定在人工**：输出恒 `humanReviewRequired=true`；签发只在人工。
3. **ISSUED 只读**：改口径须 `package fork` 新版本；派生物手改 → `DERIVED_DRIFT`。
4. **数据源 deny-by-default**：地址/凭证只来自部署配置；包内只写逻辑 `sourceId`。

---

## 1. 两种角色、两条产品路径

| | **完整工作台路径**（样例：AML） | **最小业务插件路径**（样例：TAX） |
|---|---|---|
| 装什么 | `@dsh-onto/backend` + `@dsh-onto/workbench` | 只装 `@dsh-aml/app` / `@dsh-tax/app`（RUN-only） |
| 能做什么 | 包管理、建模、知识库人审、校验派生、场景运行、治理链 | 接数 → 映射 → 签发 → 最小运行页 + Agent 同源 |
| 适合谁 | 要持续建模/迭代口径的业务 + 平台团队 | 只跑已签发场景的业务应用接入方 |
| 禁止 | — | 不注册 DEV 服务；不改 `core` / `runtime` |

两条路径共用同一套引擎与运行时契约。

---

## 2. 构建本体模型（建模期）

本体包是 YAML 目录树，三层结构：

| 层 | 内容 | 回答的问题 |
|---|---|---|
| **O1 对象** | 对象/关系/字典、属性、ID 规则 | 业务世界里有什么、怎么关联 |
| **O2 行为规则** | 打分规则（weight 合计 = 1.0）、排除规则、方法论模板 | 怎么判断、证据怎么说 |
| **O3 场景** | 目标、输入输出、pipeline、输出契约、复核门禁、禁语 | 解决什么问题、能说什么 |

### 2.1 建模入口

**① 工作台 UI**（AML profile）

侧栏「dsh-onto」→ **包管理 · 建模 · 知识库 · 校验派生 · 场景运行 · 经验**（右栏常驻本体图谱）。

**② 知识库管线（推荐起步）**

```text
上传原料 → LLM 解析成草案（带置信度）→ 候选队列 → 人工批准/驳回 → 物化进包
```

六类原料：`LEGACY_SYS` / `CASE_SAMPLE` / `POLICY` / `SCHEMA_API` / `WORK_ORDER` / `CONVERSATION`。  
原料**永不直写包**；置信度 &lt; 0.75 强制人审；LLM 不打分、不改已签发内容。

**③ 直接编辑 `packages/<name>/<version>/`**

冷启动常用（TAX 补 `bindings/` 即是）。写完必须过校验三步。

**④ 对话式建模**

主会话一句话 → `create_package`（须 `humanApproved`）→ 骨架 → 分片 `draft_elements` → 画布人审 → I6 骨架门物化 → 校验/派生/签发。

### 2.2 校验 → 派生 → 门禁

```powershell
cd core
node dist\cli.js validate ..\packages\tax\1.0.0   # errors 必须为 []
node dist\cli.js derive   ..\packages\tax\1.0.0   # 生成 derived/** + manifest
node dist\cli.js gate     ..\packages\tax\1.0.0   # 加载门禁 ok:true
cd ..
```

- **error 挡路**：引用闭合、权重合计、字典、属性可解析等。
- **`ID_UNREFERENCED` 警告可放行**（尤其 `FM-*` / `SRC-*`；score 低不代表映射坏）。
- 派生物带指纹：手改 `derived/**` → `DERIVED_DRIFT`，重新 `derive` 即恢复。

### 2.3 签发（人工）

```powershell
cd core
node dist\cli.js package review --name tax-risk --version 1.0.0 --root ..
node dist\cli.js package issue  --name tax-risk --version 1.0.0 --by "张三（人工）" --root ..
cd ..
```

状态机：`DRAFT → IN_REVIEW → ISSUED`。  
`issuedBy` **不得**为 agent/llm。ISSUED 后源只读；改内容须 fork。

仓库样例：`packages/aml`（反洗钱）、`packages/med`（医疗）、`packages/tax`（tax-risk，已 ISSUED）。

### 2.4 接数映射（bindings）

| 文件 | 作用 |
|---|---|
| `bindings/api-sources.yaml` | 逻辑源（如 `SRC-TAX-CORE`，`endpoint: api://tax-query`，**不写真实 URL**） |
| `bindings/field-maps.yaml` | 源字段 → `OBJ-*.attr`（target 必须闭合） |

真实地址与凭证只进**部署环境变量**，不进包。

---

## 3. 挂上本体运行时（运行期）

### 3.1 业务插件里有什么（以 `apps/tax` 为例）

| 模块 | 职责 |
|---|---|
| `src/index.ts` | 注册 `OntoRuntime` + RUN 工具/技能；不注册 DEV；`runtime.claim()` 同宿主唯一 |
| `src/tax-connector.ts` | 只读 `DataConnector`：业务 API → O1 对象/关系/候选 |
| `src/client/*` | 最小运行页：选场景 → `runScenario` |
| `cordis.patch.yml` | 注入 dsh bundle |

`apps/aml` 同构，另含复核工作台与治理动作面。

### 3.2 部署侧四步（TAX 冷启动示例）

```powershell
# 1) 装插件到独立 profile
scripts\setup-tax-profile.ps1

# 2) 播种已签发包并激活（strict 要求 active release）
node scripts\m-tax-seed-release.mjs

# 3) 组合断言：TAX 在、backend/workbench 不在
scripts\dump-tax-config.ps1

# 4) 环境变量 + 数据源 + 宿主
$env:DSH_TAX_API_URL     = 'http://127.0.0.1:3911'   # 不设则 sourceId 运行拒绝
$env:DSH_BIZ_USER_ID     = 'user-tax-1'
$env:DSH_BIZ_TENANT      = 'tenant-tax'
$env:DSH_BIZ_ROLES       = 'analyst'
$env:DSH_BIZ_SCOPE_TYPES = 'OBJ-TAX-TAXPAYER,OBJ-TAX-INVOICE,...'

node mock-services\tax-api\server.mjs --port 3911
cd ..\deepseek-harness
pnpm dsh --profile dsh-tax --no-open
```

AML 完整工作台：`scripts\setup-profile.ps1` → `dump-config.ps1` → `dev-web.ps1`（见根 README）。

### 3.3 双入口同源

| 入口 | 调用 | 结果 |
|---|---|---|
| **页面** | `runScenario({ name, version, scenarioId, sourceId })` | 候选表、riskScore、命中规则、证据链 |
| **Agent** | `run_scenario` 同参 | 同一 ruleId 集合、同分、禁语 0 |

分数不因入口而异——只在规则引擎算一次。

---

## 4. 路径 A：构建业务应用

### 4.1 最小应用模板（照抄 TAX）

适合「一个场景 + 一个数据源 + 一个运行页」：

1. 复制 `apps/tax` → `apps/<domain>`，改包名、场景 ID、`sourceId`、对象类型。
2. 写 `DataConnector`：业务 API → `RuntimeDataset`（对象 id 符合 idRule、关系两端闭合、候选 `objectRef` 命中）。
3. 改 `bindings/` → `validate` / `derive` / `gate` → 人工 `issue`。
4. 部署侧 env 登记 `dataSources.register('SRC-XXX', connector)`。
5. 页面只调 `runScenario`（与 Agent 同源）；侧栏注册 panel。
6. 测试：mock 单测 + connector→场景 e2e（参考 `apps/tax/tests`）。

边界：页面与 Agent 同场景同 sourceId；连接器/UI 不改分；RUN-only 不 import backend/workbench；文案 `ctx.locale.register` 内联。

完整步骤：[plugin-authoring.zh.md](plugin-authoring.zh.md)。

### 4.2 完整治理应用（照抄 AML）

- 运行记录 / 复核队列 / 证据详情  
- `record_review_decision`（业务复核）  
- 动作：`create_action_proposal` → 批准卡 → `execute_behavior_action`（幂等台账）  
- 审计 `export_audit`、对账见 [ops-manual.md](ops-manual.md)

适合要把「跑场景 → 人审 → 动作 → 对账」做成产品的团队。

### 4.3 典型页面交互

```text
打开「TAX 运行」→ 选 SCN-TAX-BURDEN-ANOMALY → 运行（sourceId=SRC-TAX-CORE）
  → 候选表：riskScore / hitRuleIds / 证据链 / 缺数
  → 人工认定（恒 humanReviewRequired=true）
  → （可选）复核决定 / 动作提案 —— AI 不代点批准
```

---

## 5. 路径 B：智能业务问答（Agent）

无需先做页面——在挂了 RUN 工具面的 dsh 会话里直接问。

### 5.1 常用工具

| 意图 | 工具 | 说明 |
|---|---|---|
| 有哪些场景？ | `list_scenarios` | 按包名/版本列场景卡 |
| 查某类风险 | `run_scenario` | 取数 + 排除 + 打分 + 证据 + 审计 |
| 批量跑 | `run_scenarios` | 多场景同一契约 |
| 图上扩邻域 | `expand_entity` | 只准备数据，**不打分** |
| 包内容 | `get_package` 等 | 只读 |
| 改口径 | `apply_draft` | 草案队列，**不直写 ISSUED** |

沙箱：写包走 `apply_draft`，取数走 `run_scenario`，人审走工作台/批准卡。

### 5.2 问法示例

**问能力：**
> 有哪些可跑的税务场景？tax-risk 1.0.0 里 burden anomaly 的输入是什么？

**要判定（与页面同源）：**
> 用 tax-risk@1.0.0 跑 SCN-TAX-BURDEN-ANOMALY，数据源 SRC-TAX-CORE，列出高风险纳税人、命中规则和证据。

等价参数：

```text
run_scenario(
  name=tax-risk, version=1.0.0,
  scenarioId=SCN-TAX-BURDEN-ANOMALY,
  sourceId=SRC-TAX-CORE
)
```

AML 示例场景：`SCN-AML-FIND-CLUES`（包 `aml-analysis`）。

**问「为什么」：** 读 `evidenceChains`（`ruleId` + 模板回填 + 分数）；回答必须回指 ruleId。  
**问「能不能定性」：** 机器给候选与证据，`humanReviewRequired=true`，认定在人工；禁语零容忍。

### 5.3 结果形态

```text
候选 TAX-CAND-001（对象 91110000T001）
  riskScore / hitRuleIds / evidenceChains / pendingChecks
  humanReviewRequired: true
  dataStatus · contractStatus · audit
```

与页面表格是同一执行路径的两种呈现。

### 5.4 问答前环境检查

| 症状 | 排查 |
|---|---|
| `数据源未登记: SRC-…` | 未设数据源 env 或宿主未重启 |
| `Business identity is unavailable` | `DSH_BIZ_USER_ID/TENANT/ROLES` 不全 |
| `RELEASE_NOT_ACTIVE` | 未 seed / profile 不对 |
| `DERIVED_DRIFT` | 改了源没 `derive` |
| 工具不可见 | 插件未进当前 profile，或描述符未加载 |

---

## 6. 两个样例对照

| | **AML**（完整） | **TAX**（最小闭环） |
|---|---|---|
| 包 | `packages/aml` aml-analysis | `packages/tax` tax-risk@1.0.0 |
| 场景 | `SCN-AML-FIND-CLUES` | `SCN-TAX-BURDEN-ANOMALY` 等 3 个 |
| 插件 | `apps/aml` | `apps/tax` |
| 数据 | mock / ext-api | `mock-services/tax-api` + `SRC-TAX-CORE` |
| profile | `dsh-onto` | `dsh-tax` |
| 验收 | 五 tab + agent `run_scenario` | 页面 + Agent 同 ruleId；`dump-tax-config` |
| 文档 | architecture / ops-manual | **plugin-authoring** + 本指南 |

**建议顺序：** ① 用 AML workbench 理解 O1/O2/O3 与人审 → ② 跟 TAX 指南走冷启动 → ③ 复制 TAX 模板接你的域。

---

## 7. 最短路径清单

**只想智能问答（包已签发、插件在跑）：**

1. 确认 profile 已装插件、数据源 env 已设、seed 已激活。  
2. 新会话直接问业务，或让 Agent `list_scenarios` → `run_scenario`。  
3. 读 ruleId/证据链；需认定时转人工。

**想做业务应用：**

1. 按 [plugin-authoring.zh.md](plugin-authoring.zh.md)：建包 → bindings → validate/issue。  
2. 写连接器 + env 登记 `sourceId`。  
3. 页面只调 `runScenario`（与 Agent 同源）。  
4. 输出恒带 `humanReviewRequired=true`；正式动作走批准卡。

**想持续迭代口径：**

1. 知识库收原料 → 人审批准物化。  
2. 改 DRAFT → validate/derive/gate → 再 issue 或 fork。  
3. 禁止手改 ISSUED / 手改 `derived/**`。

---

## 8. 相关文档

| 文档 | 内容 |
|---|---|
| [architecture.md](architecture.md) | 概念、三层本体、校验/派生/引擎规则（自包含） |
| [plugin-authoring.zh.md](plugin-authoring.zh.md) | 第二业务插件冷启动装配（卡点 C1–C7） |
| [ops-manual.md](ops-manual.md) | 正式动作启用门槛、对账与停用 |
| [../README.zh.md](../README.zh.md) | 快速开始与 CLI |
| [user-guide.en.md](user-guide.en.md) | 本指南英文版 |
