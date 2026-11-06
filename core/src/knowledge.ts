/**
 * 知识库 → LLM 解析 → 快速建模（规范 §5）。
 *
 * 硬规则（§5.3）：
 *  1. 原料永不直写包内 YAML；只产 draft 候选。
 *  2. 结论性表述禁止进入 O3 输出契约（只能落红线 forbiddenPhrases）。
 *  3. 同 (包 + 层 + kind + name) 对 pending/approved/merged 幂等跳过；rejected 不挡同名重提（恢复路径）。
 *  4. confidence < 0.75 强制人审；LLM 失败回落词面启发。
 *  5. LLM 永不直写生效版——物化只发生在人工 approve 之后。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { draftCandidateId, knowledgeSourceId, isValidId } from './ids.js'
import { isConclusionLike, parseWithFallback } from './llm.js'
import { assertWritable, loadPackage, readPackageMeta, savePackage } from './store.js'
import type {
  DraftCandidate,
  DraftItem,
  DraftProvenance,
  DraftTargetKind,
  KnowledgeSourceRecord,
  LlmPort,
  OntologyPackage,
  SkeletonRecord,
  SourceType,
} from './types.js'
import { DRAFT_TARGET_KINDS, SOURCE_TYPES } from './types.js'

/** 单源解析报告：收到/接受/幂等跳过/非法丢弃 + 引擎。 */
export interface ParseReport {
  received: number
  accepted: number
  idempotentSkipped: number
  invalidDropped: number
  engine: 'deepseek' | 'heuristic'
}

/** previewMaterialize 单条结果。 */
export interface MaterializePreviewItem {
  id: string
  ok: boolean
  error?: string
  targetKind: string
  name: string
  /** 将写入包的元素（RedLine 为 { scenarioId, phrases } 增量描述）。 */
  element?: unknown
  /** 变更摘要（人类可读一行）。 */
  summary: string
}

/**
 * 单条草案的结构化形状校验（DeepSeek 输出逐条过闸）。返回 null = 合法。
 * 只做形状闸门（已知边界）：嵌套内容（如 RedLine.phrases 元素类型、RelationType.from/to
 * 是否指向已有对象）不在此校验，由 applyDraftToPackage 物化兜底、validatePackage 终检。
 */
export function validateDraftItem(item: unknown): string | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return 'not an object'
  const it = item as Record<string, unknown>
  if (it['layer'] !== 'O1' && it['layer'] !== 'O2' && it['layer'] !== 'O3') return 'bad layer'
  if (!(DRAFT_TARGET_KINDS as readonly string[]).includes(it['targetKind'] as string)) return 'bad targetKind'
  const op = it['op']
  if (op !== undefined && op !== 'create' && op !== 'update') return 'bad op'
  if (op === 'update' && (typeof it['targetId'] !== 'string' || !it['targetId'].trim())) {
    return 'update requires targetId'
  }
  if (typeof it['name'] !== 'string' || !it['name'].trim()) return 'bad name'
  const payload = it['payload']
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'bad payload'
  // update：白名单外字段起草即拒（fail-loud；曾静默入队并在物化时报 merged，冒烟才暴露——D9）
  if (op === 'update') {
    const kind = it['targetKind'] as string
    const norm = normalizeUpdatePayload(kind, payload as Record<string, unknown>)
    const bad = findNonUpdatableKey(kind, norm)
    if (bad !== undefined) {
      return `update payload field not updatable: ${bad} (allowed: ${(UPDATABLE[kind] ?? []).join(', ')})`
    }
  }
  const rationale = it['rationale']
  if (rationale !== undefined && rationale !== null && typeof rationale !== 'string') return 'bad rationale'
  // 已知数值字段：出现即须为有限数字（null/缺省视作未填，由物化侧默认）
  const numericFields: Record<string, string[]> = {
    ScoreRule: ['weight', 'threshold'],
    ExclusionRule: ['factor'],
  }
  for (const field of numericFields[it['targetKind'] as string] ?? []) {
    const v = (payload as Record<string, unknown>)[field]
    if (v !== undefined && v !== null && (typeof v !== 'number' || !Number.isFinite(v))) {
      return `bad payload.${field}`
    }
  }
  // ScenarioCard 嵌套数值：reviewGate.threshold（NaN/Infinity 不得入库）
  if (it['targetKind'] === 'ScenarioCard') {
    const rg = (payload as Record<string, unknown>)['reviewGate']
    if (rg !== undefined && rg !== null) {
      if (typeof rg !== 'object' || Array.isArray(rg)) return 'bad payload.reviewGate'
      const th = (rg as Record<string, unknown>)['threshold']
      if (th !== undefined && th !== null && (typeof th !== 'number' || !Number.isFinite(th))) {
        return 'bad payload.reviewGate.threshold'
      }
    }
  }
  const conf = it['confidence']
  if (typeof conf !== 'number' || !Number.isFinite(conf) || conf < 0 || conf > 1) return 'bad confidence'
  return null
}

export class KnowledgeError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'KnowledgeError'
    this.code = code
  }
}

/**
 * CONCLUSION_BLOCKED 统一路径指引（D5）：拒绝即给可执行落法——
 * 此前只说「只能落 RedLine」，恢复路径靠调用方自悟。
 */
const REDLINE_HOWTO =
  '（正确路径：新草案 targetKind=RedLine、targetId=场景ID、payload.phrases=[短语…]，追加进该场景 forbiddenPhrases）'

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** packageId 归一：知识管线约定裸包名（meta.name）；`name@version` 形态剥版本段（幂等）。 */
function normalizePackageId(packageId: string): string {
  // wire 直传可能非 string（原代码直接 .lastIndexOf 裸抛 TypeError）——一律受控错误面。
  // 空串按原语义保留（listSources('') 过滤无匹配返回 []，不抛错）；写入路径另拒空。
  if (typeof packageId !== 'string') {
    throw new KnowledgeError('BAD_PACKAGE_ID', `packageId 必须是字符串: ${JSON.stringify(packageId)}`)
  }
  const at = packageId.lastIndexOf('@')
  return at > 0 ? packageId.slice(0, at) : packageId
}

/** 对话开局骨架存储（conversational-modeling P3/I6）：`<dataDir>/knowledge/skeletons/<pkg>.json`。 */
export class SkeletonStore {
  readonly root: string

  constructor(dataDir: string) {
    this.root = join(dataDir, 'knowledge', 'skeletons')
    mkdirSync(this.root, { recursive: true })
  }

  private pathOf(packageId: string): string {
    return join(this.root, `${normalizePackageId(packageId)}.json`)
  }

  /** 读取骨架；不存在返回 null（无骨架 = 不启用 I6 门，保持既有管线兼容）。 */
  get(packageId: string): SkeletonRecord | null {
    try {
      const p = this.pathOf(packageId)
      if (!existsSync(p)) return null
      const rec = JSON.parse(readFileSync(p, 'utf8')) as SkeletonRecord
      if (!rec || typeof rec !== 'object' || !Array.isArray(rec.ids)) return null
      return rec
    } catch {
      return null
    }
  }

  /** 保存骨架（updatedAt 每次刷新）。 */
  save(rec: Omit<SkeletonRecord, 'updatedAt'>): SkeletonRecord {
    if (typeof rec.packageId !== 'string' || normalizePackageId(rec.packageId) === '') {
      throw new KnowledgeError('BAD_PACKAGE_ID', 'skeleton packageId 不得为空')
    }
    if (!Array.isArray(rec.ids)) {
      throw new KnowledgeError('BAD_SKELETON', 'skeleton.ids 必须是字符串数组')
    }
    const next: SkeletonRecord = {
      ...rec,
      packageId: normalizePackageId(rec.packageId),
      ids: rec.ids.map(String),
      updatedAt: new Date().toISOString(),
    }
    writeFileSync(this.pathOf(next.packageId), `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    return next
  }
}

/** 知识库存储（profile 数据目录下的一等运行时状态）。 */
export class KnowledgeStore {
  readonly root: string
  /** 对话骨架（同数据目录）；skeleton 门在 materialize 前置（I6）。 */
  readonly skeletons: SkeletonStore

  constructor(dataDir: string) {
    this.root = join(dataDir, 'knowledge')
    this.skeletons = new SkeletonStore(dataDir)
    mkdirSync(join(this.root, 'sources'), { recursive: true })
    if (!existsSync(this.queuePath)) writeFileSync(this.queuePath, '[]\n', 'utf8')
  }

  private get queuePath(): string {
    return join(this.root, 'queue.json')
  }

  private loadQueue(): DraftCandidate[] {
    try {
      return JSON.parse(readFileSync(this.queuePath, 'utf8')) as DraftCandidate[]
    } catch {
      return []
    }
  }

  private saveQueue(queue: DraftCandidate[]): void {
    writeFileSync(this.queuePath, `${JSON.stringify(queue, null, 2)}\n`, 'utf8')
  }

  /* ── 上传（sha256 幂等） ────────────────────────────────────────────── */

  uploadSource(input: {
    packageId: string
    sourceType: SourceType
    name: string
    content: string
  }): KnowledgeSourceRecord {
    if (!SOURCE_TYPES.includes(input.sourceType)) {
      throw new KnowledgeError('BAD_SOURCE_TYPE', `unknown sourceType ${input.sourceType}`)
    }
    // packageId 归一为裸包名（meta.name）：知识管线唯一约定；`name@version` 形态剥版本段（幂等），
    // 工具面/工作台/wire 直传两种写法入库一致（S2.6 闭环）。写入路径空串拒绝（空 packageId 不入库）。
    const packageId = normalizePackageId(input.packageId)
    if (packageId === '') {
      throw new KnowledgeError('BAD_PACKAGE_ID', 'packageId 不得为空')
    }
    const sha256 = sha256Hex(input.content)
    const existing = this.listSources().find(
      (s) => s.sha256 === sha256 && normalizePackageId(s.packageId) === packageId,
    )
    if (existing) return existing
    const id = knowledgeSourceId(`${packageId}|${input.sourceType}|${input.name}|${sha256}`)
    const record: KnowledgeSourceRecord = {
      id,
      packageId,
      sourceType: input.sourceType,
      name: input.name,
      content: input.content,
      sha256,
      parseStatus: 'uploaded',
      uploadedAt: new Date().toISOString(),
    }
    writeFileSync(join(this.root, 'sources', `${id}.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    return record
  }

  listSources(packageId?: string): KnowledgeSourceRecord[] {
    const dir = join(this.root, 'sources')
    const want = packageId === undefined ? undefined : normalizePackageId(packageId)
    const out: KnowledgeSourceRecord[] = []
    for (const f of readdirSafe(dir)) {
      if (!f.endsWith('.json')) continue
      try {
        const rec = JSON.parse(readFileSync(join(dir, f), 'utf8')) as KnowledgeSourceRecord
        if (!want || normalizePackageId(rec.packageId) === want) out.push(rec)
      } catch {
        /* skip */
      }
    }
    return out.sort((a, b) => (a.uploadedAt < b.uploadedAt ? -1 : 1))
  }

  getSource(id: string): KnowledgeSourceRecord {
    const path = join(this.root, 'sources', `${id}.json`)
    if (!existsSync(path)) throw new KnowledgeError('SOURCE_NOT_FOUND', `source ${id} not found`)
    return JSON.parse(readFileSync(path, 'utf8')) as KnowledgeSourceRecord
  }

  /* ── 解析（LLM → 候选队列；幂等） ──────────────────────────────────── */

  async parseSource(
    sourceId: string,
    llm: LlmPort,
  ): Promise<{ added: DraftCandidate[]; engine: 'deepseek' | 'heuristic'; report: ParseReport }> {
    const src = this.getSource(sourceId)
    const { items, engine } = await parseWithFallback(llm, {
      sourceType: src.sourceType,
      content: src.content,
      packageName: src.packageId,
    })
    const queue = this.loadQueue()
    const added: DraftCandidate[] = []
    let invalidDropped = 0
    let idempotentSkipped = 0
    for (const raw of items) {
      if (validateDraftItem(raw) !== null) {
        invalidDropped++
        continue
      }
      const item = raw as DraftItem
      // 幂等键用 sourceName（解析原始名）；人审改 name 不影响同源去重；update 按 targetId 区分
      const nm = item.name
      const key =
        item.op === 'update'
          ? `${src.packageId}|${item.layer}|${item.targetKind}|${item.targetId}|${nm}`
          : `${src.packageId}|${item.layer}|${item.targetKind}|${nm}`
      const sameKey = (c: DraftCandidate): boolean =>
        c.op === 'update'
          ? `${c.packageId}|${c.layer}|${c.targetKind}|${c.targetId}|${c.sourceName ?? c.name}` === key
          : `${c.packageId}|${c.layer}|${c.targetKind}|${c.sourceName ?? c.name}` === key
      // 幂等只挡在途/已定稿（pending/approved/merged）；rejected 不挡——驳回后可同名重解析（D6 恢复路径）
      if (queue.some((c) => sameKey(c) && c.status !== 'rejected')) {
        idempotentSkipped++
        continue
      }
      const retries = queue.filter(sameKey).length
      const conclusionLike = isConclusionLike(item)
      const cand: DraftCandidate = {
        ...item,
        id: draftCandidateId(retries === 0 ? key : `${key}|retry-${retries}`),
        packageId: src.packageId,
        sourceId,
        sourceName: item.name,
        status: 'pending',
        forcedReview: item.confidence < 0.75,
        conclusionLike,
        provenance: { sourceId },
        createdAt: new Date().toISOString(),
      }
      queue.push(cand)
      added.push(cand)
    }
    this.saveQueue(queue)
    src.parseStatus = 'parsed'
    writeFileSync(join(this.root, 'sources', `${sourceId}.json`), `${JSON.stringify(src, null, 2)}\n`, 'utf8')
    const report: ParseReport = {
      received: items.length,
      accepted: added.length,
      idempotentSkipped,
      invalidDropped,
      engine,
    }
    return { added, engine, report }
  }

  /* ── 人审队列 ──────────────────────────────────────────────────────── */

  /**
   * 对话轮直起草（conversational-modeling P3：draft_elements 落点）。
   * 与 parseSource 同闸门：validateDraftItem / 幂等键 / conclusionLike / forcedReview；
   * 永远只入草案队列（pending），不写包（I1）。
   */
  addDraft(input: {
    packageId: string
    item: DraftItem
    provenance?: DraftProvenance
  }): DraftCandidate {
    const packageId = normalizePackageId(input.packageId)
    if (packageId === '') {
      throw new KnowledgeError('BAD_PACKAGE_ID', 'packageId 不得为空')
    }
    const bad = validateDraftItem(input.item)
    if (bad) throw new KnowledgeError('BAD_DRAFT', `draft invalid: ${bad}`)
    const item = input.item
    const nm = item.name
    const key =
      item.op === 'update'
        ? `${packageId}|${item.layer}|${item.targetKind}|${item.targetId}|${nm}`
        : `${packageId}|${item.layer}|${item.targetKind}|${nm}`
    const queue = this.loadQueue()
    const sameKey = (c: DraftCandidate): boolean =>
      c.op === 'update'
        ? `${c.packageId}|${c.layer}|${c.targetKind}|${c.targetId}|${c.sourceName ?? c.name}` === key
        : `${c.packageId}|${c.layer}|${c.targetKind}|${c.sourceName ?? c.name}` === key
    // 幂等只挡在途/已定稿；rejected 同名允许重新起草（驳回→修复→重提的恢复路径，D6）
    const matches = queue.filter(sameKey)
    const live = matches.find((c) => c.status !== 'rejected')
    if (live) return live
    const retries = matches.length
    const cand: DraftCandidate = {
      ...item,
      id: draftCandidateId(retries === 0 ? key : `${key}|retry-${retries}`),
      packageId,
      sourceId: input.provenance?.sourceId ?? '',
      sourceName: item.name,
      status: 'pending',
      forcedReview: item.confidence < 0.75,
      conclusionLike: isConclusionLike(item),
      provenance: input.provenance ?? {},
      createdAt: new Date().toISOString(),
    }
    queue.push(cand)
    this.saveQueue(queue)
    return cand
  }

  listCandidates(filter?: { packageId?: string; status?: DraftCandidate['status'] }): DraftCandidate[] {
    const want = filter?.packageId ? normalizePackageId(filter.packageId) : undefined
    return this.loadQueue().filter(
      (c) => (!want || normalizePackageId(c.packageId) === want) && (!filter?.status || c.status === filter.status),
    )
  }

  getCandidate(id: string): DraftCandidate {
    const c = this.loadQueue().find((x) => x.id === id)
    if (!c) throw new KnowledgeError('CANDIDATE_NOT_FOUND', `candidate ${id} not found`)
    return c
  }

  /**
   * 批准前编辑草案载荷（人审动作的一部分；仅 pending 可改）。
   * 改 confidence 会重算 forcedReview；改内容会重算 conclusionLike；合入后整条复检非法即拒存。
   */
  updateCandidate(
    id: string,
    patch: { name?: string; payload?: Record<string, unknown>; rationale?: string; confidence?: number },
  ): DraftCandidate {
    const queue = this.loadQueue()
    const c = queue.find((x) => x.id === id)
    if (!c) throw new KnowledgeError('CANDIDATE_NOT_FOUND', `candidate ${id} not found`)
    if (c.status !== 'pending') {
      throw new KnowledgeError('CANDIDATE_FINALIZED', `candidate ${id} already ${c.status}`)
    }
    const next: DraftCandidate = { ...c }
    if (patch.payload !== undefined) next.payload = patch.payload
    if (patch.name !== undefined) {
      // 改名同步 payload.name（物化侧 payload.name 优先）；仅当 payload.name 与旧名一致
      // （解析时的自动副本）才同步。patch.payload 显式带 name 键视为故意保留，不覆盖。
      const explicitName =
        patch.payload !== undefined && Object.prototype.hasOwnProperty.call(patch.payload, 'name')
      const pay = next.payload
      if (!explicitName && pay && typeof pay === 'object' && (pay as Record<string, unknown>)['name'] === c.name) {
        next.payload = { ...(pay as Record<string, unknown>), name: patch.name }
      }
      next.name = patch.name
    }
    if (patch.rationale !== undefined) next.rationale = patch.rationale
    if (patch.confidence !== undefined) {
      if (!Number.isFinite(patch.confidence) || patch.confidence < 0 || patch.confidence > 1) {
        throw new KnowledgeError('BAD_CONFIDENCE', 'confidence must be a number in [0,1]')
      }
      next.confidence = patch.confidence
    }
    // 合入后整条复检（空 name / 非对象 payload / 非数值 weight 等一律拒存）
    const bad = validateDraftItem(next)
    if (bad) throw new KnowledgeError('BAD_DRAFT', `draft invalid after edit: ${bad}`)
    next.forcedReview = next.confidence < 0.75
    next.conclusionLike = isConclusionLike(next)
    Object.assign(c, next)
    this.saveQueue(queue)
    return c
  }

  /**
   * 人审动作：approve / reject / merge（合并进已有元素名）。
   * LLM/agent 路径永不绕过此入口直写包。
   */
  reviewCandidate(
    id: string,
    action: 'approve' | 'reject' | 'merge',
    opts: { mergeIntoName?: string; reviewedBy?: string } = {},
  ): DraftCandidate {
    const queue = this.loadQueue()
    const c = queue.find((x) => x.id === id)
    if (!c) throw new KnowledgeError('CANDIDATE_NOT_FOUND', `candidate ${id} not found`)
    if (c.status !== 'pending') {
      throw new KnowledgeError('CANDIDATE_FINALIZED', `candidate ${id} already ${c.status}`)
    }
    if (action === 'approve') {
      // 结论性表述不允许批准进任何非 RedLine 目标（§5.3.2）
      if (c.conclusionLike && c.targetKind !== 'RedLine') {
        throw new KnowledgeError(
          'CONCLUSION_BLOCKED',
          `结论性表述禁止进入 ${c.targetKind}（只能落 RedLine 红线）${REDLINE_HOWTO}`,
        )
      }
      c.status = 'approved'
    } else if (action === 'reject') {
      c.status = 'rejected'
    } else {
      if (!opts.mergeIntoName) {
        throw new KnowledgeError('MERGE_TARGET_REQUIRED', 'merge requires mergeIntoName')
      }
      c.status = 'merged'
      c.payload = { ...c.payload, mergeInto: opts.mergeIntoName }
    }
    // 人审留痕（I1/I5）：谁在哪个面执行了审定动作，入队列可审计回看。
    if (opts.reviewedBy !== undefined) c.reviewedBy = String(opts.reviewedBy)
    c.reviewedAt = new Date().toISOString()
    this.saveQueue(queue)
    return c
  }

  /* ── 物化（approved → 包 YAML；ISSUED 拒绝） ───────────────────────── */

  /**
   * 将 approved 候选物化进包版本目录。硬规则：
   * - 只物化 status=approved 的候选（pending/forcedReview 未过人审的拒绝）
   * - ISSUED 包拒绝写入（§3.4）
   * - 结论性表述只落 forbiddenPhrases 红线，绝不进输出契约（§5.3.2）
   */
  materialize(versionDir: string, candidateIds: string[]): { applied: string[]; skipped: Array<{ id: string; reason: string }> } {
    const meta = readPackageMeta(versionDir)
    const queue = this.loadQueue()
    const applied: string[] = []
    const skipped: Array<{ id: string; reason: string }> = []

    const targets = candidateIds.map((id) => {
      const c = queue.find((x) => x.id === id)
      if (!c) throw new KnowledgeError('CANDIDATE_NOT_FOUND', `candidate ${id} not found`)
      return c
    })
    // I6 骨架门：骨架存在且未确认 → 全部拒物化（无骨架记录 = 不启用，保持既有管线兼容）。
    const skeleton = this.skeletons.get(meta.name)
    if (skeleton && !skeleton.confirmed) {
      for (const c of targets) {
        skipped.push({ id: c.id, reason: 'skeleton 未确认，不得物化（I6）' })
      }
      return { applied, skipped }
    }
    const inSkeleton = (id: string): boolean => !skeleton || skeleton.ids.includes(id)
    const eligible: typeof targets = []
    for (const c of targets) {
      // 比较前归一（旧数据可能存 name@version）：与 uploadSource 入库口径一致，避免误判 mismatch。
      if (typeof c.packageId !== 'string' || normalizePackageId(c.packageId) !== meta.name) {
        skipped.push({ id: c.id, reason: `package mismatch: 候选属于 ${c.packageId}，目标包为 ${meta.name}` })
        continue
      }
      if (c.status !== 'approved') {
        skipped.push({ id: c.id, reason: `status=${c.status}，未经人审批准不得物化` })
        continue
      }
      // 显式 payload.id 超骨架 → 拒（ID 漂移源头拦截）。
      const explicitId = (c.payload as Record<string, unknown> | undefined)?.['id']
      if (typeof explicitId === 'string' && explicitId && !inSkeleton(explicitId)) {
        skipped.push({ id: c.id, reason: `ID ${explicitId} 不在骨架内（I6）` })
        continue
      }
      eligible.push(c)
    }
    if (eligible.length === 0) return { applied, skipped }

    // ISSUED 拒写（对 agent 路径是一等硬约束）
    try {
      assertWritable(versionDir)
    } catch (e) {
      throw new KnowledgeError(
        'PACKAGE_READONLY',
        `${meta.name}@${meta.version} 已签发，知识物化拒绝写入（先 fork 新版本）`,
      )
    }

    const pkg = loadPackage(versionDir)
    const weightTouched = new Set<string>()
    for (const c of eligible) {
      // 自动分配 ID 也必须在骨架内：先干跑应用，超界即回滚该条（I6 全覆盖）。
      // 口径：I6 只约束新增 Schema ID；update/属性/红线不新增 ID，按 ID 段对照骨架。
      const before = snapshotPkg(pkg)
      try {
        c.appliedAs = applyDraftToPackage(pkg, c)
        const idSegment = c.appliedAs.split('.')[0]
        if (!inSkeleton(idSegment)) {
          restorePkg(pkg, before)
          delete c.appliedAs
          skipped.push({ id: c.id, reason: `ID ${idSegment} 不在骨架内（I6）` })
          continue
        }
        if (c.op === 'update' && c.targetKind === 'ScoreRule' && 'weight' in (c.payload ?? {})) {
          weightTouched.add(c.appliedAs)
        }
        applied.push(c.id)
      } catch (e) {
        skipped.push({ id: c.id, reason: e instanceof Error ? e.message : String(e) })
      }
    }
    // 权重联动归一（P3）：显式权重为准，未动规则吸收残差并同步技能模板——批量一次，避免互相打架。
    if (weightTouched.size > 0) renormalizeWeights(pkg, weightTouched)
    savePackage(versionDir, pkg)

    for (const c of queue) {
      if (applied.includes(c.id)) c.status = 'merged'
    }
    this.saveQueue(queue)
    return { applied, skipped }
  }

  /**
   * 干跑预览：把候选应用到包模型副本，返回每个候选将物化成的元素/变更，不落盘。
   * 不校验 status（批准前也要能看 diff）；不拒 ISSUED（只读预览）。
   * 与 materialize 同语义：共享一份副本按序累积应用（后条可见前条的插入）。
   */
  previewMaterialize(versionDir: string, candidateIds: string[]): MaterializePreviewItem[] {
    const meta = readPackageMeta(versionDir)
    const pkg = loadPackage(versionDir)
    const queue = this.loadQueue()
    const out: MaterializePreviewItem[] = []
    for (const id of candidateIds) {
      const c = queue.find((x) => x.id === id)
      if (!c) {
        out.push({ id, ok: false, error: `candidate ${id} not found`, targetKind: '-', name: '-', summary: '' })
        continue
      }
      if (typeof c.packageId !== 'string' || normalizePackageId(c.packageId) !== meta.name) {
        out.push({
          id,
          ok: false,
          error: `candidate ${id} belongs to package ${c.packageId}, not ${meta.name}`,
          targetKind: c.targetKind,
          name: c.name,
          summary: '',
        })
        continue
      }
      try {
        const before = snapshotPkg(pkg)
        applyDraftToPackage(pkg, c)
        const delta = diffSnapshot(before, snapshotPkg(pkg))
        // Attribute 的 diff 定位到宿主对象，摘要补上属性名便于人审定位
        const summary = c.targetKind === 'Attribute' ? `属性「${c.name}」→ ${delta.summary}` : delta.summary
        out.push({ id, ok: true, targetKind: c.targetKind, name: c.name, element: delta.element, summary })
      } catch (e) {
        out.push({
          id,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          targetKind: c.targetKind,
          name: c.name,
          summary: '',
        })
      }
    }
    return out
  }
}

/** 包模型快照：各集合的 JSON 串（用于干跑 diff）。 */
function snapshotPkg(pkg: OntologyPackage): Record<string, string> {
  return {
    objects: JSON.stringify(pkg.objects),
    relations: JSON.stringify(pkg.relations),
    dictionaries: JSON.stringify(pkg.dictionaries),
    behaviors: JSON.stringify(pkg.behaviors),
    scoreRules: JSON.stringify(pkg.scoreRules),
    exclusionRules: JSON.stringify(pkg.exclusionRules),
    skillTemplates: JSON.stringify(pkg.skillTemplates),
    scenarios: JSON.stringify(pkg.scenarios),
    fieldMaps: JSON.stringify(pkg.fieldMaps),
    apiSources: JSON.stringify(pkg.apiSources),
  }
}

/** 从快照还原内存模型（骨架门超界回滚单条草案）。 */
function restorePkg(pkg: OntologyPackage, snap: Record<string, string>): void {
  pkg.objects = JSON.parse(snap.objects)
  pkg.relations = JSON.parse(snap.relations)
  pkg.dictionaries = JSON.parse(snap.dictionaries)
  pkg.behaviors = JSON.parse(snap.behaviors)
  pkg.scoreRules = JSON.parse(snap.scoreRules)
  pkg.exclusionRules = JSON.parse(snap.exclusionRules)
  pkg.skillTemplates = JSON.parse(snap.skillTemplates)
  pkg.scenarios = JSON.parse(snap.scenarios)
  pkg.fieldMaps = JSON.parse(snap.fieldMaps)
  pkg.apiSources = JSON.parse(snap.apiSources)
}

function diffSnapshot(
  before: Record<string, string>,
  after: Record<string, string>,
): { element: unknown; summary: string } {
  const labels: Record<string, string> = {
    objects: 'ObjectType',
    relations: 'RelationType',
    dictionaries: 'Dictionary',
    behaviors: 'BehaviorType',
    scoreRules: 'ScoreRule',
    exclusionRules: 'ExclusionRule',
    skillTemplates: 'SkillTemplate',
    scenarios: 'ScenarioCard',
    fieldMaps: 'FieldMap',
    apiSources: 'ApiSource',
  }
  const parts: string[] = []
  const elements: unknown[] = []
  for (const key of Object.keys(before)) {
    if (before[key] === after[key]) continue
    const arr = JSON.parse(after[key]) as unknown[]
    const prev = JSON.parse(before[key]) as unknown[]
    // 新增元素：取数组尾部差异；修改元素（RedLine 改 forbiddenPhrases）：取全部变化项
    const changed = arr.length > prev.length ? arr.slice(prev.length) : arr.filter((x, i) => JSON.stringify(x) !== JSON.stringify(prev[i]))
    if (changed.length === 0) {
      parts.push('（变更未定位）')
      continue
    }
    if (key === 'scenarios') {
      for (const el of changed) {
        const s = el as { id?: string; name?: string; outputContract?: { forbiddenPhrases?: string[] } }
        const prevRaw = prev.find((x) => (x as { id?: string }).id === s.id)
        if (prevRaw === undefined) {
          // 新建场景卡：展示整元素（RedLine 禁语增量只适用于已存在场景的原地合并）
          elements.push(el)
          parts.push(`→ ${labels[key]} ${s.id ?? ''}${s.name ? `「${s.name}」` : ''}`)
          continue
        }
        const prevS = prevRaw as { outputContract?: { forbiddenPhrases?: string[] } }
        const beforePhrases = new Set(prevS.outputContract?.forbiddenPhrases ?? [])
        const newPhrases = (s.outputContract?.forbiddenPhrases ?? []).filter((p) => !beforePhrases.has(p))
        if (newPhrases.length > 0) {
          elements.push({ scenarioId: s.id, phrases: newPhrases })
          parts.push(`→ ${labels[key]} ${s.id ?? ''} 禁语 +${newPhrases.length}: ${newPhrases.join('、')}`)
        } else {
          elements.push(el)
          parts.push(`→ ${labels[key]} ${s.id ?? ''}（内容变更）`)
        }
      }
      continue
    }
    for (const el of changed) {
      elements.push(el)
      const id = (el as { id?: string })?.id ?? '?'
      const name = (el as { name?: string })?.name ?? ''
      parts.push(`→ ${labels[key]} ${id}${name ? `「${name}」` : ''}`)
    }
  }
  if (parts.length === 0) return { element: null, summary: '（无变化）' }
  // 单项保持原形状（element = 单个元素/RedLine 增量）；多项返回数组
  return { element: elements.length === 1 ? elements[0] : elements, summary: parts.join('；') }
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 草案 → 包模型
 * ═══════════════════════════════════════════════════════════════════════════ */

const MAX_ID_SEQ = 900

function nextId(pkg: OntologyPackage, prefix: string, tag: string): string {
  const taken = new Set<string>()
  for (const o of pkg.objects) taken.add(o.id)
  for (const r of pkg.relations) taken.add(r.id)
  for (const b of pkg.behaviors) taken.add(b.id)
  for (const r of pkg.scoreRules) taken.add(r.id)
  for (const r of pkg.exclusionRules) taken.add(r.id)
  for (const s of pkg.skillTemplates) taken.add(s.id)
  for (const s of pkg.scenarios) taken.add(s.id)
  for (const f of pkg.fieldMaps) taken.add(f.id)
  for (const s of pkg.apiSources) taken.add(s.id)
  for (let i = 1; i < MAX_ID_SEQ; i++) {
    const id = `${prefix}-${tag}-${i}`
    if (!taken.has(id)) return id
  }
  throw new KnowledgeError('ID_EXHAUSTED', `cannot allocate ${prefix}-${tag}-* id`)
}

function tagOf(pkg: OntologyPackage): string {
  const domain = (pkg.meta.domain || 'GEN').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'GEN'
  return domain.slice(0, 12)
}

/* ── 更新/接线（conversational-modeling P3：op='update'） ───────────────── */

/** 各 targetKind 可更新字段（与 create 分支同源；未列字段一律拒改，防脏键入包）。 */
const UPDATABLE: Record<string, string[]> = {
  ObjectType: ['name', 'idRule', 'attributes', 'lifecycle'],
  RelationType: ['name', 'from', 'to', 'attributes'],
  Attribute: ['name', 'type', 'refObject', 'enumValuesRef'],
  Dictionary: ['name', 'values'],
  BehaviorType: ['name', 'anchor', 'relations', 'states', 'trigger'],
  ScoreRule: ['name', 'description', 'weight', 'expression', 'threshold', 'evidenceTemplate'],
  ExclusionRule: ['name', 'action', 'factor', 'condition'],
  SkillTemplate: ['name', 'weights', 'steps', 'outputTemplate'],
  ScenarioCard: ['name', 'goal', 'boundary', 'inputs', 'outputs', 'pipeline', 'behaviorRefs', 'exclusionRefs', 'scoreRefs', 'outputContract', 'reviewGate', 'auditChecks'],
  FieldMap: ['name', 'source', 'target'],
  ApiSource: ['name', 'sourceType', 'endpoint'],
}

const clamp01 = (w: number): number => Math.min(1, Math.max(0, w))

/**
 * update 载荷归一（与 create 同源，消除字段路径不对称）：
 * ScenarioCard 顶层 `mustInclude` → `outputContract.mustInclude`（create 分支即读顶层，
 * update 白名单只认 outputContract——曾导致同一字段 create 可写、update 静默丢失）。
 */
function normalizeUpdatePayload(kind: string, payload: Record<string, unknown>): Record<string, unknown> {
  if (kind !== 'ScenarioCard' || payload['mustInclude'] === undefined) return payload
  const { mustInclude, ...rest } = payload
  const oc = rest['outputContract']
  const base = oc !== null && typeof oc === 'object' && !Array.isArray(oc) ? (oc as Record<string, unknown>) : {}
  return { ...rest, outputContract: { ...base, mustInclude } }
}

/**
 * update 白名单检查：返回首个非法键（meta 键 targetId/op/append 结构另行处理）。
 * 无 UPDATABLE 登记的 kind（RedLine 等）不做键集约束，由各自专用规则拒绝。
 */
function findNonUpdatableKey(kind: string, payload: Record<string, unknown>): string | undefined {
  const allowedList = UPDATABLE[kind]
  if (!allowedList) return undefined
  const allow = new Set(allowedList)
  for (const k of Object.keys(payload)) {
    if (k === 'targetId' || k === 'op' || k === 'append') continue
    if (!allow.has(k)) return k
  }
  const ap = payload['append']
  if (ap !== null && typeof ap === 'object' && !Array.isArray(ap)) {
    for (const k of Object.keys(ap as Record<string, unknown>)) {
      if (!allow.has(k)) return `append.${k}`
    }
  }
  return undefined
}

/** 合并更新载荷到既有元素：标量覆盖、对象浅并（weights 按键并入）、数组整替；`append.<field>` 追加去重（接线）。 */
function mergeUpdateFields(el: Record<string, unknown>, payload: Record<string, unknown>, kind: string): void {
  const eff = normalizeUpdatePayload(kind, payload)
  const bad = findNonUpdatableKey(kind, eff)
  if (bad !== undefined) {
    throw new KnowledgeError(
      'UPDATE_FIELD_NOT_UPDATABLE',
      `update payload field not updatable: ${bad} (allowed: ${(UPDATABLE[kind] ?? []).join(', ')})`,
    )
  }
  const allowed = new Set(UPDATABLE[kind] ?? [])
  for (const [k, v] of Object.entries(eff)) {
    if (k === 'targetId' || k === 'op' || k === 'append') continue
    if (v === undefined) continue
    const cur = el[k]
    if (
      cur !== null && typeof cur === 'object' && !Array.isArray(cur) &&
      v !== null && typeof v === 'object' && !Array.isArray(v)
    ) {
      el[k] = { ...(cur as Record<string, unknown>), ...(v as Record<string, unknown>) }
    } else {
      el[k] = v
    }
  }
  const append = eff['append']
  if (append && typeof append === 'object' && !Array.isArray(append)) {
    for (const [k, v] of Object.entries(append as Record<string, unknown>)) {
      if (!allowed.has(k) || !Array.isArray(v)) continue
      const cur = Array.isArray(el[k]) ? (el[k] as unknown[]) : []
      const seen = new Set(cur.map((x) => JSON.stringify(x)))
      const add = (v as unknown[]).filter((x) => {
        const s = JSON.stringify(x)
        if (seen.has(s)) return false
        seen.add(s)
        return true
      })
      el[k] = [...cur, ...add]
    }
  }
}

/**
 * op='update' 物化：按 targetId 定位既有元素做增量合并（改权重/阈值/接线），
 * 不新增 ID（I6 口径：门禁只约束新增）；返回 targetId（溯源 I2）。
 */
function applyUpdateToPackage(pkg: OntologyPackage, c: DraftCandidate): string {
  const targetId = String(c.targetId ?? '').trim()
  if (targetId === '') throw new KnowledgeError('UPDATE_TARGET_NOT_FOUND', 'update 草案缺 targetId')
  if (c.targetKind === 'RedLine') {
    throw new KnowledgeError('BAD_TARGET_KIND', 'RedLine 只支持追加（create），不支持 update')
  }
  if (c.conclusionLike) {
    throw new KnowledgeError('CONCLUSION_BLOCKED', `结论性表述禁止进入业务元素（只能落 RedLine）${REDLINE_HOWTO}`)
  }
  const p = (c.payload ?? {}) as Record<string, unknown>

  if (c.targetKind === 'Attribute') {
    const dot = targetId.indexOf('.')
    const ownerId = dot > 0 ? targetId.slice(0, dot) : ''
    const attrName = dot > 0 ? targetId.slice(dot + 1) : ''
    const owner =
      pkg.objects.find((o) => o.id === ownerId) ?? pkg.relations.find((r) => r.id === ownerId)
    const attr = owner?.attributes?.find((a) => a.name === attrName)
    if (!owner || !attr) throw new KnowledgeError('UPDATE_TARGET_NOT_FOUND', `属性不存在: ${targetId}`)
    mergeUpdateFields(attr as unknown as Record<string, unknown>, p, 'Attribute')
    return targetId
  }

  const tables: Partial<Record<DraftTargetKind, Array<{ id: string; name?: string }>>> = {
    ObjectType: pkg.objects,
    RelationType: pkg.relations,
    Dictionary: pkg.dictionaries,
    BehaviorType: pkg.behaviors,
    ScoreRule: pkg.scoreRules,
    ExclusionRule: pkg.exclusionRules,
    SkillTemplate: pkg.skillTemplates,
    ScenarioCard: pkg.scenarios,
    FieldMap: pkg.fieldMaps,
    ApiSource: pkg.apiSources,
  }
  const table = tables[c.targetKind]
  const el = table?.find((x) => x.id === targetId || (x.name !== undefined && x.name === targetId))
  if (!el) throw new KnowledgeError('UPDATE_TARGET_NOT_FOUND', `元素不存在: ${targetId}`)
  mergeUpdateFields(el as unknown as Record<string, unknown>, p, c.targetKind)
  return el.id
}

/**
 * 打分规则权重归一（P3「权重联动自动归一」）：显式改过权重的规则（fixedIds）保持原值，
 * 未动规则按比例吸收残差至合计 1.0；随后把规则权重同步进各技能模板（同权口径，
 * 消除手抄漂移）。批量一次调用——避免同批多条权重更新互相打架。
 */
export function renormalizeWeights(pkg: OntologyPackage, fixedIds: ReadonlySet<string>): void {
  const rules = pkg.scoreRules
  if (rules.length === 0) return
  const fixed = rules.filter((r) => fixedIds.has(r.id))
  const others = rules.filter((r) => !fixedIds.has(r.id))
  for (const r of fixed) r.weight = clamp01(r.weight)
  if (others.length === 0) {
    syncSkillWeights(pkg) // 全显式：数值交给 WEIGHT_SUM 校验，键集仍须同步
    return
  }
  const fixedSum = fixed.reduce((a, r) => a + r.weight, 0)
  const target = Math.max(0, 1 - fixedSum)
  const othersSum = others.reduce((a, r) => a + Math.max(0, r.weight), 0)
  if (othersSum <= 0) {
    const each = target / others.length
    for (const r of others) r.weight = each
  } else {
    for (const r of others) r.weight = (Math.max(0, r.weight) / othersSum) * target
  }
  const sum = rules.reduce((a, r) => a + r.weight, 0)
  const residual = 1 - sum
  if (residual !== 0) {
    const biggest = others.reduce((a, b) => (b.weight > a.weight ? b : a))
    biggest.weight += residual
  }
  syncSkillWeights(pkg)
}

/** 技能模板权重与规则同权（WEIGHT_SET_MISMATCH 口径：键集与数值全等）。 */
function syncSkillWeights(pkg: OntologyPackage): void {
  const map = Object.fromEntries(pkg.scoreRules.map((r) => [r.id, r.weight]))
  for (const s of pkg.skillTemplates) s.weights = { ...map }
}

/** 把一条 approved 草案应用到内存模型（RedLine 红线特殊路由）；返回物化的元素 ID（溯源 I2）。 */
export function applyDraftToPackage(pkg: OntologyPackage, c: DraftCandidate): string {
  const p = c.payload ?? {}
  const tag = tagOf(pkg)

  if (c.op === 'update') {
    return applyUpdateToPackage(pkg, c)
  }
  if (c.targetKind === 'RedLine') {
    // 结论性表述/禁语 → 只允许进场景 forbiddenPhrases（§5.3.2）
    const phrases: string[] = Array.isArray(p['phrases'])
      ? (p['phrases'] as string[]).map(String)
      : [String(p['phrase'] ?? c.name)]
    const scenarioId = typeof p['scenarioId'] === 'string' ? p['scenarioId'] : undefined
    let scenario = scenarioId ? pkg.scenarios.find((s) => s.id === scenarioId) : undefined
    if (!scenario) scenario = pkg.scenarios[0]
    if (!scenario) {
      throw new KnowledgeError('REDLINE_NEEDS_SCENARIO', '红线物化需要已有场景卡（或 payload.scenarioId）')
    }
    for (const phrase of phrases) {
      if (phrase && !scenario.outputContract.forbiddenPhrases.includes(phrase)) {
        scenario.outputContract.forbiddenPhrases.push(phrase)
      }
    }
    return scenario.id
  }

  if (c.conclusionLike) {
    throw new KnowledgeError(
      'CONCLUSION_BLOCKED',
      `结论性表述禁止物化为业务元素（只能落 RedLine）${REDLINE_HOWTO}`,
    )
  }

  switch (c.targetKind) {
    case 'ObjectType': {
      const id = pickId(p, 'OBJ', tag, pkg)
      pkg.objects.push({
        id,
        name: String(p['name'] ?? c.name),
        idRule: typeof p['idRule'] === 'string' ? p['idRule'] : undefined,
        attributes: Array.isArray(p['attributes']) ? (p['attributes'] as OntologyPackage['objects'][number]['attributes']) : [],
        lifecycle: Array.isArray(p['lifecycle']) ? (p['lifecycle'] as string[]) : undefined,
      })
      return id
    }
    case 'RelationType': {
      const id = pickId(p, 'REL', tag, pkg)
      pkg.relations.push({
        id,
        name: String(p['name'] ?? c.name),
        from: String(p['from'] ?? ''),
        to: String(p['to'] ?? ''),
        attributes: Array.isArray(p['attributes']) ? (p['attributes'] as OntologyPackage['relations'][number]['attributes']) : [],
      })
      return id
    }
    case 'Attribute': {
      const ownerName = typeof p['ownerName'] === 'string' ? p['ownerName'] : undefined
      const ownerId = typeof p['ownerId'] === 'string' ? p['ownerId'] : undefined
      const owner =
        pkg.objects.find((o) => o.id === ownerId || o.name === ownerName) ??
        pkg.relations.find((r) => r.id === ownerId || r.name === ownerName)
      if (!owner) throw new KnowledgeError('ATTR_OWNER_NOT_FOUND', `属性 owner 不存在: ${ownerId ?? ownerName ?? '(空)'}`)
      owner.attributes = owner.attributes ?? []
      const attrName = String(p['name'] ?? c.name)
      if (owner.attributes.some((a) => a.name === attrName)) return `${owner.id}.${attrName}`
      owner.attributes.push({
        name: attrName,
        type: (p['type'] as 'string') ?? 'string',
        enumValuesRef: typeof p['enumValuesRef'] === 'string' ? p['enumValuesRef'] : undefined,
        refObject: typeof p['refObject'] === 'string' ? p['refObject'] : undefined,
      })
      return `${owner.id}.${attrName}`
    }
    case 'Dictionary': {
      const id = pickDictId(p, pkg)
      pkg.dictionaries.push({
        id,
        name: String(p['name'] ?? c.name),
        values: Array.isArray(p['values']) ? (p['values'] as string[]).map(String) : [],
      })
      return id
    }
    case 'BehaviorType': {
      const id = pickId(p, 'BHV', tag, pkg)
      pkg.behaviors.push({
        id,
        name: String(p['name'] ?? c.name),
        anchor: String(p['anchor'] ?? ''),
        relations: Array.isArray(p['relations']) ? (p['relations'] as string[]) : undefined,
        states: Array.isArray(p['states']) ? (p['states'] as string[]) : undefined,
        trigger: typeof p['trigger'] === 'string' ? p['trigger'] : undefined,
      })
      return id
    }
    case 'ScoreRule': {
      const id = pickId(p, 'RULE', tag, pkg)
      pkg.scoreRules.push({
        id,
        name: String(p['name'] ?? c.name),
        description: typeof p['description'] === 'string' ? p['description'] : undefined,
        weight: Number.isFinite(p['weight'] as number) ? (p['weight'] as number) : 0,
        expression: String(p['expression'] ?? '1'),
        threshold: Number.isFinite(p['threshold'] as number) ? (p['threshold'] as number) : undefined,
        evidenceTemplate: typeof p['evidenceTemplate'] === 'string' ? p['evidenceTemplate'] : undefined,
      })
      return id
    }
    case 'ExclusionRule': {
      const id = pickId(p, 'RULE', tag, pkg)
      pkg.exclusionRules.push({
        id,
        name: String(p['name'] ?? c.name),
        action: p['action'] === 'downweight' ? 'downweight' : 'drop',
        factor: Number.isFinite(p['factor'] as number) ? (p['factor'] as number) : undefined,
        condition: String(p['condition'] ?? "tag == 'unknown'"),
      })
      return id
    }
    case 'SkillTemplate': {
      const id = pickId(p, 'SKL', tag, pkg)
      pkg.skillTemplates.push({
        id,
        name: String(p['name'] ?? c.name),
        weights: (p['weights'] as Record<string, number>) ?? {},
        steps: Array.isArray(p['steps']) ? (p['steps'] as string[]) : undefined,
        outputTemplate: typeof p['outputTemplate'] === 'string' ? p['outputTemplate'] : undefined,
      })
      return id
    }
    case 'ScenarioCard': {
      const id = pickId(p, 'SCN', tag, pkg)
      pkg.scenarios.push({
        id,
        name: String(p['name'] ?? c.name),
        goal: String(p['goal'] ?? ''),
        boundary: String(p['boundary'] ?? ''),
        inputs: Array.isArray(p['inputs']) ? (p['inputs'] as OntologyPackage['scenarios'][number]['inputs']) : [],
        outputs: { fields: Array.isArray((p['outputs'] as { fields?: string[] })?.fields) ? (p['outputs'] as { fields: string[] }).fields : [] },
        pipeline: Array.isArray(p['pipeline'])
          ? (p['pipeline'] as OntologyPackage['scenarios'][number]['pipeline'])
          : [
              { stepId: 's1', stepType: 'DATA_INGEST' },
              { stepId: 's2', stepType: 'BEHAVIOR_CALL' },
              { stepId: 's3', stepType: 'RULE_EVALUATE', order: 'before-scoring' },
              { stepId: 's4', stepType: 'RULE_EVALUATE' },
              { stepId: 's5', stepType: 'AUDIT_CHECK' },
              { stepId: 's6', stepType: 'HUMAN_REVIEW' },
            ],
        // v1.1 引用位：缺省 = 全部（不落键）；显式数组 = 限定范围
        ...(Array.isArray(p['behaviorRefs'])
          ? { behaviorRefs: (p['behaviorRefs'] as string[]).map(String) }
          : {}),
        ...(Array.isArray(p['exclusionRefs'])
          ? { exclusionRefs: (p['exclusionRefs'] as string[]).map(String) }
          : {}),
        ...(Array.isArray(p['scoreRefs'])
          ? { scoreRefs: (p['scoreRefs'] as string[]).map(String) }
          : {}),
        // 结论性表述绝不能出现在 mustInclude / forbidden 清洗后的契约里
        outputContract: {
          mustInclude: Array.isArray(p['mustInclude'])
            ? (p['mustInclude'] as string[]).filter((m) => !isConclusionLike({ name: m, payload: {}, rationale: '' }))
            : ['candidateList', 'riskScore', 'evidenceChains', 'pendingChecks'],
          forbiddenPhrases: Array.isArray((p['outputContract'] as { forbiddenPhrases?: string[] })?.forbiddenPhrases)
            ? (p['outputContract'] as { forbiddenPhrases: string[] }).forbiddenPhrases
            : [],
        },
        reviewGate: {
          required: true,
          threshold: Number.isFinite((p['reviewGate'] as { threshold?: number })?.threshold)
            ? (p['reviewGate'] as { threshold: number }).threshold
            : 0.75,
        },
        auditChecks: Array.isArray(p['auditChecks']) ? (p['auditChecks'] as string[]) : ['O1_CLOSED', 'O2_CLOSED', 'O3_CLOSED'],
      })
      return id
    }
    case 'FieldMap': {
      const id = pickId(p, 'FM', tag, pkg)
      pkg.fieldMaps.push({
        id,
        source: String(p['source'] ?? ''),
        target: String(p['target'] ?? ''),
      })
      return id
    }
    case 'ApiSource': {
      const id = pickId(p, 'SRC', tag, pkg)
      pkg.apiSources.push({
        id,
        name: String(p['name'] ?? c.name),
        sourceType: (p['sourceType'] as SourceType) ?? 'SCHEMA_API',
        endpoint: typeof p['endpoint'] === 'string' ? p['endpoint'] : undefined,
      })
      return id
    }
    default:
      throw new KnowledgeError('BAD_TARGET_KIND', `unknown targetKind ${String(c.targetKind)}`)
  }
}

function idTaken(pkg: OntologyPackage, id: string): boolean {
  return (
    pkg.objects.some((x) => x.id === id) ||
    pkg.relations.some((x) => x.id === id) ||
    pkg.dictionaries.some((x) => x.id === id) ||
    pkg.behaviors.some((x) => x.id === id) ||
    pkg.scoreRules.some((x) => x.id === id) ||
    pkg.exclusionRules.some((x) => x.id === id) ||
    pkg.skillTemplates.some((x) => x.id === id) ||
    pkg.scenarios.some((x) => x.id === id) ||
    pkg.fieldMaps.some((x) => x.id === id) ||
    pkg.apiSources.some((x) => x.id === id)
  )
}

function pickId(p: Record<string, unknown>, prefix: string, tag: string, pkg: OntologyPackage): string {
  const raw = p['id']
  if (typeof raw === 'string' && isValidId(raw)) {
    // 显式 payload.id 与包内已有 ID（含同批次先前插入）冲突 → 拒绝，避免造出重复 ID
    if (idTaken(pkg, raw)) {
      throw new KnowledgeError('DUP_ID', `payload.id ${raw} 与包内已有 ID 重复`)
    }
    return raw
  }
  return nextId(pkg, prefix, tag)
}

/** 字典 ID slug：ASCII 名直接 slug；CJK 等非 ASCII 名用短哈希保熵（避免全塌缩成 gen）。 */
function dictSlug(name: string): string {
  const ascii = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  if (ascii) return ascii
  if (!name) return 'gen'
  let h = 5381
  for (let i = 0; i < name.length; i++) h = ((h * 33) ^ name.charCodeAt(i)) >>> 0
  return `g${h.toString(16)}`
}

function pickDictId(p: Record<string, unknown>, pkg: OntologyPackage): string {
  const raw = p['id']
  // 显式 payload.id 撞车 → 拒绝（与 pickId 同语义）
  if (typeof raw === 'string' && raw.startsWith('dict-')) {
    if (idTaken(pkg, raw)) {
      throw new KnowledgeError('DUP_ID', `payload.id ${raw} 与包内已有 ID 重复`)
    }
    return raw
  }
  // 自动生成路径撞车 → 加盐取空闲 ID，不硬拒（同批多本同名/同 slug 字典可共存）
  const base = `dict-${dictSlug(String(p['name'] ?? ''))}`
  if (!idTaken(pkg, base)) return base
  for (let n = 2; ; n++) {
    const cand = `${base}-${n}`
    if (!idTaken(pkg, cand)) return cand
  }
}
