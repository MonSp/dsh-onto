/**
 * Client half of __PKG_ID__ —— browser entry（classic script，零 runtime import/export）。
 *
 * Remote 描述符仅 ontoRuntime RUN 面（与 AML 同一服务；开发命名空间不注册）。
 * 页面与 Agent 共用 runScenario 同源执行路径。
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
  id: '__PKG_ID__',
  factory(require) {
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
      plugin?: (p: unknown) => unknown
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
        id: `__PKG_ID__#${service}/${method}`,
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

    // RUN 面 + 复核面（issue #30 WP-A）+ 受控取数面（WP-B）；无 DEV 命名空间。
    const allDescriptors: InvocationDescriptorLike[] = [
      desc('ontoRuntime', 'listSourceConfigs', true, 'RSC', 'List managed source configs for a package (summary).'),
      desc('ontoRuntime', 'listScenarios', true, 'RTS', 'List scenario cards.'),
      desc('ontoRuntime', 'runScenario', true, 'RTR', 'Run one scenario through the pipeline.'),
      desc('ontoRuntime', 'listRuns', false, 'RLR', 'List persisted run records (summary).'),
      desc('ontoRuntime', 'showRun', true, 'RSH', 'Show one run record (human-review face).'),
      desc('ontoRuntime', 'getRunReport', true, 'RGR', 'Run report projection (human-review face).'),
      desc('ontoRuntime', 'compareRuns', true, 'RCP', 'Compare two run records (human-review face).'),
      desc('ontoRuntime', 'listReportPages', false, 'RLP', 'List saved report pages (human-review face).'),
      desc('ontoRuntime', 'getReportPage', true, 'RGP', 'Show one saved report page (human-review face).'),
      desc('ontoRuntime', 'exportAudit', true, 'RXP', 'Export run audit archive + governance chain.'),
      desc('ontoRuntime', 'listReviewQueue', false, 'RRQ', 'List review queue (RunRecord x ReviewDecision).'),
      desc('ontoRuntime', 'reviewChain', true, 'RRC', 'Governance chain: decision -> proposal -> action.'),
      desc('ontoRuntime', 'recordReviewDecision', true, 'RRD', 'Record a human review decision (UI face).'),
      desc('ontoRuntime', 'listExperiences', false, 'EXL', 'List experience notes (summary).'),
      desc('ontoRuntime', 'showExperience', true, 'EXS', 'Show one experience note (human-review face).'),
      desc('ontoRuntime', 'annotateExperience', true, 'EXA', 'Create or backfill one experience note (UI face).'),
      desc('ontoRuntime', 'createActionProposal', true, 'CAP', 'Create an action proposal (governed, single-use).'),
      desc('ontoRuntime', 'prepareAction', true, 'RPA', 'Issue a UI approval challenge (two-phase approval card).'),
      desc('ontoRuntime', 'executeAction', true, 'REA', 'Execute an action with UI approval proof (page face).'),
      desc('ontoRuntime', 'reconcileAction', true, 'RRL', 'Manual reconcile of an unknown/in-flight action record.'),
      desc('ontoRuntime', 'browseObjects', true, 'RBO', 'Browse entity instances (paged, by type).'),
      desc('ontoRuntime', 'expandEntity', true, 'REX2', 'Expand entity neighborhood subgraph from seeds.'),
    ]

    const React = require('react') as typeof import('react')
    const ui = createPlugin(React)

    return {
      inject: ['remote', 'slots', 'locale', 'layout'],
      async apply(ctx: Ctx): Promise<void> {
        try {
          await ctx.remote.$mount({ package: '__PKG_ID__', descriptors: allDescriptors })
          console.log('__LOG_PREFIX__ $mount ok, descriptors:', allDescriptors.length)
        } catch (e) {
          console.error('__LOG_PREFIX__ $mount FAILED:', e)
          throw e
        }
        const nested = ctx as Ctx
        if (typeof nested.plugin === 'function' && ctx.slots && ctx.locale) {
          nested.plugin({
            name: '__PLUGIN_INSERT_ID__-run-ui',
            inject: ['remote.ontoRuntime', 'slots', 'locale', 'remote', 'layout'],
            apply: (c: unknown) => ui.apply(c as never),
          })
        } else if (ctx.slots && ctx.locale) {
          ui.apply(ctx as never)
        }
      },
    }
  },
})
