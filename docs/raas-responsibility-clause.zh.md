# 分层责任条款（RaaS 交付物 · 合同语言）

- 状态：生效（2026-11-27，audit-package P1a 交付）
- 性质：交付物责任边界——过程层归平台、认定层归人审、数据层归客户，每层责任对应可指认技术证据
- 关联：`docs/architecture.md`（技术红线）、`docs/compose/spec/raas-delivery-plan.zh.md`（§2.3/§4 决策记录）

---

## 0. 交付物形态

平台交付的是「候选 + 证据链 + 人审提示」，**定性结论留给人**（`humanReviewRequired` 恒真、
禁语红线）。一次判定的可复核载体是**审计包**（`runs/exports/<runId>*`）：

| 文件 | 内容 |
|---|---|
| `<runId>.json` | 运行归档（RunRecord）：候选、证据链、ruleHitLog、审计项、指纹、映射校验回执 |
| `<runId>-report.json` | 报表投影（RunReport）：同源数值的复核视图 |
| `<runId>-chain.json` | 治理链：人审决定 → 动作提案 → 动作台账（含批准与外部回执） |
| `<runId>-manifest.json` | 包清单：逐文件 sha256、关键指纹、责任映射、可验边界 |

## 1. 分层责任

### 1.1 过程层——责任方：平台

责任：规则按约定执行、数据映射正确、证据链完整、人审提示到位。

| 责任点 | 技术证据（包内字段路径） |
|---|---|
| 规则按约定执行 | `run.json#/result/ruleHitLog`（逐条计分流水）、`manifest.json#/fingerprints/ruleFingerprint` |
| 数据映射正确 | `run.json#/mappingReceipt`（映射校验回执：来源/诊断汇总/计数/契约指纹） |
| 证据链完整 | `run.json#/result/candidates[].evidenceChains`、`run.json#/result/audit`（三层闭合） |
| 人审提示到位 | `run.json#/result/humanReviewRequired`（恒真）、`run.json#/result/reviewGate` |
| 过程完整性 | `manifest.json#/files`（逐文件 sha256）、`manifest.json#/fingerprints/datasetDigest` |

### 1.2 认定层——责任方：人审方（签名 reviewer）

责任：定性结论与最终处置。

| 责任点 | 技术证据（包内字段路径） |
|---|---|
| 认定归属可追溯 | `chain.json#/decisions[].reviewer`（复核人绑定，宿主可信身份） |
| 认定绑定该次运行 | `chain.json#/decisions[].snapshotDigest` + `ruleFingerprint`（换数据/换规则后旧决定不得套用） |
| 处置可对账 | `chain.json#/proposals[]` + `chain.json#/actions[]`（批准、执行、外部回执） |

### 1.3 数据层——责任方：客户（数据提供方）

责任：输入数据的真实性与及时性。

| 责任点 | 技术证据（包内字段路径） |
|---|---|
| 数据来源可指认 | `run.json#/mappingReceipt/provenance`（connector/inline/file）、`run.json#/mappingReceipt/sourceAnchor`（快照 ID/查询摘要/文件指纹） |
| 时效与完整性另判 | `run.json#/result/dataStatus`、`run.json#/result/dataTrust`（平台只判定「依据是否齐」，不判「数据是否真」） |

## 2. 可验什么、不可验什么（P1a 边界）

**可验（仅凭包内容，脱离平台 UI）：**

1. 包内文件完整性——`manifest.json#/files` 逐文件 sha256 对照；
2. 一次判定的计算过程——证据链 + ruleHitLog + 审计项逐条对账；
3. 人审认定与运行的绑定关系——决定指纹与运行指纹一致性；
4. 数据映射校验结果——`mappingReceipt` 诊断汇总与计数。

**不可验（显式边界，不得据本包主张）：**

1. **本包完整性为同信任域自证（无平台签名）——离线验签属 P1b 路线图，不在本包承诺范围**；
2. 输入数据本身的真实性与及时性（数据层责任归数据提供方）；
3. 定性结论（认定层责任归人审方；本包只含候选 + 证据链 + 人审提示）。

## 3. 承诺边界

对外合同先承诺「可复核」；「可验签」写进路线图——**不在信任根（平台签名密钥 + 公钥发布 +
验签工具 + 密钥轮换/吊销说明）就绪前承诺验签**。密钥体系属 P1b 独立工作项。

---

*本条款与审计包 `manifest.json` 的 `responsibility`/`verifiability` 字段同源表述；
条款修订须同步包清单模板（`core/src/runstore.ts` RESPONSIBILITY/VERIFIABILITY）。*
