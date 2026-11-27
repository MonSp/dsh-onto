# 信任根说明（RaaS 验签交付 · 密钥体系）

- 状态：生效（2026-11-27，signed-delivery P1b 交付）
- 性质：对外验签交付包的信任根——公钥发布、验签工具、密钥轮换与吊销说明
- 关联：`docs/raas-responsibility-clause.zh.md`（分层责任）、`docs/compose/spec/signed-delivery.zh.md`（本地台账）

---

## 0. 签名方案

平台对审计包的 `<runId>-manifest.json` **字节**做 **Ed25519** 签名，签名块独立落
`<runId>-manifest.sig.json`。manifest 成员清单覆盖 run/report/chain 三件——
**签 manifest 即签整包内容，人审决定（chain 成员）随签不可事后抵赖**。

manifest 内 `signature` 字段（keyId/alg/file）是信息位，被签名覆盖自身；
`verifiability` 为带签模板（canVerify 含「包来源离线验签」；cannotVerify 显式
「无权威时间戳」「数据真实性归数据方」「定性结论归人审方」）。

## 1. 密钥生成与保管

- **生成**：`dsh-onto trust keygen --out <dir> [--key-id K] [--published-by X]`
  （Ed25519；输出 `trust-root.json` 公钥文档 + `private/<keyId>.pem` 私钥）。
- **保管**：私钥由部署侧保管——只经部署 env 注入（`DSH_ONTO_SIGN_KEY_FILE` =
  私钥 PEM 路径、`DSH_ONTO_SIGN_KEY_ID` = keyId），**不入包、不入仓、不落业务存储**。
  测试/演练用临时密钥，用后即弃。注：`trust keygen` 的 0600 权限位在 Windows 上
  不生效（NTFS 权限另行收紧），非 Windows 部署按 0600 落盘。
- **签发**：env 配置齐后 `export_audit`/`exportAudit` 导出自动带签（`signed=true`）；
  CLI `runs export --sign-key F --sign-key-id K` 等价。未配置 → 未签包
  （P1a 可复核口径，manifest verifiability 如实标注未签）。

## 2. 公钥发布（验签方获取渠道）

`trust-root.json` 经**带外渠道**交付验签方（合同附件/官网发布/安全邮件），
不经被验包本身传递（包内不携信任根——信任锚必须来自包外）：

```json
{
  "kind": "TrustRoot",
  "version": 1,
  "publishedBy": "发布渠道说明",
  "keys": [
    { "keyId": "key-xxxxxxxx", "alg": "ed25519", "publicKeyPem": "-----BEGIN PUBLIC KEY-----...",
      "createdAt": "ISO 时刻", "status": "active" }
  ],
  "revoked": []
}
```

## 3. 离线验签（第三方操作步骤）

1. 取得审计包目录（`runs/exports/<runId>*` 四件套 + 验签块）与 `trust-root.json`；
2. 运行 `dsh-onto runs verify --dir <导出目录> --trust <trust-root.json>`
   （平台发行版自带验签工具；不依赖平台 UI / workspace）；
3. 逐检查行读结论：`manifest-present` → `signature-present` → `signed-sha256` →
   `key-trusted`（吊销 fail-closed）→ `signature-valid`（Ed25519）→ `members-intact`
   （逐文件 sha256）→ `human-decision-covered`（人审决定随签且 reviewer/指纹齐全）→
   `rule-fingerprint-recompute`（ruleFingerprint 对 ruleHitLog 重算一致）。

## 4. 密钥轮换

1. 生成新密钥（新 keyId），`trust-root.json` 更新 keys（新 key `active`、旧 key 转 `retired`）；
2. 经带外渠道**发布新版信任根**；平台切换 env 到新私钥，新包用新 keyId 签发；
3. 旧 keyId `retired`：**不再签新包，但历史签名仍可验**（轮换不使历史失效）。

## 5. 密钥吊销（密钥泄露/失控）

1. `trust-root.json` 中该 keyId 置 `status: 'revoked'` 并追加进 `revoked[]`（双通道一致）；
2. 立即经带外渠道发布更新；平台换用备用密钥（轮换流程）；
3. 验签工具对 revoked keyId **fail-closed 直接拒**（`key-trusted` 检查行给出吊销结论）；
4. 已签包效力：吊销后该 keyId 所签历史包验签不通过——需由平台重新导出重签，
   吊销公告应注明受影响 keyId 与时间段。

## 6. 可验什么、不可验什么（P1b 口径）

**可验**（信任根公钥 + 包目录离线）：包来源（Ed25519 签名）、包内文件完整性、
一次判定的计算过程、人审认定绑定（随签）、数据映射校验结果、ruleFingerprint 重算。

**不可验**（显式边界）：签名时刻的权威时间戳（`createdAt` 为签发方自报，时间戳服务
属路线图外）；输入数据本身的真实性与及时性（数据层归数据提供方）；定性结论
（认定层归人审方）。

---

*本说明与包内 `manifest.verifiability`（signed 模板）同源表述；修订须同步
`core/src/runstore.ts` VERIFIABILITY_SIGNED 与 `core/src/trust.ts` 验签检查链。*
