/**
 * Host entry of @dsh-tax/app —— named `apply` only（禁止 default export 混用）。
 *
 * 第二业务插件最小装配：
 * - 注册 ontoRuntime wire + RUN 工具/技能面（与 @dsh-aml/app 同一公共 runtime 实现）
 * - **不**注册 DEV 服务（Workspace/Model/Validate/Derive/Knowledge）
 * - 显式 `DSH_TAX_API_URL` 才登记 `SRC-TAX-CORE` 只读数据源（与包 apiSources.id 一致）
 * - 无动作连接器（本轮只读分析）
 * 依赖方向：core <- runtime <- TAX host；不 import backend/workbench。
 * @module @dsh-tax/app
 */
import type { Context } from '@deepseek-ai/cordis'
import { enableStrictReleaseMode, OntoRuntime, runtimeContextForHost, dataSources } from '@dsh-onto/runtime'
import { applyRun } from '@dsh-onto/runtime/agent-tools'
import { apply as applySkills } from '@dsh-onto/runtime/agent-skills'
import { businessPolicy, createLazyUserResolver } from '@dsh-onto/runtime'
import { createTaxDataConnector } from './tax-connector.js'

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

export const TAX_SOURCE_ID = 'SRC-TAX-CORE'

export function apply(ctx: Context): void {
  const runtime = runtimeContextForHost(ctx.root)
  // 同宿主仅允许一个本体运行服务提供者（与 backend/AML 冲突时 fail-loud）。
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
  enableStrictReleaseMode()
  // RUN wire only — DEV namespaces 未注册。
  ctx.plugin(OntoRuntime)
  ctx.plugin(runToolsPlugin)
  ctx.plugin(skillsPlugin)

  // 身份与 backend/AML 同口径：缺省关闭；env 不全 → null（正式读被拒，探索仍需身份时同拒）。
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

  // 只读数据源：显式 URL 才登记（deny-by-default；地址只来自部署配置）。
  const taxApiUrl = process.env.DSH_TAX_API_URL
  if (typeof taxApiUrl === 'string' && taxApiUrl !== '') {
    const kind = process.env.DSH_TAX_API_KIND === 'formal' ? 'formal' : 'simulated'
    dataSources.register(TAX_SOURCE_ID, createTaxDataConnector({ baseUrl: taxApiUrl, kind }))
    console.log(`[dsh-tax] data source registered: ${TAX_SOURCE_ID} (kind=${kind}):`, taxApiUrl)
  } else {
    console.log('[dsh-tax] DSH_TAX_API_URL not set — SRC-TAX-CORE not registered (sourceId runs will deny)')
  }

  console.log('[dsh-tax] mounted: OntoRuntime + RUN tools/skills (no DEV services, no action connectors)')
}
