/**
 * 页面系统批准卡（issue #30 WP-C）—— wire 面两段式批准挑战。
 *
 * 与宿主 ApprovalService（agent 面 requestGrant）互补：页面操作者就是人本身，
 * 威胁模型是「agent 不得自批」。页面批准卡充当 requestGrant 的替代源：
 * - {@link issueUiApprovalChallenge}：`prepareAction` 服务端签发带 contextDigest 的批准挑战
 *   （绑定 intent/载荷/对象/连接器目标），页面据此弹批准卡；
 * - {@link consumeUiApprovalChallenge}：`executeAction` 携 challengeId，服务端校验
 *   digest 绑定一致、TTL 内、单次消费，记录批准人宿主身份——不匹配 fail-closed。
 *
 * fail-closed：挑战存于进程内存（重启即失 → 重新 prepare）；未知/过期/重复/错摘要一律拒。
 * 批准事件可核验：challengeId + contextDigest + approvedBy(宿主身份) + approvedAt。
 * @module @dsh-onto/runtime/ui-approval
 */
import { randomUUID } from 'node:crypto'
import { AgentToolError } from './agent-policy.js'
import { currentRuntimeContext, runtimeState } from './context.js'
import { requireReviewerHostId } from './review-decision.js'

/** 批准挑战 TTL：人工读卡并点击的窗口；过期须重新 prepare（不续期、不静默放行）。 */
export const UI_APPROVAL_TTL_MS = 5 * 60_000

export interface UiApprovalChallenge {
  challengeId: string
  /** 绑定面：批准上下文摘要（包/契约/对象/载荷/连接器目标）。 */
  contextDigest: string
  /** 签发时刻（ISO）。 */
  issuedAt: string
  /** 过期时刻（ISO，epoch 比较用 expiresAtMs）。 */
  expiresAt: string
  expiresAtMs: number
  consumed: boolean
  /** 签发人宿主身份（prepare 侧留痕）。 */
  issuedBy: string
}

/** 批准凭据（challengeId + 摘要回显；executeAction 携带）。 */
export interface UiApprovalProof {
  challengeId: string
  /** 摘要回显（卡上展示的绑定面；服务端与重算值比对）。 */
  contextDigest: string
}

const uiApprovalStateKey = Symbol('uiApprovalState')

function challenges(): Map<string, UiApprovalChallenge> {
  return runtimeState(uiApprovalStateKey, () => {
    const map = new Map<string, UiApprovalChallenge>()
    currentRuntimeContext().onStop(() => map.clear())
    return map
  })
}

/** 签发批准挑战（prepareAction 调用；身份先行留痕）。 */
export function issueUiApprovalChallenge(
  contextDigest: string,
  ttlMs: number = UI_APPROVAL_TTL_MS,
): { challengeId: string; contextDigest: string; issuedAt: string; expiresAt: string } {
  currentRuntimeContext().assertActive()
  const issuedBy = requireReviewerHostId()
  const issuedAtMs = Date.now()
  const challenge: UiApprovalChallenge = {
    challengeId: `uiac-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    contextDigest,
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: new Date(issuedAtMs + ttlMs).toISOString(),
    expiresAtMs: issuedAtMs + ttlMs,
    consumed: false,
    issuedBy,
  }
  challenges().set(challenge.challengeId, challenge)
  return {
    challengeId: challenge.challengeId,
    contextDigest,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
  }
}

/**
 * 消费批准挑战（executeAction 的 requestGrant 源）：单次、TTL、摘要绑定全过才放行。
 * 返回批准凭据（approvalDigest = 上下文摘要；approvedBy = 批准人宿主身份）。
 */
export function consumeUiApprovalChallenge(
  proof: UiApprovalProof,
  contextDigest: string,
): { approvalDigest: string; approvedAt: string; approvedBy: string } {
  currentRuntimeContext().assertActive()
  // 身份先行（fail-closed，防无身份探测挑战存在性）
  const approvedBy = requireReviewerHostId()
  const found = challenges().get(proof.challengeId)
  if (found === undefined) {
    throw new AgentToolError(
      'UI_APPROVAL_UNKNOWN',
      `批准挑战 ${proof.challengeId} 不存在（或宿主已重启）——请重新走批准卡（prepareAction）`,
    )
  }
  if (found.consumed) {
    throw new AgentToolError('UI_APPROVAL_REUSED', `批准挑战 ${proof.challengeId} 已消费——批准卡单次有效，不得重放`)
  }
  if (Date.now() > found.expiresAtMs) {
    challenges().delete(proof.challengeId)
    throw new AgentToolError('UI_APPROVAL_EXPIRED', `批准挑战 ${proof.challengeId} 已过期——请重新走批准卡（prepareAction）`)
  }
  if (found.contextDigest !== contextDigest || proof.contextDigest !== contextDigest) {
    throw new AgentToolError(
      'UI_APPROVAL_MISMATCH',
      `批准挑战 ${proof.challengeId} 的上下文摘要与本次动作不符——批准不得跨内容生效（fail-closed）`,
    )
  }
  found.consumed = true
  return {
    approvalDigest: contextDigest,
    approvedAt: new Date().toISOString(),
    approvedBy,
  }
}
