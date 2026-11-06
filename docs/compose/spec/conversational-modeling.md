---
feature: conversational-modeling
status: draft
updated: 2026-11-05
---

# 对话式建模 × 图谱画布 × O→L 能力落地

**工作边界**：本平台的工作 = **建模域本体**——把业务域（如 AML）的 O1/O2/O3（对象/
关系/行为/规则/场景）从业务原料与对话里建出来、审出来、签发派生出 L2/L3/L4，模型
本身即工作产物。**套用模型建实例**（案件/交易/候选研判、场景处置）是**后续对话助手**
在 L1/L5 入口上的工作，不是建模平台的工作；本仓的 `run_scenario`/`invoke_expert`
仅作「派生件可执行」的验收面。

建模面现状是表格 + 手写 JSON（pipeline/inputs/属性行协议），业务用户门槛高，校验
报错跳不回元素，签发/校验/fork 三处割裂。本文档定义新形态：**对话创建，右侧画布
按每轮对话自动长出图谱**；模型骨架沿用本仓库 **O1/O2/O3（建规矩）+ L1–L5（干活）**，
派生后落成 dsh 会话里直接可调用的能力。外部技能 ontology-business-map 的五视角
（对象/行为/规则/事件/场景/报表）**只作工程参考**——骨架先行、分片并行、三道校验门、
力导向渲染；其模型骨架不采用。事件不进 Schema、判定在规则引擎、认定在人工三条纪律不变。

## [P1] 产品形态：对话是入口，画布是状态

两个视图、同一份模型状态：

| 视图 | 职责 | 变更载体 |
|---|---|---|
| **对话面**（L5，dsh 会话） | 口述 / 文档 / 指令进入；AI 起草草案（带置信度、理由、结论性标记） | 每轮对话 → `ModelDelta` |
| **图谱画布**（workbench 面板） | 增量长出节点与引用边；节点检视器做人审动作 | 模型版本号递增 → 订阅刷新 |

- 布局（P1 修正）：**对话留在 `main[key=conversation]`（dsh 原生会话），图谱常驻右栏 tab**
  ——`ui-sidebar-right` 的 `ontology-graph` 页型（guide 卡片可发现；栏体打开一次后常驻，
  4s 轮询持续生长；自动弹出暂缓——harness `openTab` 只置展开旗标、面板可能不挂载，
  半开态风险，待布局契约明确后再做）。画布组件 `GraphWorkbench` 由主区建模视图与
  右栏 tab 共用，包选中状态经工厂闭包共享。左侧 dsh-onto 行保留五 tab 管理工作台
  （包管理/知识库/校验/运行）。**草拟单一入口 = dsh 主对话**（自然语言口述 → agent
  起草 `draft_elements`）：画布与 workbench **不再放任何对话输入框**——对话是入口，
  画布是状态；workbench 内只做状态展示、节点检视器人审动作与骨架管理，不建第二套
  对话历史。
- 每轮协议（turn → delta → 审定）：
  1. 用户输入解析为建模意图（新增元素 / 修改·接线既有元素 / 改权重 / 查询图）；
     实例套用（案件研判、场景处置）是下游助手意图，不在此列；
  2. AI 产出 `ModelDelta`：`drafts[]`（DraftCandidate）+ `edges[]`（引用边）+
     provenance（对话轮次）+ rationale，**不落包**；
  3. 画布应用 delta：草案节点**虚线**渲染，边按引用类型着色；
  4. 人审动作（节点检视器或对话内联）：批准 / 合并 / 驳回 / 编辑后重审；
  5. 批准 → 物化进包（走 knowledge 物化通道）→ 节点转实线 → 模型版本号递增；
     驳回 → 节点灰置留痕，可回滚。
- 节点检视器内容：属性 / 出入引用 / 依据（对话轮次或知识源）/ 置信度 / 该节点
  校验 issues / 审定状态。校验 error 直接标红节点，点击即到检视器——修复闭环
  不再跨 tab。
- ISSUED 包对话只读：AI 引导「去 fork」，不提供绕过签发状态机的写路径。

## [P2] 模型骨架：O1/O2/O3 + L1–L5

O 层（规矩）类型不动（`core/src/types.ts` 现状即事实源）：

| 层 | 回答 | 元素 |
|---|---|---|
| O1 对象层 | 有什么 | 对象 / 关系 / 字典 / 属性引用 |
| O2 规则层 | 怎么判 | 行为 / 打分规则 / 排除规则 / 技能模板 |
| O3 场景层 | 边界在哪 | 场景卡 / 输出契约 / 复核门禁 / 审计项 |

L 层（干活）= 运行时能力栈。其中 **L2/L3/L4** 是签发后由 derive 从 O 层编译的
只读执行件（manifest 指纹；流水线步骤 4「O→L 翻译层」仅此三层）；**L1/L5 是
入口面，不派生**。运行时调用链：L1/L5 进需求 → O3 场景派发 → L4 专家（持 L3
技能、用 L2 工具查 O1）→ O2/O3 引擎打分红线（AI 不参与）→ 人工拍板。

| 层 | 名 | 内容 | 来源 | dsh 承接面 |
|---|---|---|---|---|
| L1 | 应用 · 入口 | 嵌入业务系统的入口（带上下文发起场景） | 不派生（集成面） | `run_scenario` / `invoke_expert` 入口 |
| L2 | 工具池 · 家伙 | 查询 · 计算 · 对接接口 · 对象粒度收权 | derive：O1 tool-contracts + bindings（api-sources/field-maps） | agent-tools 注册（收权投影） |
| L3 | 技能 · 怎么组合用 | 工具调用方法论（权重 · 步骤 · 叙述模板） | derive：O2 skill-templates | `skl-*` skill provider |
| L4 | 专家 · 谁来干 | 持多技能 · 探索关联 · 按 duties 领步骤 | derive：O3 agent-duties（职责 / llm 权限 / 人审闸） | 专家面 `list_experts` / `invoke_expert`；专家团叠 Agent Teams |
| L5 | 助手 · 门面 | 形象 · 锚点 · 对话入口 | 不派生（产品面） | dsh 会话 + workbench |

五视角取舍（只借工程手段，不借骨架）：

| 五视角手段 | 取 | 落点 |
|---|---|---|
| 骨架先行（全局 ID 先钉死） | ✓ | 对话开局产 skeleton（域码 + ID 清单 + 预算），此后分片只填内容不起名 |
| 分片并行起草 | ✓ | ModelDelta 按 O1/O2/O3 分片产出，跨片引用靠 ID 维系 |
| 三道校验门 | ✓ | 片级=validate 元素级；合并级=引用闭合；全量级=quality 分 + 覆盖统计 |
| 力导向 HTML 图谱 | ✓ | 画布底座改自绘分层 SVG（O1/O2/O3/草案列 + 引用边；classic script 零依赖，不引 ECharts），替代其独立 HTML 交付形态 |
| 事件视角 | ✗ | 事件是 O2 行为的运行时实例记录，不进 Schema（现有纪律） |
| 报表视角 | ✗ | 报表是 O3 输出契约的呈现层，不作为建模元素 |

## [P3] 对话协议与草案通道

- **轮次即原料**：每轮用户输入落 `KnowledgeSourceRecord`（建议 `SourceType` 增
  `CONVERSATION`，sha256 幂等去重）——对话草案与知识库草案汇入同一
  `DraftCandidate` 队列，保持「LLM 只起草、人审才物化」单通道与完整审计链。
  退化方案（对话轮次记作 CASE_SAMPLE）语义混淆，不采用。
- **`ModelDelta`**（core/types.ts 新增）：`{ drafts: DraftCandidate[]; edges:
  ModelEdge[]; removed?: string[]; rationale: string; turnId: string }`；
  `DraftCandidate` 增 `provenance: { turnId?: string; sourceId?: string }`。
- **修改/接线语义（op='update'）**：`DraftItem` 增 `op: 'create'|'update'` 与
  `targetId`（Attribute 为 `OBJ.attr` 形态）。update 物化对既有元素做增量合并——
  标量字段覆盖、`weights` 按键并入、数组整替，`append.<字段>=[…]` 追加去重（接线）；
  不新增 ID（I6 门禁只约束新增）。**载荷字段必须在 UPDATABLE 白名单内：起草即拒
  （`not updatable`），物化侧同口径兜底——白名单外字段曾被静默跳过且 apply 回报
  merged（靠冒烟才暴露），现为 fail-loud**。`ScenarioCard` 契约字段顶层
  `mustInclude` 与 `outputContract.mustInclude` 均接受（归一到 outputContract，
  与 create 同源，消除字段路径不对称）。改 `ScoreRule.weight` 走**权重联动归一**：
  显式权重为准、未动规则按比例吸收残差至合计 1.0，并同步技能模板权重（同权口径；
  同批多条权重更新须经 `apply_draft` 的 `candidateIds` **同批物化**，一次归一——
  逐条物化会互相打架）。**驳回后的同名草案不挡重提**（幂等只对 pending/approved/
  merged 生效；rejected 允许同名重新起草，重试记录以 retry 序号区分 ID）。
- **场景引用位（v1.1）**：`ScenarioCard` 增 `behaviorRefs?` / `exclusionRefs?` /
  `scoreRefs?`——场景与行为、排除规则、打分规则的关联显式化（此前是「全部都用」的隐式
  约定）。**缺省 = 全部**（向后兼容，不落键）；显式数组 = 限定范围，元素须指向同类型
  且闭合（悬空/错类型 → `REF_UNCLOSED`）。引用位随 `scenario-orchestration` 下发，
  **执行器按引用位收窄运行范围**（排除段只跑圈内规则、行为段只物化圈内类型、打分段
  只求值圈内规则——范围外打分规则不再因缺特征刷待核实；D7/D13 曾仅校验不收窄或只收窄
  部分，与「限定范围」口径冲突）。`SCN-*` 作为场景入口豁免 `ID_UNREFERENCED`（入口天然无上游，与 AGT-/AUD-/TOOL- 同列）。
  多场景协作口径（C4 压测拍板）：包级权重合计仍 = 1.0（WEIGHT_SUM 不变）；场景间口径
  差异靠 scoreRefs 圈定 + 带式权重分配（公共带 + 场景带）表达，不在场景内二次归一。
  **D14（C5 冒烟发现）**：圈定后 riskScore 上限 = 圈内权重和——`reviewGate.threshold`
  超过该和即 `REVIEW_GATE_UNREACHABLE`（error，校验期拦截）；超过 90% 报
  `REVIEW_GATE_TIGHT`（warn，仅近满分候选可触发）。阈值必须按圈内上限标定，
  不得沿用全包 0.75 默认。
- **ID 骨架门**：skeleton 确认前不得物化任何元素；分片阶段新增骨架外 ID → 校验
  error（`SKELETON_OUT_OF_SCOPE`），防 ID 漂移。口径：skeleton.ids 是**全量 Schema
  元素 ID 清单**（含 `dict-*`，不含 `OBJ.attr` 属性引用）——门禁只约束**新增 ID**；
  Attribute 落 `OBJ.attr` 属性引用、RedLine 落既有场景 forbiddenPhrases（均不新增
  ID），物化按 appliedAs 的 ID 段（owner / 场景 ID）对照骨架。
- **人审动作工具化契约**（P4 的 `apply_draft` / `reject_draft`）：`humanApproved`
  为必填显式声明（仅当用户在会话中明确批准/驳回时才为 true，agent 不得自行审定）；
  `reviewCandidate` 落 `reviewedBy`（'workbench' 人工直操 / 'agent-tool' 会话代执行）
  与 `reviewedAt`，入草案队列可审计回看。
- **红线纪律不变**：conclusionLike 只落 `forbiddenPhrases`，禁入输出契约；
  confidence < 0.75 强制人审；weight 合计 = 1.0 与 SKL 同权校验照旧（改权重经
  update 语义联动归一，见上；SKL 同权由归一同步，消除手抄）。
- **v1.1 待办沉淀（P2 拍板）**：规范位 = 包根 `backlog.md`——附属文件，`exportVersion`
  读面携带（工作台清单/YAML 导入可读写），但**不入 `listSourceFiles`/派生摘要/loadgate**
  （改待办不触发 `DERIVED_DRIFT`）；fork 整目录复制自动携带。对话中 agent 先写会话工作区
  `<包名>-backlog.md` 草稿，定稿条目由用户粘贴进包根；逐条格式：条目 / 理由 / 预估 ID 数。

## [P4] O→L 派生与 dsh 落地

派生物即 L 层执行件，现有产物结构不变，加层标注与能力发现面：

- `derived/manifest.yaml` 每条目增 `layer: L1|L2|L3|L4`（缺省按 §P2 映射推断，
  向后兼容）。
- 新工具面（全部经 tool-face-policy 三出口：value 闸 + render 闸 + 错误信封；
  新增 `@Remote` 方法须登记 `backend/src/client.ts` 的 `allDescriptors`）：

| 工具 | 用途 | 面 |
|---|---|---|
| `get_model_graph` | 画布数据源：nodes + edges + issues（按收权投影） | 建模 |
| `create_package` | 对话建包（D3）：DRAFT 空包、同名同版本拒绝；签发仍仅人工 | 建模 |
| `save_skeleton` | 骨架落盘（I6 前置）：ids 语法/去重校验 + `humanApproved` 契约——确认仅由用户点头驱动 | 建模 |
| `draft_elements` | 对话轮 → ModelDelta（只入草案队列） | 建模 |
| `apply_draft` / `reject_draft` | 人审动作工具化（画布与对话共用；`apply_draft` 收 `candidateIds` 批量同批物化——权重归一批语义；`humanApproved` 显式人审契约 + reviewedBy 留痕） | 建模 |
| `list_capabilities` | L1–L5 能力清单，会话里可发现「这个包能干什么」 | 发现 |
| `list_experts` | L4 专家发现：profile（职责 / 技能 / 工具白名单 / 边界） | 专家面 |
| `invoke_expert` | duties 预检（对齐 / llm 权限 / 白名单越权即拒）+ 规则引擎整跑场景（单专家执行面） | 专家面 |

**专家面（L4 落点）**：`agent-duties.yaml` 从死文档变活——**专家 Profile** 由三件
派生物组装：duties（职责 / llm 权限 / 人审闸）+ `skl-*`（方法论）+ `TOOL-*`（收权
工具面）。两阶段落地：

1. **单专家（bundle 内，不依赖 experimental）**：`invoke_expert` 先过 duties 预检
   （pipeline 对齐、打分步恒 `llm:forbidden`、humanGate 只能人过、toolRefs 越权即拒），
   再走与 `run_scenario` 相同的规则引擎契约整段执行（v1 引擎步内不调工具/LLM，预检式
   收权是落点）；toolRefs 按步收权（数据/行为/技能步挂对象粒度读工具，引擎/人审步空
   清单）。打分只在规则引擎；`humanReviewRequired` 恒真。
2. **专家团（渐进增强）**：多专家分工叠 dsh `ctx.agentTeams`（experimental，需
   显式启用、有 maxMembers 限额）——profile 灌 `spawn_teammate`，`team_task_*`
   按场景步分工，`send_message` 传候选。单专家路径不依赖该实验包。

- 落地不变量沿用：L 层只读（手改 → `DERIVED_DRIFT`，改 O 层重派生）；打分只在
  规则引擎；`humanReviewRequired` 恒真；签发仅人工；工具面不携带禁语本体。
  **D15（C5 实测发现）**：manifest 锚点按**版本**匹配——fork 原样携带的上一版本
  `issueRecord[].manifestDigest` 既不阻断新版本门禁（签发前预检不再假漂移），
  也不被新版本派生覆写（历史锚点保真）。

## [P5] 分期落地

| 切片 | 内容 | 验收 |
|---|---|---|
| S1 | GraphCanvas + 草案虚线 / 人审物化最小闭环 | 对话一轮 → 画布长节点 → 批准 → 包内出现元素 |
| S2 | skeleton 先行 + 校验节点定位 | skeleton 门生效；error 点击跳节点 |
| S3 | derive 层标注 + 能力/专家面（`list_capabilities` / `list_experts` / `invoke_expert`） | dsh 会话列出 L1–L5 能力与专家清单，可按 duties 执行 |
| S4 | 运行回图谱 | 运行结果命中规则 / 证据链在图上高亮，可点回规则定义 |
| S5 | 专家团（可选） | 多专家叠 Agent Teams 按场景步分工协作 |

## [P6] 不变量清单（测试即此清单）

| # | 不变量 | 含义 |
|---|---|---|
| I1 | 草案不直写包 | 虚线态只存在于 DraftCandidate 队列与画布；approve 才物化 |
| I2 | 节点可溯源 | 每个物化元素带 provenance（对话轮次或知识源 ID），画布可回看 |
| I3 | 图谱即校验视图 | 每条 error/warn 定位到节点或显式「包级」，无孤立报错 |
| I4 | L 层只读 | 手改派生物 → DERIVED_DRIFT；改 O 层 → 重派生恢复 |
| I5 | 对话面同受策略层 | 建模工具同过禁语 / 收权 / 错误信封，无旁路；`apply_draft`/`reject_draft` 另过 `humanApproved` 人审契约（agent 不得自行审定）+ reviewedBy 留痕 |
| I6 | 骨架外 ID 不得分片新增 | skeleton 门在物化前置，ID 漂移在源头拦截；属性/红线不新增 ID，按 appliedAs 的 ID 段（owner / 场景 ID）对照骨架 |
| I7 | 专家边界 | `invoke_expert` 每步受 duties 约束（toolRefs 白名单 / llm 权限 / humanGate），越权即拒；打分步 LLM 恒不参与 |

## 模块落位（改动点预估）

- `core/src/types.ts`：`ModelDelta` / `ModelEdge` / `DraftCandidate.provenance` /
  `reviewedBy·reviewedAt`（人审留痕）；`SOURCE_TYPES` 增 `CONVERSATION`。
- `core/src/knowledge.ts`：对话原料路由（轮次 → KnowledgeSourceRecord → 草案队列）。
- `core/src/validate.ts`：skeleton 门（`SKELETON_OUT_OF_SCOPE`）；issue 带节点定位。
- `core/src/derive.ts`：manifest 条目 `layer` 标注；duties `toolRefs` 按步收权。
- `backend/src/agent-tools.ts` + `client.ts`：建模与发现工具（`get_model_graph` /
  `draft_elements` / `apply_draft` / `reject_draft` / `list_capabilities`），
  描述符表登记；attack-surface 不变量表扩同族用例。草拟单一入口 = dsh 主对话：
  `draft_elements`（agent 结构化起草，进程内 `KnowledgeStore.addDraft`）；CONVERSATION
  管线（uploadSource + parseSource）保留为轮次留痕与知识库通用解析通道；不注册
  `addDraft` wire（无调用方，防描述符表漂移）。
- `backend/src/agent-experts.ts`（新）：专家 Profile 组装（duties + skl + TOOL）与
  `list_experts` / `invoke_expert`；专家团阶段接 `ctx.agentTeams`（可选注入，
  单专家路径不依赖）。
- `backend/src/agent-skills.ts`：SKL 模板 skill 目录之外，注册内置 `onto-modeling`
  建模引导技能（正文=工作边界+标准流程+引擎契约；D1：全新会话的建模需求曾被外部
  导图技能误导轨，目录内需要一个更强匹配的平台正解；`draft_elements` 描述同步指路）。
- `workbench/src/client.ts`：classic script 单入口约束下**不拆文件**，按分区落位
  （`GraphCanvas` / `InspectorView` / `GraphWorkbench` 为文件内分区组件，主区建模视图
  与右栏 `ontology-graph` tab 共用）；建模 tab 以画布为主视图，表格降级为清单视图保留。
