/**
 * 对象粒度收权（tool-face-policy P2.3）：两段式 resolve → match，deny-by-default。
 *
 * - match 单点：checkGrant / grantMatches；
 * - resolve 两个入参通道：顶层 objectId/objectRef（guard）、dataset 内嵌（执行）；
 * - 任何解析失败、歧义、未命中 → OBJECT_NOT_GRANTED；签发/审阅端点永不进工具面。
 * @module @dsh-onto/backend/agent-grants
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DERIVED_FILES,
  PackageStoreError,
  loadYaml,
  verifyDerived,
  type RuntimeDataset,
} from '@dsh-onto/core'
import { AgentToolError, isRecord } from './agent-policy.js'

/** 全部 dsh-onto 工具名；guard 只作用于本工具面。 */
export const ONTOOL_NAMES: ReadonlySet<string> = new Set([
  'list_packages',
  'get_package',
  'get_rule',
  'list_tool_contracts',
  'list_scenarios',
  'run_scenario',
  'upload_knowledge_source',
])

/** tool-contracts 条目；只保留 grant 相关字段（输出投影）。 */
export interface ToolContractEntry {
  id: string
  objectId?: string
  relationId?: string
  grantScope: string
  idRule?: string | null
  inputs: string[]
  outputs: string[]
}

/** 逐字段裁剪到 grant 面，防御意外扩面。 */
export function projectByContract(raw: unknown): ToolContractEntry {
  const r = isRecord(raw) ? raw : {}
  const entry: ToolContractEntry = {
    id: String(r.id ?? ''),
    grantScope: String(r.grantScope ?? ''),
    inputs: Array.isArray(r.inputs) ? r.inputs.map(String) : [],
    outputs: Array.isArray(r.outputs) ? r.outputs.map(String) : [],
  }
  if (typeof r.objectId === 'string') entry.objectId = r.objectId
  if (typeof r.relationId === 'string') entry.relationId = r.relationId
  if (r.idRule === null) entry.idRule = null
  else if (typeof r.idRule === 'string') entry.idRule = r.idRule
  return entry
}

/** 读取派生收权清单；先过加载门禁，漂移即拒绝。顶层 `idRules` 按 objectId join 进条目（derive 实际格式）。 */
export function readToolContracts(versionDir: string): ToolContractEntry[] {
  let gate: ReturnType<typeof verifyDerived>
  try {
    gate = verifyDerived(versionDir)
  } catch {
    // 门禁内部读取失败（TOCTOU/文件锁）：按不可加载处理；不回显底层 message（含绝对路径）。
    throw new AgentToolError('DERIVED_DRIFT', '拒绝加载: 派生门禁不可读')
  }
  if (!gate.ok) {
    throw new AgentToolError('DERIVED_DRIFT', `拒绝加载: ${gate.reason}`)
  }
  let tools: unknown[]
  let idRules: Array<{ objectId: string; idRule: string | null }> = []
  try {
    const raw = loadYaml(readFileSync(join(versionDir, DERIVED_FILES.toolContracts), 'utf8')) as {
      tools?: unknown[]
      idRules?: unknown[]
    }
    tools = Array.isArray(raw?.tools) ? raw.tools : []
    idRules = Array.isArray(raw?.idRules)
      ? raw.idRules.flatMap((r) => {
          if (!isRecord(r) || typeof r.objectId !== 'string') return []
          return [{ objectId: r.objectId, idRule: r.idRule === null ? null : String(r.idRule ?? '') }]
        })
      : []
  } catch (e) {
    // 门禁通过后仍失败（如 TOCTOU 删文件）：按不可加载处理；只回错误码，
    // 不拼 e.message（ENOENT 的 message 含全路径）。
    const code =
      e instanceof Error && 'code' in e && typeof (e as { code?: unknown }).code === 'string'
        ? (e as { code: string }).code
        : ''
    throw new AgentToolError('DERIVED_DRIFT', `拒绝加载: tool-contracts 不可读${code ? `（${code}）` : ''}`)
  }
  const idRuleByObject = new Map(idRules.map((r) => [r.objectId, r.idRule]))
  return tools.map((t) => {
    const entry = projectByContract(t)
    if (entry.idRule === undefined && entry.objectId !== undefined && idRuleByObject.has(entry.objectId)) {
      entry.idRule = idRuleByObject.get(entry.objectId) ?? null
    }
    return entry
  })
}

/** grant 判定的主体：运行时引用带实例段（`OBJ-AML-ACCOUNT:x`），收权是对象粒度，按类型段匹配。 */
export function grantSubject(objectId: string): string {
  const i = objectId.indexOf(':')
  return i >= 0 ? objectId.slice(0, i) : objectId
}

/** grantScope 判定：objectId（可含 `:实例` 段）必须落在收权清单内，否则拒绝。 */
export function grantMatches(entry: ToolContractEntry, objectId: string): boolean {
  const subject = grantSubject(objectId)
  if (subject === '') return false
  return entry.grantScope === subject || entry.objectId === subject || entry.relationId === subject
}

export function checkGrant(contracts: ToolContractEntry[], objectId: string | undefined): string | undefined {
  if (objectId === undefined) return undefined
  const hit = contracts.some((c) => grantMatches(c, objectId))
  return hit ? undefined : `OBJECT_NOT_GRANTED: ${objectId}`
}

/** guard 判定纯函数：args 带 objectId/objectRef 即须过收权；缺 name/version 一律拒绝。 */
export function grantGuardDecision(
  toolName: string,
  args: unknown,
  readContracts: (name: string, version: string) => ToolContractEntry[],
): string | undefined {
  if (!ONTOOL_NAMES.has(toolName)) return undefined
  const a = isRecord(args) ? args : {}
  // args 含 objectId/objectRef 即须过收权（S2.4）：非字符串/空串一律拒绝，
  // 不静默跳过；null/undefined 视为未提供。
  const scoped: string[] = []
  for (const key of ['objectId', 'objectRef'] as const) {
    const v = a[key]
    if (v === undefined || v === null) continue
    if (typeof v !== 'string' || v.length === 0) {
      return `OBJECT_NOT_GRANTED: ${key} 非法（须为非空字符串）`
    }
    scoped.push(v)
  }
  if (scoped.length === 0) return undefined
  if (typeof a.name !== 'string' || typeof a.version !== 'string') {
    return `OBJECT_NOT_GRANTED: ${scoped.join(', ')}（缺少 name/version，无法核对收权清单）`
  }
  try {
    const contracts = readContracts(a.name, a.version)
    for (const objectId of scoped) {
      const denial = checkGrant(contracts, objectId)
      if (denial !== undefined) return denial
    }
    return undefined
  } catch (e) {
    // 保留机器可读错误码（AgentToolError / PackageStoreError——后者 message 只含调用方入参），
    // 拒绝语义不丢码；其余错误不回显底层 message。
    if (e instanceof AgentToolError) return `${e.code}: ${e.message}`
    if (e instanceof PackageStoreError) return `${e.code}: ${e.message}`
    return 'UNKNOWN_ERROR: 收权清单读取失败'
  }
}

/**
 * dataset 收权（run_scenario 双通道解析后、`runScenario` 之前）：
 * `candidates[].objectRef` 逐条解析到类型后过 grantScope——
 * - 实例 id（无 `:`）→ `objects[].type`；裸 ref 不在图中按自身匹配（未命中即拒）；
 * - `TYPE:inst` 形态：实例在图中时**以声明类型为准**，与类型段不符即拒（防伪托）；
 *   实例不在图中才回退 `:` 前类型段匹配（运行时实例段，如 `OBJ-AML-ACCOUNT:x`）；
 * - 实例 id 重复（无论同型异型）→ 解析歧义，一律拒绝；
 * - 无法解析或未收权一律 OBJECT_NOT_GRANTED（deny-by-default，不以放行掩盖越权）。
 * 顶层 args 由 guard 收口、dataset 由本函数收口，两层覆盖全部入参面。
 */
export function assertDatasetGranted(
  dataset: RuntimeDataset,
  contracts: ToolContractEntry[],
): void {
  // 实例 id → 类型；重复 id 视为解析歧义（同 id 异型可伪托已收权类型），从解析表剔除。
  const typeByInstanceId = new Map<string, string>()
  const ambiguousIds = new Set<string>()
  for (const o of dataset.objects) {
    if (ambiguousIds.has(o.id)) continue
    if (typeByInstanceId.has(o.id)) {
      typeByInstanceId.delete(o.id)
      ambiguousIds.add(o.id)
      continue
    }
    typeByInstanceId.set(o.id, o.type)
  }
  for (const c of dataset.candidates) {
    const subject = resolveDatasetSubject(c.objectRef, typeByInstanceId, ambiguousIds)
    if (subject === undefined) {
      throw new AgentToolError(
        'OBJECT_NOT_GRANTED',
        `dataset 候选 ${c.candidateId} 的 objectRef ${c.objectRef} 解析歧义或类型段与实例声明不符`,
      )
    }
    if (checkGrant(contracts, subject) !== undefined) {
      throw new AgentToolError(
        'OBJECT_NOT_GRANTED',
        `dataset 候选 ${c.candidateId} 的 objectRef ${c.objectRef}（类型 ${subject}）不在收权清单`,
      )
    }
  }
}

/** objectRef → 收权主体；无法安全解析返回 undefined（调用方 deny-by-default）。 */
function resolveDatasetSubject(
  objectRef: string,
  typeByInstanceId: ReadonlyMap<string, string>,
  ambiguousIds: ReadonlySet<string>,
): string | undefined {
  // 完整 ref 命中实例表 → 声明类型（裸实例 id 形态，examples 的 ACCT-001 同此）。
  // 声明类型不得含实例段：夹带冒号的类型会在 grantSubject 二次剥段时被截成
  // 已收权前缀（类型段伪托）——形状校验已拦，此处兜底直调路径（deny-by-default）。
  const direct = typeByInstanceId.get(objectRef)
  if (direct !== undefined) return direct.includes(':') ? undefined : direct
  if (ambiguousIds.has(objectRef)) return undefined
  const colon = objectRef.indexOf(':')
  if (colon >= 0) {
    const typeSeg = objectRef.slice(0, colon)
    const inst = objectRef.slice(colon + 1)
    if (ambiguousIds.has(inst)) return undefined
    const declared = typeByInstanceId.get(inst)
    if (declared !== undefined) {
      // 实例在图中：声明类型是唯一事实；类型段不符即拒（不以放行掩盖越权）。
      return declared === typeSeg ? declared : undefined
    }
    // 实例不在图中：回退类型段匹配（运行时实例段 OBJ-AML-ACCOUNT:x；空类型段永不命中）。
    return typeSeg === '' ? undefined : typeSeg
  }
  // 裸 ref 不在图中：按自身匹配 grantScope（未命中即 deny-by-default）。
  return objectRef === '' ? undefined : objectRef
}

/**
 * list_tool_contracts 过滤：与 guard 同口径——null/undefined 视为未提供（返回全部，
 * P2.3 目录可见豁免仅此一处）；非法值拒绝，不静默退化。
 */
export function pickContracts(
  contracts: ToolContractEntry[],
  objectId: unknown,
): ToolContractEntry[] {
  if (objectId === undefined || objectId === null) return contracts
  if (typeof objectId !== 'string' || objectId.length === 0) {
    throw new AgentToolError('OBJECT_NOT_GRANTED', 'objectId 非法（须为非空字符串）')
  }
  return contracts.filter((c) => grantMatches(c, objectId))
}
