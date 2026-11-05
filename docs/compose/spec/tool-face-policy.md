---
feature: tool-face-policy
status: delivered
updated: 2026-11-16
supersedes: dsh-native-integration.md §S2.3/§S2.4 的散点实现口径
---

# 工具面信任边界与策略层设计

PR#2 十三轮评审反复出现同类问题（路径 9 轮、收权 8 轮、禁语 5 轮）的根因是
守卫逐点打补丁、无集中策略层、无不变量测试。本文档一次性定义模型可见面的信任
边界与三个策略收口，实现按此收敛；评审按本文档的不变量走查，不再按 diff 行点名。

## [P1] 信任边界：两个面

| 面 | 载体 | 可见者 | 允许携带 | 禁止携带 |
|---|---|---|---|---|
| **模型面** | `defineTool` execute/render 返回值、renderRunText 文本 | LLM / 会话轨迹 | 结构化判定结果、规则 ID、位置信息、计数 | 禁语短语本体、绝对路径、底层 fs 错误原文、知识原料正文 |
| **人审面** | core/wire/workbench（audit、知识库、候选队列） | 人工复核者 | 完整短语、完整正文、完整路径（供复核定位） | （无附加限制） |

**唯一脱钩点**：工具出口在返回前经过一次策略执行（`enforceOutputPolicy`），
人审面不经过该函数。不允许任何工具在出口自行决定脱敏/投影口径。

## [P2] 策略层：三个收口

### [P2.1] 路径策略（唯一判定源：`core/src/store.ts`）

- `isSafeRelPath(rel)`：拒绝绝对路径、含 `:` 段（盘符/ADS）、空段/`.`/`..`。
- `isInsideDir(root, dir)`：两侧 `canonPath`（最近存在祖先 realpath + 词法尾段）
  后必须严格落在 root 内——符号链接/junction 指向外部即拒。
- **文件读写一律组合二者**：rel 形态先 `isSafeRelPath`，落点再 `isInsideDir`。
- 调用点清单（新代码禁止绕过）：
  - `writeSourceFile`（core 本体校验，不再依赖调用方自觉）；
  - `importVersion`（既有两遍式保留）；
  - wire `writeSource`（services.ts，保留为纵深防御）；
  - `loadDatasetFromArgs` 的 `datasetPath`（本次补：**工作目录围栏**，
    `baseDir = opts.baseDir ?? process.cwd()`，越界/穿越/ADS 一律
    `INVALID_ARGS`，错误只回显调用方原文）。
- 错误面：机器码（`PACKAGE_MALFORMED`/`INVALID_ARGS`/`UNKNOWN_ERROR`）+
  调用方原文；**永不回显 resolve 后绝对路径**。

### [P2.2] 禁语策略（整字段重遮 + 断言，禁止字符串手术）

设计原则：**模型面根本不携带短语**，靠"整字段替换"而非"子串替换"——
子串替换无法证明完备（嵌套短语、重组残留、标记自嵌都是它的衍生病）。

执行规则（`enforceOutputPolicy(result)`）：

1. 从 `audit.forbiddenPhraseHits[].phrase` 取短语清单（去重非空）；
   空清单直接返回原引用（幂等锚点）。
2. 深走输出结构，逐字符串字段判定：
   - `phrase` 字段 → 空串（幂等锚点：二次执行时清单为空，同引用返回）；
   - ID 回指字段（id/ruleId/objectRef/candidateId 等 `ID_FACE_KEYS`）含短语
     → **fail-loud** 抛 `INVALID_TOOL_OUTPUT`（"不改写 ID"与"零容忍"不可兼得时
     拒绝产出，错误消息不回显短语）；
   - 其余字段**含任一短语即整字段替换**为占位标记 `【禁语已脱敏】`
     （标记选首枚不含任何短语的候选，防标记自嵌）。
3. **断言闸门**（`assertNoForbiddenPhrases`）：执行后输出任何字符串字段再含短语
   → 抛 `INVALID_TOOL_OUTPUT`。断言是不变量测试的同源函数，不是第二套脱敏。
4. `renderRunText` 同口径：叙述/证据/待核实/位置等**片段级**先重遮再拼行；
   拼接后若仍检出短语（仅当短语横跨分隔符的病态构造），整段渲染文本替换为标记。
   渲染不改写入参。

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
- **不变量**：任何解析失败、任何歧义、任何未命中 → `OBJECT_NOT_GRANTED`
  （不以放行掩盖越权）；签发/审阅端点永不进工具面。

## [P3] 不变量清单（测试即此清单）

| # | 不变量 | 含义 |
|---|---|---|
| I1 | 不回显-短语 | 模型面任何字符串不含禁语短语；二次执行同引用（幂等） |
| I2 | 不回显-路径 | 任何工具错误消息不含 resolve 后绝对路径/底层 fs 原文 |
| I3 | 不放行-路径 | datasetPath/写源/归档的穿越、junction 逃逸、ADS、盘符绝对路径全拒 |
| I4 | 不放行-收权 | objectRef 全形态（空/非串/裸/实例段/类型段伪托/重复歧义）未命中即拒 |
| I5 | 不裸抛 | 畸形输入落 `AgentToolError`/`PackageStoreError` 受控错误，无 TypeError 裸抛 |

发现一类问题时按不变量同族穷举补测，不再逐旁路点名。

## [P4] 本次落地变更

1. `core/src/store.ts`：`writeSourceFile` 本体收 `isSafeRelPath`（纵深防御保留 wire 层）。
2. `backend/src/agent-tools.ts`：`loadDatasetFromArgs` 补工作目录围栏（P2.1）；
   禁语执行收口为 `enforceOutputPolicy` + `assertNoForbiddenPhrases`（P2.2）；
   `renderRunText` 片段级重遮。
3. 测试：I1–I5 不变量补缺（datasetPath 围栏等价类、写源围栏、整字段重遮幂等、
   断言闸门）。
