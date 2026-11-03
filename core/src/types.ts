/**
 * O1/O2/O3 业务本体模型类型 —— 对应规范 §3/§6 的建模要素。
 *
 * ID 语法（§3.3）：`<TYPE>-<PKG_TAG>-<NAME>`，TYPE ∈ {PKG,OBJ,REL,BHV,RULE,SKL,SCN,TOOL,FM,SRC,AGT,AUD}；
 * 字典 `dict-<slug>`；属性引用 `<OBJ|REL ID>.<attrName>`。
 */

/** 包签发状态机（§3.4）：DRAFT → IN_REVIEW → ISSUED。 */
export type PackageStatus = 'DRAFT' | 'IN_REVIEW' | 'ISSUED'

/** 知识原料五类（§5.1）。 */
export type SourceType = 'LEGACY_SYS' | 'CASE_SAMPLE' | 'POLICY' | 'SCHEMA_API' | 'WORK_ORDER'

export const SOURCE_TYPES: readonly SourceType[] = [
  'LEGACY_SYS',
  'CASE_SAMPLE',
  'POLICY',
  'SCHEMA_API',
  'WORK_ORDER',
]

/* ═══════════════════════════════════════════════════════════════════════════
 * O1 对象层
 * ═══════════════════════════════════════════════════════════════════════════ */

export type AttributeType = 'string' | 'int' | 'float' | 'bool' | 'date' | 'enum' | 'ref'

export interface OntoAttribute {
  name: string
  type: AttributeType
  /** type=enum 时指向 dict-<slug>。 */
  enumValuesRef?: string
  /** type=ref 时指向 OBJ-* 对象类型。 */
  refObject?: string
  required?: boolean
  description?: string
}

export interface O1ObjectType {
  id: string
  name: string
  idRule?: string
  attributes: OntoAttribute[]
  lifecycle?: string[]
  description?: string
}

export interface O1RelationType {
  id: string
  name: string
  from: string
  to: string
  attributes?: OntoAttribute[]
  description?: string
}

export interface O1Dictionary {
  id: string
  name: string
  values: string[]
  description?: string
}

/* ═══════════════════════════════════════════════════════════════════════════
 * O2 行为规则层
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface O2BehaviorType {
  id: string
  name: string
  /** 锚点对象类型（OBJ-*）。 */
  anchor: string
  /** 该行为产生/使用的关系类型（REL-*）。 */
  relations?: string[]
  states?: string[]
  trigger?: string
  description?: string
}

export interface O2ScoreRule {
  id: string
  name: string
  description?: string
  /** 全包打分规则权重合计必须 = 1.0。 */
  weight: number
  /** 特征表达式，映射到 [0,1]。 */
  expression: string
  threshold?: number
  /** 证据模板，占位符 {featureName} 以特征值回填。 */
  evidenceTemplate?: string
}

export interface O2ExclusionRule {
  id: string
  name: string
  /** drop=剔除；downweight=按 factor 降权。 */
  action: 'drop' | 'downweight'
  factor?: number
  /** 条件表达式，打分前执行。 */
  condition: string
  description?: string
}

export interface O2SkillTemplate {
  id: string
  name: string
  /** 方法论模板权重集合必须与打分规则集合一致（同 ID 同权重）。 */
  weights: Record<string, number>
  steps?: string[]
  outputTemplate?: string
  description?: string
}

/* ═══════════════════════════════════════════════════════════════════════════
 * O3 场景层
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface O3Input {
  name: string
  type: string
  required: boolean
  description?: string
}

export type PipelineStepType =
  | 'DATA_INGEST'
  | 'BEHAVIOR_CALL'
  | 'RULE_EVALUATE'
  | 'SKILL_RUN'
  | 'AUDIT_CHECK'
  | 'HUMAN_REVIEW'

export interface O3PipelineStep {
  stepId: string
  stepType: PipelineStepType
  /** RULE_EVALUATE 专属：before-scoring = 排除段。 */
  order?: 'before-scoring'
  skillRefs?: string[]
  label?: string
}

export interface O3OutputContract {
  mustInclude: string[]
  forbiddenPhrases: string[]
}

export interface O3ReviewGate {
  required: boolean
  threshold: number
}

export interface O3ScenarioCard {
  id: string
  name: string
  goal: string
  boundary: string
  inputs: O3Input[]
  outputs: { fields: string[] }
  pipeline: O3PipelineStep[]
  outputContract: O3OutputContract
  reviewGate: O3ReviewGate
  /** 三层闭合闸门清单，如 [O1_CLOSED, O2_CLOSED, O3_CLOSED]。 */
  auditChecks: string[]
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 绑定（bindings/）
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface O1FieldMap {
  id: string
  /** 源字段名。 */
  source: string
  /** 目标属性引用 `<OBJ|REL ID>.<attrName>`。 */
  target: string
  description?: string
}

export interface O1ApiSource {
  id: string
  name: string
  sourceType: SourceType
  endpoint?: string
  description?: string
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 包元数据与内存模型
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface IssueRecordEntry {
  version: string
  issuedAt: string
  issuedBy: string
  note?: string
  /** 可选库外锚点：派生 manifest 的 sha256（防「改派生物+改 manifest」双改，§8.1.5）。 */
  manifestDigest?: string
}

export interface PackageMeta {
  kind: 'BusinessOntologyPackage'
  name: string
  version: string
  domain: string
  metaFrameworkVersion: string
  status: PackageStatus
  issueRecord: IssueRecordEntry[]
  /** 跨包引用必须在此声明；未声明的外部 ID 视为未闭合。 */
  externalRefs?: string[]
}

/** 一个业务本体包版本的完整内存模型。 */
export interface OntologyPackage {
  meta: PackageMeta
  objects: O1ObjectType[]
  relations: O1RelationType[]
  dictionaries: O1Dictionary[]
  behaviors: O2BehaviorType[]
  scoreRules: O2ScoreRule[]
  exclusionRules: O2ExclusionRule[]
  skillTemplates: O2SkillTemplate[]
  scenarios: O3ScenarioCard[]
  fieldMaps: O1FieldMap[]
  apiSources: O1ApiSource[]
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 校验与质量分（§7）
 * ═══════════════════════════════════════════════════════════════════════════ */

export type IssueLevel = 'error' | 'warn' | 'info'

export interface ValidationIssue {
  level: IssueLevel
  code: string
  message: string
  where: string
}

export interface QualityReport {
  package: string
  version: string
  generatedAt: string
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
  info: ValidationIssue[]
  /** clamp(0, 100, 100 - 10×errors - 2×warnings)。 */
  score: number
  passed: boolean
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 派生（§8）
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface ManifestEntry {
  path: string
  sha256: string
}

export interface DerivedManifest {
  kind: 'DerivedManifest'
  package: string
  version: string
  domain: string
  generatedAt: string
  /** 所有源文件指纹的聚合摘要。 */
  sourceDigest: string
  sources: ManifestEntry[]
  derived: ManifestEntry[]
}

export type LoadGateResult =
  | { ok: true; manifest: DerivedManifest }
  | { ok: false; code: 'DERIVED_DRIFT'; reason: string }

/* ═══════════════════════════════════════════════════════════════════════════
 * 运行时（§9）
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface RuntimeObjectInstance {
  id: string
  type: string
  attrs: Record<string, unknown>
}

export interface RuntimeRelationInstance {
  id: string
  type: string
  from: string
  to: string
  attrs?: Record<string, unknown>
}

export interface RuntimeBehaviorInstance {
  id: string
  type: string
  anchorRef: string
  objectRef: string
  occurredAt: string
  source?: string
}

export interface RuntimeCandidate {
  candidateId: string
  objectRef: string
  /** 特征值；表达式映射到 [0,1]；缺失特征 → 待核实。 */
  features: Record<string, number | string>
  tags: string[]
}

export interface RuntimeDataset {
  objects: RuntimeObjectInstance[]
  relations: RuntimeRelationInstance[]
  behaviors?: RuntimeBehaviorInstance[]
  candidates: RuntimeCandidate[]
}

export interface EvidenceChainEntry {
  ruleId: string
  score: number
  evidence: string
}

export interface PendingCheck {
  ruleId?: string
  missing?: string[]
  note: string
}

export interface CandidateResult {
  candidateId: string
  objectRef: string
  riskScore: number
  hitRuleIds: string[]
  evidenceChains: EvidenceChainEntry[]
  narrative: string[]
  pendingChecks: PendingCheck[]
  pendingVerification: boolean
}

export interface RuleHitLogEntry {
  ruleId: string
  candidateId: string
  score: number
  ts: string
}

export interface AuditCheckEntry {
  check: string
  closed: boolean
  detail: string
  ts: string
}

export interface ForbiddenPhraseHit {
  phrase: string
  where: string
}

export interface ScenarioRunResult {
  scenarioId: string
  runId: string
  startedAt: string
  candidates: CandidateResult[]
  excluded: Array<{ candidateId: string; ruleId: string }>
  /** 永远为 true —— 认定出口只在人工（§12.1）。 */
  humanReviewRequired: true
  reviewGate: { threshold: number; required: boolean; requireReviewFor: string[] }
  ruleHitLog: RuleHitLogEntry[]
  audit: {
    checks: AuditCheckEntry[]
    forbiddenPhraseHits: ForbiddenPhraseHit[]
    passed: boolean
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 知识库 → LLM 解析 → 候选队列（§5）
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface KnowledgeSourceRecord {
  id: string
  packageId: string
  sourceType: SourceType
  name: string
  content: string
  sha256: string
  parseStatus: 'uploaded' | 'parsed' | 'failed'
  uploadedAt: string
}

export type DraftStatus = 'pending' | 'approved' | 'merged' | 'rejected'

/** 草案目标类型全集（唯一事实源；类型与运行时校验共用，防双源漂移）。 */
export const DRAFT_TARGET_KINDS = [
  'ObjectType',
  'RelationType',
  'Attribute',
  'Dictionary',
  'BehaviorType',
  'ScoreRule',
  'ExclusionRule',
  'SkillTemplate',
  'ScenarioCard',
  'RedLine',
  'FieldMap',
  'ApiSource',
] as const

export type DraftTargetKind = (typeof DRAFT_TARGET_KINDS)[number]

export interface DraftItem {
  layer: 'O1' | 'O2' | 'O3'
  targetKind: DraftTargetKind
  name: string
  payload: Record<string, unknown>
  confidence: number
  rationale: string
}

export interface DraftCandidate extends DraftItem {
  id: string
  packageId: string
  sourceId: string
  /** 解析时的原始 name，幂等键用它而非可编辑的 name（人审改名不破坏同源去重）。 */
  sourceName?: string
  status: DraftStatus
  /** confidence < 0.75 强制人审（§5.3）。 */
  forcedReview: boolean
  /** 结论性表述标记：只允许落红线，禁止进输出契约（§5.3.2）。 */
  conclusionLike: boolean
  createdAt: string
}

export interface LlmParseRequest {
  sourceType: SourceType
  content: string
  packageName: string
}

export interface LlmParseResponse {
  items: DraftItem[]
}

/** LLM 端口：解析原料产出草案；实现可以是 DeepSeek API 或词面启发回落。 */
export interface LlmPort {
  parseSource(request: LlmParseRequest): Promise<LlmParseResponse>
}
