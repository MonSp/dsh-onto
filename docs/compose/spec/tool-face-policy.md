---
feature: tool-face-policy
status: delivered
updated: 2026-11-05
supersedes: dsh-native-integration.md §S2.3/§S2.4 的散点实现口径
---

# 工具面信任边界与策略层设计

PR#2 前十三轮评审反复出现同类问题（路径 9 轮、收权 8 轮、禁语 5 轮）的根因是
守卫逐点打补丁、无集中策略层、无不变量测试。第十四轮复审再暴露一类**挂点病**：
策略执行只挂在中间产物（execute 返回值）上，而模型轨迹实际所见的是 render 产物
与错误消息——短语清单从空化后的 value 反推，render 的遮蔽与兜底恒空转，模板字面
碰撞与跨分隔符重组两条路径直达模型面。本文档定义模型可见面的信任边界与策略层的
正确挂点；实现按此收敛；评审按本文档的不变量走查，不再按 diff 行点名。

## [P1] 信任边界：两个面、三个出口载体

| 面 | 载体 | 可见者 | 允许携带 | 禁止携带 |
|---|---|---|---|---|
| **模型面** | ① render 产物（工具 content——会话轨迹实际所见）② 工具错误/拒绝消息 ③ execute 返回值（执行局部，按同等零容忍对待） | LLM / 会话轨迹 | 结构化判定结果、规则 ID、位置信息、计数 | 禁语短语本体、绝对路径、底层 fs 错误原文、知识原料正文 |
| **人审面** | core/wire/workbench（audit、知识库、候选队列） | 人工复核者 | 完整短语、完整正文、完整路径（供复核定位） | （无附加限制） |

**策略执行必须挂在全部三个出口载体上**（value 闸 + render 闸 + 错误信封），
一处决定口径；人审面不经过。不允许任何工具在出口自行决定脱敏/投影口径。

## [P2] 策略层：三个收口 + 一个信封

模块落位：`core/src/store.ts`（P2.1 唯一判定源）、`backend/src/agent-policy.ts`
（P2.2 禁语 + P2.4 信封 + 输出契约断言）、`backend/src/agent-grants.ts`（P2.3 收权）、
`backend/src/agent-tools.ts`（注册与投影，只消费不裁决）。

### [P2.1] 路径策略（唯一判定源：`core/src/store.ts`）

- `isSafeRelPath(rel)`：拒绝绝对路径、含 `:` 段（盘符/ADS）、空段/`.`/`..`。
- `isInsideDir(root, dir)`：两侧 `canonPath` 后必须严格落在 root 内——符号链接/
  junction 指向外部即拒。
- **读写成对**：`readSourceFile` 与 `writeSourceFile` 同一口径收口（读侧不再
  依赖调用方自觉）；`verifyDerived` 的 manifest `entry.path` 经由之，恶意清单
  路径在门禁内落 DERIVED_DRIFT，不读围栏外文件。
- 调用点清单（新代码禁止绕过）：
  - `readSourceFile` / `writeSourceFile`（core 本体，读写成对）；
  - `importVersion`（既有两遍式保留）；
  - wire `writeSource`（services.ts，保留为纵深防御）；
  - `loadDatasetFromArgs` 的 `datasetPath`（工作目录围栏，
    `baseDir = opts.baseDir ?? process.cwd()`，越界/穿越/ADS 一律
    `INVALID_ARGS`，错误只回显调用方原文）。
- 错误面：机器码 + 调用方原文；**永不回显 resolve 后绝对路径**（执行口径见 P2.4）。

### [P2.2] 禁语策略（双面执行 + 双源清单，禁止字符串手术）

设计原则：**模型面根本不携带短语**，遮蔽是「整字段替换」而非「子串替换」——
子串替换无法证明完备（嵌套短语、重组残留、标记自嵌都是它的衍生病）。

- **清单双源**：`phrases = 命中（audit.forbiddenPhraseHits[].phrase）∪ 场景红线
  （scenario.outputContract.forbiddenPhrases）`，去重非空，execute 时一次取定。
  只取命中是不够的：渲染模板固定字面与未扫描字段的碰撞不在命中记录里。
- **清单传递**：`rememberPhrases(runId)` 注册表从 execute 带到 render——value 会被
  快照克隆且 `phrase` 字段已空化，从 value 反推清单恒为空（挂点病的根因）。
  渲染侧取不到时回退命中源（直调/测试路径）。
- **value 闸** `enforceOutputPolicy(result, phrases?)`：
  1. `phrase` 字段 → 空串；
  2. ID 回指字段（`ID_FACE_KEYS`）含短语 → **fail-loud** 抛 `INVALID_TOOL_OUTPUT`
     （错误消息不回显短语）；
  3. 其余字段含任一短语即**整字段替换**为占位标记（选首枚不含任何短语的候选，
     防标记自嵌；全冲突 fail-loud）；
  4. 断言闸门（`assertNoForbiddenPhrases`）同源复核。
  walk 带 **copy-on-write**：无变化返回同引用——幂等是结构性的，不依赖清单为空。
- **render 闸** `renderRunText(result, phrases?)`：叙述/证据/待核实/位置等**片段级**
  先重遮再拼行；拼接后若仍检出短语（模板固定字面碰撞、短语横跨分隔符重组等
  病态构造），**整段渲染文本**替换为标记。渲染不改写入参。
- **错误面**：抛出消息同受 P2.4 信封约束；**且过禁语退避**——`asToolError`/`toolExecute`
  接受红线清单（或按 args 惰性取值的 getter，仅 catch 时 `loadPackage` 求值），
  message 含任一短语时**整段退避**为受控短语并保留机器码（`retreatPhraseEcho`，
  与 render 拼接后兜底同口径，禁止子串手术）；guard 拒绝语为字符串信封，
  退避时保留 `CODE:` 前缀。人审面错误不经本函数。

被删除的机制（衍生病的根源，禁止回潮）：占位标记子串替换、边界重组残留剥离
不动点、嵌套短语长者优先排序、剥离相位终止性论证。

### [P2.3] 收权策略（两段式：resolve → match，deny-by-default）

- **match 单点**：`checkGrant(contracts, subject)` / `grantMatches`（既有）。
  匹配口径：`grantScope | objectId | relationId` 等于主体（主体 = 剥 `:实例` 段后的类型段）。
- **resolve 两个入参通道**（面不同，规则同一）：
  1. 顶层 `objectId`/`objectRef`（guard 通道，`grantGuardDecision`）：非字符串/空串拒；
     缺 name/version 拒；清单读取失败保留机器码。
  2. `dataset` 内嵌（执行通道，`assertDatasetGranted`）：实例 id 在图中以声明类型为准
     （类型段伪托拒）、重复实例 id 歧义拒、裸 ref 按自身匹配、解析失败拒。
- **目录可见豁免（唯一）**：`list_tool_contracts` 不带 objectId 返回全量收权清单——
  收权目录本身属于「结构化判定结果」允许面；豁免仅此一处，其余一律未命中即拒。
- **不变量**：任何解析失败、任何歧义、任何未命中 → `OBJECT_NOT_GRANTED`
  （不以放行掩盖越权）；签发/审阅端点永不进工具面。

### [P2.4] 错误信封（全工具统一，`asToolError` / `toolExecute`）

- 所有工具 execute 一律套信封；禁止任何出口裸抛原生错误。
- **受控错误**（AgentToolError / PackageStoreError / ScenarioRunError /
  ExpressionError / MissingFeatureError / KnowledgeError）：保留机器码与业务语义
  message，剥除服务端目录（serverDir 清单）后放行。
- **原生 fs/系统错误**（带 errno/syscall 的 SystemError）：**只留机器码**
  （如 `工具执行失败（ENOENT）`），原文一律不入模型面（原文含绝对路径）。
- **其余未知错误**：`UNKNOWN_ERROR`/`RUN_FAILED` + 受控短消息。
- **禁语退避（与 P2.2 错误面同源）**：受控/未知错误的 message 在路径剥除后
  再过 `retreatPhraseEcho(message, phrases)`——含红线短语即整段退避，
  `AgentToolError.code` 不变；guard 字符串拒绝保留 `CODE:` 前缀。
- 机器码词汇：`PACKAGE_MALFORMED`/`PACKAGE_EXISTS`/`INVALID_ARGS`/
  `INVALID_TOOL_OUTPUT`/`OBJECT_NOT_GRANTED`/`DERIVED_DRIFT`/`NOT_FOUND`/
  `RUN_FAILED`/`UNKNOWN_ERROR`/业务码透传。

## [P3] 不变量清单（测试即此清单）

| # | 不变量 | 含义 |
|---|---|---|
| I1 | 不回显-短语 | 模型面任何字符串（value / render / **错误与 guard 拒绝语**）不含禁语短语；二次执行同引用（幂等） |
| I2 | 不回显-路径 | 任何工具错误消息不含 resolve 后绝对路径/底层 fs 错误原文 |
| I3 | 不放行-路径 | datasetPath/读源/写源/归档的穿越、junction 逃逸、ADS、盘符绝对路径全拒 |
| I4 | 不放行-收权 | objectRef 全形态（空/非串/裸/实例段/类型段伪托/重复歧义）未命中即拒 |
| I5 | 不裸抛 | 畸形输入落 `AgentToolError`/`PackageStoreError` 受控错误，无 TypeError 裸抛 |

口径补充：

- I1 的「模型面任何字符串」以 **render 产物与错误消息**为首要检对象（轨迹实际所见），
  execute 返回值同等对待；短语清单取 P2.2 双源，不以命中为限。
- I2 的「fs 错误原文」指原生错误 message 全文——一律不入模型面（P2.4）。
- 发现一类问题时按不变量同族穷举补测，不再逐旁路点名。

## [P4] 本变更集（策略层 v2 落地）

1. `core/src/store.ts`：`readSourceFile` 读围栏（读写成对）；store 错误消息不再
   内嵌 versionDir（调用方入参之外零服务端路径）。
2. `backend/src/`：策略层三分落地——`agent-policy.ts`（禁语双面 + runId 清单注册表
   + 错误信封 + 输出契约逐字段断言）、`agent-grants.ts`（收权）、`agent-tools.ts`
   （注册与投影）。
3. 测试：模板固定字面碰撞、跨分隔符重组、copy-on-write 幂等、读围栏等价类、
   fs 错误信封、证据/hits/待核实逐字段验形——I1–I5 同族穷举补齐。
