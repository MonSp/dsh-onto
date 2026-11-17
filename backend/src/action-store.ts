/**
 * 动作事务台账（M2/D）—— SQLite 唯一约束 + 版本号/CAS 更新（node:sqlite，零新增依赖）。
 *
 * 方案 §7 幂等与持久化：
 * - 业务幂等键唯一约束占位（跨进程/跨会话只有一个派发者）；同键不同载荷/批准上下文 → 显式冲突，
 *   不通过改 payload 悄悄生成新业务操作；
 * - 等待人工批准/网络响应不持有数据库事务——claim / settle 各自短事务；
 * - ReviewDecision（业务复核）与 ActionProposal（动作提案）分离持久：提案绑定复核决定，
 *   服务端分配并固定 operationId；提案单次消费；
 * - JSON 历史台账只读保留：{@link verifyLegacyJsonRecords} 核对、{@link migrateLegacyJsonRecords}
 *   显式迁移（缺上下文记录不迁移、不自动重跑）。
 * @module @dsh-onto/backend/action-store
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { AgentToolError, isRecord } from './agent-policy.js'
import type { ActionRecord, ConnectorIdentity } from './action-executor.js'

/** 台账存储记录 = 动作记录 + 版本号（CAS）+ D 包链条引用。 */
export interface StoredActionRecord extends ActionRecord {
  /** CAS 版本号（每次终态/相位更新递增）。 */
  version: number
  /** 业务复核决定（D 包链条：decision → proposal → approval → externalRef）。 */
  decisionId?: string
  /** 动作提案。 */
  proposalId?: string
  /** 业务租户（业务键组成；缺省空串=单租户试点）。 */
  tenant?: string
  /** 载荷指纹（同业务键不同载荷 → 显式冲突的判据）。 */
  intentDigest: string
}

/** 业务复核决定（人对该次分析与证据的业务决定；不等于执行批准）。 */
export interface ReviewDecision {
  decisionId: string
  runId: string
  /** 获准动作的候选集合（提案候选必须落在集合内）。 */
  candidateIds: string[]
  /** 数据快照摘要。 */
  snapshotDigest: string
  /** 本体/规则指纹。 */
  ruleFingerprint: string
  /** 复核人可信身份（宿主用户 id；工具面经批准卡绑定，不收模型自称）。 */
  reviewer: string
  /** 业务决定：approved（允许对集合内候选提案）/ rejected。 */
  decision: 'approved' | 'rejected'
  reason?: string
  revision: number
  createdAt: string
}

/** 动作提案（绑定复核决定 + 运行 + 候选 + 意图 + 连接器目标 + 服务端操作标识）。 */
export interface ActionProposal {
  proposalId: string
  decisionId: string
  runId: string
  candidateId: string
  behaviorId: string
  objectRef: string
  payload: Record<string, unknown>
  intentDigest: string
  connectorId: string
  connectorEnv: string
  /** 服务端分配并固定（业务键组成）。 */
  operationId: string
  status: 'pending' | 'consumed' | 'canceled'
  createdAt: string
  consumedAt?: string
}

const SCHEMA = `
  create table if not exists actions (
    business_key text primary key,
    action_id text not null,
    operation_id text,
    tenant text not null default '',
    intent_digest text not null,
    approval_context text not null,
    connector_id text not null,
    connector_env text not null,
    connector_kind text,
    behavior_id text not null,
    object_ref text not null,
    payload_json text not null,
    status text not null,
    phase text,
    external_ref text,
    error text,
    compensation_error text,
    approval_digest text not null,
    approved_at text not null,
    executed_at text not null,
    compensated_at text,
    decision_id text,
    proposal_id text,
    version integer not null default 1,
    created_at text not null,
    updated_at text not null
  );
  create table if not exists decisions (
    decision_id text primary key,
    run_id text not null,
    candidate_ids_json text not null,
    snapshot_digest text not null,
    rule_fingerprint text not null,
    reviewer text not null,
    decision text not null,
    reason text,
    revision integer not null default 1,
    created_at text not null
  );
  create table if not exists proposals (
    proposal_id text primary key,
    decision_id text not null,
    run_id text not null,
    candidate_id text not null,
    behavior_id text not null,
    object_ref text not null,
    payload_json text not null,
    intent_digest text not null,
    connector_id text not null,
    connector_env text not null,
    operation_id text not null unique,
    status text not null,
    created_at text not null,
    consumed_at text
  );
`

function now(): string {
  return new Date().toISOString()
}

function shortId(prefix: string): string {
  return `${prefix}-${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

function rowToAction(row: Record<string, unknown>): StoredActionRecord {
  return {
    businessKey: row.business_key as string,
    actionId: row.action_id as string,
    ...(row.operation_id !== null ? { operationId: row.operation_id as string } : {}),
    approvalContext: row.approval_context as string,
    connector: {
      id: row.connector_id as string,
      env: row.connector_env as string,
      ...(row.connector_kind !== null ? { kind: row.connector_kind as ConnectorIdentity['kind'] } : {}),
    },
    behaviorId: row.behavior_id as string,
    objectRef: row.object_ref as string,
    payload: JSON.parse(row.payload_json as string) as Record<string, unknown>,
    status: row.status as ActionRecord['status'],
    ...(row.phase !== null ? { phase: row.phase as ActionRecord['phase'] } : {}),
    ...(row.external_ref !== null ? { externalRef: row.external_ref as string } : {}),
    ...(row.error !== null ? { error: row.error as string } : {}),
    ...(row.compensation_error !== null ? { compensationError: row.compensation_error as string } : {}),
    approvalDigest: row.approval_digest as string,
    approvedAt: row.approved_at as string,
    executedAt: row.executed_at as string,
    ...(row.compensated_at !== null ? { compensatedAt: row.compensated_at as string } : {}),
    version: row.version as number,
    tenant: (row.tenant as string) ?? '',
    intentDigest: row.intent_digest as string,
    ...(row.decision_id !== null ? { decisionId: row.decision_id as string } : {}),
    ...(row.proposal_id !== null ? { proposalId: row.proposal_id as string } : {}),
  }
}

function rowToDecision(row: Record<string, unknown>): ReviewDecision {
  return {
    decisionId: row.decision_id as string,
    runId: row.run_id as string,
    candidateIds: JSON.parse(row.candidate_ids_json as string) as string[],
    snapshotDigest: row.snapshot_digest as string,
    ruleFingerprint: row.rule_fingerprint as string,
    reviewer: row.reviewer as string,
    decision: row.decision as ReviewDecision['decision'],
    ...(row.reason !== null ? { reason: row.reason as string } : {}),
    revision: row.revision as number,
    createdAt: row.created_at as string,
  }
}

function rowToProposal(row: Record<string, unknown>): ActionProposal {
  return {
    proposalId: row.proposal_id as string,
    decisionId: row.decision_id as string,
    runId: row.run_id as string,
    candidateId: row.candidate_id as string,
    behaviorId: row.behavior_id as string,
    objectRef: row.object_ref as string,
    payload: JSON.parse(row.payload_json as string) as Record<string, unknown>,
    intentDigest: row.intent_digest as string,
    connectorId: row.connector_id as string,
    connectorEnv: row.connector_env as string,
    operationId: row.operation_id as string,
    status: row.status as ActionProposal['status'],
    createdAt: row.created_at as string,
    ...(row.consumed_at !== null ? { consumedAt: row.consumed_at as string } : {}),
  }
}

function selectAction(db: DatabaseSync, businessKey: string): StoredActionRecord | null {
  const row = db.prepare('select * from actions where business_key = ?').get(businessKey)
  return row === undefined ? null : rowToAction(row as Record<string, unknown>)
}

/** SQLite 事务台账（单机试点；多主机不在首期范围）。连接即开即关（不长持有句柄）。 */
export class ActionStore {
  private readonly dbPath: string

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(join(dbPath, '..'), { recursive: true })
    this.dbPath = dbPath
  }

  /** 即开即关：等待人工批准/网络响应不持有数据库事务与文件句柄。 */
  private withDb<T>(fn: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(this.dbPath, this.dbPath === ':memory:' ? {} : { timeout: 5_000 })
    try {
      db.exec(SCHEMA)
      return fn(db)
    } finally {
      db.close()
    }
  }

  close(): void {
    /* 连接即开即关：无长持有句柄 */
  }

  /** 占位（互斥）：唯一键失败 → 返回既有记录（同键并发只有一个派发者）。 */
  claim(record: ActionRecord & { intentDigest: string; tenant?: string }): { created: true; record: StoredActionRecord } | { created: false; existing: StoredActionRecord } {
    const at = now()
    return this.withDb((db) => {
      try {
        db.exec('begin immediate')
        db.prepare(
          `insert into actions (business_key, action_id, operation_id, tenant, intent_digest, approval_context,
            connector_id, connector_env, connector_kind, behavior_id, object_ref, payload_json, status, phase,
            approval_digest, approved_at, executed_at, decision_id, proposal_id, version, created_at, updated_at)
           values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
        ).run(
        record.businessKey,
        record.actionId,
        record.operationId ?? null,
        record.tenant ?? '',
        record.intentDigest,
        record.approvalContext,
        record.connector.id,
        record.connector.env,
        record.connector.kind ?? null,
        record.behaviorId,
        record.objectRef,
        JSON.stringify(record.payload),
        record.status,
        record.phase ?? 'claimed',
        record.approvalDigest,
        record.approvedAt,
        record.executedAt,
        record.decisionId ?? null,
        record.proposalId ?? null,
          at,
          at,
        )
        db.exec('commit')
      } catch (e) {
        try {
          db.exec('rollback')
        } catch {
          /* 事务未开启 */
        }
        const existing = selectAction(db, record.businessKey)
        if (existing !== null) {
          // 同键不同载荷/批准上下文：显式冲突（不悄悄生成新业务操作）
          if (existing.intentDigest !== record.intentDigest || existing.approvalContext !== record.approvalContext) {
            throw new AgentToolError(
              'ACTION_CONFLICT',
              `业务操作 ${record.businessKey.slice(0, 12)} 已存在但载荷/批准上下文不同——同业务键不得变更内容；`
                + '重复业务动作须显式新提案并重新批准（新 operationId）',
            )
          }
          return { created: false, existing }
        }
        throw new AgentToolError('ACTION_LEDGER_CORRUPT', `动作台账占位失败：${e instanceof Error ? e.message : String(e)}`)
      }
      const created = selectAction(db, record.businessKey)
      if (created === null) {
        throw new AgentToolError('ACTION_LEDGER_CORRUPT', '动作台账占位后不可读——fail-closed')
      }
      return { created: true, record: created }
    })
  }

  load(businessKey: string): StoredActionRecord | null {
    return this.withDb((db) => selectAction(db, businessKey))
  }

  /** CAS 终态更新：版本不符 → ACTION_LEDGER_CONFLICT（并发方已更新，不覆盖）。 */
  settle(businessKey: string, expectedVersion: number, patch: Partial<StoredActionRecord>): StoredActionRecord {
    const at = now()
    return this.withDb((db) => {
      const cur = selectAction(db, businessKey)
      if (cur === null) {
        throw new AgentToolError('ACTION_LEDGER_CORRUPT', `动作台账 ${businessKey.slice(0, 12)} 不存在——fail-closed`)
      }
      const next = { ...cur, ...patch }
      const res = db.prepare(
        `update actions set status = ?, phase = ?, external_ref = ?, error = ?, compensation_error = ?,
          approval_digest = ?, approved_at = ?, executed_at = ?, compensated_at = ?, version = version + 1, updated_at = ?
         where business_key = ? and version = ?`,
      ).run(
        next.status,
        next.phase ?? null,
        next.externalRef ?? null,
        next.error ?? null,
        next.compensationError ?? null,
        next.approvalDigest,
        next.approvedAt,
        next.executedAt,
        next.compensatedAt ?? null,
        at,
        businessKey,
        expectedVersion,
      )
      if (res.changes !== 1) {
        throw new AgentToolError(
          'ACTION_LEDGER_CONFLICT',
          `动作台账 ${businessKey.slice(0, 12)} CAS 更新失败（版本 ${expectedVersion} 已被并发方推进）——不覆盖，人工核对`,
        )
      }
      return selectAction(db, businessKey) as StoredActionRecord
    })
  }

  /** 释放占位（批准被拒/无效应回收；仅 claimed 相位可释放，不构成动作历史）。 */
  releaseClaim(businessKey: string): void {
    this.withDb((db) => {
      db.prepare('delete from actions where business_key = ? and status = ? and phase = ?')
        .run(businessKey, 'executing', 'claimed')
    })
  }

  // ── ReviewDecision / ActionProposal（D 包两次人工事件） ──────────────────

  createDecision(input: Omit<ReviewDecision, 'decisionId' | 'revision' | 'createdAt'>): ReviewDecision {
    const dec: ReviewDecision = {
      ...input,
      decisionId: shortId('DEC'),
      revision: 1,
      createdAt: now(),
    }
    this.withDb((db) => {
      db.prepare(
        `insert into decisions (decision_id, run_id, candidate_ids_json, snapshot_digest, rule_fingerprint,
          reviewer, decision, reason, revision, created_at) values (?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        dec.decisionId,
        dec.runId,
        JSON.stringify(dec.candidateIds),
        dec.snapshotDigest,
        dec.ruleFingerprint,
        dec.reviewer,
        dec.decision,
        dec.reason ?? null,
        dec.revision,
        dec.createdAt,
      )
    })
    return dec
  }

  getDecision(decisionId: string): ReviewDecision | null {
    return this.withDb((db) => {
      const row = db.prepare('select * from decisions where decision_id = ?').get(decisionId)
      return row === undefined ? null : rowToDecision(row as Record<string, unknown>)
    })
  }

  /**
   * 创建动作提案（服务端分配 operationId，提案单次消费）。
   * 前置校验（复核不可伪造）：决定存在、approved、候选在获准集合内。
   */
  createProposal(input: {
    decisionId: string
    runId: string
    candidateId: string
    behaviorId: string
    objectRef: string
    payload: Record<string, unknown>
    intentDigest: string
    connectorId: string
    connectorEnv: string
  }): ActionProposal {
    const dec = this.getDecision(input.decisionId)
    if (dec === null) {
      throw new AgentToolError('REVIEW_DECISION_NOT_FOUND', `复核决定 ${input.decisionId} 不存在——提案不得脱离复核决定`)
    }
    if (dec.decision !== 'approved') {
      throw new AgentToolError('REVIEW_NOT_APPROVED', `复核决定 ${dec.decisionId} 为 ${dec.decision}——不得对未获准决定提案动作`)
    }
    if (dec.runId !== input.runId) {
      throw new AgentToolError('REVIEW_RUN_MISMATCH', `复核决定 ${dec.decisionId} 绑定运行 ${dec.runId}，与提案运行 ${input.runId} 不符——错 run 不可套用`)
    }
    if (!dec.candidateIds.includes(input.candidateId)) {
      throw new AgentToolError(
        'REVIEW_CANDIDATE_NOT_ALLOWED',
        `候选 ${input.candidateId} 不在复核决定 ${dec.decisionId} 的获准集合内——Agent 只能对允许的候选提案动作`,
      )
    }
    const proposal: ActionProposal = {
      ...input,
      proposalId: shortId('PROP'),
      operationId: shortId('OP'),
      status: 'pending',
      createdAt: now(),
    }
    this.withDb((db) => {
      db.prepare(
        `insert into proposals (proposal_id, decision_id, run_id, candidate_id, behavior_id, object_ref,
          payload_json, intent_digest, connector_id, connector_env, operation_id, status, created_at)
         values (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        proposal.proposalId,
        proposal.decisionId,
        proposal.runId,
        proposal.candidateId,
        proposal.behaviorId,
        proposal.objectRef,
        JSON.stringify(proposal.payload),
        proposal.intentDigest,
        proposal.connectorId,
        proposal.connectorEnv,
        proposal.operationId,
        proposal.status,
        proposal.createdAt,
      )
    })
    return proposal
  }

  getProposal(proposalId: string): ActionProposal | null {
    return this.withDb((db) => {
      const row = db.prepare('select * from proposals where proposal_id = ?').get(proposalId)
      return row === undefined ? null : rowToProposal(row as Record<string, unknown>)
    })
  }

  /** 提案单次消费（执行前消费；已消费 → 显式拒绝，重复业务动作须新提案）。 */
  consumeProposal(proposalId: string): ActionProposal {
    const at = now()
    const changed = this.withDb((db) =>
      db.prepare('update proposals set status = \'consumed\', consumed_at = ? where proposal_id = ? and status = ?')
        .run(at, proposalId, 'pending').changes)
    if (changed !== 1) {
      const cur = this.getProposal(proposalId)
      if (cur === null) {
        throw new AgentToolError('PROPOSAL_NOT_FOUND', `动作提案 ${proposalId} 不存在`)
      }
      throw new AgentToolError(
        'PROPOSAL_ALREADY_CONSUMED',
        `动作提案 ${proposalId} 已消费（${cur.status}）——重复业务动作须显式新提案并重新批准`,
      )
    }
    return this.getProposal(proposalId) as ActionProposal
  }

  cancelProposal(proposalId: string): ActionProposal {
    const changed = this.withDb((db) =>
      db.prepare('update proposals set status = \'canceled\' where proposal_id = ? and status = ?')
        .run(proposalId, 'pending').changes)
    if (changed !== 1) {
      const cur = this.getProposal(proposalId)
      throw new AgentToolError(
        'PROPOSAL_NOT_PENDING',
        `动作提案 ${proposalId} 当前状态 ${cur?.status ?? '不存在'}，不可取消`,
      )
    }
    return this.getProposal(proposalId) as ActionProposal
  }

  listDecisions(runId?: string): ReviewDecision[] {
    return this.withDb((db) => {
      const rows = runId === undefined
        ? db.prepare('select * from decisions order by created_at asc').all()
        : db.prepare('select * from decisions where run_id = ? order by created_at asc').all(runId)
      return rows.map((r) => rowToDecision(r as Record<string, unknown>))
    })
  }

  listProposals(decisionId?: string): ActionProposal[] {
    return this.withDb((db) => {
      const rows = decisionId === undefined
        ? db.prepare('select * from proposals order by created_at asc').all()
        : db.prepare('select * from proposals where decision_id = ? order by created_at asc').all(decisionId)
      return rows.map((r) => rowToProposal(r as Record<string, unknown>))
    })
  }

  /** 动作台账记录（治理链末端：decision → proposal → action → externalRef）。 */
  listActions(filter?: { decisionId?: string; proposalId?: string }): StoredActionRecord[] {
    return this.withDb((db) => {
      let rows: unknown[]
      if (filter?.decisionId !== undefined) {
        rows = db.prepare('select * from actions where decision_id = ? order by created_at asc').all(filter.decisionId)
      } else if (filter?.proposalId !== undefined) {
        rows = db.prepare('select * from actions where proposal_id = ? order by created_at asc').all(filter.proposalId)
      } else {
        rows = db.prepare('select * from actions order by created_at asc').all()
      }
      return rows.map((r) => rowToAction(r as Record<string, unknown>))
    })
  }
}

const storeCache = new Map<string, ActionStore>()

/** 取（或开）工作区台账：`<root>/actions/ledger.db`。 */
export function actionStoreFor(root: string): ActionStore {
  const key = root.toLowerCase()
  let store = storeCache.get(key)
  if (store === undefined) {
    store = new ActionStore(join(root, 'actions', 'ledger.db'))
    storeCache.set(key, store)
  }
  return store
}

/** 测试/关停用：关掉并清缓存。 */
export function closeActionStore(root: string): void {
  const key = root.toLowerCase()
  const store = storeCache.get(key)
  if (store !== undefined) {
    store.close()
    storeCache.delete(key)
  }
}

// ── JSON 历史台账（只读保留）：核对 / 显式迁移 ─────────────────────────────

export interface LegacyRecordReport {
  file: string
  businessKey: string | null
  parseOk: boolean
  hasContext: boolean
}

function jsonRecordFiles(root: string): string[] {
  const dir = join(root, 'actions')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => join(dir, f))
}

/** 核对 JSON 历史台账（只读）：逐文件报告可解析性与上下文字段在缺。 */
export function verifyLegacyJsonRecords(root: string): LegacyRecordReport[] {
  return jsonRecordFiles(root).map((file) => {
    let parsed: unknown
    let parseOk = true
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      parseOk = false
    }
    const rec = parseOk && isRecord(parsed) ? parsed : null
    return {
      file,
      businessKey: typeof rec?.businessKey === 'string' ? rec.businessKey : null,
      parseOk,
      hasContext: typeof rec?.approvalContext === 'string' && rec.connector !== undefined,
    }
  })
}

/**
 * 显式迁移 JSON 历史台账 → SQLite（缺上下文记录不迁移、不自动重跑；JSON 原件只读保留）。
 * 迁移行 version=1、携带 intentDigest（无法回填时以旧摘要占位，仅供识别）。
 */
export function migrateLegacyJsonRecords(root: string): { migrated: string[]; skipped: LegacyRecordReport[] } {
  const store = actionStoreFor(root)
  const migrated: string[] = []
  const skipped: LegacyRecordReport[] = []
  for (const report of verifyLegacyJsonRecords(root)) {
    if (!report.parseOk || !report.hasContext || report.businessKey === null) {
      skipped.push(report)
      continue
    }
    const raw = JSON.parse(readFileSync(report.file, 'utf8')) as ActionRecord
    if (store.load(raw.businessKey) !== null) {
      continue
    }
    const rawDigest = (raw as unknown as Record<string, unknown>).intentDigest
    const intentDigest = typeof rawDigest === 'string' ? rawDigest : 'legacy'
    try {
      store.claim({
        ...raw,
        // 旧 executing 记录无法判断相位（claimed/dispatched），一律按效应待核实迁入（禁止自动重跑）
        status: raw.status === 'executing' ? 'unknown' : raw.status,
        intentDigest,
        tenant: (raw as unknown as Record<string, unknown>).tenant as string | undefined,
      })
    } catch {
      skipped.push(report)
      continue
    }
    migrated.push(report.file)
  }
  return { migrated, skipped }
}
