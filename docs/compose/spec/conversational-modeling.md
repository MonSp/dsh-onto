---
feature: conversational-modeling
status: draft
updated: 2026-11-05
---

# 对话式建模 × 图谱画布 × O→L 能力落地

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
  （包管理/知识库/校验/运行）；dsh 主会话经 agent 工具（draft_elements 等）驱动同一
  管线，workbench 内轻量输入框直达同管线，不建第二套对话历史。
- 每轮协议（turn → delta → 审定）：
  1. 用户输入解析为建模意图（新增元素 / 改权重 / 查询图 / 运行场景）；
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
| 力导向 HTML 图谱 | ✓ | 画布底座（ECharts 离线资产），替代其独立 HTML 交付形态 |
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
- **ID 骨架门**：skeleton 确认前不得物化任何元素；分片阶段新增骨架外 ID → 校验
  error（`SKELETON_OUT_OF_SCOPE`），防 ID 漂移。
- **红线纪律不变**：conclusionLike 只落 `forbiddenPhrases`，禁入输出契约；
  confidence < 0.75 强制人审；weight 合计 = 1.0 与 SKL 同权校验照旧（画布上
  权重联动自动归一，消除三处手抄）。

## [P4] O→L 派生与 dsh 落地

派生物即 L 层执行件，现有产物结构不变，加层标注与能力发现面：

- `derived/manifest.yaml` 每条目增 `layer: L1|L2|L3|L4`（缺省按 §P2 映射推断，
  向后兼容）。
- 新工具面（全部经 tool-face-policy 三出口：value 闸 + render 闸 + 错误信封；
  新增 `@Remote` 方法须登记 `backend/src/client.ts` 的 `allDescriptors`）：

| 工具 | 用途 | 面 |
|---|---|---|
| `get_model_graph` | 画布数据源：nodes + edges + issues（按收权投影） | 建模 |
| `draft_elements` | 对话轮 → ModelDelta（只入草案队列） | 建模 |
| `apply_draft` / `reject_draft` | 人审动作工具化（画布与对话共用） | 建模 |
| `list_capabilities` | L1–L5 能力清单，会话里可发现「这个包能干什么」 | 发现 |
| `list_experts` | L4 专家发现：profile（职责 / 技能 / 工具白名单 / 边界） | 专家面 |
| `invoke_expert` | 按 duties 逐步执行场景（单专家执行面） | 专家面 |

**专家面（L4 落点）**：`agent-duties.yaml` 从死文档变活——**专家 Profile** 由三件
派生物组装：duties（职责 / llm 权限 / 人审闸）+ `skl-*`（方法论）+ `TOOL-*`（收权
工具面）。两阶段落地：

1. **单专家（bundle 内，不依赖 experimental）**：`invoke_expert` 按 duties 逐步
   执行（步派发 + duties 注入 + 工具收权），收编今天隐式的 `run_scenario` 内核；
   打分步恒 `llm:forbidden`、humanGate 只能人过。
2. **专家团（渐进增强）**：多专家分工叠 dsh `ctx.agentTeams`（experimental，需
   显式启用、有 maxMembers 限额）——profile 灌 `spawn_teammate`，`team_task_*`
   按场景步分工，`send_message` 传候选。单专家路径不依赖该实验包。

- 落地不变量沿用：L 层只读（手改 → `DERIVED_DRIFT`，改 O 层重派生）；打分只在
  规则引擎；`humanReviewRequired` 恒真；签发仅人工；工具面不携带禁语本体。

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
| I5 | 对话面同受策略层 | 建模工具同过禁语 / 收权 / 错误信封，无旁路 |
| I6 | 骨架外 ID 不得分片新增 | skeleton 门在物化前置，ID 漂移在源头拦截 |
| I7 | 专家边界 | `invoke_expert` 每步受 duties 约束（toolRefs 白名单 / llm 权限 / humanGate），越权即拒；打分步 LLM 恒不参与 |

## 模块落位（改动点预估）

- `core/src/types.ts`：`ModelDelta` / `ModelEdge` / `DraftCandidate.provenance`；
  `SOURCE_TYPES` 增 `CONVERSATION`。
- `core/src/knowledge.ts`：对话原料路由（轮次 → KnowledgeSourceRecord → 草案队列）。
- `core/src/validate.ts`：skeleton 门（`SKELETON_OUT_OF_SCOPE`）；issue 带节点定位。
- `core/src/derive.ts`：manifest 条目 `layer` 标注。
- `backend/src/agent-tools.ts` + `client.ts`：建模与发现工具（`get_model_graph` /
  `draft_elements` / `apply_draft` / `reject_draft` / `list_capabilities`），
  描述符表登记；attack-surface 不变量表扩同族用例。
- `backend/src/agent-experts.ts`（新）：专家 Profile 组装（duties + skl + TOOL）与
  `list_experts` / `invoke_expert`；专家团阶段接 `ctx.agentTeams`（可选注入，
  单专家路径不依赖）。
- `workbench/src/client.ts`：拆出 `GraphCanvas` / `InspectorView`（2547 行已到限，
  拆文件）；建模 tab 以画布为主视图，表格降级为清单视图保留。
