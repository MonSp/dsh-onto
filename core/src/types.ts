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
  /**
   * 动作契约（M1-C；方案 §6）：行为转正式动作时的受校验契约扩展。
   * 不在本体包中嵌入任意代码——条件为受限可校验表达；真实实例状态由连接器核验。
   */
  actionContract?: ActionContract
}

/** 动作载荷字段契约（白名单/必填/类型/范围；ref 字段限定允许对象类型）。 */
export interface ActionFieldSpec {
  name: string
  type: 'string' | 'int' | 'float' | 'bool' | 'date' | 'ref'
  required: boolean
  /** 数值范围（int/float）。 */
  range?: { min?: number; max?: number }
  /** ref 字段：允许的对象类型（OBJ-*；其余拒绝）。 */
  refTypes?: string[]
}

/**
 * 动作契约（M1-C，方案 §6）：载荷字段白名单、对象角色与关系要求、允许的前置状态
 * 及所需权限、支持的连接器能力与契约版本、场景是否允许提出该动作及要求哪类人工决定。
 * 条件为受限合取表达（attr op 常量），不嵌任意代码；派生进 tool-contracts 沿 DERIVED_DRIFT 链。
 */
export interface ActionContract {
  /** 载荷字段白名单（不在表内字段 → 拒绝）。 */
  fields: ActionFieldSpec[]
  /** 对象角色与关系要求（锚点对象须处于的关系/状态）。 */
  requires?: {
    /** 须存在的关系类型 id（REL-*）。 */
    relations?: string[]
    /** 须满足的状态属性条件（受限合取：attr op 常量）。 */
    states?: ActionCondition[]
  }
  /** 允许的前置状态（对象状态机；受限合取）。 */
  precondition?: ActionCondition[]
  /** 所需业务角色（对照 BusinessIdentity.roles；缺省沿操作级角色策略）。 */
  requiredRoles: string[]
  /** 支持的连接器能力与契约版本。 */
  connector: { capability: string; contractVersion: string }
  /** 场景绑定：是否允许提出该动作 + 要求哪类人工决定。 */
  scenarioBinding: { scenarioId: string; decisionKind: 'business-review' | 'approval' | 'both' }
}

/** 受限条件（合取项）：`<attr> <op> <常量>`——可校验，不嵌任意代码。 */
export interface ActionCondition {
  attr: string
  op: '=' | '!=' | '>' | '<' | '>=' | '<='
  value: string | number
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
  /**
   * 随包默认报表页契约（chat-run-report 图注「契约＝设计时定义」的布局侧）：
   * 预置可复用报表 surface，随 O3 场景卡发布（进派生指纹/发布台账）。
   * 消费方：生成页客户端（缺省用它替代 buildDefaultReportSurface，不合法时运行面回退默认模板）
   * 与 listScenarios 透出；core reportpage / runtime 对话报表工具暂不消费此字段。
   * 不合法时校验上墙（REPORT_SURFACE_INVALID）。工作区沉淀的 ReportPage 仍可覆盖。
   */
  reportSurface?: import('./surface.js').A2uiSurfaceMessage
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
  /**
   * 事实覆盖留痕（可信取数 T1.1）：调用方预置特征被对象事实/配方派生值覆盖的冲突对。
   * 仅人审面对账；模型面经 pendingChecks 另行降级提示。
   */
  featureOverrides?: FeatureOverride[]
}

/**
 * 事实覆盖记录（可信取数 T1.1）：调用方预置特征与对象事实/配方派生值冲突时，
 * 事实值写入 features，冲突对留痕供人审对账与审计溯源。
 */
export interface FeatureOverride {
  candidateId: string
  key: string
  caller: number | string
  fact: number | string
}

/**
 * 特征来源状态（R5 无事实特征显式降级）：参与评分/排除的特征逐条记录来源，
 * 声明来源缺失的预置值不得伪装为可复算事实。
 */
export type FeatureSourceKind =
  /** 对象投影（featureSources → 对象 attrs，本轮可复算）。 */
  | 'object-fact'
  /** 合法配方派生（since/count/ratio，记录实际输入与计算条件）。 */
  | 'derived'
  /** 可信连接器供数（provenance=connector 的对象投影/派生）。 */
  | 'connector'
  /** 未核实调用方值（声明源缺失 / 配方缺输入 / 来源未声明——不可复算）。 */
  | 'unverified-caller'

export interface FeatureSourceRecord {
  candidateId: string
  key: string
  source: FeatureSourceKind
  /**
   * 有声明契约（featureSources 或 featureRecipes）——契约在而事实缺 = 伪装面，
   * 须逐候选降级；来源未声明（旧输入面）只留痕。
   */
  declared: boolean
  /** 详情：投影目标 / 配方与实际输入 / 缺失原因（审计与人审对账用）。 */
  detail: string
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

/** API 形态（信封/分页）；地址与凭证仍在部署侧，包内只描述结构（api-to-plugin S2.1）。 */
export interface ApiShapePagination {
  /** cursor=游标翻页；offset=偏移翻页；none=一次取完。 */
  mode: 'cursor' | 'offset' | 'none'
  /** cursor 模式：请求游标参数名（缺省 cursor）。 */
  cursorParam?: string
  /** cursor 模式：响应下一页游标字段名（缺省 nextCursor；空/缺=无下一页）。 */
  nextField?: string
  /** offset 模式：limit 参数名（缺省 limit）。 */
  limitParam?: string
  /** offset 模式：offset 参数名（缺省 offset）。 */
  offsetParam?: string
  /** offset 模式：每页条数（缺省 100）。 */
  pageSize?: number
  /** 响应完整性字段名（缺省 complete；显式 false → complete=false）。 */
  completeField?: string
}

export interface ApiShape {
  /** collections=每集合一次 GET；snapshot=单请求多集合。 */
  mode: 'collections' | 'snapshot'
  /** collections 模式：集合路径模板，须含 `{collection}`。 */
  collectionPath?: string
  /** snapshot 模式：单请求路径。 */
  path?: string
  /** collections 模式：items 字段路径（缺省 items）。 */
  itemsPath?: string
  /** snapshot 模式：集合键 → 响应体 JSON 路径（如 `bins`、`data.bins`）。 */
  collectionPaths?: Record<string, string>
  pagination: ApiShapePagination
}

export interface O1ApiSource {
  id: string
  name: string
  sourceType: SourceType
  endpoint?: string
  description?: string
  /** API 形态声明（供配置驱动连接器/采样使用；手写连接器可缺省）。 */
  shape?: ApiShape
}

/** source-maps：源字段 → 目标属性名（对象映射内，target 是本对象类型上的属性名）。 */
export interface O1SourceFieldMap {
  source: string
  target: string
  description?: string
}

/** 关系端点：self=本行对象 id；{field}=字段值即对端对象 id（数组字段→多条关系）。 */
export type SourceMapEndpoint = 'self' | { field: string }

export interface O1ObjectSourceMap {
  id: string
  kind?: 'object'
  collection: string
  /** 目标对象类型（OBJ-*）。 */
  objectType: string
  /** 实例 id 模板：`<field>` 占位 + 字面分隔符（与 O1 idRule 同构）。 */
  idTemplate: string
  /** 业务记录时间字段（业务窗/时效门用）。 */
  timeField?: string
  /** 源字段→属性映射；缺省按同名全映。 */
  fields?: O1SourceFieldMap[]
  description?: string
}

export interface O1RelationSourceMap {
  id: string
  kind: 'relation'
  collection: string
  relationType: string
  from: SourceMapEndpoint
  to: SourceMapEndpoint
  /** 对端所在集合键（断引用检查与提示用）。 */
  targetCollection?: string
  description?: string
}

export interface O1CandidateSourceMap {
  id: string
  kind: 'candidate'
  collection: string
  /** 候选 id 字段。 */
  idField: string
  /** 候选归属对象 id 字段（须命中同批对象 id）。 */
  objectRefField: string
  /** objectRef 指向的对象类型（断引用检查用）。 */
  objectType?: string
  /** 特征名 → 源字段。 */
  features?: Record<string, string>
  /** 标签数组字段。 */
  tagsField?: string
  description?: string
}

export interface O1BehaviorSourceMap {
  id: string
  /** behavior=独立集合即事件行；behavior-list=行内嵌套事件数组。 */
  kind: 'behavior' | 'behavior-list'
  collection: string
  behaviorType: string
  /** 归属对象 id 模板（占位取自归属行：list 模式为父行，否则为本行）。 */
  objectRefTemplate: string
  /** 事件行上的时间字段。 */
  timeField?: string
  /** 行为属性名 → 事件行源字段。 */
  attrMap?: Record<string, string>
  /** behavior-list：行内事件数组字段路径。 */
  eventsPath?: string
  description?: string
}

export type O1SourceMap =
  | O1ObjectSourceMap
  | O1RelationSourceMap
  | O1CandidateSourceMap
  | O1BehaviorSourceMap

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
  /** 源映射（bindings/source-maps.yaml）：配置驱动取数的转换契约（api-to-plugin S2.1）。 */
  sourceMaps: O1SourceMap[]
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
  /** 事件属性（source-maps attrMap 落地；可选）。 */
  attrs?: Record<string, unknown>
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
  /**
   * 数据来源信任面（可信取数 T1.2）：inline=Agent 内联提交（未核验）；
   * file=工作区数据文件；connector=可信取数接口。缺省 = 来源未声明（不触发信任检查）。
   */
  provenance?: 'inline' | 'file' | 'connector'
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
  /**
   * 可执行回指（issue #33 缺口1）：缺特征类待核实 → 回查询/补数重算所需种子与来源。
   * 仅缺特征类条目携带（missing 非空）；旧记录/审计类条目无此键。
   */
  refill?: {
    /** 缺失特征名（与 missing 同源，显式命名便于页面预填）。 */
    missingFeatures: string[]
    /** 缺失特征的声明来源类型（规则 featureSources 解析；未声明则空）。 */
    sourceTypes: string[]
    /** 建议回查/补数种子（候选对象 id，可直接作 seedIds）。 */
    seedIds: string[]
    /** 建议动作：query-objects=先回查询补数；rerun-scenario=直接带种子重算。 */
    suggestedAction: 'query-objects' | 'rerun-scenario'
  }
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
  /** 默认 true（参与 passed 与待核实降级）；false=提示项（如 DATA_TRUST），只留痕不阻断。 */
  blocking?: boolean
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
   * 人审屏障（T2.2）：pipeline 里 HUMAN_REVIEW 之后的步骤未自动执行（待人工放行恢复）。
   * 现有包 HUMAN_REVIEW 均为末步 → 缺省无此字段（零回归）。
   */
  reviewBarrier?: { stepId: string; skipped: string[] }
  /**
   * 数据信任提示（可信取数 T1.2）：数据集声明 provenance 时回填。
   * verified 仅当 provenance='connector'；inline 数据经审计 DATA_TRUST 不闭合降级。
   */
  dataTrust?: { provenance: string; verified: boolean; note: string }
  /**
   * 有 prep 时回填的 effective 数据集（buildRunRecord 双 digest 用）。
   * enumerable:false——不进 JSON.stringify / 模型面 / RunRecord.result。
   */
  effectiveDataset?: RuntimeDataset
  /** 契约状态（M1-B）：规则与输出结构是否符合契约。缺省 = 非正式通道不判定。 */
  contractStatus?: ContractStatus
  /** 数据状态（M1-B）：来源/时效/完整性/特征依据。formal 缺依据 → 'insufficient'（不可处置）。 */
  dataStatus?: DataStatus
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 可信数据与三状态（M1-B；接口基线 docs/design/bc-shared-interfaces.md）
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 受保护存储 locator：完整快照落受控存储，结构只留可回查引用 + 摘要。 */
export interface SnapshotLocator {
  /** 受控存储内的快照键（如 snapshots/<id>.json）。 */
  key: string
  /** 快照内容 sha256（canonical JSON），防换内容保 locator。 */
  sha256: string
}

/**
 * 可信取数快照（方案 §5）：服务端连接器取数的来源证据。
 * 只证明「通过已登记来源获得」，不自动证明数据正确或业务完整——
 * 正式分析另查时效、完整性、必需特征与场景关系覆盖。
 */
export interface DataSnapshot {
  /** 服务端分配快照 ID（snap-<uuid8>）。 */
  snapshotId: string
  /** 服务端登记的 sourceId（apiSources 条目 id）；Agent 不得自称 provenance=connector。 */
  sourceId: string
  /** 连接器实现版本（部署配置登记）。 */
  connectorVersion: string
  /** 业务租户（身份面）；取数范围受 BusinessIdentity.dataScope 约束（C 包）。 */
  tenant: string
  /** 查询摘要：查询条件 canonical JSON 的 sha256（不存敏感参数本体）。 */
  queryDigest: string
  /** 取数时刻（ISO）。 */
  fetchedAt: string
  /** 业务时间范围（数据覆盖窗，时效判定用）。 */
  businessWindow: { from: string; to: string }
  /** 完整性：连接器报告分页/截断状态。complete=false → formal 不可得可处置结果。 */
  completeness: { complete: boolean; paged?: boolean; truncatedReason?: string }
  /** 快照 locator（受保护存储；Agent 上下文只出现 locator+摘要，不内联原始数据）。 */
  locator: SnapshotLocator
  /** 来源性质：simulated=本地/测试闭环（F1 记录须显式标注）；business-source=业务来源。 */
  nature: 'simulated' | 'business-source'
}

/** 规则与输出结构是否符合契约（O1/O2/O3 闭合 + 输出契约）。 */
export type ContractStatus = 'conformant' | 'non-conformant'

/**
 * 数据状态（方案 §5「三种结果不要混为一谈」）：
 * verified=连接器来源且时效/完整性/必需特征全过；conditional=探索通道或部分依据缺失
 * （条件性分数）；insufficient=formal 且缺源/超时效/不完整——不可完成/待补数，
 * 不得把「缺特征后 0 分」展示为低风险；unverified=内联/文件/未声明来源。
 */
export type DataStatus = 'verified' | 'conditional' | 'insufficient' | 'unverified'

/**
 * 人工复核状态（方案 §7；实体由 D 包 ReviewDecision 落，B 包先占位字段位）。
 * 与 humanReviewRequired 恒真声明分离——恒真字段不替代真实复核状态。
 */
export type ReviewStatus = 'pending' | 'approved' | 'rejected'

/**
 * 映射校验回执（audit-package P1a）：过程层「数据映射正确」的可指认凭据。
 * 随 RunRecord 落盘并入审计包——客户审计员据此复核「这批数据是怎么映射进
 * 对象/候选的、校验过没有」。回执只含结构化计数与诊断码，不展开行数据。
 */
export interface MappingReceipt {
  /** 回执口径版本。 */
  receiptVersion: 1
  /** 数据来源标记（provenance：connector/inline/file，dataTrust 轴）。 */
  provenance: 'connector' | 'inline' | 'file' | 'unspecified'
  /** source-maps 映射是否发生（true=配置映射连接器转换路径）。 */
  mappingApplied: boolean
  /** 映射契约身份（映射证据可得时）。 */
  mapBasis?: {
    package?: { name: string; version: string }
    /** source-maps 契约指纹：sha256(canonicalJson(maps))。 */
    mapsDigest?: string
    /** 包派生 manifest sourceDigest（派生链指纹）。 */
    sourceDigest?: string
  }
  /** 来源锚点（可指认）：connector=快照证据；file=文件指纹。 */
  sourceAnchor?: {
    snapshotId?: string
    sourceId?: string
    queryDigest?: string
    connectorVersion?: string
    nature?: 'simulated' | 'business-source'
    fileLocator?: string
    fileSha256?: string
  }
  /** 映射诊断汇总（错误/警告计数 + 代码归并计数）。 */
  diagnostics?: {
    errors: number
    warnings: number
    codes: Array<{ code: string; level: string; count: number }>
  }
  /** 映射产出计数（与 datasetSummary 对账；prep 前的输入侧）。 */
  counts?: { objects: number; relations: number; behaviors: number; candidates: number }
  businessWindow?: { from: string; to: string }
  /** 对账锚 === RunRecord.datasetDigest（回执与运行数据一致性可查）。 */
  datasetDigest: string
  issuedAt: string
}

/** 映射证据输入（buildRunRecord 汇入 MappingReceipt；连接器/取数路径自报）。 */
export interface MappingEvidenceInput {
  /** source-maps 映射已执行（配置映射连接器转换路径自报 true）。 */
  mappingApplied?: boolean
  mapBasis?: MappingReceipt['mapBasis']
  sourceAnchor?: MappingReceipt['sourceAnchor']
  /** 映射诊断（transformSourceRows 全量；buildRunRecord 归并为汇总）。 */
  diagnostics?: ValidationIssue[]
  businessWindow?: { from: string; to: string }
}

/**
 * 取数上下文（M1-B）：服务端连接器取数时随数据集传入，runScenario 据此统一判定
 * dataStatus——Agent、wire、CLI 同一入口策略（调用方要求 formal ≠ 已满足可信条件）。
 * 缺省 = 来源未声明。nature/complete/fresh 由服务端连接器与快照核验给出，
 * 不接受调用方自称（伪造来源 → 无 basis → 不得 verified）。
 */
export interface DataBasisInput {
  /** 来源性质（快照 nature）。 */
  nature?: 'simulated' | 'business-source'
  /** 取数完整性（连接器报告：分页/截断）。 */
  complete?: boolean
  /** 时效判定（服务端按业务时间窗判定）。 */
  fresh?: boolean
  /** 快照 ID（对账锚点）。 */
  snapshotId?: string
  /** 服务端登记 sourceId。 */
  sourceId?: string
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
  'SourceMap',
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
  /** 人审留痕：动作执行面（'workbench' 人工直操 / 'host-gate' 系统批准卡 / 'agent-tool' 会话代执行）与时间。 */
  reviewedBy?: string
  reviewedAt?: string
  /** approved→rejected 时保留原批准人/时间（单字段 reviewedBy 会被驳回覆盖，审计链不断）。 */
  approvedBy?: string
  approvedAt?: string
  /** 批准凭证摘要（可信人审 T2.1）：批准时的动作载荷指纹，绑定「批的就是这份内容」。 */
  approvalDigest?: string
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
  /**
   * 业务问题定义（建模前置轻结构，issue #30 差量①）：先于原料的问题工件——
   * 目标/边界/期望结果/反例。「反例」是业务级「不算命中」的样例说明（建模前置语义），
   * 与经验层 ExperienceNote.counterexample（运行反例）不同层，互不覆盖。
   */
  problem?: {
    goal?: string
    boundary?: string
    expected?: string[]
    counterexamples?: string[]
  }
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
  skeleton?: { confirmed: boolean; ids: string[]; problem?: SkeletonRecord['problem'] }
}
