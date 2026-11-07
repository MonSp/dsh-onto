# 闭环打通迭代循环方案（方案→开发→自测→NL 真实验证→反馈出下一轮）

> 目标：打通「对话建模 → 构建业务专家 → 经验沉淀提升专家」断链。
> 分支 `feat/closed-loop`；每轮协议见 §二；**循环驱动 = NL 真实验证反馈**（§四），
> 不是文档想象。验证口径恒为 AGENTS.md 验证阶梯 + §四真实剧本。
> **本文件是执行源与唯一进度事实源**——新会话读本文件即可续跑，不需要聊天历史。

## 一、循环定位

- **不是任务书一次性交付**：每轮 = 一个可验收切片（≤ 半天），切片过三道真实关：
  ① 代码验证阶梯 ② 浏览器冒烟 ③ **自然语言对话验证**（模拟真实用户说话，禁止直接下工具指令）。
- **验证反馈是需求源**：NL 对话里用户视角的困惑 / 断链 / 繁琐操作，直接决定下一轮切片——
  backlog 顺序可被反馈重排（T6 回写）。
- **台账是唯一进度事实源**：轮次记录、缺陷、拍板全在本文件。

## 二、每轮协议（tick protocol）

### T1 选片 + 定本轮「NL 验证剧本」

- 优先级：① 台账「已拍板待修」> ② 上轮 NL 验证反馈出的新方案 > ③ §三 backlog 下一未完成片 > ④ 用户新指示。
- 切片 = 可独立验证的最小改动；禁跨片大爆炸。
- **本轮 NL 剧本在 T1 就定**（§四模板）：写 2–3 句自然语言用户台词 + 期望闭环行为。

### T2 开发

- 恒守 AGENTS.md 不可违背四条 + tool-face-policy 三出口。
- 新工具须：`humanApproved` 契约（人审类）、ONTOOL_NAMES 登记、`allDescriptors` 登记、双语内联。
- **经验只提示不改分**：任何「经验提升专家」改动不得触碰 `core/src/rules.ts` 打分语义。

### T3 验证阶梯（按改动面裁剪，恒不跳级）

1. `core`：`pnpm run build` + `node --test tests/*.test.mjs`
2. `backend`：`pnpm run build` + `pnpm run test`（attack-surface 全表重放）+ `node --check dist/index.js dist/client.js`
3. `workbench`：`pnpm run build` + `node --check dist/client.js`
4. `scripts/dump-config.ps1`（2/2 硬断言）

### T4 浏览器冒烟（改动涉及 workbench 时跑）

- 环境前置：原生 Node `%LOCALAPPDATA%\Temp\nodejs24\node-v24.22.2-win-x64`、
  pnpm `%LOCALAPPDATA%\pnpm\.tools\pnpm\11.28.5\bin`；先杀 3080 旧监听；
  Tabbit 用 `localhost:3808` / `localhost:3080`（勿用 127.0.0.1）。
- `scripts/dev-web.ps1` 启动；断言改动涉及的 tab 行为。

### T5 真实 NL 对话验证（每轮必跑，闭环核心）

- 开**真实会话**（新对话，不是当前开发会话），**只用自然语言说话**——
  禁止「请调用 recall_experience」这类工具指令；用户台词见 T1 定的剧本。
- 断言闭环行为（对照 §四）：用户没提工具名，agent 自己选对工具；输出含
  ruleId / 证据链 / `humanReviewRequired=true`；禁语零命中；错误不泄路径。
- **反馈收集（决定下一轮）**：记录——哪一步需要用户多嘴 / 多次点头 / 换 tab；
  agent 是否漏了该自动做的事（如没召回经验、没提接线）；输出是否回答了用户真实问题。
- 失败 / 断链 → 记台账缺陷（P0 纪律 / P1 功能 / P2 打磨），修复后同轮重跑 T5。

### T6 反馈出下一方案

- 把 T5 反馈改写成**下一轮切片**（可新增、可重排 §三 backlog）。
- 更新台账：轮号 / 切片 / NL 剧本与结果 / 新缺陷 / 反馈→下轮方案 / 提交号。
- 若规格错误：先改 spec 再继续。

### T7 提交

- 每轮自动提交不推送（`feat:` / `fix:` / `docs:`），台账与代码同提交。

## 三、Backlog（初始切片，可被 T5 反馈重排）

| # | 切片 | 出口判据 | 状态 |
|---|---|---|---|
| E1-1 | `invoke_expert` 执行前自动 `retrieveSimilar`，expert 包络附 experience 只读提示段（coldStart/hits 含 reviewFocus/advice） | NL：用户只说「跑一下反洗钱专家」，输出自带经验参考段；打分与不召回逐字段一致 | **完成**（轮 1，含 D1 当场修） |
| D2 | run/invoke 工具描述 + `datasetPath` 参数描述 + 读取失败信封指明样例数据位置（dsh-onto 检出目录 examples/，读取后 dataset 内联） | NL：「最新那批数据」定位不再盲目翻目录，agent 从描述直接得知检出目录位置 | **完成**（轮 2，含 D2a 当场修） |
| E1-2 | `recall_experience` hits 投影补 `reviewFocus`（过 value/render 闸） | NL：用户问「上次类似的跑得怎么样」，回答含下轮复核提示 | **完成**（轮 3） |
| E1-3 | SkillTemplate 物化接线：append 新 SKL id 到对应场景 `pipeline.skillRefs` | NL：用户批准经验模板草案后问「专家现在会什么」，skills 含新 id | **完成**（轮 4，含 D6 当场未修→下轮） |
| E2-1 | `abstract_experience` 工具（humanApproved，聚簇草案入队，结构位回执） | NL：用户说「最近这些成功经验总结一下」，agent 聚簇入队并让人审 | **完成**（轮 6，含 D7 当场闭环验证） |
| E2-2 | reviseDiff 接生产（可选）：recall top-1 走双路修正 + 转人工闸 | NL：差异大时 advice 明确「转人工」而非硬复用 | 待做 |
| E3-1 | 操作简化：画布节点内嵌批准/驳回；draft_elements 批量 apply | NL 建模对话中点头次数减少（台账记录前后对比） | 待做 |

## 四、NL 验证剧本模板（真实用户口吻，非工具指令）

**原则**：台词像业务人员说话，不出现工具名 / 字段名 / 「请调用」。

| 轮 | 用户台词（自然语言） | 期望闭环 |
|---|---|---|
| E1 | 「用反洗钱包跑一下最新那批数据，看看有没有问题」「上次类似的场景你们是怎么处理的」 | agent 自动 invoke_expert + 召回经验；输出含经验参考段与 reviewFocus |
| E1 | 「这次跑完了，结论是分析成功，复核时注意一下那个集中转入的特征」 | agent annotate 成功 + reviewFocus；不再需要用户指工具 |
| E1 | 「把这些成功经验里反复出现的做法，做成正式的方法论吧」 | agent 聚簇出 SkillTemplate 草案入队，提示人审；批准后专家技能可见 |
| E2 | 「这个场景以前是不是踩过坑？」「那这次执行要注意什么」 | 反例/误迁移不参赛；advice 给出边界提示 |
| E3 | 「给我建个税务风险的新包」「对象是发票和申报表」「场景就是查虚开发票」 | 建模对话点头次数少；画布可直接批准 |

**断言点**（每轮按剧本裁剪）：agent 自选工具正确；`humanReviewRequired=true` 在场；
禁语扫描零命中；不硬迁移（冷启动明说）；用户无需重复上下文。

## 五、台账（轮次记录）

| 轮 | 日期 | 切片 | NL 剧本 | 结果 | 新缺陷 | 反馈→下轮方案 | 提交 |
|---|---|---|---|---|---|---|---|
| 1 | 2026-11-08 | E1-1 invoke 自动召回经验入包络 | 「用反洗钱专家跑一下最新那批数据，看看有没有问题」（两轮） | ✓ backend 141/141 + dump 2/2；T4 裁剪（未改 workbench）；T5 首轮：agent 自选 invoke_expert、经验参考段在场（run-83450578 命中 score=1.00 + advice + humanReviewRequired）、ruleId/证据链齐、禁语 0；修复后重跑全绿且 RunRecord 落盘 | D1（P1，当场修）：invoke_expert 不落 RunRecord → export_audit not found（agent 自己发现并绕过 run_scenario 重跑留痕）；D2（P2）：「最新那批数据」定位摩擦——agent 花 ~20 步翻目录才找到 examples/aml-run.json | 下轮优先 D2：数据集发现引导（invoke/run 工具描述或技能提示样例数据位置，或列平台数据目录的只读入口）；再进 E1-2 | 3263373 |
| 2 | 2026-11-08 | D2 数据集发现引导（run/invoke 描述 + datasetPath 参数 + 读取失败信封指明 examples/ 位置） | 「用反洗钱专家跑一下最新那批数据，看看有没有问题」→「这次跑完把结论记一笔，复核时重点看集中转入特征」 | ✓ backend 142/142（+D2 回归测试）+ dump 2/2；T4 裁剪（未改 workbench）；T5 重跑绿：描述引导生效（agent 思考直接点名 dsh-onto checkout examples/aml-run.json，~14 步定位 vs 轮 1 ~20 步）、自选 invoke_expert（run-39af3f64）、经验参考段在场（run-83450578 score=1.00 + 结构同构提示）、annotate 26s 自选落 reviewFocus 三项、humanReviewRequired=true 恒在、禁语 0、打分与轮 1 逐字段一致（0.906/0.0188/0.080）、D1 留痕修复复验通过（专家 run 可 export_audit） | D2a（P2，当场修）：初版描述误写「会话工作区 examples/」（实际在 dsh-onto 源码检出目录，会话工作区是 default-workspace），agent 找不到卡在提问——改为「dsh-onto 源码检出目录」后重跑通过；D3（P2，新）：agent 中途调 plugin_manager 触发 danger-full-access 审批打断（非必要调用）；D4（P2，新）：「最新那批」语义仍让 agent 花数步确认没有更新批次（读昨日报告+比对 digest 才定） | 下轮进 E1-2（recall hits 补 reviewFocus）；D3/D4 记 backlog 可选：工具面收窄 plugin_manager 暴露、run 记录/数据集「最新」只读查询入口 | 本轮提交 |
| 3 | 2026-11-08 | E1-2 recall hits 投影补 reviewFocus（projectRecallHits 纯函数 + render 复核提示 + 工具描述） | 「上次类似的跑得怎么样？」 | ✓ backend 144/144（+2 E1-2 回归）+ node --check + dump 2/2；T4 裁剪（未改 workbench）；T5 绿（单轮 ~20s/8 步）：agent 自选 recall_experience（先 list_packages 定位包，思考明确「That's the designed tool for 上次类似的跑得怎么样」）、工具输出含 **复核提示[RULE-AML-SCORE-FANOUT, inboundCount, OBJ-AML-TXN.amount]**（E1-2 新路径）、score=1.00/字段对照/humanReviewRequired=true 齐、最终回答点名 reviewFocus 三项、禁语 0、无路径泄漏 | D5（P2，新）：模糊问题「上次类似的」需先 list_packages+翻报告+查 runs 目录（~6 步）才落到 recall——可加 recall 默认上下文提示或「最近经验」只读入口；无 P0/P1 | 下轮优先 E1-3（SkillTemplate 物化接线：批准后 append SKL 到 pipeline.skillRefs）；可选做 D5（recall 发现摩擦）、E2-1（abstract_experience） | 2918dcc |
| 4 | 2026-11-08 | E1-3 SkillTemplate 物化接线（resolveSkillWireTarget + appendSkillRef；abstractSkillDrafts 带 scenarioId；materialize catch 回滚） | 「把这些成功经验里反复出现的做法，做成正式的方法论吧」→「专家现在会什么？把反洗钱专家的技能列出来」→「知识库里那条经验模板的待审草案，我批准了，把它物化进反洗钱包」→「现在专家会什么？技能列表再看一遍」 | ✓ core 149/149（+3 E1-3 回归）+ backend 144/144 + workbench node --check + dump 2/2；T4 裁剪（未改 workbench UI）；T5 四轮：批准后物化 **SKL-AML-EXP-FIND-CLUES** 落盘、场景 s5 skillRefs=NARRATIVE+EXP-FIND-CLUES（E1-3 接线 ✓）、list_experts 技能 1→2 且回答点名新 id、草案 merged/appliedAs 齐；期间 DERIVED_DRIFT 被 agent 自发现并 CLI derive 修复（gate ok） | D6（P1，新）：apply_draft 物化只写源文件不重派生 → 包立刻 DERIVED_DRIFT 不可读；agent 被迫 danger-full-access 跑 CLI derive 才恢复（审批打断 1 次）；D7（P2，新）：「做成正式的方法论」引导 agent 写工作区 methodology 文档而非走 SkillTemplate 草案链路（缺 E2-1 abstract 工具 + 草案发现入口）；D8（P2，新）：get_model_graph 摘要不回待审草案 id，agent 只能读 queue.json（绕过工具面） | 下轮优先 D6：apply_draft 成功后自动 derive（或注册 derive 工具免提权）；再进 E2-1（abstract_experience）；可选 D7/D8（草案发现面） | 本轮提交 |
| 5 | 2026-11-08 | D6 物化后自动重派生（KnowledgeStore.materialize：savePackage 后 applied>0 即 derivePackage；apply_draft 描述告知「无需再手动 derive」） | 「知识库里新来了两条待审的红线草案，我批准了，把它们物化进反洗钱包」→「物化完了？反洗钱专家现在还能正常用吗，把它的技能列出来看看」→「用反洗钱专家跑一下最新那批数据，看看有没有问题」 | ✓ core 150/150（+1 D6 回归：物化后 verifyDerived 过闸）+ backend 145/145（+1 apply_draft 描述源断言）+ node --check + dump 2/2；T4 裁剪（未改 workbench）；T5 三句全绿（04:21–04:26，3 轮 38 步，零审批打断）：同批物化 2 条 RedLine → **自动重派生**（agent 原话「已自动重新派生」；盘上 gate ok、manifest 20:22:32 重写、forbiddenPhrases 4→6）；list_experts 技能 2 个且主动试跑 run-12d85501；invoke run-bc6f9715 审计过、分数与轮 1–3 逐字段一致（0.906/0.019/0.080）、禁语 0 命中、humanReviewRequired=true、无路径泄漏；数据定位直接点名检出目录 examples/aml-run.json（D2 引导仍有效） | D9（P2，新）：新红线是整句精确匹配，短语级词（涉案账户/跨境赌博）不带整句扫不到——agent 两轮自提示建议收窄为短语级或双通道；D10（P2，新）：第 3 句 invoke 最终回答未转述经验参考段（第 2 句 run 有转述；E1-1 包络可能在工具面但用户视角弱）；无 P0/P1，D6 关闭 | 下轮优先 E2-1（abstract_experience 聚簇入队人审）；可选 D7/D8（草案发现面）、D9（红线短语级口径）、D5（recall 发现摩擦） | 本轮提交 |
| 6 | 2026-11-08 | E2-1 abstract_experience（abstractExperienceForTool + renderAbstractText + ONTOOL 登记；humanApproved 契约；只入队不直写包） | 「最近这些成功经验总结一下，看看能不能沉淀成正式的方法论」→「总结出来的东西现在是什么状态？反洗钱专家现在能用上吗，把它的技能列出来看看」 | ✓ backend 148/148（+3 E2-1 回归：契约/聚簇入队/渲染/源断言）+ node --check + dump 2/2；T4 裁剪（未改 workbench）；T5 两句全绿：第 1 句 agent 思考原文点名工具描述「总结成功经验 / 沉淀方法论」（**D7 闭环**——不再写工作区 methodology 文档）、humanApproved=true、自选 abstract_experience 跑 aml+scf；aml 回执 **dc-7f40d1ec… status=merged 簇员=3 代表 run-83450578**、scf ISSUED 正确拒；第 2 句 list_experts 技能 2 个（SKL-AML-EXP-FIND-CLUES + SKL-AML-NARRATIVE）、get_model_graph 待审 0、诚实指出「聚簇结论有了正文没变」并给出 draft_elements→apply_draft 人审下一步；humanReviewRequired 在场、禁语 0、最终回答无服务端路径泄漏；本轮未跑场景（打分断言 N/A） | D11（P2，新）：包/经验发现摩擦——agent 为定位 packageId 花大量步 glob/pwsh/get_package，最终 ask_user_question 要用户多选（阻塞式问题在 API 会话难自动应答）；缺「哪些包有成功经验」只读入口；D13（P2，新）：幂等回执 status=merged 但不更新技能正文，用户期望「沉淀成方法论」时有落差（agent 自察并建议 draft_elements update）；无 P0/P1，E2-1 关闭 | 下轮优先 D11：abstract 可省 packageId 扫全库非 ISSUED 有经验包，或新增 list_experiences 只读入口（顺带缓解 D5/D8）；再进 E2-2（reviseDiff 接生产）或 D13（merged 草案 update 通道）；可选 D9/D10 | 本轮提交 |
| 7 | 2026-11-08 | D11 abstract 省 packageId 扫全库（packageId 可选 + 扫描模式：有经验非 ISSUED 包入队、ISSUED 记 skipped 不整单失败 + 逐包回执渲染 + 描述引导「不必先追问包名」） | 「最近这些成功经验总结一下，看看能不能沉淀成正式的方法论」→（人审提问选「先不物化，留队列」）→「总结出来的东西现在是什么状态？反洗钱专家现在能用上吗，把它的技能列出来看看」 | ✓ backend 151/151（+3 D11 回归：扫全库入队/ISSUED 跳过/渲染/源断言）+ node --check + dump 2/2；T4 裁剪（未改 workbench）；T5 两句全绿：第 1 句 agent 思考原文 **「Use abstract_experience with packageId omitted, humanApproved=true」**（D11 核心断言——零包名追问、零 glob 翻目录，直接省略参数扫全库）、回执「候选经验包 1 个」+ dc-7f40d1ec… status=merged + humanReviewRequired=true、首句 2分04秒完成（轮 6 同句需多选打断）；第 2 句状态分层表 + 技能清单 2 个（SKL-AML-EXP-FIND-CLUES/SKL-AML-NARRATIVE）+ 诚实指出「merged 草案批准与否专家行为不变」；禁语 0、无路径泄漏；零审批打断（plugin_manager 未复现） | 无新 P0/P1；D11 关闭。D13 复现观察（非新缺陷）：两轮回答均强调「merged 不更新正文、批准差异很小」——落差仍在。环境观察：发送脚本误重跑导致第 2 句台词重复发了一次，agent 两次回答均绿（非产品缺陷） | 下轮优先 D13（merged 草案 update 通道：abstract 幂等回执时提供正文更新路径，消「沉淀成方法论」落差）；再进 E2-2（reviseDiff 接生产）；可选 D9/D10、E3-1 | 本轮提交 |

**轮 1 反馈细节（T5 收集）**：
- 需要用户多嘴/多次点头：无——一句台词 agent 全程自选工具；但数据定位阶段 agent 长时间自主翻目录（用户视角等待 ~5min46s 才出结论）。
- agent 漏做：首轮漏留痕（D1，已修）；其余未漏（自动 invoke + 自动召回经验段都在场）。
- 输出回答真实问题：是——除跑分外主动给出数据质量矛盾清单（同账户冲突/特征不可复算/listHitCount 无源），并产出报告文件。
- 打分一致性：两轮同数据打分完全一致（0.906/0.019/0.080），经验段只提示未改分。

**轮 2 反馈细节（T5 收集）**：
- 需要用户多嘴/多次点头：一次——中途 `plugin_manager` 触发 danger-full-access 审批（D3，agent 非必要调用），点了「允许一次」；其余两句台词全程 agent 自选工具。
- 定位摩擦对比：轮 1 ~20 步盲目翻目录；轮 2 描述引导下 ~14 步且**有明确目的地**（思考直接引用「dsh-onto checkout examples/aml-run.json」），首步即调 working_directory/list_packages 而非乱搜。但「最新那批」语义仍需读昨日报告 + 比对 digest 才能确认没有更新批次（D4）。
- agent 漏做：无——invoke 自动经验段、RunRecord 留痕（D1 修复复验 ✓）、annotate 自选 reviewFocus 均在场。
- 输出回答真实问题：是——除跑分外主动给出三处严重数据问题（同账户矛盾候选/特征不可复算/listHitCount 无源），并发现「集中转入」在现有规则口径中被 FANOUT 乘法项漏掉（有价值的规则缺口反馈）。
- 打分一致性：与轮 1 逐字段一致（0.906/0.0188/0.080），经验只提示未改分。
- 首跑失败教训（D2a）：描述文案必须区分「会话工作区」与「dsh-onto 源码检出目录」——平台三 cwd（会话 workspace / 进程 cwd=harness / 检出目录）不同，写错一个词 agent 就按错位置找。

**轮 3 反馈细节（T5 收集）**：
- 需要用户多嘴/多次点头：无——一句台词 agent 全程自选工具，无审批打断（D3 未复现）。
- 工具选择路径：list_packages →（查 runs 目录空）→ 读昨日报告 → **自选 recall_experience**（思考原文：「That's the designed tool for 上次类似的跑得怎么样」）。约 6 步定位摩擦（D5），但方向正确且最终走对工具。
- E1-2 断言：工具输出含 `复核提示[RULE-AML-SCORE-FANOUT, inboundCount, OBJ-AML-TXN.amount]`（新渲染路径）；最终回答明确转述「上轮沉淀的复核重点（reviewFocus）是…」；humanReviewRequired=true 在场；禁语 0；无错误路径泄漏。
- agent 漏做：无——recall 自选、reviewFocus 上墙、结论回答了「上次类似的跑得怎么样」（含 outcome=partial、分数、数据可信度问题清单）。
- 输出回答真实问题：是——除 recall 结果外还交叉核对了报告与分数，指出 listHitCount 无源等数据问题。
- 与轮 1/2 对比：模糊问法下 agent 仍能收敛到 recall；D5 是发现摩擦不是断链。

**轮 4 反馈细节（T5 收集）**：
- 需要用户多嘴/多次点头：两次——① 物化后 DERIVED_DRIFT 触发 danger-full-access 审批（点了「允许一次」，D6）；② 第一句「做成正式的方法论」agent 走偏写文档（多轮 ~8min），第三句才回到草案批准。最终断言句一次通过。
- E1-3 断言：物化后盘上 `SCN-AML-FIND-CLUES` s5 skillRefs 含 `SKL-AML-EXP-FIND-CLUES`；list_experts 技能列表 2 个且点名新 id、溯源 dc-7f40d1ec…/run-112f768b；草案 status=merged。
- agent 漏做：无最终漏（批准→物化→接线→技能可见全链走到）；但第一句未自动走草案链路（见 D7）。
- 输出回答真实问题：是——技能表含定位/步骤/权重/来源，并主动指出模板内容偏薄、建议是否摘出 s5（有价值的产品反馈）。
- 禁语/打分：本轮未跑场景，禁语与打分断言 N/A（剧本裁剪）。
- 与轮 1–3 对比：工具选择正确（get_model_graph→读 queue→apply_draft→derive→list_experts）；新摩擦集中在**物化后派生断链**与**草案发现面**。

**轮 5 反馈细节（T5 收集）**：
- 需要用户多嘴/多次点头：**零**——三句台词全程 agent 自选工具，无任何审批打断（轮 4 的 D6 提权审批未复现，D3 也未复现）。
- D6 断言：第 1 句 apply_draft 同批物化 2 条 RedLine 后，agent 原话「已自动重新派生，derived/scenario-orchestration.yaml 的 forbiddenPhrases 同步含新两条」；盘上 `gate` ok（manifest generatedAt 与物化时刻一致）、队列两条均 merged；后续 list_experts / invoke 全程无 DERIVED_DRIFT。
- 定位与工具路径：第 1 句直接读知识库队列找到两条 dc-…；第 3 句「最新那批数据」仍需确认无更新批次（D4 未消除但有明确目的地），最终点名 dsh-onto 检出目录 examples/aml-run.json（digest a7977766），用时 2分58秒。
- agent 漏做：无最终漏。第 2 句主动试跑 run-12d85501 做可用性验证（超出最小要求）；第 3 句 invoke run-bc6f9715 留痕。第 3 句最终回答未转述经验参考段（第 2 句有转述「低置信度：结构位差异→转人工」）——记 D10 观察。
- 输出回答真实问题：是——除跑分外给出 6 条分级数据质量问题（listHitCount 无源占 44% 分、特征不可复算、同账户矛盾候选等），并确认新红线 0 误伤。
- 禁语/打分：forbiddenPhraseHits=0（6 条短语在场）；分数 0.906/0.019/0.080 与轮 1–3 逐字段一致（RedLine 物化不改分）；humanReviewRequired=true 两跑均在。
- 新观察（D9）：agent 主动指出新红线整句匹配的口径盲区（「涉案账户」不带整句扫不到），两轮重复建议收窄为短语级——有价值的产品反馈，非断链。

**轮 6 反馈细节（T5 收集）**：
- 需要用户多嘴/多次点头：**一次**——第 1 句 agent 用 `ask_user_question` 要用户多选沉淀包（D11；阻塞式问题，API 会话需开 UI 才能应答）。选定后第 2 句零打断。
- 工具选择路径：思考原文直接引用 abstract_experience 描述「总结成功经验 / 沉淀方法论」（**D7 闭环**：不再写 methodology 文档）；humanApproved=true 推理正确；并行跑 aml + scf 两包。
- E2-1 断言：aml 回执含结构位 `dc-7f40d1ec… / SkillTemplate / status=merged / 簇员=3 / 代表=run-83450578`；scf ISSUED 被工具拒（INVALID_ARGS 提示 fork）；第 2 句 list_experts 技能 2 个且点名 SKL-AML-EXP-FIND-CLUES 与 SKL-AML-NARRATIVE；humanReviewRequired 在场；禁语 0；最终回答无服务端绝对路径。
- agent 漏做：无最终漏。第 2 句额外 get_model_graph 交叉验证待审 0，并主动指出「聚簇结论有了、正文没变」——超出最小要求的诚实反馈。
- 输出回答真实问题：是——状态（merged≠已进正文）、专家能否用（能跑但用的是旧骨架技能）、下一步（draft_elements update → apply_draft 人审）三问都答了。
- 与轮 1–5 对比：新摩擦集中在**包发现**（D11）与**merged 幂等落差**（D13）；工具面本身（契约/入队/拒 ISSUED/渲染）无断链。
- 环境观察：浏览器 `localhost` 解析超时、`127.0.0.1` 正常（与协议「勿用 127.0.0.1」相反，记为本机 DNS 观察，不改协议）。

**轮 7 反馈细节（T5 收集）**：
- 需要用户多嘴/多次点头：**零**（就产品面而言）——第 1 句 agent 直接省略 packageId 扫全库，未出现轮 6 的包名多选拦截；第 1 句末尾的「是否物化」是人审契约正常提问（非 D11 摩擦），选「留队列」后第 2 句零打断。环境侧：发送脚本误重跑导致第 2 句重复一次，agent 两次回答均绿（非产品缺陷）。
- D11 断言：思考原文「Use abstract_experience with packageId omitted, humanApproved=true」——未翻目录、未 glob、未问包名；工具回执「候选经验包 1 个」逐包行 + dc-7f40d1ec… status=merged + humanReviewRequired=true；首句 2分04秒出结论（轮 6 同类请求需多轮定位 + 多选拦截）。
- agent 漏做：无。第 1 句额外交叉验证（get_package/get_model_graph/recall）解释 merged 语义；第 2 句主动给分层状态表 + 技能清单 + 「能跑但结论停在人审前」边界说明，并主动提出可跑 invoke_expert 验证（未擅自跑）。
- 输出回答真实问题：是——「什么状态」答了四层表（经验/草案/包内技能/专家）；「能用上吗」答了「能用既有版、新草案未生效、merged 批准差异小」；技能 2 个含步骤/权重/红线。
- 禁语/路径：禁语 0；最终回答无服务端绝对路径。本轮未跑场景（打分断言 N/A）。
- 与轮 1–6 对比：工具选择与参数面首次做到「零发现摩擦」（D11 关闭）；剩余摩擦收敛到 D13（merged 幂等落差）——两轮回答都主动澄清「批准与否专家行为几乎不变」，说明用户期望的「沉淀成方法论」在正文更新通道上仍断。

## 六、拍板记录

| 项 | 拍板 | 日期 |
|---|---|---|
| 分支 | `feat/closed-loop` | 2026-11-08（轮 1 开） |
| 提交策略 | 每轮自动提交，不推送 | 初始 |
| 经验影响边界 | 只提示不改分（advice/reviewFocus 进包络，不进 rules.ts） | 初始 |
