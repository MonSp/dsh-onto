/**
 * 实例级鉴权与业务策略（M1-C；接口基线 docs/design/bc-shared-interfaces.md）。
 *
 * 口径（方案 §6）：
 * - 授权判定六元组：`宿主用户身份 + 租户 + 业务角色 + 操作 + 目标实例 + 数据范围`。
 *   身份来自可信宿主或业务认证服务（迟到读取），**不来自工具参数**的 username/role/tenant。
 * - **三次不同检查**：类型存在 → 实例存在 → 当前用户有权操作目标实例；
 *   任一未过即拒绝（deny-by-default），三者不得合并成一次模糊判定。
 * - 覆盖读取、扩图、候选之外的关系/行为、载荷内对象、运行历史、导出和动作——
 *   不只检查 candidates。
 * - **批准卡不是授予业务权限的工具**：无权限时即使点允许也不执行（权限判定在批准之前，
 *   且派发前再次核验）。
 * - 宿主拿不到可信业务身份时正式模式保持关闭；不以自由字符串替代身份集成。
 * - 首期单用户、单业务租户，保留实例级权限检查（多租户规模化不在本轮）。
 * @module @dsh-onto/backend/business-policy
 */
import { AgentToolError, isRecord } from './agent-policy.js'

/** 业务操作面（授权判定入参；不进身份本体）。 */
export type BusinessOperation =
  | 'read'          // 读取数据/候选/特征
  | 'expand'        // 扩图（expand_entity 及 prep 扩图入参面）
  | 'related-read'  // 候选之外的关系/行为读取
  | 'history'       // 运行历史/审计导出
  | 'export'        // 导出
  | 'act'           // 业务动作（execute_behavior_action 及后续正式动作）

/**
 * 可信业务身份（宿主/业务认证服务产出）。
 * userId/tenant/roles 一律取自可信源——工具参数自称的身份无效（见 resolveIdentity）。
 */
export interface BusinessIdentity {
  /** 宿主可信用户 id。 */
  userId: string
  /** 业务租户。 */
  tenant: string
  /** 业务角色集合（如 analyst / reviewer）。 */
  roles: string[]
  /** 数据范围：允许取数/读取的对象类型与实例过滤。 */
  dataScope: { objectTypes: string[]; instanceFilter?: string }
}

/** 目标实例引用（授权判定入参）：类型 + 实例段（TYPE:instance 解析后）。 */
export interface TargetRef {
  type: string
  instance: string
}

/** 三次独立检查的证据面（调用方提供——类型/实例存在性由本体与数据面回答）。 */
export interface ExistenceChecks {
  /** 类型存在（O1 类型 id 在本体中）。 */
  typeExists: (type: string) => boolean
  /** 实例存在（在数据集/图/连接器可见面中）。 */
  instanceExists: (type: string, instance: string) => boolean
}

/** 操作 → 所需角色（业务策略配置；缺省 = 读面任何已识别角色可做，动作面需显式角色）。 */
const OPERATION_ROLES: Record<BusinessOperation, string[] | null> = {
  read: null,
  expand: null,
  'related-read': null,
  history: null,
  export: ['analyst', 'reviewer'],
  act: ['analyst'],
}

/**
 * 授权判定（六元组合一入口）：三次检查 + 角色 + 数据范围。
 * 返回 undefined = 放行；返回拒绝语 = 拒绝（含机器可读码前缀）。
 */
export function authorize(
  identity: BusinessIdentity,
  operation: BusinessOperation,
  target: TargetRef | null,
  checks: ExistenceChecks,
): string | undefined {
  // 检查一：类型存在（target 为 null 的操作（history）跳过实例面，但仍过身份/角色）
  if (target !== null && !checks.typeExists(target.type)) {
    return `OBJECT_NOT_GRANTED: 类型不存在 ${target.type}（类型存在性检查未过）`
  }
  // 检查二：实例存在
  if (target !== null && !checks.instanceExists(target.type, target.instance)) {
    return `OBJECT_NOT_GRANTED: 实例不存在 ${target.type}:${target.instance}（实例存在性检查未过）`
  }
  // 检查三：当前用户有权操作目标实例（角色 + 数据范围）
  const required = OPERATION_ROLES[operation]
  if (required !== null && !required.some((r) => identity.roles.includes(r))) {
    return `OBJECT_NOT_GRANTED: 操作 ${operation} 需要角色 ${required.join('/')}（当前 ${identity.roles.join('/') || '无'}）`
  }
  if (target !== null) {
    const scope = identity.dataScope
    if (scope.objectTypes.length > 0 && !scope.objectTypes.includes(target.type)) {
      return `OBJECT_NOT_GRANTED: ${target.type} 不在数据范围（dataScope.objectTypes）`
    }
    if (scope.instanceFilter !== undefined && scope.instanceFilter !== '') {
      // 受限实例过滤表达（前缀匹配；不引入任意表达式执行）
      if (!target.instance.startsWith(scope.instanceFilter)) {
        return `OBJECT_NOT_GRANTED: 实例 ${target.instance} 不满足数据范围实例过滤（${scope.instanceFilter}*）`
      }
    }
  }
  return undefined
}

/** 身份提供者（宿主/业务认证服务迟到读取；拿不到 → null = 正式模式保持关闭）。 */
export type IdentityProvider = () => BusinessIdentity | null | undefined

/**
 * 业务策略面：身份解析 + 授权判定 + 正式模式门。
 * 身份只经 provideIdentity 解析（宿主可信源），不读工具参数。
 */
export class BusinessPolicy {
  private provider: IdentityProvider | null = null

  /** 登记可信身份提供者（部署适配器/宿主服务接线；重复登记覆盖——部署期一次）。 */
  setIdentityProvider(provider: IdentityProvider | null): void {
    this.provider = provider
  }

  /**
   * 解析可信业务身份。服务缺席/异常/未登记 → null（正式模式保持关闭，
   * 不以自由字符串替代身份集成；不靠模型声明判身份）。
   */
  resolveIdentity(): BusinessIdentity | null {
    if (this.provider === null) return null
    try {
      const id = this.provider()
      if (id === undefined || id === null) return null
      if (
        !isRecord(id)
        || typeof id.userId !== 'string' || id.userId === ''
        || typeof id.tenant !== 'string' || id.tenant === ''
        || !Array.isArray(id.roles) || !id.roles.every((r) => typeof r === 'string')
        || !isRecord(id.dataScope) || !Array.isArray(id.dataScope.objectTypes)
      ) {
        return null // 形状非法 = 身份不可信（fail-closed）
      }
      return id as unknown as BusinessIdentity
    } catch {
      return null // 提供者异常 = 身份不可确认（fail-closed，不冒充）
    }
  }

  /**
   * 授权（解析身份 + 三次检查合一）。身份不可确认 → 拒绝开展受控业务
   * （方案 §4「新业务会话身份不能确认时拒绝开展受控业务」）。
   */
  authorize(
    operation: BusinessOperation,
    target: TargetRef | null,
    checks: ExistenceChecks,
  ): string | undefined {
    const identity = this.resolveIdentity()
    if (identity === null) {
      return 'OBJECT_NOT_GRANTED: 业务身份不可确认（可信宿主/认证服务缺席）——拒绝开展受控业务，不靠模型声明判身份'
    }
    return authorize(identity, operation, target, checks)
  }
}

/** 服务端共享策略面（同 dataSources 模式；部署适配器接身份提供者）。 */
export const businessPolicy = new BusinessPolicy()

/**
 * 业务授权入口门（六元组接线面）：可解析身份 → 全量 {@link authorize}（三查 + 角色 + dataScope），
 * 拒绝抛 {@link AgentToolError} `OBJECT_NOT_GRANTED`（批准卡不是授予权限的工具——权限判定在批准之前）。
 *
 * WHY（身份不可解析口径）：act / export / history / formal-read 一律拒绝（正式模式保持关闭，
 * 宿主拿不到可信业务身份时不以自由字符串替代身份集成）；explore 的 read / expand / related-read
 * 放行——探索通道结果已有未核验降级轴（dataStatus=unverified/conditional、pendingVerification），
 * 不冒充可信分析。`opts.analysisMode='formal'` 的读面视同 formal-read。
 */
export function requireBizAuth(
  operation: BusinessOperation,
  target: TargetRef | null,
  checks: ExistenceChecks,
  opts?: { analysisMode?: 'formal' | 'explore' },
): void {
  const identity = businessPolicy.resolveIdentity()
  if (identity === null) {
    const readFamily = operation === 'read' || operation === 'expand' || operation === 'related-read'
    const formal = opts?.analysisMode === 'formal'
    if (!readFamily || formal) {
      throw new AgentToolError(
        'OBJECT_NOT_GRANTED',
        `业务身份不可确认（可信宿主/业务认证服务缺席）——${operation}${formal ? '（formal 正式模式）' : ''}`
          + '一律拒绝（正式模式保持关闭）；explore 读面（read/expand/related-read）放行（结果带未核验降级轴）',
      )
    }
    return
  }
  const denial = authorize(identity, operation, target, checks)
  if (denial !== undefined) {
    throw new AgentToolError('OBJECT_NOT_GRANTED', denial)
  }
}

/** 解析 TYPE:instance 目标引用（授权判定入参；非法形态 → INVALID_ARGS）。 */
export function parseTargetRef(objectRef: string): TargetRef {
  const i = objectRef.indexOf(':')
  if (i <= 0) {
    throw new AgentToolError('INVALID_ARGS', `目标引用非法（须为 TYPE:instance）: ${objectRef}`)
  }
  const type = objectRef.slice(0, i)
  const instance = objectRef.slice(i + 1)
  if (instance === '' || /[\s:]/.test(instance)) {
    throw new AgentToolError('INVALID_ARGS', `目标引用非法（实例段）: ${objectRef}`)
  }
  return { type, instance }
}
