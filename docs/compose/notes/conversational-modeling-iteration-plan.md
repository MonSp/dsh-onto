# 对话式建模整体迭代方案（压测驱动）

> 依据：C1–C3 完整压测 + C4 骨架阶段（详见 [conversational-modeling-stress.md](./conversational-modeling-stress.md)）；
> 分支 `feat/multi-domain-stress`（8 个提交）。案例测试已叫停，本文是后续迭代的事实源与执行序。
> 验证口径恒为 AGENTS 验证阶梯：core 110 / backend 121 / workbench build+check / dump-config 2/2 / dev-web 冒烟。

---

## 一、压测结论（一段话）

修复前（C1）：新会话误走外部导图技能、逆向读源码 81 步、无建包/骨架工具导致越权直写被拒、
禁语与 update 白名单两道闸拦出 2 次 fork 返工——14 轮才 PASS。修复 D1/D6/D7/D9 后（C2/C3）：
引导技能首步命中、骨架 1 轮定稿、批次首过率 3/5 → 6/6、5/5、端到端 14 → 9 → 7 轮、零驳回零拦截零 fork；
C4 按同一方法论在骨架阶段即挖出结构性缺陷 D13（打分无场景收窄）并当场拍板修复。
**结论：链路已从「能走通」进入「可高效走通」；剩余摩擦集中在开局建包（D3）、
人工链 UI 成本（D11）、与工具面围栏（D12）三处。**

## 二、缺陷台账

### 已修（7 项，已入分支）

| # | 面 | 内容 | 提交 |
|---|---|---|---|
| D1 | 产品+工具 | 新会话误载外部技能 → 内置 `onto-modeling` 引导技能 + `draft_elements` 描述指路 | a1e0337 |
| D6 | 引擎 | 驳回后同名重建被判重 → 幂等只挡 pending/approved/merged，rejected 允许 retry | 5640467 |
| D7 | 引擎 | behaviorRefs/exclusionRefs 只校验不收窄 → 执行器按场景收窄（缺省=全部） | 3210bc3 |
| D9 | 引擎 | update 白名单外字段静默忽略却报 merged → 起草即拒 fail-loud + mustInclude create/update 归一 | 5640467 |
| D10 | 工具 | 起草缺引擎契约说明（mustInclude 五键/模板变量/引用位） → 写入引导技能正文 | a1e0337 |
| D13 | 引擎 | 打分规则无场景收窄、范围外规则刷待核实 → 新增 `scoreRefs`（校验/执行/派生/持久化/图谱边全链） | 8b417a6 |
| D3 | 产品+工具 | 对话建包/存骨架（create_package + save_skeleton：DRAFT 空包同名拒绝、humanApproved 确认契约、ID 语法去重、ISSUED 只读、ONTOOL_NAMES 登记） | 087d630 |
| D5 | 引擎 | CONCLUSION_BLOCKED 只说「只能落 RedLine」→ 三出口内联可执行落法（targetKind + payload.phrases） | 3e9c9d7 |
| D12 | 工具 | datasetPath 围栏（进程 cwd，I3 设计）不可发现 → 参数描述/越界报错明示围栏语义与 dataset 内联恢复路径 | 3e9c9d7 |
| D4 | 产品 | 清单视图不显示待审草案 → 计数+明细+恢复提示（随 reload 刷新） | 3e9c9d7 |
| DOC-1 | 文档 | 骨架提案模板补 SRC/FM 绑定段（预算单列、防误判骨架外新增） | 3e9c9d7 |
| P-1 | 引擎 | 否决件不进人工队列 → `reviewGate.includeExcluded`（缺省 false 兼容；create/update 持久化、坏类型起草即拒） | 8116210 |
| D11 | 产品 | 签发前人工链 ≈8 步 UI → 校验派生 tab「签发前预检」一键串 校验写盘→派生→门禁，全绿提示转人工签发 | 8116210 |
| P-2 | 产品+文档 | v1.1 待办沉淀口径 → 包根 `backlog.md` 附属文件（exportVersion 读面携带、不入 listSourceFiles/派生摘要——改待办零漂移、fork 自动携带）+ 清单视图展示卡 + 引导技能约定 | 8116210 |
| D14 | 引擎 | scoreRefs 圈定后阈值沿用全包 0.75 → 数学不可达（C5 冒烟发现）：`REVIEW_GATE_UNREACHABLE`（error）+ `REVIEW_GATE_TIGHT`（warn >90% 圈内和）；包侧 fork 校准 0.60/0.30 并实证触发 | C5 内修复 |
| D15 | 引擎 | fork 携带上一版本 manifestDigest 锚点 → 签发前预检假漂移（C5 发现）：锚点按版本匹配——门禁忽略异版本旧锚、锚点只回写同版本条目 | C5 内修复 |
| D2残 | 文档 | 引导技能补 targetKind payload 形状速查（起草前对照、省读源码） | 见本轮 |
| — | 文档 | spec 口径同步（update fail-loud、refs 运行收窄、scoreRefs、多场景拍板）、测试计数 110/121 | 5513832, 66b021d |

### 已拍板待修（0 项：D3 已于 087d630 完成并入 PR #5）

### 待拍板（按面分类）

**产品面**

| # | 问题 | 建议 |
|---|---|---|
| D4 | 清单视图不显示待审草案（只有画布有虚线态与计数），走清单人审会误以为无草案 | 清单视图顶部同步「待审草案 N」+分组列出；低风险小改 |
| D11 | fork 修复一轮人工链 ≈8 个 UI 动作（校验/送审/签发人/签发/派生/门禁 ×2 版本往返） | 中期：「签发前一键预检」清单（校验写盘+门禁预跑+派生预演）；签发动作本身保持人工 |
| P-1 | 否决件不进 requireReviewFor（C2 提出） | 属场景输出契约语义：建议 v1.1 增 `reviewGate.includeExcluded` 开关，默认 false 兼容 |
| P-2 | v1.1 待办沉淀方式（各案 agent 自发写 backlog md，位置/格式不一） | 产品化：workbench 包内固定 `v1.1-backlog` 展示区，或知识库预留待办区；先统一约定「包根 backlog 文件」口径 |

**引擎面**

| # | 问题 | 建议 |
|---|---|---|
| D5 | isConclusionLike 对否定式/引用式过命中（C1「不认定骗贷」被拦）；RedLine 正确通道靠 agent 自悟 | 低优先：物化报错文案内联指路「结论性表述请走 RedLine 追加」；词表边界本身**不放宽**（纪律优先，C3 术语换词证明可绕行且体验良好） |
| D8 | fillTemplate 无数值格式化（0.8114000000000001） | 已拍板「接受长尾」（C2 对话中确认），记 wontfix-at-present；若做：模板语法加 `{{riskScore:.2f}}` 类限定 |

**工具面**

| # | 问题 | 建议 |
|---|---|---|
| D12 | run_scenario 文件式 dataset 受进程 cwd 围栏限制，会话内只能内联 | 查 tool-face-policy 的 datasetPath 口径后定：要么白名单放行会话工作区 fixtures 目录，要么工具描述明示「文件式仅限平台工作目录」 |
| D2残 | agent 仍会读 core 源码补 schema/表达式细节（C3/C4 各 ~20-40 步） | 增量：引导技能附「各 targetKind payload 形状速查」+ 工具描述挂关键校验规则；预期骨架轮再省 30% 步数 |

**文档面**

| # | 问题 | 建议 |
|---|---|---|
| DOC-1 | 各案 v1.1 发现 L2 数据源（SRC/FM）不在骨架默认段，接真实数据前必然补 | 骨架提案模板（引导技能正文）加「数据源绑定段（可选 v1.1）」提示，预算表单列 |
| DOC-2 | 本方案与压测记录需随修复滚动更新 | 每合入一项修复：对应台账行打勾 + 计数同步 README/AGENTS（现行纪律） |

## 三、分期执行序

| Phase | 内容 | 验收 |
|---|---|---|
| **P0 已完成** | D1/D6/D7/D9/D10/D13 + spec/计数（8 提交在分支） | 验证阶梯全绿（110/121/2-2） |
| **P1 已完成** | D3 对话建包/存骨架（087d630）：backend 测试 +2（123/123）、attack-surface 全表重放、引导技能与 spec 更新 | 阶梯全绿（110/123/2-2）已验 |
| **P2 已完成** | D4 + D12 + D5 + DOC-1（3e9c9d7；D12 取保守解——不改围栏只补可发现性） | core 111 / backend 124（D5、D12 各 +1 测试）/ workbench build+check / dump-config 2-2 全绿 |
| **P3 已完成** | P-1 + D11 + P-2（8116210；P-2 实现按「包根规范位 + 读面不入摘要」落地，规避改待办触发 DERIVED_DRIFT 的坑） | core 114 / backend 124 / workbench build+check / dump-config 2-2 全绿 |
| **P4 已完成（实测指令）** | 续跑 C4-TAX：6 轮到验收 PASS；特性矩阵（scoreRefs/includeExcluded/D11/D4/P-2/D5 预防）全绿，域码事故经「拒绝直写→工作台 YAML 修复」恢复；详见压测记录 C4 续跑节 | 74/74、0/0、三场景冒烟三重点全过、3 份审计归档、backlog 落盘 |
| **P4 续（遗留待办）** | C5-MIC 全程实测（含 D3 活体首跑）：5+2 轮双版本收口；新发现并当场修复 D14/D15；D2残同步落地；详见压测记录 C5 节 | 68/68、0/0、0.30 闸实证触发、评分 Δ=0、D3 双工具 ✓ |

> 执行依赖：P1 完成后宿主需重启加载新 dist；P0/P1 均不动 harness（只读约束满足）。

## 四、度量基线（供后续修复回归对照）

| 指标 | 基线（修复后 C2/C3） | 目标（P1+P2 后） |
|---|---|---|
| 骨架轮耗时 | 2.7–5.3 分钟 / 1 轮 | ≤3 分钟 / 1 轮 |
| 端到端轮次 | 7–9 | ≤7（P1 再省人工切屏 2 步） |
| 草案批次首过率 | 100%（6/6、5/5） | 保持 100% |
| 骨架外越界 | 0 | 0 |
| agent 补课读源码步数 | 骨架轮 ~10–28 步 | ≤10 步（D2残 修复后） |
| fork 返工 | 0（C2/C3） | 0 |

## 五、分支与提交现状

`feat/multi-domain-stress`：15 提交（5 fix / 4 feat / 6 docs），已推送并开 **PR #5**（https://github.com/MonSp/dsh-onto/pull/5）；P0–P4 + 遗留待办（D3 实测/C5/D14/D15/D2残）全部完成；仅 D8 数值格式化维持 wontfix-at-present（长尾已拍板接受）；
C4 的 tax-risk@1.0.0（DRAFT、骨架 74 ID 已确认）与
C1–C3 三个 ISSUED 包留在 dsh profile 数据目录，作为后续 P4 回归夹具。
