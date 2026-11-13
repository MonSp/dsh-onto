# AGENTS.md

dsh-onto 是**业务本体建模平台**（架构与规则见 [docs/architecture.md](docs/architecture.md)，自包含），
以 dsh plugin bundle 形态承载：`backend/`（@dsh-onto/backend 统一后端 wire 服务）、
`workbench/`（@dsh-onto/workbench Web UI）、`core/`（@dsh-onto/core 纯引擎库 + CLI，零 harness 依赖）。
示例业务本体包在 `packages/`（aml/1.0.0、med/1.0.0、tax/1.0.0），场景样例在 `examples/`。

## 不可违背

- **deepseek-harness 只读**：不改 `../deepseek-harness` 一行代码。harness 依赖用 **`link:`**
  指向物理路径（共享 cordis 模块实例；`file:` 会破坏 Service 身份）。
- **判定在规则引擎，认定在人工**：打分只在 `core/src/rules.ts`；输出恒 `humanReviewRequired=true`；
  知识库原料永不直写包，approved 后才物化；结论性表述只落红线禁语。
- **ISSUED 只读**：签发端点仅人工（issuedBy 不得为 agent/llm）；改须 fork 新版本。
- **派生防漂移**：manifest 指纹 + sourceDigest；手改派生物 → `DERIVED_DRIFT` 拒绝加载。
- **bundle 纪律（同 Investigator）**：全部 TypeScript + tsc 构建（`dist/` 不入库）；
  backend 只 named `apply`（禁止 default export 混用）；client 零 runtime import/export
  （classic script，React 经 factory `require`）；client `inject` 列全 `remote.dsh-onto*` 命名空间；
  跨 bundle 只走 cordis 服务注入；文案双语内联 `ctx.locale.register`（zh/en 字典在 client.ts）。
- **新版本目录解析**：workspace `packages/<name>/<version>/`；目录键与 meta.name 不一致时
  `PackageWorkspace.versionDir` 按 meta.name 扫描回退。

## 验证阶梯（改动后必跑）

1. `core`：`pnpm run build` + `node --test tests/*.test.mjs`（146 项验收测试全绿）。
2. `backend` / `workbench`：`pnpm install`（依赖变化时）+ `pnpm run build` +
   `node --check dist/index.js dist/client.js`；backend 另跑 `pnpm run test`
   （agent 工具/技能纯函数，138 项全绿，含 attack-surface 不变量表——防线改动必须全表重放）。
3. `scripts/dump-config.ps1` — 硬断言 `@dsh-onto/backend`、`@dsh-onto/workbench` 均在组合结果中。
4. `scripts/dev-web.ps1` 启动 → 浏览器冒烟（可 Tabbit）：侧栏「dsh-onto」→ 五个 tab
   （包管理/建模/知识库/校验派生/场景运行）；选中 aml-analysis@1.0.0 → 场景运行
   用 `examples/aml-run.json` 跑 SCN-AML-FIND-CLUES，候选/证据链/审计/人审字段齐全。
   再开一个会话让 agent 调 `run_scenario` 工具（数据同上），工具结果含 ruleId/证据链/
   humanReviewRequired=true、禁语扫描零命中。
   重启前先杀 3080 旧监听；Tabbit 用 `localhost:3808`/`localhost:3080`（勿用 127.0.0.1）。
5. 运行历史与审计留痕冒烟（run-insight）：`examples/aml-run.json` 两轮运行（第二轮 fork
   改权重）→ `compare_runs`（或 CLI `runs compare`）出命中增删与分数 delta →
   `export_audit` 落盘 `runs/exports/` 且人审面含 ruleId/证据链/审计项 → 工具 content +
   render 禁语零命中 → `run_scenarios` 批量 aml+med+tax 全场景过装配断言 → workbench
   场景运行 tab 运行记录/两轮对比/导出 locator 可见。

## 核心模块地图（core/src/）

| 文件 | 职责 |
|---|---|
| `types.ts` | O1/O2/O3 模型类型、运行时、知识库草案 |
| `ids.ts` | ID 语法 `<TYPE>-<TAG>-<NAME>` / `dict-<slug>` / `OBJ.attr` |
| `store.ts` | 包存储 + 签发状态机（DRAFT→IN_REVIEW→ISSUED）+ 导入导出 |
| `validate.ts` | 校验全规则（引用闭合/权重/字典/事件/属性）+ 质量分 |
| `derive.ts` / `loadgate.ts` | 派生链 + manifest 指纹 + DERIVED_DRIFT 门禁 |
| `rules.ts` | 表达式求值（无 eval）+ 排除→打分 |
| `scenario.ts` / `audit.ts` | 六槽位派发 + 三层闭合审计 + 禁语扫描 |
| `runstore.ts` | RunRecord 运行留痕（runs/ 落盘 + phrase 持久后端）+ 两轮对比 + 审计归档 |
| `experience.ts` | TaskSignature/ExperienceNote 结构检索 + 差异表 + 人审回填 + 抽象巩固/压缩（经验闭环） |
| `knowledge.ts` / `llm.ts` | 六类原料解析（含 CONVERSATION 对话轮次）、人审队列、物化（含修改/接线与权重归一）、对话草案与骨架门（I6）；HeuristicLlm / DeepSeekLlm |
| `graph.ts` | 图谱构建（画布数据源）、issue 节点定位（I3）、场景 refs 全链路边（v0.2.1） |
| `subgraph.ts` | 子图扩展 `expandEntity`：种子 BFS 邻域闭包 / 诱导子图 / truncated（subgraph-expansion S3） |
| `features.ts` | 特征投影 `projectFeatures` + 派生 `deriveFeatures`（since/count/ratio，now 注入确定性，S4） |
| `cli.ts` | `dsh-onto package/validate/derive/gate/run/runs/knowledge/exp` |

## 常见故障

- **wire 调用 404**：backend 同时有 default export + named `apply` → loader 丢弃 apply。
- **wire 新方法 `api.X is not a function`**：`backend/src/client.ts` 的 `allDescriptors`
  是手工描述符表，新增 `@Remote` 方法必须同步登记（并重启 dsh host），否则客户端命名空间不可见。
- **`cannot get property without inject`**：client `inject` 缺 `remote.ontoXxx`。
- **后端找不到数据目录**：`profileContext.dir` 不可用（不在 dsh profile 里跑）。
- **pnpm overrides 位置**：`pnpm-workspace.yaml`（不读 package.json `pnpm.overrides`）。
