/**
 * 知识库 → LLM 解析 → 快速建模（规范 §5）。
 *
 * 硬规则（§5.3）：
 *  1. 原料永不直写包内 YAML；只产 draft 候选。
 *  2. 结论性表述禁止进入 O3 输出契约（只能落红线 forbiddenPhrases）。
 *  3. 同 (包 + 层 + kind + name) 幂等跳过。
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
  KnowledgeSourceRecord,
  LlmPort,
  OntologyPackage,
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
  if (typeof it['name'] !== 'string' || !it['name'].trim()) return 'bad name'
  const payload = it['payload']
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'bad payload'
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

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 知识库存储（profile 数据目录下的一等运行时状态）。 */
export class KnowledgeStore {
  readonly root: string

  constructor(dataDir: string) {
    this.root = join(dataDir, 'knowledge')
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
    const sha256 = sha256Hex(input.content)
    const existing = this.listSources().find((s) => s.sha256 === sha256 && s.packageId === input.packageId)
    if (existing) return existing
    const id = knowledgeSourceId(`${input.packageId}|${input.sourceType}|${input.name}|${sha256}`)
    const record: KnowledgeSourceRecord = {
      id,
      packageId: input.packageId,
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
    const out: KnowledgeSourceRecord[] = []
    for (const f of readdirSafe(dir)) {
      if (!f.endsWith('.json')) continue
      try {
        const rec = JSON.parse(readFileSync(join(dir, f), 'utf8')) as KnowledgeSourceRecord
        if (!packageId || rec.packageId === packageId) out.push(rec)
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
      const key = `${src.packageId}|${item.layer}|${item.targetKind}|${item.name}`
      // 幂等键用 sourceName（解析原始名）；人审改 name 不影响同源去重
      if (queue.some((c) => `${c.packageId}|${c.layer}|${c.targetKind}|${c.sourceName ?? c.name}` === key)) {
        idempotentSkipped++
        continue
      }
      const conclusionLike = isConclusionLike(item)
      const cand: DraftCandidate = {
        ...item,
        id: draftCandidateId(key),
        packageId: src.packageId,
        sourceId,
        sourceName: item.name,
        status: 'pending',
        forcedReview: item.confidence < 0.75,
        conclusionLike,
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

  listCandidates(filter?: { packageId?: string; status?: DraftCandidate['status'] }): DraftCandidate[] {
    return this.loadQueue().filter(
      (c) => (!filter?.packageId || c.packageId === filter.packageId) && (!filter?.status || c.status === filter.status),
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
          `结论性表述禁止进入 ${c.targetKind}（只能落 RedLine 红线）`,
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
    const eligible: typeof targets = []
    for (const c of targets) {
      if (c.packageId !== meta.name) {
        skipped.push({ id: c.id, reason: `package mismatch: 候选属于 ${c.packageId}，目标包为 ${meta.name}` })
        continue
      }
      if (c.status !== 'approved') {
        skipped.push({ id: c.id, reason: `status=${c.status}，未经人审批准不得物化` })
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
    for (const c of eligible) {
      try {
        applyDraftToPackage(pkg, c)
        applied.push(c.id)
      } catch (e) {
        skipped.push({ id: c.id, reason: e instanceof Error ? e.message : String(e) })
      }
    }
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
      if (c.packageId !== meta.name) {
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

/** 把一条 approved 草案应用到内存模型（RedLine 红线特殊路由）。 */
export function applyDraftToPackage(pkg: OntologyPackage, c: DraftCandidate): void {
  const p = c.payload ?? {}
  const tag = tagOf(pkg)

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
    return
  }

  if (c.conclusionLike) {
    throw new KnowledgeError('CONCLUSION_BLOCKED', '结论性表述禁止物化为业务元素（只能落 RedLine）')
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
      break
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
      break
    }
    case 'Attribute': {
      const ownerName = typeof p['ownerName'] === 'string' ? p['ownerName'] : undefined
      const ownerId = typeof p['ownerId'] === 'string' ? p['ownerId'] : undefined
      const owner =
        pkg.objects.find((o) => o.id === ownerId || o.name === ownerName) ??
        pkg.relations.find((r) => r.id === ownerId || r.name === ownerName)
      if (!owner) throw new KnowledgeError('ATTR_OWNER_NOT_FOUND', `属性 owner 不存在: ${ownerId ?? ownerName ?? '(空)'}`)
      owner.attributes = owner.attributes ?? []
      if (owner.attributes.some((a) => a.name === String(p['name'] ?? c.name))) break
      owner.attributes.push({
        name: String(p['name'] ?? c.name),
        type: (p['type'] as 'string') ?? 'string',
        enumValuesRef: typeof p['enumValuesRef'] === 'string' ? p['enumValuesRef'] : undefined,
        refObject: typeof p['refObject'] === 'string' ? p['refObject'] : undefined,
      })
      break
    }
    case 'Dictionary': {
      pkg.dictionaries.push({
        id: pickDictId(p, pkg),
        name: String(p['name'] ?? c.name),
        values: Array.isArray(p['values']) ? (p['values'] as string[]).map(String) : [],
      })
      break
    }
    case 'BehaviorType': {
      pkg.behaviors.push({
        id: pickId(p, 'BHV', tag, pkg),
        name: String(p['name'] ?? c.name),
        anchor: String(p['anchor'] ?? ''),
        relations: Array.isArray(p['relations']) ? (p['relations'] as string[]) : undefined,
        states: Array.isArray(p['states']) ? (p['states'] as string[]) : undefined,
        trigger: typeof p['trigger'] === 'string' ? p['trigger'] : undefined,
      })
      break
    }
    case 'ScoreRule': {
      pkg.scoreRules.push({
        id: pickId(p, 'RULE', tag, pkg),
        name: String(p['name'] ?? c.name),
        description: typeof p['description'] === 'string' ? p['description'] : undefined,
        weight: Number.isFinite(p['weight'] as number) ? (p['weight'] as number) : 0,
        expression: String(p['expression'] ?? '1'),
        threshold: Number.isFinite(p['threshold'] as number) ? (p['threshold'] as number) : undefined,
        evidenceTemplate: typeof p['evidenceTemplate'] === 'string' ? p['evidenceTemplate'] : undefined,
      })
      break
    }
    case 'ExclusionRule': {
      pkg.exclusionRules.push({
        id: pickId(p, 'RULE', tag, pkg),
        name: String(p['name'] ?? c.name),
        action: p['action'] === 'downweight' ? 'downweight' : 'drop',
        factor: Number.isFinite(p['factor'] as number) ? (p['factor'] as number) : undefined,
        condition: String(p['condition'] ?? "tag == 'unknown'"),
      })
      break
    }
    case 'SkillTemplate': {
      pkg.skillTemplates.push({
        id: pickId(p, 'SKL', tag, pkg),
        name: String(p['name'] ?? c.name),
        weights: (p['weights'] as Record<string, number>) ?? {},
        steps: Array.isArray(p['steps']) ? (p['steps'] as string[]) : undefined,
        outputTemplate: typeof p['outputTemplate'] === 'string' ? p['outputTemplate'] : undefined,
      })
      break
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
      break
    }
    case 'FieldMap': {
      pkg.fieldMaps.push({
        id: pickId(p, 'FM', tag, pkg),
        source: String(p['source'] ?? ''),
        target: String(p['target'] ?? ''),
      })
      break
    }
    case 'ApiSource': {
      pkg.apiSources.push({
        id: pickId(p, 'SRC', tag, pkg),
        name: String(p['name'] ?? c.name),
        sourceType: (p['sourceType'] as SourceType) ?? 'SCHEMA_API',
        endpoint: typeof p['endpoint'] === 'string' ? p['endpoint'] : undefined,
      })
      break
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
