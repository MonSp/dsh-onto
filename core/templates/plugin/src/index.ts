/**
 * Host entry of __PKG_ID__ —— named `apply` only（禁止 default export 混用）。
 *
 * 最小自助装配（api-to-plugin S2.4）：
 * - 注册 ontoRuntime wire + RUN 工具/技能面（与 @dsh-aml/app 同一公共 runtime 实现）
 * - **不**注册 DEV 服务（Workspace/Model/Validate/Derive/Knowledge）
 * - 显式 `__ENV_API_URL__` 才登记数据源（deny-by-default；地址与凭证只来自部署配置）
 * - 取数走配置驱动连接器（createMappedDataConnector）：转换契约随包（bindings.json 冻结自已签发包）
 * - 无动作连接器（只读分析）
 * 依赖方向：core <- runtime <- 本插件；不 import backend/workbench。
 * @module __PKG_ID__
 */
import type { Context } from '@deepseek-ai/cordis'
import { enableStrictReleaseMode, OntoRuntime, runtimeContextForHost, dataSources, businessPolicy, createLazyUserResolver, createMappedDataConnector } from '@dsh-onto/runtime'
import { applyRun } from '@dsh-onto/runtime/agent-tools'
import { apply as applySkills } from '@dsh-onto/runtime/agent-skills'
import { BINDINGS } from './bindings.js'

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

export const SOURCE_ID = BINDINGS.sourceId

export function apply(ctx: Context): void {
  const runtime = runtimeContextForHost(ctx.root)
  // 同宿主仅允许一个本体运行服务提供者（不与 backend/AML 冲突时 fail-loud）。
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
  // RUN wire only —— DEV 命名空间未注册。
  ctx.plugin(OntoRuntime)
  ctx.plugin(runToolsPlugin)
  ctx.plugin(skillsPlugin)

  // 业务身份：env 不全 → null（正式读被拒，探索仍需身份时同拒）。
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

  // 只读数据源：显式 URL 才登记（deny-by-default；地址不来自包内）。
  const apiUrl = process.env.__ENV_API_URL__
  if (typeof apiUrl === 'string' && apiUrl !== '') {
    const kind = process.env.__ENV_API_KIND__ === 'formal' ? 'formal' : 'simulated'
    dataSources.register(
      BINDINGS.sourceId,
      createMappedDataConnector({
        sourceId: BINDINGS.sourceId,
        baseUrl: apiUrl,
        shape: BINDINGS.shape,
        maps: BINDINGS.maps,
        kind,
        ...(process.env.__ENV_API_TOKEN__ ? { auth: { token: process.env.__ENV_API_TOKEN__ } } : {}),
      }),
    )
    console.log(`__LOG_PREFIX__ data source registered: ${BINDINGS.sourceId} (kind=${kind}):`, apiUrl)
  } else {
    console.log(`__LOG_PREFIX__ __ENV_API_URL__ not set — ${BINDINGS.sourceId} not registered (sourceId runs will deny)`)
  }

  console.log('__LOG_PREFIX__ mounted: OntoRuntime + RUN tools/skills (no DEV services, no action connectors)')
}
