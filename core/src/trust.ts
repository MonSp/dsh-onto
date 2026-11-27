/**
 * 信任根与离线验签（signed-delivery P1b）：平台 Ed25519 签名密钥、审计包签名/验签。
 *
 * - 签名对象 = `<runId>-manifest.json` 的字节（签 manifest 即签整包成员清单——
 *   run/report/chain 三件随签；人审决定（chain 成员）不可事后抵赖）；
 * - 私钥只在部署侧（env 注入路径）出现，不入包不入仓；测试用临时密钥；
 * - 验签离线：信任根（公钥发布）+ 导出目录即可，不依赖平台 UI；
 * - 吊销 fail-closed：revoked keyId 签的包直接拒（含 status='revoked' 与 revoked 列表并集）。
 * @module @dsh-onto/core/trust
 */
import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isSafeRelPath, PackageStoreError } from './store.js'
import {
  isSafeRunId,
  ruleBasisDigest,
  VERIFIABILITY_SIGNED,
  type RunExportManifest,
  type RunRecord,
} from './runstore.js'

/** 信任根文档（公钥发布 + 轮换/吊销状态；带外渠道分发）。 */
export interface TrustRoot {
  kind: 'TrustRoot'
  version: 1
  /** 发布说明（带外渠道文本：谁发布、哪里获取、有效期）。 */
  publishedBy?: string
  keys: Array<{
    keyId: string
    alg: 'ed25519'
    publicKeyPem: string
    createdAt: string
    /** active=签发与验签；retired=停签发但历史签名仍可验；revoked=验签拒绝。 */
    status: 'active' | 'retired' | 'revoked'
  }>
  /** 吊销清单（keyId）；与 status='revoked' 并集判吊销（fail-closed）。 */
  revoked?: string[]
}

/** 签名块（独立文件；不入 manifest.files——签名不能自列，同 manifest 不自列口径）。 */
export interface ManifestSignature {
  kind: 'ManifestSignature'
  /** 被签文件名（导出目录内相对）。 */
  signedFile: string
  /** 被签字节的 sha256（对照文件实字节）。 */
  signedSha256: string
  keyId: string
  alg: 'ed25519'
  createdAt: string
  /** base64(Ed25519 签名)。 */
  sig: string
}

/** 验签检查行（审计员逐步看结论，不是笼统 ok）。 */
export interface VerifyCheck {
  name: string
  ok: boolean
  detail: string
}

export interface VerifyResult {
  ok: boolean
  keyId?: string
  checks: VerifyCheck[]
}

/** 生成 Ed25519 密钥对 + 信任根文档（私钥 PEM 由调用方保管，不落包/仓）。 */
export function generateTrustKeyPair(opts?: {
  keyId?: string
  createdAt?: string
  publishedBy?: string
}): {
  keyId: string
  privateKeyPem: string
  publicKeyPem: string
  trustRoot: TrustRoot
} {
  const keyId = opts?.keyId ?? `key-${createHash('sha256').update(String(Date.now()) + Math.random()).digest('hex').slice(0, 8)}`
  if (!isSafeRelPath(keyId) || /[/\\:]/.test(keyId)) {
    throw new PackageStoreError('INVALID_ARGS', 'keyId 非法（单段、无分隔符）')
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const createdAt = opts?.createdAt ?? new Date().toISOString()
  const trustRoot: TrustRoot = {
    kind: 'TrustRoot',
    version: 1,
    ...(opts?.publishedBy === undefined ? {} : { publishedBy: opts.publishedBy }),
    keys: [{ keyId, alg: 'ed25519', publicKeyPem, createdAt, status: 'active' }],
    revoked: [],
  }
  return { keyId, privateKeyPem, publicKeyPem, trustRoot }
}

/** 吊销判定（fail-closed）：status='revoked' 或 revoked 列表任一命中即吊销。 */
export function isRevoked(trustRoot: TrustRoot, keyId: string): boolean {
  const entry = trustRoot.keys.find((k) => k.keyId === keyId)
  return (entry?.status === 'revoked') || (trustRoot.revoked ?? []).includes(keyId)
}

/** 对 manifest 字节签名 → 签名块（独立文件内容）。 */
export function signManifest(
  manifestBytes: Buffer,
  privateKeyPem: string,
  keyId: string,
  opts?: { signedFile?: string; createdAt?: string },
): ManifestSignature {
  if (!isSafeRelPath(keyId) || /[/\\:]/.test(keyId)) {
    throw new PackageStoreError('INVALID_ARGS', 'keyId 非法（单段、无分隔符）')
  }
  const signedSha256 = createHash('sha256').update(manifestBytes).digest('hex')
  let key: KeyObject
  try {
    key = requirePrivateKey(privateKeyPem)
  } catch {
    throw new PackageStoreError('INVALID_ARGS', '私钥 PEM 不可解析')
  }
  return {
    kind: 'ManifestSignature',
    signedFile: opts?.signedFile ?? 'manifest.json',
    signedSha256,
    keyId,
    alg: 'ed25519',
    createdAt: opts?.createdAt ?? new Date().toISOString(),
    sig: edSign(null, manifestBytes, key).toString('base64'),
  }
}

function requirePrivateKey(pem: string): KeyObject {
  return createPrivateKey(pem)
}

/**
 * 对已导出审计包签名（overlay 步骤；runstore 无签名依赖，模块图无环）：
 * ① manifest 补 signature 标记 + signed 可验模板（标记被签名覆盖自身）；
 * ② 重写 manifest 后对其字节 Ed25519 签名 → `<runId>-manifest.sig.json`。
 * 私钥 PEM 只经内存，不落盘不进包。
 */
export function signAuditPackage(
  dir: string,
  runId: string,
  sign: { privateKeyPem: string; keyId: string },
): { manifest: RunExportManifest; signature: ManifestSignature; signatureLocatorName: string } {
  if (!isSafeRunId(runId)) {
    throw new PackageStoreError('INVALID_ARGS', 'invalid runId')
  }
  const manifestName = `${runId}-manifest.json`
  const manifestPath = join(dir, manifestName)
  if (!existsSync(manifestPath)) {
    throw new PackageStoreError('NOT_FOUND', `manifest 不存在: ${manifestName}`)
  }
  let manifest: RunExportManifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as RunExportManifest
  } catch {
    throw new PackageStoreError('PACKAGE_MALFORMED', `manifest 不是合法 JSON: ${manifestName}`)
  }
  const sigFileName = `${runId}-manifest.sig.json`
  manifest.signature = { keyId: sign.keyId, alg: 'ed25519', file: sigFileName }
  manifest.verifiability = VERIFIABILITY_SIGNED
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  writeFileSync(manifestPath, manifestBytes)
  const signature = signManifest(manifestBytes, sign.privateKeyPem, sign.keyId, {
    signedFile: manifestName,
  })
  writeFileSync(join(dir, sigFileName), `${JSON.stringify(signature, null, 2)}\n`, 'utf8')
  return { manifest, signature, signatureLocatorName: sigFileName }
}

/**
 * 离线验签（P1b 验收锚点）：导出目录 + 信任根 → 逐步检查行。
 * 不依赖平台 UI / workspace——第三方只拿包目录与信任根文件即可。
 *
 * 检查链：manifest 可读（opts.runId 指定单包；否则目录内恰一份）→ 签名块存在
 * （未签包显式 unsigned 行）→ signedSha256 对照 manifest 字节 → keyId 受信且未吊销
 * （fail-closed）→ Ed25519 验签 → manifest.files 逐文件 sha256 对照包内成员 →
 * 无游离未登记成员 → 人审决定被签名覆盖（chain 成员在清单内）→ ruleFingerprint 可重算一致。
 */
export function verifyAuditPackage(
  dir: string,
  trustRoot: TrustRoot,
  opts?: { runId?: string },
): VerifyResult {
  const checks: VerifyCheck[] = []
  const push = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail })
  }

  // manifest 文件定位：opts.runId 精确指定（多包导出目录）；否则要求目录内恰一份
  let manifestName: string | null
  if (opts?.runId !== undefined) {
    if (!isSafeRunId(opts.runId)) {
      push('manifest-present', false, 'runId 非法')
      return { ok: false, checks }
    }
    manifestName = existsSync(join(dir, `${opts.runId}-manifest.json`))
      ? `${opts.runId}-manifest.json`
      : null
  } else {
    manifestName = findManifestName(dir)
  }
  if (manifestName === null) {
    push('manifest-present', false, opts?.runId !== undefined
      ? `导出目录内无 ${opts.runId}-manifest.json`
      : describeManifestScan(dir))
    return { ok: false, checks }
  }
  push('manifest-present', true, manifestName)
  const manifestBytes = readFileSync(join(dir, manifestName))
  let manifest: RunExportManifest
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8')) as RunExportManifest
  } catch {
    push('manifest-parse', false, 'manifest 不是合法 JSON')
    return { ok: false, checks }
  }
  // 形守卫（评审 gap-4）：坏形 manifest 出检查行，不裸抛 TypeError
  if (!Array.isArray(manifest.files)
    || typeof manifest.fingerprints?.ruleFingerprint !== 'string'
    || typeof manifest.runId !== 'string') {
    push('manifest-shape', false, 'manifest 缺 files/runId/fingerprints.ruleFingerprint 必要字段')
    return { ok: false, checks }
  }
  push('manifest-shape', true, '必要字段齐全')

  const sigRef = manifest.signature
  if (sigRef === undefined) {
    push('signature-present', false, '未签包（P1a 可复核口径；验签属 P1b 签发包）')
    // 未签包：成员完整性仍可复验
    push('members-intact', verifyMembers(dir, manifest), 'manifest.files 逐文件 sha256')
    return { ok: false, keyId: undefined, checks }
  }
  const sig = readSignature(dir, sigRef.file)
  if (sig === null) {
    push('signature-present', false, `签名块缺失: ${sigRef.file}`)
    return { ok: false, checks }
  }
  push('signature-present', true, `${sig.keyId} (${sig.alg})`)

  // sig 元数据与 manifest 标记一致性（评审 gap-7；签名已覆盖内容，此行是显式对账）
  const metaOk = sig.signedFile === manifestName && sig.keyId === sigRef.keyId
  push('sig-meta-consistent', metaOk,
    metaOk ? 'signedFile/keyId 与 manifest.signature 对齐' : 'sig 元数据与 manifest.signature 不一致')

  const actualSha = createHash('sha256').update(manifestBytes).digest('hex')
  push('signed-sha256', actualSha === sig.signedSha256, `manifest 字节 sha256 对照签名块`)
  if (actualSha !== sig.signedSha256) return { ok: false, keyId: sig.keyId, checks }

  const keyId = sig.keyId
  if (isRevoked(trustRoot, keyId)) {
    push('key-trusted', false, `keyId ${keyId} 已吊销（fail-closed）`)
    return { ok: false, keyId, checks }
  }
  const entry = trustRoot.keys.find((k) => k.keyId === keyId && k.alg === 'ed25519')
  if (entry === undefined) {
    push('key-trusted', false, `keyId ${keyId} 不在信任根（未发布/未登记）`)
    return { ok: false, keyId, checks }
  }
  push('key-trusted', true, `keyId ${keyId} (${entry.status})`)

  let sigOk = false
  try {
    sigOk = edVerify(null, manifestBytes, entry.publicKeyPem, Buffer.from(sig.sig, 'base64'))
  } catch {
    sigOk = false
  }
  push('signature-valid', sigOk, 'Ed25519 验签')
  if (!sigOk) return { ok: false, keyId, checks }

  push('members-intact', verifyMembers(dir, manifest), 'manifest.files 逐文件 sha256')

  // 未登记成员检查：只看**本包 runId 前缀**的游离文件（多包导出目录里兄弟包文件不属本包清单）；
  // 本包前缀内 manifest/sig 之外的未登记文件 = 清单外内容，不可放过（评审 gap-5）
  const listed = new Set(manifest.files.map((f) => f.name))
  const prefix = `${manifest.runId}.`
  const prefixDash = `${manifest.runId}-`
  const unlisted = readdirSync(dir).filter(
    (n) => (n.startsWith(prefix) || n.startsWith(prefixDash))
      && n !== manifestName && n !== sigRef.file && !listed.has(n),
  )
  push('no-unlisted-members', unlisted.length === 0,
    unlisted.length === 0 ? '无游离未登记成员' : `未登记成员: ${unlisted.join(', ')}`)

  // 人审签字口径：chain 成员在签名覆盖的清单内，且决定行带 reviewer/指纹
  const chainName = manifest.files.find((f) => f.name.endsWith('-chain.json'))?.name
  if (chainName === undefined) {
    push('human-decision-covered', true, '无入包人审决定（签名覆盖清单即全包）')
  } else {
    const chain = safeReadJson(join(dir, chainName)) as {
      decisions?: Array<{ reviewer?: unknown; ruleFingerprint?: unknown }>
    } | null
    const decisions = chain?.decisions ?? []
    const bound = decisions.length > 0
      && decisions.every((d) => typeof d.reviewer === 'string' && d.reviewer !== ''
        && typeof d.ruleFingerprint === 'string' && d.ruleFingerprint !== '')
    push(
      'human-decision-covered',
      bound || decisions.length === 0,
      decisions.length === 0
        ? 'chain 成员已被签名覆盖（本轮无人审决定）'
        : `${decisions.length} 条决定 reviewer/ruleFingerprint 齐全且随签`,
    )
  }

  // ruleFingerprint 重算一致（换规则后旧决定不得套用的包内自查）
  const runName = `${manifest.runId}.json`
  const runRec = safeReadJson(join(dir, runName)) as RunRecord | null
  if (runRec === null || typeof runRec.result?.ruleHitLog === 'undefined') {
    push('rule-fingerprint-recompute', false, 'run 归档不可读')
  } else {
    push(
      'rule-fingerprint-recompute',
      ruleBasisDigest(runRec) === manifest.fingerprints.ruleFingerprint,
      'manifest.fingerprints.ruleFingerprint 对 ruleHitLog 重算',
    )
  }

  return { ok: checks.every((c) => c.ok), keyId, checks }
}

function findManifestName(dir: string): string | null {
  if (!existsSync(dir)) return null
  const hit = readdirSync(dir).filter((n) => n.endsWith('-manifest.json'))
  return hit.length === 1 ? hit[0] : null
}

/** manifest 扫描歧义说明（0 份 vs 多份分别给结论；多份提示指定 runId——评审 gap-3）。 */
function describeManifestScan(dir: string): string {
  if (!existsSync(dir)) return '导出目录不存在'
  const hit = readdirSync(dir).filter((n) => n.endsWith('-manifest.json'))
  return hit.length === 0
    ? '导出目录内无 *-manifest.json'
    : `导出目录内 ${hit.length} 份 manifest（${hit.join(', ')}）——多包目录请指定 runId`
}

function readSignature(dir: string, file: string): ManifestSignature | null {
  if (!isSafeRelPath(file)) return null
  const raw = safeReadJson(join(dir, file)) as ManifestSignature | null
  return raw !== null && raw.kind === 'ManifestSignature' && typeof raw.sig === 'string'
    ? raw
    : null
}

function verifyMembers(dir: string, manifest: RunExportManifest): boolean {
  for (const f of manifest.files) {
    if (!isSafeRelPath(f.name)) return false
    const p = join(dir, f.name)
    if (!existsSync(p)) return false
    const sha = createHash('sha256').update(readFileSync(p)).digest('hex')
    if (sha !== f.sha256) return false
  }
  return true
}

function safeReadJson(file: string): unknown | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}
