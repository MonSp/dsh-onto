# 业务插件自助装配指南（配置只读 API → 发布页面与 Agent 同源插件）

> 目标读者：**未参与 `core` / `runtime` 开发**的人。按本文走完「接数 → 映射 → 签发 → 回放 → 生成插件 → 部署 → 双入口验收」，
> 全程**不手写连接器、不改** `core/**`、`runtime/**` 与 harness。卡住的地方填文末卡点表——那就是产品缺口。
>
> 你带来的材料：① 一个**只读 JSON HTTP API**；② 一套**业务口径**（对象/规则/一个场景的本体包，建模路径见
> [user-guide.zh.md](user-guide.zh.md)，本文从「已有 DRAFT 包」开始）。默认路径支持一个只读 JSON API、
> 一个场景、一张结果页、一个 Agent 入口。
>
> 参考素材：`mock-services/wst-api`（结构不同于 TAX 的示例 API）+ `packages/wst/1.0.0`（示例口径包）。
> `apps/tax` 是手写连接器的历史参照，**不必**再照抄。

## 0. 边界（先读）

| 必须 | 禁止 |
|---|---|
| 页面与 Agent 调**同一场景、同一 `sourceId`** | 页面/Agent 各写一套判分逻辑 |
| 打分只在 `core/src/rules.ts`（经 `runScenario`） | 在连接器或 UI 里改分 |
| ISSUED 只读；改动 fork 新版本 | 直接改已签发包 |
| 数据源地址/凭证只来自**部署配置**（env） | 把真实 URL/密钥写进本体包 |
| `humanReviewRequired=true` 恒真 | 把机器分当业务认定 |
| 生成 ≠ 签发，导入 ≠ 激活 | 让生成器/播种脚本冒充人审 |
| 模拟数据标 `simulated` | 把 mock 验收写成真实业务验收 |

## 1. 前置

```powershell
# Node ≥ 24.9；harness 为兄弟目录（仓库根旁 ../deepseek-harness；worktree 经 .worktrees/deepseek-harness junction）
# 验证：必须是独立 Node，不能是带 electron 指纹的嵌入式构建
node -e "console.log(process.version, process.versions.electron ?? 'ok')"
# 期望：v24.x ok；若打印 electron 版本号，dsh web 启动会失败（见卡点 C6）
Test-Path ..\deepseek-harness\package.json   # 从仓库根（或 worktree 根）出发
```

pnpm 可用性（任选其一）：

```powershell
# harness 自带
$env:PATH = "node目录;D:\trunk\Inv\deepseek-harness\node_modules\.bin;$env:PATH"
pnpm -v
```

构建引擎（一次性）：

```powershell
cd core;     pnpm install; pnpm run build; cd ..
cd runtime;  pnpm install; pnpm run build; cd ..
```

以下命令均从**仓库根**执行，`<pkg>` 指你的包版本目录（如 `packages/wst/1.0.0`）。
构建侧工作台（backend/workbench 组合）另有「接入」tab，与下述 CLI 同一口径（采样/预览/生成/回放按钮转发），
可选用；本文以 CLI 为准。

## 2. 形态声明：api-sources 的 `shape`

编辑 `<pkg>/bindings/api-sources.yaml`，给逻辑源声明 **API 形态**（信封/分页）。地址仍不进包：

```yaml
kind: O1ApiSources
sources:
  - id: SRC-WST-CORE
    name: 废物清运查询服务
    sourceType: SCHEMA_API
    endpoint: "api://wst-snapshot"        # 逻辑名，不写真实 URL
    shape:
      mode: snapshot                      # snapshot=单请求多集合；collections=每集合一次 GET
      path: /api/v1/bin-snapshot          # snapshot 模式：单请求路径
      collectionPaths:                    # 集合键 → 响应体点路径
        bins: bins
        routes: routes
        dumps: dumps
        alerts: alerts
      pagination: { mode: none }
```

collections 模式（每集合一次 GET，分页可配）：

```yaml
    shape:
      mode: collections
      collectionPath: "/api/v1/data/{collection}"   # 模板须含 {collection}
      itemsPath: items                              # 响应行字段路径（缺省 items）
      pagination:
        mode: cursor                                # cursor | offset | none
        cursorParam: cursor                         # 可选（缺省 cursor）
        nextField: nextCursor                       # 可选（缺省 nextCursor；空/缺=无下一页）
        # mode: offset 时可配 limitParam/offsetParam/pageSize（缺省 limit/offset/100）
        # completeField: complete                   # 可选；显式 false → 不完整
```

## 3. 接数与映射

### 3.1 采样探字段

```powershell
node core\dist\cli.js source probe --dir <pkg> --url http://127.0.0.1:3912 --samples 50
# 也可离线：--data <样本响应体.json>（snapshot=整包响应体；collections=各集合响应体的键值对象）
# 输出：每集合行数 + 字段名/推断类型/样例值
```

### 3.2 映射（bindings/source-maps.yaml）

```powershell
node core\dist\cli.js source map init --dir <pkg> --url http://127.0.0.1:3912   # 启发式草稿（对象映射）
# 然后手补关系/候选/行为映射，再预览
```

映射语法（`kind: O1SourceMaps`，每条 `id: SM-<TAG>-<NAME>`）：

```yaml
kind: O1SourceMaps
maps:
  # 对象：行 → 对象实例
  - id: SM-WST-BIN
    collection: bins                  # shape 里的集合键
    objectType: OBJ-WST-BIN
    idTemplate: "<binId>"             # <字段> 占位 + 字面分隔（复合 id："<code>:<no>"）
    timeField: lastEmptiedAt          # 可选：业务记录时间（业务窗/时效门）
    fields:                           # 可选：源字段→属性名（缺省同名全映）
      - { source: binNo, target: binNo }
  # 关系：FK 式（数组字段 → 多条关系）
  - id: SM-WST-COVERS
    kind: relation
    collection: routes
    relationType: REL-WST-COVERS
    from: self                        # self=本行对象 id
    to: { field: covers }             # 字段值即对端对象 id
    targetCollection: bins            # 对端集合（断引用定位用）
  # 候选：上游风险信号
  - id: SM-WST-ALERT
    kind: candidate
    collection: alerts
    idField: alertId
    objectRefField: binId             # 须命中同批对象 id
    objectType: OBJ-WST-BIN
    features:                         # 特征名 → 源字段（点路径支持嵌套）
      fillRatio: features.fillRatio
      mixCount: features.mixCount
    tagsField: tags
  # 行为：独立集合即事件行
  - id: SM-WST-DUMP
    kind: behavior
    collection: dumps
    behaviorType: BHV-WST-DUMP
    objectRefTemplate: "<binId>"      # 归属对象 id 模板
    timeField: at
  # 行为：行内嵌套事件数组
  - id: SM-WST-MIX
    kind: behavior-list
    collection: bins
    behaviorType: BHV-WST-MIX
    objectRefTemplate: "<binId>"
    eventsPath: mixEvents
    timeField: at
```

规则速记：`idTemplate` 与对象 `idRule` 必须同构（占位序列一致，大小写/下划线归一比较）；
关系两端必须同批闭合（对端集合未取数报「待补」，取了没命中报「断引用」）；值连接（按值 join）暂不支持。

### 3.3 映射预览（缺字段 / 类型不符 / 断引用 / 证据够不够）

```powershell
node core\dist\cli.js source map preview --dir <pkg> --url http://127.0.0.1:3912
# --json 输出机器报告；--strict 有 error 级诊断时退出码 2（可入 CI）
```

诊断码：`SM_FIELD_MISSING` 缺字段、`SM_TYPE_MISMATCH` 类型不符（含枚举不在字典）、
`SM_REF_BROKEN` 断引用、`SM_REF_PENDING` 对端未取数、`SM_ID_EMPTY`/`SM_ID_CONFLICT` id 问题、
`SM_REQUIRED_UNMAPPED` 必填属性未覆盖、`SM_OBJECT_UNKNOWN`/`SM_FIELD_UNKNOWN`/`SM_IDRULE_MISMATCH`
等静态闭合错误。报告还含**证据就绪度**：逐特征标注可复算（object-fact/derived/connector，够用）
还是 unverified-caller（待补）。

> **改 bindings 后先派生**：`bindings/*` 是源文件、进派生指纹。新增/改动 `api-sources.yaml`、
> `source-maps.yaml` 之后，跑一次 `node core\dist\cli.js derive <pkg>` 再做回放/加载
> （否则 `DERIVED_DRIFT` 拒载——不是坏了，是 manifest 还没认领新文件）。

## 4. 发布前回放（随包验收样例）

```powershell
# 4.0 改过 bindings 后先派生（见 §3 末注）；然后：
# 4.1 冻结数据快照（原始响应体）到 <pkg>/fixtures/replay-<SCN>.json
# 4.2 生成基线（候选/分数/命中规则/证据/排除/人审/审计，写 fixtures/replay-<SCN>.expected.json 并重派生）
node core\dist\cli.js replay --dir <pkg> --scenario <SCN> --fixture <快照.json> --write-expected
# 4.3 之后每次改口径/升级前：对照基线
node core\dist\cli.js replay --dir <pkg> --scenario <SCN> --check
# 覆盖用例：
#   缺数：--fixture <删字段变体>（映射诊断可见 + 基线 diff）
#   越权：--scope-types OBJ-A,OBJ-B（范围外对象不出数，scopedOut 留痕）
#   版本切换：--against <另一版本目录>（同快照双跑，出候选增删/分数 delta/命中变化）
```

`--check` 有差异退出码 2，可入 CI。

## 5. 签发（人工步骤）

签发 = 人审通过；`issuedBy` **不得**为 agent/llm/ai/bot/system。

```powershell
cd core
node dist\cli.js package review --name <包名> --version 1.0.0 --root ..
node dist\cli.js package issue  --name <包名> --version 1.0.0 --by "张三（人工）" --root ..
cd ..
```

> issue 会内置再派生；再跑一次 `gate` 应仍 `ok: true`。ISSUED 后改动须 `package fork` 出新版本。
> 回放基线（fixtures/**）随包进派生指纹——签发后手改夹具会被 `DERIVED_DRIFT` 拒载。

## 6. 插件生成与装配

```powershell
# 6.1 生成最小插件（结果页 + Agent 入口 + 部署模板；生成 ≠ 签发，不落凭据）
node core\dist\cli.js plugin generate --dir <pkg> --scenario <SCN> --source <SRC> --out ..\<domain>-app
# 产物：src/index.ts（配置驱动连接器装配）、src/client.ts（结果页）、src/bindings.ts（契约冻结）、
#       .env.example、scripts/{setup-profile,dump-config}.ps1、scripts/seed-release.mjs、tests/

# 6.2 构建与自检（对着回放夹具的 e2e）
cd ..\<domain>-app
pnpm install; pnpm run build; node --test tests\*.test.mjs

# 6.3 装进独立 profile（无 backend/workbench）
powershell -ExecutionPolicy Bypass -File scripts\setup-profile.ps1
# 6.4 原样导入已签发包，再由授权部署人单独激活
node scripts\seed-release.mjs
node scripts\seed-release.mjs activate "授权部署人姓名"
# 6.5 组合断言
powershell -ExecutionPolicy Bypass -File scripts\dump-config.ps1
# 必须：OK: @dsh-<domain>/app present / backend absent / workbench absent
```

环境变量（启动前；见生成物 `.env.example`）：

```powershell
$env:DSH_<TAG>_API_URL    = 'http://127.0.0.1:3912'   # 不设则数据源不登记，sourceId 运行拒绝
$env:DSH_BIZ_USER_ID      = 'user-1'
$env:DSH_BIZ_TENANT       = 'tenant-1'
$env:DSH_BIZ_ROLES        = 'analyst'
$env:DSH_BIZ_SCOPE_TYPES  = 'OBJ-WST-BIN,OBJ-WST-ROUTE'   # 你的对象类型清单
```

启动：

```powershell
cd ..\deepseek-harness
pnpm dsh --profile dsh-<domain> --no-open
# 浏览器用 localhost（项目惯例）；重启前先杀旧监听
```

## 7. 双入口验收（同一场景）

| 入口 | 操作 | 通过标准 |
|---|---|---|
| **页面** | 侧栏「<域> 运行」→ 选场景 → 运行 | 候选表出现；riskScore 数字；hitRuleIds 非空（至少高风险户）；humanReviewRequired=true；dataStatus 显示 |
| **Agent** | 新会话调 `run_scenario`：`name=<包名>, version=1.0.0, scenarioId=<SCN>, sourceId=<SRC>` | 工具结果含 ruleId/证据链/`humanReviewRequired=true`；禁语零命中 |

对照：同一 `sourceId` 下两边 **ruleId 集合与分数一致**（只在规则引擎算一次）。

无浏览器时的等价冒烟：`cd ..\<domain>-app; node --test tests\*.test.mjs`（含夹具→场景 e2e）。

### 7.1 对话报表与报表页（chat-run-report）

页面与 Agent 之外，同一次运行还有**对话内交互报表**（A2UI 1.0 子集，catalog `dsh-onto/report/v1`）：

- **打开**：会话里 `show_run_report(runId, surface?)`——摘要卡/候选表/证据展开直接渲染在对话中。
  `surface` 可按问题组织视图（白名单组件 Card/Stat/Row/Column/Text/Table/Accordion/Button/
  KeyValue/Badge/Callout/Progress/Timeline/Tabs/Chart/Input/Select/Compare；**数值槽位只准字段绑定**（如
  `{"@path":"/summary/maxRiskScore"}`、Table 列 field 用候选行字段、Timeline 绑
  `/ruleHitLog` 等列表 + 行字段映射；Chart 序列绑定 `rowsBind + labelField + valueField`
  出 bars/line/donut，数据数组字面量拒），字面量分数/证据会被 `INVALID_ARGS` 拒）；
  省略 surface 用默认模板（KeyValue 状态块 + Badge + Stat 行 + 风险分布图 + 候选表）。
  组件事件只做筛选（含表头排序）/展开/跳转（跳转到固定结果页），不接写操作。
- **结构增强**：任意节点可带 `when`（数据驱动条件显隐，如 dataStatus=insufficient 才出
  警示条；也可用 `field` 读 input/select 的界面态）；Table 列 `type`（bar/badge/delta/num）
  与 `filterBy` 外联筛选；`Stat.spark` 微趋势（`spark:{rowsBind,valueField}`）；Chart
  `palette` 色板与悬停提示。`when.value`/`palette`/`max` 是呈现配置字面量，数据槽位仍只准绑定。
- **多系列图表**：`Chart` 支持 `mode:'grouped'`（`valueFields` 同行多列并排柱）、
  `mode:'stacked'`（`stackFrom` 行内嵌套列表堆出构成，如逐规则得分）、line 的
  `seriesField`（按行字段分组多折线）；配 `input`/`select` 轻交互件（本地筛选态，零往返）。
- **导出与对比**：Table `export: true` 出「复制 Markdown / 复制 CSV」（本地剪贴板，
  取当前视图行）；`show_run_diff(runIdA, runIdB)` 对话内对比卡（delta 表/命中增删/排除
  增删；缺席侧分数 null 不补 0），报表页可选第二 run 出同一对比面。
- **同源**：页面与对话报表都经 `getRunReport(runId)` 取同一投影（core `buildRunReport`），数值
  一致由构造保证；展开详情经 wire 受权取数（strict 越权 run 拒绝）。meta 只携 runRef+布局
  引用（无数值、无短语）。
- **回退**：surface 非法、取数失败或渲染异常 → 回退工具文字结果（宿主按原文渲染）。
- **沉淀**：会话里用过的 surface 用 `save_report_page(name, runId, surface)` 沉淀为**报表页**
  （同名覆盖；写面仅工作区 `reports/` 工件，不进包、不触发激活、ISSUED 不动）；插件页
  「报表页」列出已沉淀视图，**换 runId 复用同一视图**（绑定按稳定字段引用对新 run 的投影
  重新解析）。`list_report_pages` 列摘要，`listReportPages`/`getReportPage` wire 供页面取全量。

对照：同一次运行的固定页数值 = 对话报表数值 = `show_run_report` 文字面数值（同一投影 + 同一
渲染器组件）。

> 升级 `@dsh-onto/core` 后请**重新生成插件**：旧生成物对新 surface 组件会显示
> `unknown component` 并回退文字（生成时烘焙渲染器，不随 link 依赖自动更新）。

## 8. 卡点记录表

每完成一步或卡住时填一行。**卡点 = 产品缺口**。

| # | 步骤 | 现象（报错原文/截图要点） | 分类 | 本轮是否绕过 | 备注 |
|---|---|---|---|---|---|
| 1 | | | 字段映射 / 连接器配置 / 插件装配 / 发布激活 / 其他 | | |

### 8.1 早期实现者预填卡点（TAX 时代）与现状

| # | 现象 | 分类 | 自助路径现状 |
|---|---|---|---|
| C1 | pnpm 拒跑 esbuild postinstall | 插件装配 | 已消——脚手架模板预置 `pnpm-workspace.yaml` allowBuilds |
| C2 | 连接器 typeMap 写死、转换手写 | 连接器配置 | 已消——`shape`+`source-maps` 配置驱动（runtime `createMappedDataConnector`） |
| C3 | 签发 CLI `--root` 拼路径 | 流程文档 | 文档已写明从 `core` 用 `--root ..` |
| C4 | 上游特征≠可核验依据 | 字段映射 | 预览含证据就绪度（够用/待补）；formal=verified 仍需包内 featureSources/配方 |
| C5 | worktree 依赖 junction | 插件装配 | 环境已有 junction；全新机器需文档说明 |
| C6 | Electron 指纹 Node 起不了宿主 | 插件装配 | 前置已写「验证 node 非 Electron 构建」 |
| C7 | 页面冒烟点击拦截 | 其他 | Tabbit 工程问题，不影响业务能力 |

## 9. 故障速查

| 症状 | 排查 |
|---|---|
| `数据源未登记: SRC-*` | `DSH_<TAG>_API_URL` 未设或 host 未重启 |
| `source ... 未声明 shape` | api-sources.yaml 缺 shape 块（见 §2） |
| `SM_REF_BROKEN` / `SM_REF_PENDING` | 映射 FK 对不上对象 id / 对端集合没取（§3.3） |
| `SM_IDRULE_MISMATCH` | idTemplate 与对象 idRule 占位序列不一致 |
| `生成要求已签发包` | plugin generate 只对 ISSUED 包；先人工 issue（§5） |
| 回放 `DERIVED_DRIFT: ... bindings/` 或 `... fixtures/` | 新增/改动 bindings 或夹具后未 `derive`；或签发后手改源——前者重派生，后者须 fork 新版本 |
| `run --data` 崩溃（如 `.map` of undefined） | `run --data` 吃的是**转换后 dataset**（同 `examples/*-run.json` 形态），不是原始 API 响应体；原始快照请走 §4 replay 或先映射转换 |
| `--check` 退出码 2 | 基线有 diff——看 comparison.diffs（业务口径变了） |
| `Business identity is unavailable` | `DSH_BIZ_USER_ID/TENANT/ROLES` 不全 |
| `RELEASE_NOT_ACTIVE` | 检查 profile，确认已导入并单独执行 `seed-release.mjs activate <授权部署人>` |
| `暂不支持 instanceIds` | 配置驱动连接器首版不支持按实例查询；不要用无筛选的请求替代单实例查询 |
| 页面 `remote.ontoRuntime missing` | `$mount` 失败，看浏览器 console `[dsh-<domain>]` |
| dump 断言失败 | 确认装的是生成插件而非 backend |

## 10. 验收命令速查

```powershell
# 引擎
cd core;    pnpm run build; node --test tests\*.test.mjs; cd ..
cd runtime; pnpm run build; node --test tests\*.test.mjs; cd ..
# 示例 API 与生成插件
node --test mock-services\wst-api\wst-api.test.mjs
node core\dist\cli.js source probe   --dir packages\wst\1.0.0 --url http://127.0.0.1:3912
node core\dist\cli.js source map preview --dir packages\wst\1.0.0 --url http://127.0.0.1:3912 --strict
node core\dist\cli.js replay --dir <pkg> --scenario <SCN> --check
node core\dist\cli.js plugin generate --dir <pkg> --scenario <SCN> --source <SRC> --out <out>
# 双入口同分：生成插件 tests（夹具→场景→同分幂等）+ 会话 run_scenario 对照
# 对话报表/报表页：backend tests/chat-run-report.test.mjs（工具面/投影/meta/越权）+ §7.1
```
