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
| E1-2 | `recall_experience` hits 投影补 `reviewFocus`（过 value/render 闸） | NL：用户问「上次类似的跑得怎么样」，回答含下轮复核提示 | 待做（轮 3 优先） |
| E1-3 | SkillTemplate 物化接线：append 新 SKL id 到对应场景 `pipeline.skillRefs` | NL：用户批准经验模板草案后问「专家现在会什么」，skills 含新 id | 待做 |
| E2-1 | `abstract_experience` 工具（humanApproved，聚簇草案入队，结构位回执） | NL：用户说「最近这些成功经验总结一下」，agent 聚簇入队并让人审 | 待做 |
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

## 六、拍板记录

| 项 | 拍板 | 日期 |
|---|---|---|
| 分支 | `feat/closed-loop` | 2026-11-08（轮 1 开） |
| 提交策略 | 每轮自动提交，不推送 | 初始 |
| 经验影响边界 | 只提示不改分（advice/reviewFocus 进包络，不进 rules.ts） | 初始 |
