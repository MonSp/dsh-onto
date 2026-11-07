# 经验闭环完整系统迭代循环方案（开发 + 真实浏览器 + 真实 NL 对话驱动）

> 依据：[experience-loop.md](../spec/experience-loop.md)（proposed；本循环负责把它迭代到 delivered）；
> 分支 `master`；每轮固定协议见 §二；间隔与提交策略见 §六拍板。
> 验证口径恒为 AGENTS.md 验证阶梯 + §四真实测试剧本。**本方案是执行源，规格变更回写 experience-loop.md。**

## 一、循环定位（为什么是这个形态）

experience-loop.md 定「是什么」（两层架构、数据模型、三件事、分期）；本方案定「怎么一轮一轮把它造出来」：

- **不是 MVP 一次性交付**：目标是 P1→P2→P3 全量完整系统（experience-loop.md [S7] 分期表即路线图）。
- **每轮 = 一个可验收切片**（≤ 半天工作量），切片必须同时过三道真实关：
  ① 代码验证阶梯 ② 真实浏览器冒烟 ③ 真实自然语言对话测试。
- **真实测试是需求源**：浏览器 / NL 测试暴露的缺陷直接进台账，下轮优先修——
  循环的驱动力是「跑出来的缺陷」，不是「文档里的想象」。
- **台账是唯一进度事实源**：轮次记录、缺陷、拍板全在本文件
  （体例对齐 conversational-modeling-iteration-plan）。

## 二、每轮协议（tick protocol）

### T1 选片

优先级：① 台账「已拍板待修」> ② §三 backlog 下一未完成片 > ③ 上轮新缺陷 > ④ 用户新指示。
切片定义 = 可独立验证的最小改动（如「experience.ts 签名生成 + 单测」），禁止跨片大爆炸。

### T2 开发

- 恒守 AGENTS.md 不可违背四条 + tool-face-policy 三策略收口。
- 改动只允许出现在：`core/src`、`backend/src`、`workbench/src`、`tests`、`docs`。
- 新工具 / 技能面必须：named `apply`、client `inject` 列全、`allDescriptors` 登记、双语内联。

### T3 验证阶梯（按改动面裁剪，恒不跳级）

1. `core`：`pnpm run build` + `node --test tests/*.test.mjs`
2. `backend`：`pnpm run build` + `node --check` + `pnpm run test`（attack-surface 不变量表全量重放）
3. `workbench`：`pnpm run build` + `node --check`
4. `scripts/dump-config.ps1`（2/2 硬断言）
5. 相关 CLI 冒烟（`dsh-onto` 子命令）

### T4 真实浏览器冒烟（每轮必跑）

- **环境前置（轮 1 实测）**：dsh 宿主必须用**原生 Node**（`%LOCALAPPDATA%\Temp\nodejs24\node-v24.22.2-win-x64`）——
  MiMo 运行时的 node 带 Electron 补丁 V8，会被 dsh ESM loader 以 `unsupported Electron runtime fingerprint` 拒绝；
  pnpm 用 `%LOCALAPPDATA%\pnpm\.tools\pnpm\11.28.5\bin\pnpm.CMD`。启动前先杀 3080 旧监听。
- `scripts/dev-web.ps1` 启动（或直接 `pnpm dsh --profile dsh-onto --no-open`，工作目录 = harness）。
- Tabbit 用 `localhost:3808` / `localhost:3080`（勿用 127.0.0.1）；token 从启动日志取。
- **tab 数（P2-1 起）**：六个 tab（包管理|建模|知识库|校验派生|场景运行|**经验**）；
  经验 tab 断言：列表行 + 标注列 + 回填按钮（P2-1 起 B1 含经验视图）。
- 最小剧本（§四 B）：五 tab 全开 → aml-analysis@1.0.0 → 场景运行 `examples/aml-run.json` →
  SCN-AML-FIND-CLUES → 候选 / 证据链 / 审计 / 人审字段齐全 → 运行记录可见。
- 本轮改动涉及的 tab 加深一步（如经验视图、知识库队列）。
- 断言失败 → 记台账缺陷，**不带病进 T5**。

### T5 真实自然语言对话测试（每轮必跑）

- 开真实会话，让 agent 调工具面（至少 `run_scenario`；本轮新增工具必调）。
- 断言（tool-face-policy 三出口）：
  - content 含 ruleId / 证据链 / `humanReviewRequired=true`；
  - 禁语扫描零命中（模型面三载体：value / render / 错误信封）；
  - 错误不回显绝对路径、不泄漏短语清单。
- 失败 → 记台账，修复后**同轮重跑 T4+T5**（闭环，不带病过夜）。

### T6 回写台账

- 更新 §三 backlog 状态、§五轮次记录（轮号 / 切片 / 结果 / 新缺陷 / 提交号）。
- 新缺陷定级：**P0** 破纪律（禁语 / 直写包 / 绕闸门）> **P1** 功能坏 > **P2** 打磨。
- 若本轮发现 experience-loop.md 规格错误：先改 spec 再继续——规格与实现同轮回写。

### T7 提交

- 按 §六拍板的提交策略执行；提交信息对齐仓库惯例（`fix:` / `feat:` / `docs:`）。
- 台账行与代码同提交（进度可回放）。

## 三、Backlog（P1→P2→P3 切片表）

| # | 期 | 切片 | 出口判据 | 状态 |
|---|---|---|---|---|
| P1-1 | P1 | `experience.ts`：TaskSignature 生成（纯函数 + 单测） | aml 场景卡可机械导出，digest 稳定 | **完成**（轮 1） |
| P1-2 | P1 | ExperienceNote 落盘（围栏 + 校验 + 单测） | `experiences/` 读写过 runId 围栏 | **完成**（轮 2） |
| P1-3 | P1 | 结构检索：打分 + 阈值 + top-k + 冷启动 | 检索剧本：A→B 复用、C 冷启动 | **完成**（轮 3） |
| P1-4 | P1 | DiffTable 机械生成 + 差异修正双路（LLM / 启发式） | unknown → 转人工路径有测试 | **完成**（轮 4） |
| P1-5 | P1 | 闸门复用接线 + CLI `exp` 子命令 | `exp recall` / `annotate` / `diff` 可用 | **完成**（轮 5） |
| P1-6 | P1 | 验收基准三轮 A/B/C（`examples/aml-run.json`） | `runs compare` 出 delta；C 不硬迁移 | **完成**（轮 6，P1 收官） |
| P2-1 | P2 | 人审回填（misTransfer / reviewFocus）+ workbench 经验视图 | 浏览器可见经验列表与标注 | **完成**（轮 7） |
| P2-2 | P2 | agent 工具 `recall_experience` 等（过三出口） | NL 剧本 N4 全绿 | **完成**（轮 8） |
| P2-3 | P2 | `DraftProvenance.runId` + 草案溯源人审面 | 知识库队列可见 runId | **完成**（轮 9） |
| P2-4 | P2 | med 包多域验证（换包零改引擎） | aml+med 全场景批量过装配断言 | **完成**（轮 10，P2 收官） |
| P3-1 | P3 | 自动技能抽象草案（DraftCandidate targetKind=SkillTemplate） | 高频聚簇 → 草案 → 人审 → 物化全链 | **完成**（轮 11） |
| P3-2 | P3 | 反例利用（ExclusionRule / RedLine 草案） | counterexample 聚簇出草案 | 待办 |
| P3-3 | P3 | 压缩 / 遗忘策略（字段够算 + 保留分层） | 压缩比指标可出 | 待办 |

（P1-1 起即开；每轮 T1 从上表取片。全片完成 = experience-loop.md 达 delivered。）

## 四、真实测试剧本（固定复用）

### 浏览器剧本（B）

| 步 | 内容 |
|---|---|
| B1 | dev-web 启动 → 侧栏 dsh-onto → 五 tab 全开 |
| B2 | 选中 aml-analysis@1.0.0 → 场景运行 `examples/aml-run.json` → SCN-AML-FIND-CLUES |
| B3 | 断言：候选 / 证据链 / 审计 / 人审字段齐全；运行记录列表；两轮对比表 |
| B4 | （P2 起）经验视图：ExperienceNote 列表、标注、误迁移标记可见 |

### NL 对话剧本（N）

| 步 | 内容 |
|---|---|
| N1 | 新会话 → agent 调 `run_scenario`（数据同 aml-run.json） |
| N2 | 断言：content 含 ruleId / 证据链 / `humanReviewRequired=true`、禁语 0 |
| N3 | `run_scenarios` 批量 → `compare_runs` → `export_audit` |
| N4 | （P2 起）调 `recall_experience` → 只回结构位、无自由流程、低置信度转人工话术 |

## 五、轮次记录台账

| 轮 | 日期 | 切片 | T3 | T4 | T5 | 新缺陷 | 提交 |
|---|---|---|---|---|---|---|---|
| 11 | 2026-11-07 | P3-1 自动技能抽象 | ✓ 141/141 + FULL-CHAIN PASS | ✓ 抽象草案+runId 可见 | ✓ N1–N3 | D3 exp abstract knowledge root 派生（当场修） | 本轮提交 |
| 10 | 2026-11-07 | P2-4 med 多域验证 | ✓ 139/139 + MULTI-DOMAIN PASS | ✓ med 场景+六 tab | ✓ N1–N3（med 域） | 无 | 29a232a |
| 9 | 2026-11-07 | P2-3 DraftProvenance.runId | ✓ core 139/139 + dump 2/2 | ✓ runId 可见+B2B3 | ✓ N1–N3 | 无 | 920e258 |
| 8 | 2026-11-06 | P2-2 recall_experience 工具 | ✓ backend 125/125 + dump 2/2 | ✓ 六 tab+B2B3 | ✓ N4 全绿 | 无 | 15e8350 |
| 7 | 2026-11-06 | P2-1 人审回填+经验视图 | ✓ core 138/138 + backend 124/124 + dump 2/2 | ✓ 六 tab+回填链路 | ✓ N1–N3 | 无 | e1a4344 |
| 6 | 2026-11-06 | P1-6 验收三轮 A/B/C | ✓ 136/136 + ACCEPTANCE PASS | ✓ B1–B3 | ✓ N1–N3 | 无 | 33b9bbb |
| 5 | 2026-11-06 | P1-5 CLI exp + 闸门接线 | ✓ 136/136 + CLI 冒烟正/负例 | ✓ B1–B3 | ✓ N1–N3 | 无 | 703dc06 |
| 4 | 2026-11-06 | P1-4 DiffTable+差异修正双路 | ✓ 136/136 | ✓ B1–B3 | ✓ N1–N3 | 无 | a8596dc |
| 3 | 2026-11-06 | P1-3 结构检索 | ✓ 132/132 | ✓ B1–B3 | ✓ N1–N3 | 无（跨包阈值设计缺口已当场修+同步 spec） | 5fc0948 |
| 2 | 2026-11-06 | P1-2 ExperienceNote 落盘 | ✓ 127/127 | ✓ B1–B3 | ✓ N1–N3 | 无 | 681d527 |
| 1 | 2026-11-06 | P1-1 TaskSignature | ✓ 122/122 | ✓ B1–B3 | ✓ N1–N3 | D1 相对 datasetPath baseDir；D2 dev-web 需原生 Node（已入 T4 前置） | b667fe0 |

**P1 收官记录（轮 6）**：验收基准三轮全过——A 冷启动（首跑无经验）→ B 复用命中 score=1.0、
`runs compare` 出 delta（CAND-001 −0.175，FANOUT 命中消失）→ C（fork 1.0.1 收窄 scoreRefs +
数据跨档 S→M）冷启动不硬迁。experience-loop.md [S7] P1 出口达成；**下一片起进入 P2**
（人审回填 → workbench 经验视图 → agent 工具面 → med 多域）。

**P2 收官记录（轮 10）**：多域验收 MULTI-DOMAIN PASS——aml（run-acdc64f3，3 候选）与
med（run-fd0a7117，2 候选）装配断言全过；同域复用命中 score=1.0、跨域冷启动隔离、
二域各自同域复用均成立；换包零改引擎。experience-loop.md [S7] P2 出口达成；
**下一片起进入 P3**（自动技能抽象草案 → 反例利用 → 压缩/遗忘）。

**轮 1 缺陷台账**

| # | 级 | 现象 | 处置 |
|---|---|---|---|
| D1 | P2 | `run_scenario` 的 `datasetPath` 传相对路径（`examples/aml-run.json`）报「无法读取」；绝对路径被围栏拒（设计如此）。会话 cwd 与平台 cwd 不一致时相对路径无处解析 | 待拍板：相对路径 baseDir 改为会话工作区，或错误提示直接给内联示例 |
| D2 | P2 | dev-web 在 MiMo 运行时 node 下启动失败（Electron V8 指纹被拒） | 已修协议：T4 前置原生 Node + pnpm 路径 |
| D3 | P2 | `exp abstract` 的 knowledge 队列 root 与 backend dataDir 不一致（workspace/knowledge vs dataDir/knowledge），草案入错队列 | 已修：abstract 按 workspace 布局派生 dataDir=dirname(workspace)；输出 knowledgeRoot 供核对 |

## 六、拍板记录

| 项 | 拍板 | 日期 |
|---|---|---|
| 循环间隔 | 1 小时（`0 */1 * * *`） | 2026-11-06 |
| 提交策略 | 每轮自动提交，不推送 | 2026-11-06 |
| 分支 | `master` | 2026-11-06 |
