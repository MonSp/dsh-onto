/**
 * 业务复核决定公共校验（aml-review-workbench S2.3）——工具面与 UI wire 共用一套口径。
 *
 * 绑定 RunRecord 台账：runId 真实、snapshot/rule 指纹对齐、候选合法；
 * 复核人只信 businessPolicy 身份（fail-closed），不收调用方自报。
 *
 * 两条人审路径（不可互相替代）：
 * - **工具面** `record_review_decision`：humanApproved 意图声明 + 系统批准卡 + 本模块校验；
 * - **UI wire** `recordReviewDecision`：本人点击即人审事件 + 本模块校验（候选子集更严）；
 *   执行批准 / 提案 / 对账仍只走工具面批准卡。
 *
 * 调用顺序约定：先 {@link requireReviewerHostId}，再 {@link validateReviewDecision}——
 * 无身份不得靠 REVIEW_* 错误码探测 run 存在性/摘要。
 * @module @dsh-onto/runtime/review-decision
 */
import type { ExperienceNote, ExperienceOutcome, PackageWorkspace, RunRecord } from '@dsh-onto/core'
import {
  PackageStoreError,
  exportAuditPackage,
  experienceFromRun,
  loadExperienceNote,
  loadPackage,
  loadRunRecord,
  ruleBasisDigest,
  saveExperienceNote,
  signAuditPackage,
  type AuditPackageExport,
} from '@dsh-onto/core'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AgentToolError } from './agent-policy.js'
import { businessPolicy } from './business-policy.js'
import { actionStoreFor, type ActionProposal, type ReviewDecision, type StoredActionRecord } from './action-store.js'

/**
 * 运行规则面指纹（复核决定绑定用）：包身份 + 规则命中日志（ruleId/score 排序）——
 * 与 RunRecord 台账可核对，换规则后旧决定不得照常套用（ruleFingerprint 二选一口径之一）。
 * 实现下沉 core/runstore（审计包清单共用同一算法）；此处 re-export 保持既有导出面。
 */
export { ruleBasisDigest }

/** 边界归一：模型可能把 JSON 数组参数传成字符串——解析后按数组校验。 */
export function normalizeCandidateIds(raw: unknown): string[] {
  const parsed = typeof raw === 'string'
    ? (() => {
        try {
          return JSON.parse(raw) as unknown
        } catch {
          return raw
        }
      })()
    : raw
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((c) => typeof c === 'string')) {
    throw new AgentToolError('INVALID_ARGS', 'candidateIds 必须是非空字符串数组')
  }
  return parsed as string[]
}

export interface ReviewDecisionInput {
  runId: string
  candidateIds: unknown
  snapshotDigest: string
  ruleFingerprint: string
  decision: string
  reason?: string
}

export interface ValidatedReviewDecision {
  runRec: RunRecord
  candidateIds: string[]
  decision: 'approved' | 'rejected'
  snapshotDigest: string
  ruleFingerprint: string
  reason?: string
}

/**
 * 复核决定入参校验（不落库）。
 * @param opts.requireCandidateSubset UI 直写更严：候选须在 RunRecord.result.candidates 内
 *   （工具面靠批准卡+人审，维持既有非空数组口径）。
 */
export function validateReviewDecision(
  root: string,
  input: ReviewDecisionInput,
  opts: { requireCandidateSubset?: boolean } = {},
): ValidatedReviewDecision {
  const candidateIds = normalizeCandidateIds(input.candidateIds)
  if (input.decision !== 'approved' && input.decision !== 'rejected') {
    throw new AgentToolError('INVALID_ARGS', 'decision 必须是 approved / rejected')
  }
  // 与 RunRecord 台账核对（D 包防伪造）：自报不核对 = 不存在的 run 也能立决定、
  // 换数据/换规则后旧决定照常套用——runId 必须真实存在，snapshotDigest/ruleFingerprint
  // 必须与运行台账一致（不匹配拒绝，不落决定）。
  let runRec: RunRecord
  try {
    runRec = loadRunRecord(root, input.runId)
  } catch {
    throw new AgentToolError(
      'REVIEW_RUN_NOT_FOUND',
      `运行 ${input.runId} 不存在于 RunRecord 台账——复核决定须绑定真实运行，不得对自报 run 立决定`,
    )
  }
  const snapshotOk =
    input.snapshotDigest === runRec.datasetDigest
    || (runRec.inputDigest !== undefined && input.snapshotDigest === runRec.inputDigest)
    || (input.snapshotDigest.length >= 8
      && (runRec.datasetDigest.startsWith(input.snapshotDigest)
        || (runRec.inputDigest ?? '').startsWith(input.snapshotDigest)))
  if (!snapshotOk) {
    throw new AgentToolError(
      'REVIEW_SNAPSHOT_MISMATCH',
      `snapshotDigest 与运行 ${input.runId} 的数据快照不符（datasetDigest ${runRec.datasetDigest.slice(0, 12)}…）——`
        + '换数据不可沿用自报摘要立决定',
    )
  }
  const ruleOk =
    input.ruleFingerprint === `${runRec.package.name}@${runRec.package.version}`
    || input.ruleFingerprint === ruleBasisDigest(runRec)
  if (!ruleOk) {
    throw new AgentToolError(
      'REVIEW_RULE_MISMATCH',
      `ruleFingerprint 与运行 ${input.runId} 的规则面不符（期望 ${runRec.package.name}@${runRec.package.version} 或运行规则基指纹）——`
        + '换规则不可沿用自报指纹立决定',
    )
  }
  if (opts.requireCandidateSubset) {
    const known = new Set(runRec.result.candidates.map((c) => c.candidateId))
    const unknownIds = candidateIds.filter((id) => !known.has(id))
    if (unknownIds.length > 0) {
      throw new AgentToolError(
        'REVIEW_CANDIDATE_UNKNOWN',
        `候选 ${unknownIds.join('、')} 不在运行 ${input.runId} 的结果候选集中——UI 复核不得对未知候选立决定`,
      )
    }
  }
  return {
    runRec,
    candidateIds,
    decision: input.decision,
    snapshotDigest: input.snapshotDigest,
    ruleFingerprint: input.ruleFingerprint,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  }
}

/** 复核人 = 宿主用户 id（可信身份；缺省 fail-closed）。格式与工具面一致 `host:${userId}`。 */
export function requireReviewerHostId(): string {
  const reviewerId = businessPolicy.resolveIdentity()?.userId
  if (typeof reviewerId !== 'string' || reviewerId === '') {
    throw new AgentToolError(
      'REVIEWER_UNCONFIRMED',
      '复核人身份不可确认（可信宿主/业务认证服务缺席）——复核决定须绑定宿主用户 id（fail-closed），'
        + '不以批准摘要/模型自称冒充复核人',
    )
  }
  return `host:${reviewerId}`
}

/**
 * 校验通过后落库（唯一 createDecision 入口；调用方已负责身份，工具面另过批准卡）。
 */
export function persistReviewDecision(
  root: string,
  validated: ValidatedReviewDecision,
  reviewer: string,
): ReviewDecision {
  return actionStoreFor(root).createDecision({
    runId: validated.runRec.runId,
    candidateIds: validated.candidateIds,
    snapshotDigest: validated.snapshotDigest,
    ruleFingerprint: validated.ruleFingerprint,
    reviewer,
    decision: validated.decision,
    ...(validated.reason !== undefined ? { reason: validated.reason } : {}),
  })
}

/** 认定→经验卡桥接回执（反馈闭环②断链 A）：成功或显式 skipped（不回滚决定）。 */
export type ExperienceBridgeResult =
  | { runId: string; outcome: ExperienceOutcome; created: boolean }
  | { skipped: string }

/**
 * 认定→经验卡桥接（断链 A）：缺卡补建（S5.4.2 映射），认定回执追加进 outcomeReason。
 * 工具面 record_review_decision 与 UI wire recordReviewDecision 共用同一口径——
 * 任一路径落决定都补建/更新经验卡，回填面看到认定摘要而非仅运行初稿。
 * 学习层不否决人审：桥接失败不回滚已落决定，回执显式 skipped（不静默吞）。
 */
export function bridgeExperienceFromDecision(
  ws: PackageWorkspace,
  rec: RunRecord,
  dec: ReviewDecision,
): ExperienceBridgeResult {
  try {
    let note: ExperienceNote | null = null
    try {
      note = loadExperienceNote(ws.root, rec.runId)
    } catch (e) {
      if (e instanceof PackageStoreError && e.code === 'NOT_FOUND') note = null
      else throw e
    }
    const created = note === null
    if (note === null) {
      const pkg = loadPackage(ws.versionDir(rec.package.name, rec.package.version))
      note = experienceFromRun(rec, pkg)
    }
    const stamp = `复核决定 ${dec.decision}（${dec.decisionId}）${dec.reason !== undefined ? `: ${dec.reason}` : ''}`
    note.outcomeReason =
      note.outcomeReason !== undefined && note.outcomeReason !== ''
        ? `${note.outcomeReason}；${stamp}`
        : stamp
    // 补建/桥接同口径：人审认定即定性留痕（reviewedBy=决定复核人，宿主可信身份）
    note.reviewedBy = dec.reviewer
    note.savedAt = new Date().toISOString()
    saveExperienceNote(ws.root, note)
    return { runId: note.runId, outcome: note.outcome, created }
  } catch (e) {
    return { skipped: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * 审计包导出编排（audit-package P1a）：治理链（decision→proposal→action）+
 * core `exportAuditPackage` 一次写出。工具面 export_audit 与 wire exportAudit
 * 同调本函数——两个出口交付物逐字段同构。
 */
export interface RunAuditExport extends AuditPackageExport {
  /** P1b：本包是否带平台签名（env 配置齐且签名成功）。 */
  signed: boolean
  signatureLocator?: string
}

export function exportRunAuditPackage(
  wsRoot: string,
  runId: string,
): RunAuditExport {
  const store = actionStoreFor(wsRoot)
  const decisions = store.listDecisions(runId)
  const decisionIds = new Set(decisions.map((d) => d.decisionId))
  const proposals = store.listProposals().filter((p) => decisionIds.has(p.decisionId))
  const proposalIds = new Set(proposals.map((p) => p.proposalId))
  const actions = store.listActions().filter(
    (a) => (a.decisionId !== undefined && decisionIds.has(a.decisionId))
      || (a.proposalId !== undefined && proposalIds.has(a.proposalId)),
  )
  const out = exportAuditPackage(wsRoot, runId, {
    chain: { decisions, proposals, actions } satisfies {
      decisions: ReviewDecision[]
      proposals: ActionProposal[]
      actions: StoredActionRecord[]
    },
  })
  // P1b 部署配置签名（凭证只来自部署 env，不落盘不进包）：配置齐 → overlay 签名
  const keyFile = process.env.DSH_ONTO_SIGN_KEY_FILE
  const keyId = process.env.DSH_ONTO_SIGN_KEY_ID
  if (keyFile !== undefined && keyFile !== '' && keyId !== undefined && keyId !== '') {
    const privateKeyPem = readFileSync(keyFile, 'utf8')
    const signed = signAuditPackage(join(wsRoot, 'runs', 'exports'), runId, { privateKeyPem, keyId })
    return {
      ...out,
      manifest: signed.manifest,
      signed: true,
      signatureLocator: `runs/exports/${signed.signatureLocatorName}`,
    }
  }
  return { ...out, signed: false }
}