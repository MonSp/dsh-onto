/**
 * Host entry of @dsh-aml/app —— named `apply` only（禁止 default export 混用）。
 *
 * M2 AML 独立只读运行：注册 ontoRuntime wire + RUN 工具/技能面；
 * **不**注册 DEV 服务（Workspace/Model/Validate/Derive/Knowledge）。
 * 依赖方向：core <- runtime <- AML host；不 import backend/workbench。
 * @module @dsh-aml/app
 */
import type { Context } from '@deepseek-ai/cordis'
import { OntoRuntime, runtimeContextForHost } from '@dsh-onto/runtime'
import { applyRun } from '@dsh-onto/runtime/agent-tools'
import { apply as applySkills } from '@dsh-onto/runtime/agent-skills'
import {
  businessPolicy,
  createLazyUserResolver,
  registerTicketSimConnector,
  setFormalActionEnabled,
} from '@dsh-onto/runtime'

/** Bare apply functions lose module-level `inject`; reattach for cordis DI. */
const runToolsPlugin = {
  name: 'dsh-onto-agent-tools-run',
  inject: ['tools'] as string[],
  apply: applyRun,
}
const skillsPlugin = {
  name: 'dsh-onto-agent-skills',
  inject: ['skills'] as string[],
  apply: applySkills,
}

export function apply(ctx: Context): void {
  const runtime = runtimeContextForHost(ctx.root)
  // 同宿主仅允许一个本体运行服务提供者（A4：与 backend 冲突时 fail-loud）。
  runtime.claim()
  ctx.effect(() => () => runtime.dispose())
  try {
    runtime.run(() => mount(ctx))
  } catch (error) {
    runtime.dispose()
    throw error
  }
}

function mount(ctx: Context): void {
  // RUN wire only — DEV namespaces (ontoWorkspace/Model/Validate/Derive/Knowledge) 未注册（A2）。
  ctx.plugin(OntoRuntime)
  ctx.plugin(runToolsPlugin)
  ctx.plugin(skillsPlugin)

  // 身份/正式开关与 backend 同口径：缺省关闭；DSH_FORMAL_ACTION_ENABLED=1 才开。
  const resolveHostUserId = createLazyUserResolver(async () => {
    const svc = (ctx as {
      deepseekAccount?: { getDeviceIdentity?: () => Promise<{ userId?: unknown }> }
    }).deepseekAccount
    if (svc === undefined || typeof svc.getDeviceIdentity !== 'function') return null
    const id = await svc.getDeviceIdentity()
    return typeof id?.userId === 'string' ? id.userId : null
  }, 5_000)
  businessPolicy.setIdentityProvider(() => {
    const userId = resolveHostUserId() ?? process.env.DSH_BIZ_USER_ID
    const tenant = process.env.DSH_BIZ_TENANT
    const roles = (process.env.DSH_BIZ_ROLES ?? '').split(',').map((r) => r.trim()).filter((r) => r !== '')
    if (typeof userId !== 'string' || userId === '' || typeof tenant !== 'string' || tenant === '' || roles.length === 0) {
      return null
    }
    const types = (process.env.DSH_BIZ_SCOPE_TYPES ?? '').split(',').map((t) => t.trim()).filter((t) => t !== '')
    const filter = process.env.DSH_BIZ_SCOPE_FILTER
    return {
      userId,
      tenant,
      roles,
      dataScope: {
        objectTypes: types,
        ...(typeof filter === 'string' && filter !== '' ? { instanceFilter: filter } : {}),
      },
    }
  })
  setFormalActionEnabled(process.env.DSH_FORMAL_ACTION_ENABLED === '1')
  if (process.env.DSH_FORMAL_ACTION_ENABLED === '1') {
    console.log('[dsh-aml] formal action ENABLED by deployment config')
  }

  // M3/F1 工单模拟连接器（kind=simulated）：显式 DSH_TICKET_SIM_URL 才注册；缺省 dryrun 零外部效应。
  const ticketSimUrl = process.env.DSH_TICKET_SIM_URL
  if (typeof ticketSimUrl === 'string' && ticketSimUrl !== '') {
    registerTicketSimConnector({ baseUrl: ticketSimUrl })
    console.log('[dsh-aml] ticket-sim connector registered (kind=simulated):', ticketSimUrl)
  }

  console.log('[dsh-aml] mounted: OntoRuntime + RUN tools/skills (no DEV services)')
}
