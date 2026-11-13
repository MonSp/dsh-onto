/**
 * O1/O2/O3 业务本体模型类型 —— 对应规范 §3/§6 的建模要素。
 *
 * ID 语法（§3.3）：`<TYPE>-<PKG_TAG>-<NAME>`，TYPE ∈ {PKG,OBJ,REL,BHV,RULE,SKL,SCN,TOOL,FM,SRC,AGT,AUD}；
 * 字典 `dict-<slug>`；属性引用 `<OBJ|REL ID>.<attrName>`。
 */

/** 包签发状态机（§3.4）：DRAFT → IN_REVIEW → ISSUED。 */
export type PackageStatus = 'DRAFT' | 'IN_REVIEW' | 'ISSUED'

/** 知识原料六类（§5.1；CONVERSATION 为对话轮次原料，conversational-modeling P3）。 */
export type SourceType = 'LEGACY_SYS' | 'CASE_SAMPLE' | 'POLICY' | 'SCHEMA_API' | 'WORK_ORDER' | 'CONVERSATION'

export const SOURCE_TYPES: readonly SourceType[] = [
  'LEGACY_SYS',
  'CASE_SAMPLE',
  'POLICY',
  'SCHEMA_API',
  'WORK_ORDER',
  'CONVERSATION',
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
  /**
   * 特征 → 对象/关系 ID（可选，v0.2.1 全链路）：图谱据此画规则→O1 边。
   * 仅图谱/文档语义，不参与打分；值须闭合到 OBJ-* / REL-*。
   */
  featureSources?: Record<string, string>
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
  /** 特征 → 对象/关系 ID（可选，同 O2ScoreRule.featureSources）。 */
  featureSources?: Record<string, string>
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
  /**
   * 排除件也进人工复核队列（P-1 多场景协作拍板项）：true 时 requireReviewFor
   * 追加被排除候选 ID。缺省/ false = 现状（只收达阈值的有分候选）。
   */
  includeExcluded?: boolean
}

export interface O3ScenarioCard {
  id: string
  name: string
  goal: string
  boundary: string
  inputs: O3Input[]
  outputs: { fields: string[] }
  pipeline: O3PipelineStep[]
  /**
   * 本场景 BEHAVIOR_CALL 步执行的行为范围（conversational-modeling v1.1）。
   * 缺省 = 全部行为（向后兼容）；显式数组 = 限定范围，元素须闭合。
   */
  behaviorRefs?: string[]
  /** 本场景 before-scoring 步执行的排除规则范围；缺省 = 全部，显式数组须闭合。 */
  exclusionRefs?: string[]
  /**
   * 本场景打分段执行的打分规则范围（D13 多场景协作）：缺省 = 全部（包级权重合计 1.0）；
   * 显式数组 = 只求值圈内规则——范围外规则不参与加权、不因缺特征落待核实。
   */
  scoreRefs?: string[]
  /**
   * 场景内含数据准备（scenario-prep S2.1）：种子由调用方经 run_scenario.seedIds 传入，
   * 场景卡只声明怎么扩/是否投影派生。缺省 = 无准备（输入即全部，零回归）。
   */
  prep?: O3ScenarioPrep
  outputContract: O3OutputContract
  reviewGate: O3ReviewGate
  /** 三层闭合闸门清单，如 [O1_CLOSED, O2_CLOSED, O3_CLOSED]。 */
  auditChecks: string[]
}

/** 场景 prep 声明（S2.1）。`expand` 与 `features` 均可选；两者都缺省 = 无准备。 */
export interface O3ScenarioPrep {
  /** 扩图；声明后调用方可传 seedIds 圈定业务范围。无 seedIds 时不扩图（全量执行合法）。 */
  expand?: {
    /** 0..3，默认 1（沿 subgraph-expansion 硬上限）。 */
    hops?: number
    /** 默认 'both'。 */
    direction?: 'out' | 'in' | 'both'
    relationTypes?: string[]
  }
  /** 打分前执行 projectFeatures + 包级 featureRecipes；默认 false（零回归）。 */
  features?: boolean
}

/** RunRecord 人审面对账用的 prep 摘要（S2.4；不进模型面）。 */
export interface ScenarioPrepSummary {
  expanded?: {
    seeds: string[]
    hops: number
    objects: number
    truncated: boolean
  }
  projectedWrites?: number
  derived?: string[]
  /**
   * since 派生时间基准 ISO（与本轮 startedAt 同源，单次捕获）。
   * 双 digest 只能发现数据变化，此字段还原「按哪个时刻算 since」的计算条件。
   */
  sinceBasis?: string
}

/** 确定性特征配方（PR#18 features.ts；scenario-prep S2.2 包级复用同一类型）。 */
export interface FeatureRecipe {
  /** 写入 features 的键。 */
  name: string
  kind: 'since' | 'count' | 'ratio'
  /** since：对象上的时间戳属性名。 */
  attr?: string
  /** count：计数源。 */
  source?: 'behaviors' | 'relations'
  /** count：实例过滤（type 精确匹配；attr+equals 同时给出才过滤字段值）。 */
  filter?: { type?: string; attr?: string; equals?: string | number }
  /** ratio：分子/分母特征键。 */
  num?: string
  den?: string
  /** ratio：分母下限，den < minDen → 缺省（待核实）。 */
  minDen?: number
  /** since：基准时刻 ISO；缺省 = 调用方注入（测试/回放固定 now）。包级配方禁写此字段。 */
  now?: string
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
  /**
   * 包级特征配方（scenario-prep S2.2 / PR#18 P6）：落 package.yaml，自动进派生指纹。
   * 仅当场景 prep.features=true 时由执行层注入 now 后执行 deriveFeatures；包内禁写 now。
   */
  featureRecipes?: FeatureRecipe[]
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
  /** O→L 层标注（conversational-modeling P4）：L2 工具池 / L3 技能 / L4 专家；引擎配置等可缺省。 */
  layer?: 'L1' | 'L2' | 'L3' | 'L4'
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
  /** P0-5：按 reviewGate.threshold 推导的中文等级（高/中/低）。 */
  riskLevel?: string
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
  /**
   * 排除条件特征缺口全量（含已 drop 候选——存活候选另挂 pendingChecks）。
   * 接入层投影缺失的审计面；模型面渲染按需摘要。
   */
  exclusionFeatureGaps?: Array<{ candidateId: string; ruleId: string; missing: string[] }>
  /** 永远为 true —— 认定出口只在人工（§12.1）。 */
  humanReviewRequired: true
  reviewGate: { threshold: number; required: boolean; requireReviewFor: string[] }
  ruleHitLog: RuleHitLogEntry[]
  audit: {
    checks: AuditCheckEntry[]
    forbiddenPhraseHits: ForbiddenPhraseHit[]
    passed: boolean
  }
  /** 执行层 prep 摘要（scenario-prep S2.4；人审对账，无准备时缺省）。 */
  prep?: ScenarioPrepSummary
  /**
   * 有 prep 时回填的 effective 数据集（buildRunRecord 双 digest 用）。
   * enumerable:false——不进 JSON.stringify / 模型面 / RunRecord.result。
   */
  effectiveDataset?: RuntimeDataset
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
  /** 'update' = 修改/接线既有元素（targetId 必填）；缺省 'create' = 新增元素（conversational-modeling P3）。 */
  op?: 'create' | 'update'
  /** op='update' 时的既有元素 ID（Attribute 为 'OBJ.attr' 形态）。 */
  targetId?: string
  name: string
  payload: Record<string, unknown>
  confidence: number
  /** 可缺省；出现即须为字符串（与 validateDraftItem 同口径）。 */
  rationale?: string
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
  /** 溯源（conversational-modeling I2）：对话轮次或知识源。 */
  provenance?: DraftProvenance
  /** 物化后写入的元素 ID（canvas 由元素回查 provenance）；属性类为 'OBJ.attr' 属性引用形态。 */
  appliedAs?: string
  /** 人审留痕：动作执行面（'workbench' 人工直操 / 'agent-tool' 会话代执行）与时间。 */
  reviewedBy?: string
  reviewedAt?: string
  /** approved→rejected 时保留原批准人/时间（单字段 reviewedBy 会被驳回覆盖，审计链不断）。 */
  approvedBy?: string
  approvedAt?: string
  createdAt: string
}

/** 草案来源定位：对话轮次（turnId）或知识源（sourceId）；经验闭环增运行（runId）。 */
export interface DraftProvenance {
  turnId?: string
  sourceId?: string
  /** 经验闭环（experience-loop S4.4）：草案来自哪次运行——人审面回放锚点。 */
  runId?: string
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

/* ═══════════════════════════════════════════════════════════════════════════
 * 对话式建模：ModelDelta 与图谱（conversational-modeling P1/P3）
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 图谱引用边：源/目标为元素 ID 或草案 ID。 */
export interface ModelEdge {
  from: string
  to: string
  /** 边语义：anchor | relation | ref | dict | skill-rule | scenario-step | applies。 */
  kind: string
  label?: string
}

/** 一轮对话产出的模型增量（草案不落包；人审通过才物化）。 */
export interface ModelDelta {
  turnId: string
  drafts: DraftCandidate[]
  edges: ModelEdge[]
  /** 被这轮移除/驳回的草案 ID。 */
  removed?: string[]
  rationale: string
}

export type GraphNodeKind =
  | 'object'
  | 'relation'
  | 'dictionary'
  | 'behavior'
  | 'scoreRule'
  | 'exclusionRule'
  | 'skillTemplate'
  | 'scenario'
  | 'fieldMap'
  | 'apiSource'
  | 'draft'

/** 图谱节点：物化元素或待审草案。 */
export interface GraphNode {
  /** 元素 ID（物化）或草案 ID（draft=true）。 */
  id: string
  kind: GraphNodeKind
  layer: 'O1' | 'O2' | 'O3'
  name: string
  /** 草案态（画布虚线）。 */
  draft: boolean
  provenance?: DraftProvenance
  /** 该节点最重的校验级别（画布标红）。 */
  issueLevel?: IssueLevel
  /** 低置信度强制人审标记。 */
  forcedReview?: boolean
  /** S4：被最近运行命中的规则。 */
  runHit?: boolean
}

/** 对话开局骨架（conversational-modeling P3/I6）：域码 + 全量 ID 清单 + 确认态。 */
export interface SkeletonRecord {
  packageId: string
  /** 全模型唯一域码（如 RD）。 */
  domainCode: string
  /** 确认后方可物化（skeleton 门）。 */
  confirmed: boolean
  /** 骨架内允许的全量 ID 清单（含 dict-*）。 */
  ids: string[]
  /** 能力域清单（可选，覆盖率对照用）。 */
  capabilities?: string[]
  updatedAt: string
}

/** 画布数据源（get_model_graph 返回；按收权投影由工具面执行）。 */
export interface ModelGraph {
  package: string
  version: string
  status: PackageStatus
  nodes: GraphNode[]
  edges: ModelEdge[]
  /** 校验 issues；where 为元素 ID 时可定位到节点，'package' 为包级（I3）。 */
  issues: ValidationIssue[]
  /** 最近一次人审/物化后的单调递增版本号（画布刷新信号）。 */
  revision: number
  /** 骨架状态（存在时下发，供画布显示门禁）。 */
  skeleton?: { confirmed: boolean; ids: string[] }
}
