/**
 * 全工具权限沙箱（可信执行 T4.2 / R3）—— 本体专家会话的非本体工具治理。
 *
 * 威胁面（评估结论 §5）：专家预设（onto-*）携带通用文件 / Shell / 定时等工具，本体收权（agent-grants）
 * 只覆盖 dsh-onto 工具面——专家会话仍可写文件、跑 shell、建定时任务，绕开本体治理面（改台账、改包源、
 * 越权取数都走这条路），不是整个 Agent 的权限沙箱。
 *
 * 口径（R3 能力许可集）：
 * - **作用域**：仅本体专家 preset 会话（`onto-*`）；标准会话 / 无 preset 不受影响
 *   （用户主线会话保留完整工具面——沙箱管的是本体专家子面，不是宿主本身）。
 * - **放行面**：本体工具（ONTOOL_NAMES，另过对象收权）、只读检索（read/glob/grep…）、
 *   人审交互（ask_user_question）等非破坏面照常。
 * - **拒绝面**：写入/编辑/删除/执行/定时类通用工具（bash、pwsh、write、schedule_create…）
 *   一律拒绝；**未登记能力（动态工具 / MCP 工具 / 命名空间别名 / 编程执行入口）fail-closed**——
 *   没有可信元数据的入口不得默认放行（能力许可集口径，黑名单只是补充识别）。
 * - 拒绝语指明走本体工具/工作台人审面。
 * - **身份可靠性（R3）**：专家沙箱身份是运行属性——preset 解析成功即缓存；preset 服务异常
 *   不得把已知受控专家悄悄退化为标准会话（缓存命中照常拒绝）。
 * - 新增危险能力词须补进 DANGEROUS 表（attack-surface 源断言锁清单）。
 * @module @dsh-onto/backend/agent-sandbox
 */
import { ONTOOL_NAMES } from './agent-grants.js'

/** 本体专家 preset 前缀（onto-aml / onto-tax / onto-med …）。 */
export const ONTO_PRESET_PREFIX = 'onto-'

/** 写入/执行类通用工具精确名。 */
const DANGEROUS_NAMES: ReadonlySet<string> = new Set([
  'bash',
  'pwsh',
  'write',
  'edit',
  'str_replace_editor',
  'run_code',
  'apply_patch',
])

/**
 * 危险能力词（按工具名分段匹配：`delete_file` / `exec_command` / `schedule_create` 同样命中；
 * 新增写入/执行/定时类工具须落进此表）。run/code 等通用段不入表，防误伤 run_scenario 等复合名。
 */
const DANGEROUS_WORDS: ReadonlySet<string> = new Set([
  'write',
  'edit',
  'delete',
  'remove',
  'rename',
  'move',
  'copy',
  'exec',
  'execute',
  'shell',
  'bash',
  'pwsh',
  'powershell',
  'cmd',
  'patch',
  'kill',
  'install',
  'uninstall',
  'schedule',
  'cron',
  'timer',
  'job',
])

/** 只读检索面（显式登记；受控身份下未登记能力 fail-closed）。 */
const READONLY_NAMES: ReadonlySet<string> = new Set([
  'read',
  'read_image',
  'glob',
  'grep',
  'search',
  'search_files',
  'list',
  'ls',
])

/** 人审交互面。 */
const INTERACTIVE_NAMES: ReadonlySet<string> = new Set(['ask_user_question'])

/**
 * 能力分类（R3 受控能力许可集）：
 * `onto` 本体工具（另过对象收权）/ `readonly` 只读检索 / `interactive` 人审交互 /
 * `write` 写入·执行·定时类危险能力 / `unclassified` 未登记能力（动态工具、MCP、别名、编程入口）。
 */
export type ToolCapability = 'onto' | 'readonly' | 'interactive' | 'write' | 'unclassified'

/** 是否本体专家 preset 会话。 */
export function isOntoPreset(presetId: string | null | undefined): boolean {
  return typeof presetId === 'string' && presetId.startsWith(ONTO_PRESET_PREFIX)
}

/** 是否写入/执行类通用工具（危险能力识别：精确名 ∪ 名字段命中）。 */
export function isDangerousGeneralTool(toolName: string): boolean {
  if (READONLY_NAMES.has(toolName) || INTERACTIVE_NAMES.has(toolName)) return false
  if (DANGEROUS_NAMES.has(toolName)) return true
  // 分段匹配（-_./ 切分）：delete_file / exec_command / v2-write / schedule_create 同样命中
  return toolName
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((seg) => seg !== '' && DANGEROUS_WORDS.has(seg))
}

/** 工具能力归类（R3）：受控身份按许可集放行，未登记能力不默认放行。 */
export function classifyToolCapability(toolName: string): ToolCapability {
  if (ONTOOL_NAMES.has(toolName)) return 'onto'
  if (INTERACTIVE_NAMES.has(toolName)) return 'interactive'
  if (READONLY_NAMES.has(toolName)) return 'readonly'
  if (isDangerousGeneralTool(toolName)) return 'write'
  return 'unclassified'
}

/**
 * 沙箱判定纯函数：专家会话 + 非本体工具 → 按能力许可集处置；
 * 只读/交互放行，写入/执行/定时拒绝，**未登记能力 fail-closed**；
 * 其余（非受控会话）一律 undefined。
 */
export function toolSandboxDecision(toolName: string, presetId: string | null | undefined): string | undefined {
  if (!isOntoPreset(presetId)) return undefined
  const capability = classifyToolCapability(toolName)
  if (capability === 'onto' || capability === 'readonly' || capability === 'interactive') return undefined
  const reason =
    capability === 'write'
      ? `通用写入/执行/定时类工具 ${toolName} 不在放行面`
      : `未登记能力 ${toolName}（动态工具/MCP/命名空间别名/编程执行入口）不在受控许可集——fail-closed`
  return (
    `TOOL_SANDBOX_DENIED: 本体专家会话为受控沙箱，${reason}`
    + '（写包走 apply_draft、取数走 run_scenario、人审走批准卡/工作台；需要通用写入请用标准会话）'
  )
}

/**
 * 专家沙箱身份解析（R3 身份可靠性）：preset 解析成功即按会话缓存；
 * preset 服务异常时回退缓存——已知受控身份不丢失，不把受控专家退化为标准会话。
 * 服务缺席（可晚注册）与从未解析成功的会话保持「无 preset」口径（标准会话不误伤）。
 */
export function createPresetResolver(
  getService: () => ((session: unknown) => string | null) | undefined,
): (agent: unknown) => string | null {
  const known = new WeakMap<object, string | null>()
  return (agent: unknown): string | null => {
    const session = (agent as { session?: unknown } | null | undefined)?.session
    const key = session !== null && typeof session === 'object' ? session : null
    if (session === undefined || session === null) return null
    try {
      const presetForSession = getService()
      if (presetForSession === undefined) return null // 服务缺席不缓存（容许晚注册）
      const presetId = presetForSession(session)
      if (key !== null) known.set(key, presetId)
      return presetId
    } catch {
      // preset 服务异常：已知身份不丢失（缓存命中照常收口）；未知会话按无 preset 处理
      return key !== null ? (known.get(key) ?? null) : null
    }
  }
}
