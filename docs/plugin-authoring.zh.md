# 业务插件冷启动装配指南（第二插件验证）

> 目标读者：**未参与 `core` / `runtime` 开发**的人。按本文走完「接数 → 映射 → 签发 → 部署 → 双入口验收」，
> 全程**不改** `core/**`、`runtime/**` 与 harness。卡住的地方填文末卡点表——那就是下一步要补的产品能力。
>
> 参考实现：`apps/tax`（`@dsh-tax/app`）+ `mock-services/tax-api` + 已签发 `packages/tax`（tax-risk@1.0.0）。
> AML 复核工作台（`apps/aml`）是参考应用，不要求复刻其工单/批准面。

## 0. 边界（先读）

| 必须 | 禁止 |
|---|---|
| 页面与 Agent 调**同一场景、同一 `sourceId`** | 页面/Agent 各写一套判分逻辑 |
| 打分只在 `core/src/rules.ts` | 在连接器或 UI 里改分 |
| ISSUED 只读；改动 fork 新版本 | 直接改已签发包 |
| 数据源地址/凭证只来自**部署配置** | 把真实 URL/密钥写进本体包 |
| `humanReviewRequired=true` 恒真 | 把机器分当业务认定 |
| 模拟数据标 `simulated` | 把 mock 验收写成真实业务验收 |

## 1. 前置

```powershell
# Node ≥ 24.9；harness 为兄弟目录（仓库根旁 ../deepseek-harness；worktree 经 .worktrees/deepseek-harness junction）
# 验证：必须是独立 Node，**不能**是带 electron 指纹的嵌入式构建
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

构建引擎与运行库（一次性）：

```powershell
cd core;     pnpm install; pnpm run build; cd ..
cd runtime;  pnpm install; pnpm run build; cd ..
```

## 2. 接数：起只读 tax-api

```powershell
node mock-services\tax-api\server.mjs --port 3911
# 期望输出一行 JSON：{"event":"listening","port":3911,...}
# 自测：
node --test mock-services\tax-api\tax-api.test.mjs
```

API 只读：`GET /admin/health`、`GET /api/v1/data/:collection`
（`taxpayers|invoices|bankFlows|taxReturns|benchmarks|riskCandidates`）。
非 GET → 405。

## 3. 映射：bindings 与校验

编辑 `packages/tax/1.0.0/bindings/`：

- `api-sources.yaml` — 逻辑源 `SRC-TAX-CORE`（`endpoint: api://tax-query`，**不写真实 URL**）
- `field-maps.yaml` — 源字段 → `OBJ-*.attr`（target 必须闭合）

```powershell
cd core
node dist\cli.js validate ..\packages\tax\1.0.0     # errors 必须为 []；ID_UNREFERENCED 警告可放行
node dist\cli.js derive   ..\packages\tax\1.0.0
node dist\cli.js gate     ..\packages\tax\1.0.0
cd ..
```

> **质量分说明**：`quality-report.json` 的 `score = 100 − 2×warnings`。字段映射 `FM-*` 与数据源 `SRC-*`
> 是叶子 ID（无其它元素按 ID 引用它们），core 的 `UNREFERENCED_EXEMPT_PREFIXES` 只豁免
> `AGT-/AUD-/TOOL-/SCN-`，故 48 条 field-map + 1 条 api-source 会各记一条 `ID_UNREFERENCED`，
> score 可低至个位数（本包约 2）而 `passed=true`（签发门禁只拦 errors）。AML 包同类警告 score≈54。
> 这是校验器计分口径问题，**不代表映射未闭合**；target 闭合以 `validate` 无 error + 连接器 e2e 为准。

## 4. 签发（人工步骤）

签发 = 人审通过；`issuedBy` **不得**为 agent/llm/ai/bot/system。

```powershell
cd core
# workspace 根 = 仓库根（packages/ 在 root 下；目录名 tax ≠ meta.name tax-risk 时靠扫描回退）
# 从 core 出发用 --root ..（勿写 ..\..：那会指到仓库外）
node dist\cli.js package review --name tax-risk --version 1.0.0 --root ..
node dist\cli.js package issue  --name tax-risk --version 1.0.0 --by "张三（人工）" --root ..
cd ..
```

issue 会内置再派生；再跑一次 `gate` 应仍 `ok: true`。

> 本仓库当前 `packages/tax` 已是 ISSUED（本轮冷启动产物）。改内容须 `package fork` 出新版本。

## 5. 插件装配：profile + release

```powershell
# 5.1 安装 @dsh-tax/app 到独立 profile（无 backend/workbench）
scripts\setup-tax-profile.ps1

# 5.2 播种已签发包并激活（strict 模式要求 active release）
node scripts\m-tax-seed-release.mjs

# 5.3 组合断言
scripts\dump-tax-config.ps1
# 必须：OK: @dsh-tax/app present / backend absent / workbench absent
```

环境变量（启动前）：

```powershell
$env:DSH_TAX_API_URL      = 'http://127.0.0.1:3911'   # 不设则 SRC-TAX-CORE 不登记，sourceId 运行拒绝
$env:DSH_BIZ_USER_ID      = 'user-tax-1'
$env:DSH_BIZ_TENANT       = 'tenant-tax'
$env:DSH_BIZ_ROLES        = 'analyst'
$env:DSH_BIZ_SCOPE_TYPES  = 'OBJ-TAX-TAXPAYER,OBJ-TAX-INVOICE,OBJ-TAX-BANK-FLOW,OBJ-TAX-TAX-RETURN,OBJ-TAX-INDUSTRY-BENCHMARK'
# 正式动作本轮未接线；DSH_FORMAL_ACTION_ENABLED 保持未设
```

启动：

```powershell
# 先杀占用端口的旧监听；Tabbit/浏览器用 localhost 而非 127.0.0.1（项目惯例）
# 从仓库根或 worktree 根：harness 均在上一级（worktree 下为 .worktrees/deepseek-harness junction）
cd ..\deepseek-harness
pnpm dsh --profile dsh-tax --no-open
```

## 6. 双入口验收（同一场景）

场景：`SCN-TAX-BURDEN-ANOMALY`；数据源：`SRC-TAX-CORE`。

| 入口 | 操作 | 通过标准 |
|---|---|---|
| **页面** | 侧栏「TAX 运行」→ 选场景 → 运行 | 候选表出现；`riskScore` 数字；`hitRuleIds` 非空（至少高风险户）；`humanReviewRequired=true`；dataStatus 显示 |
| **Agent** | 新会话调 `run_scenario`：`name=tax-risk, version=1.0.0, scenarioId=SCN-TAX-BURDEN-ANOMALY, sourceId=SRC-TAX-CORE` | 工具结果含 ruleId/证据链/`humanReviewRequired=true`；禁语零命中 |

对照：同一 `sourceId` 下两边 **ruleId 集合一致**（分数由 core 规则引擎给出，不因入口而异）。

无浏览器时的等价冒烟（CI/冷启动自查）：

```powershell
cd apps\tax
node --test tests\*.test.mjs
# 含 connector→场景 e2e：打分、审计、禁语
```

## 7. 卡点记录表

每完成一步或卡住时填一行。**卡点 = 产品缺口**，按类归并到字段映射 / 连接器配置 / 插件装配 / 发布激活 / 其他。

| # | 步骤 | 现象（报错原文/截图要点） | 分类 | 本轮是否绕过 | 备注 |
|---|---|---|---|---|---|
| 1 | | | 字段映射 / 连接器配置 / 插件装配 / 发布激活 / 其他 | | |

### 7.1 本轮（实现者）已知卡点预填

| # | 步骤 | 现象 | 分类 | 备注 |
|---|---|---|---|---|
| C1 | 插件构建 | pnpm 11 默认拒跑 esbuild postinstall → `install` 退出码 1，`setup-tax-profile` 当场失败 | 插件装配 | 需在插件包提供 `pnpm-workspace.yaml` 的 `allowBuilds: esbuild: true`；指南模板应预置 |
| C2 | 连接器类型 | `createExtDataConnector` 的 collection/typeMap 写死 AML 三类，TAX 五类 collection 无法复用 | 连接器配置 | 本插件自写 `DataConnector`（不改 runtime）；runtime 可考虑通用「collection→类型映射」配置面 |
| C3 | 签发 CLI 工作区 | `--root packages` 会拼成 `packages/packages/...`；目录 `tax` ≠ `meta.name tax-risk` 时必须 `--root <仓库根>` 靠扫描回退 | 字段映射（流程文档） | 指南已写明从 `core` 用 `--root ..`；CLI 报错未提示扫描回退 |
| C4 | 特征依据 | TAX 包无 `featureSources`/`featureRecipes`，候选特征来自 API 切片 → explore=`conditional`、formal=`insufficient` | 字段映射 | 业务上特征是上游风险信号；若要 formal=verified，需在包内声明投影契约或配方 |
| C5 | 工作树依赖 | harness 依赖相对路径在 `.worktrees/<feat>/` 下依赖 `.worktrees/deepseek-harness` junction | 插件装配 | 本环境已有 junction；全新机器需文档说明或改 link 解析 |
| C6 | 启动宿主 | MiMo 自带 node 的 V8 带 `electron` 指纹，`pnpm dsh` 起宿主时报 `node-addon-require-builtin unsupported` | 插件装配 | 需用独立 Node（如 `D:\nvm\v24.22.1`）；dump-config 可过但 web boot 不过，指南应写「验证 node 非 Electron 构建」 |
| C7 | 页面冒烟 | 欢迎层/遮罩拦截 composer 点击；`新会话` 可访问名是「新建会话」 | 其他 | Tabbit 用 `data-composer-input` force/focus + 键盘；不影响业务能力 |

## 8. 故障速查

| 症状 | 排查 |
|---|---|
| `数据源未登记: SRC-TAX-CORE` | `DSH_TAX_API_URL` 未设或 host 未重启 |
| `Business identity is unavailable` | `DSH_BIZ_USER_ID/TENANT/ROLES` 不全 |
| `RELEASE_NOT_ACTIVE` | 未跑 `m-tax-seed-release.mjs` 或 profile 不对 |
| `DERIVED_DRIFT` | 改了源没 derive，或手改了 `derived/**` |
| 页面 `remote.ontoRuntime missing` | `$mount` 失败 / 描述符未加载，看浏览器 console `[dsh-tax]` |
| dump 断言失败 | 确认装的是 `apps/tax` 而非误装 backend |

## 9. 验收命令速查

```powershell
# 全量（实现者回归）
node --test mock-services\tax-api\tax-api.test.mjs
cd apps\tax; pnpm run build; node --test tests\*.test.mjs; cd ..\..
scripts\dump-tax-config.ps1
# 零改引擎
git diff --stat -- core runtime backend workbench   # 本 feature 应为空
# 质量分：score 低（FM-/SRC- 记 ID_UNREFERENCED）不代表映射坏——看 errors=[] 与 gate ok
```
