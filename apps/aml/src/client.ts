/**
 * Client half of @dsh-aml/app —— browser entry（classic script，零 runtime import/export）。
 *
 * M3：治理链面板（运行记录 + decision→proposal→action→externalRef）；
 * Remote 描述符仍仅 ontoRuntime（A2：开发命名空间不注册）。
 */

import { createPlugin } from './client/app'

declare global {
  interface Window {
    __ModuleLoader__: {
      load(entry: { id: string; factory(require: (id: string) => unknown): unknown }): void
    }
  }
}

window.__ModuleLoader__.load({
  id: '@dsh-aml/app',
  factory(require) {
    // Remote descriptors (same set as before) + UI plugin
    const zod = require('zod') as typeof import('zod')

    type TypertCodecLike = {
      mode: 'strict'
      typeSymbol: string
      create: () => { parse(value: unknown): unknown }
      decode?: (value: unknown) => unknown
    }
    type InvocationParameterDescriptorLike = {
      name: string
      wire: string
      source: 'json' | 'lookup'
      codec: TypertCodecLike
    }
    type InvocationDescriptorLike = {
      id: string
      service: string
      namespace: string
      method: string
      invocation: { kind: 'direct' }
      parameters: readonly InvocationParameterDescriptorLike[]
      result: TypertCodecLike
      description?: string
    }
    type TypertRemoteContributionLike = {
      package: string
      descriptors: readonly InvocationDescriptorLike[]
    }
    type Remote = {
      $mount(contribution: TypertRemoteContributionLike): Promise<() => Promise<void>>
    }
    type Ctx = {
      effect(dispose: void | (() => void) | Promise<void>, key?: string): void
      remote: Remote
      locale?: { register(ns: string, dict: unknown): void; bind(ns: string): (k: string) => string }
      slots?: { inject(name: string, register: () => unknown): void; register(spec: Record<string, unknown>, c: unknown): unknown }
    }

    const anyCodec = (typeSymbol: string): TypertCodecLike => ({
      mode: 'strict',
      typeSymbol,
      create: () => zod.any(),
    })
    const voidCodec: TypertCodecLike = {
      mode: 'strict',
      typeSymbol: 'Void',
      create: () => zod.void(),
    }

    function desc(
      service: string,
      method: string,
      request: boolean,
      resultSymbol: string,
      description: string,
    ): InvocationDescriptorLike {
      return {
        id: `@dsh-aml/app#${service}/${method}`,
        service,
        namespace: service,
        method,
        invocation: { kind: 'direct' },
        parameters: request
          ? [{ name: 'request', wire: 'request', source: 'json', codec: anyCodec(`${service}-${method}-req`) }]
          : [],
        result: resultSymbol === 'Void' ? voidCodec : anyCodec(resultSymbol),
        description,
      }
    }

    const allDescriptors: InvocationDescriptorLike[] = [
      desc('ontoRuntime', 'listScenarios', true, 'RTS', 'List scenario cards.'),
      desc('ontoRuntime', 'runScenario', true, 'RTR', 'Run one scenario through the pipeline.'),
      desc('ontoRuntime', 'listRuns', false, 'RLR', 'List persisted run records (summary).'),
      desc('ontoRuntime', 'showRun', true, 'RSH', 'Show one run record (human-review face).'),
      desc('ontoRuntime', 'compareRuns', true, 'RCP', 'Compare two run records.'),
      desc('ontoRuntime', 'exportAudit', true, 'REX', 'Export one run audit archive.'),
      desc('ontoRuntime', 'reviewChain', true, 'RVC', 'Review decision -> proposal -> action chain for one run.'),
      desc('ontoRuntime', 'listExperiences', false, 'EXL', 'List experience notes (summary).'),
      desc('ontoRuntime', 'showExperience', true, 'EXS', 'Show one experience note (human-review face).'),
      desc('ontoRuntime', 'reviewExperience', true, 'EXR', 'Human review write-back.'),
    ]

    const React = require('react') as typeof import('react')
    const ui = createPlugin(React)

    return {
      // 先只依赖 remote 做 $mount；UI 半在挂载完成后以嵌套插件声明 remote.ontoRuntime inject
      // （同插件直接 inject 会自等待：命名空间由本插件自己提供）。
      inject: ['remote', 'slots', 'locale'],
      async apply(ctx: Ctx): Promise<void> {
        try {
          await ctx.remote.$mount({ package: '@dsh-aml/app', descriptors: allDescriptors })
          console.log('[dsh-aml] $mount ok, descriptors:', allDescriptors.length)
        } catch (e) {
          console.error('[dsh-aml] $mount FAILED:', e)
          throw e
        }
        // Nested plugin: inject unlocks ctx.remote.ontoRuntime after $mount has provided it.
        const nested = ctx as Ctx & { plugin?: (p: unknown) => unknown }
        if (typeof nested.plugin === 'function' && ctx.slots && ctx.locale) {
          nested.plugin({
            name: 'dsh-aml-governance-ui',
            inject: ['remote.ontoRuntime', 'slots', 'locale', 'remote'],
            apply: (c: unknown) => ui.apply(c as never),
          })
        } else if (ctx.slots && ctx.locale) {
          // Fallback (tests / minimal ctx): apply directly — GovernancePanel must not
          // gate on inject in that path; see app.ts remote access strategy.
          ui.apply(ctx as never)
        }
      },
    }
  },
})
