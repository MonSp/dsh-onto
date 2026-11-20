# 对账与停用手册（正式启用门槛 · 条件 3 交付物）

> 适用范围：`DSH_EXT_API_KIND=formal` 的**真实工单动作**链路（当前受控面 = `BHV-AML-OPEN-REVIEW-TICKET` 创建复核工单）。
> 本手册是方案 §9「正式启用门槛」的组成部分，与《ontology-agent-closure-plan.md》配套使用。
> 边界恒定：**AI 不代用户签发本体、作业务复核、点批准卡、翻转正式动作开关。**

---

## 1. 启用操作（门后执行）

### 1.1 部署开关

| 项 | 值 |
|---|---|
| 环境变量 | `DSH_FORMAL_ACTION_ENABLED=1`（缺省**不设/0** = 总开关关闭） |
| 作用 | 启动时置 `setFormalActionEnabled(true)`，formal 连接器动作放行；关闭时 formal 动作一律 `FORMAL_ACTION_DISABLED`（零外部效应），读取/对账能力保留 |
| 谁翻转 | **用户在部署侧配置**（宿主环境变量/服务配置）。AI 只接线不代开；生效 = 宿主重启 |
| 配套 | `DSH_EXT_API_URL` + `DSH_EXT_API_TOKEN`（OAuth 签发的 access_token）+ `DSH_EXT_API_KIND=formal` |

宿主启动日志应出现两行确认：

```text
[dsh-onto] ext-api connector + data source registered (kind=formal): <url>
[dsh-onto] formal action ENABLED by deployment config
```

### 1.2 灰度首单操作单（单一真实工单动作）

逐项打勾后再进入观察期：

1. **凭证**：用 OAuth 流签发专用 client（租户/角色/数据范围最小化），token 进 secrets，不落代码。
2. **复核决定**：对目标运行跑 `record_review_decision`（approved，候选集 = 获准候选），批准卡由**用户**点允许；记录 `DEC-*`。
3. **提案**：`create_action_proposal`（behaviorId=BHV-AML-OPEN-REVIEW-TICKET，载荷 = 工单标题/候选/运行号），记录 `PROP-*` 与服务端 `OP-*`。
4. **执行**：`execute_behavior_action` 传 proposalId，**批准卡展示工单目标、载荷、候选、来源运行**后由用户点允许。
5. **核对外部回执**：外部单号（EXT-TKT-*）在外部系统 `GET /api/v1/tickets/{no}` 可查，状态/载荷/操作号与台账一致；本地台账 `succeeded` 且绑定 decisionId/proposalId。
6. **审计串联**：`export_audit` 落 `runs/exports/<runId>.json + <runId>-chain.json`，链条 snapshot → run → decision → proposal → approval → externalRef 完整。
7. **外部侧证据**：`GET /api/v1/audit/operations` 该 Idempotency-Key 有一条成功受理记录，无第二条。

七项全勾 = 首单通过。不通过 → 按 §4 处置，不得带病扩面。

### 1.3 扩面准则

观察期内每单执行 §2 日常对账；连续 N 单（建议 ≥5）零重复效应、零 unknown 积压后，才讨论扩到下一个行为/租户。**每扩一步重跑 `f2-matrix.mjs` 矩阵**（12 组）再放行。

---

## 2. 对账操作

### 2.1 日常核对（每单/每日）

- **本地台账**（`workspace/actions/ledger.db`，工具面 `reconcile_action` / 治理链面板）↔ **外部审计**（`GET /api/v1/audit/operations?from=&to=`）逐条对：Idempotency-Key、结果、ticketNo 三元组一致。
- **判据**：外部有受理记录而本地无对应终态 = 漏记 → 查 `unknown`/`executing` 行；本地 `succeeded` 而外部无记录 = 伪造/串环境 → 立即停用（§4.2）。
- **重复效应红线**：同一 Idempotency-Key 在外部审计出现两条「受理成功」= 严重事故 → 停用 + 全量对账（§4.3）。

### 2.2 `unknown` 台账处置（人工对账流程）

`unknown` = 效应不明（超时/中断/对账不可达）。**禁止自动重跑。**

1. 查外部：`GET /api/v1/tickets?key=<业务键>`（系统之记录裁决：`succeeded` / `not-executed`）。
2. 调 `reconcile_action`（actionId，humanApproved=true，**批准卡用户点允许**）：
   - 外部 `succeeded` → 恢复同单号，台账转 `succeeded`；
   - 外部 `not-executed`（含审计零记录）→ 台账转 `failed`（无效应留痕）；
   - 外部 `unknown`/不可达 → **保持 unknown**，记待办，不得重跑。
3. 确需重做业务动作 → **新提案**（新 operationId）+ 重新批准——同键重放只回读，不新建。
4. 每次对账把结论（单号/判定/处置人/时间）记入审计导出附注。

### 2.3 定期核对命令

```bash
# 矩阵回归（扩面/变更后必跑）
node scripts/f2-matrix.mjs
# 矩阵输出与归档对照
# docs/audit/f2-rehearsal-matrix.md（本地留痕区，按仓库约定不入库）
```

---

## 3. 证据留存（每动作必存）

构建标识（git commit）、测试/业务身份（userId/tenant）、请求摘要（approvalDigest/intentDigest）、
拒绝码或外部回执（EXT-TKT-*）、运行与动作 locator（runId/actionId/chain.json）。
**外部系统侧记录是最终证据**；本地台账不自证。F1 演练回执恒 `simulated`，不得混入正式证据链。

---

## 4. 停用与故障处置

### 4.1 计划性暂停（保留对账能力）

1. 去掉 `DSH_FORMAL_ACTION_ENABLED`（或置 0）→ 重启宿主 → formal 动作零派发；
2. 在途单：逐单查外部状态，能 cancel 的 cancel（补偿幂等）；
3. 保留凭证与台账只读，供对账。

### 4.2 完全停用（含事故）

1. 执行 §4.1；
2. **吊销凭证**：`POST /oauth/revoke`（单 token）/ `POST /admin/clients/{id}/revoke`（client 级，已签发 token 立即失效）；
3. 导出封存：`export_audit` 全量 + 外部 `GET /api/v1/audit/operations` 全量存档；
4. 事故报告：时间线、影响单号清单、根因、修复项；修复后重跑 §1.2 灰度首单 + `f2-matrix.mjs`。

### 4.3 故障分级

| 级别 | 症状 | 处置 |
|---|---|---|
| P0 | 同键外部双受理 / 本地伪造成功 / 跨租户泄露 | 立即 §4.2 完全停用 + 事故报告 |
| P1 | unknown 积压不降 / 对账判据不一致 / 批准卡被绕过迹象 | 暂停 §4.1 + 全量对账，查清再启 |
| P2 | 单笔外部拒绝（422/409/权限） | 按拒绝码处理（换提案/修权限/修载荷），不动开关 |
| P3 | 外部服务不可达 | 保持停发新动作；恢复后先对账（§2.2）再续 |

### 4.4 停用后的恢复

故障清零 → 修复项入回归（矩阵全绿）→ 用户确认 → §1.2 灰度首单重跑 → 观察期重新计数。

---

## 5. 边界与不变量（复述方案红线）

- 两次人工事件分离：业务复核（ReviewDecision）≠ 执行批准（批准卡），humanReviewRequired 恒真不替代任一次。
- ISSUED 包只读；知识/经验只入草案队列，人审后物化。
- 分数只在 `core/src/rules.ts` 计算；经验只提示不改分。
- 低分≠低风险结论 · 审计通过≠可信数据 · 人审恒真≠复核通过 · 报告不含动作执行结论（四态分离）。
- 演练/模拟回执不冒充真实业务成功；正式动作失败按效应面补偿（saga），未知效应只进对账。
