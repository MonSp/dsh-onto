/**
 * Client half of @caliber/backend —— 手写 Remote 贡献并挂载进 Gateway，
 * 让所有消费方 bundle 能注入 `remote.caliber*` 命名空间。无 UI。
 *
 * Runtime shape: dsh loads bundle clients as CLASSIC scripts, so this file
 * emits with zero runtime import/export. Descriptors are hand-written because
 * `@deepseek-ai/dsh-typert-protocol` is not a module-table seed word; `zod`
 * is a seed word and backs the codecs.
 *
 * Namespaces: caliberWorkspace, caliberModel, caliberValidate, caliberDerive,
 * caliberKnowledge, caliberRuntime.
 */

type RemoteResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { message: string; code?: string } }
void (0 as unknown as RemoteResult<unknown>)

interface TypertCodecLike {
  mode: 'strict'
  typeSymbol: string
  create: () => { parse(value: unknown): unknown }
  decode?: (value: unknown) => unknown
}

interface InvocationParameterDescriptorLike {
  name: string
  wire: string
  source: 'json' | 'lookup'
  codec: TypertCodecLike
}

interface InvocationDescriptorLike {
  id: string
  service: string
  namespace: string
  method: string
  invocation: { kind: 'direct' }
  parameters: readonly InvocationParameterDescriptorLike[]
  result: TypertCodecLike
  description?: string
}

interface TypertRemoteContributionLike {
  package: string
  descriptors: readonly InvocationDescriptorLike[]
}

interface Remote {
  $mount(contribution: TypertRemoteContributionLike): Promise<() => Promise<void>>
}

interface Ctx {
  effect(dispose: void | (() => void) | Promise<void>, key?: string): void
  remote: Remote
}

interface ModuleRequire {
  (id: 'zod'): typeof import('zod')
  (id: string): unknown
}

interface PluginModule {
  inject?: string[]
  apply(ctx: Ctx): void | Promise<void>
}

interface Window {
  __ModuleLoader__: {
    load(entry: { id: string; factory(require: ModuleRequire): PluginModule }): void
  }
}

window.__ModuleLoader__.load({
  id: '@caliber/backend',
  factory(require): PluginModule {
    const zod = require('zod')

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
        id: `@caliber/backend#${service}/${method}`,
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
      // caliberWorkspace —— 包管理与签发状态机
      desc('caliberWorkspace', 'listVersions', false, 'WLV', 'List all package versions.'),
      desc('caliberWorkspace', 'createPackage', true, 'WCP', 'Create a new DRAFT package version.'),
      desc('caliberWorkspace', 'forkVersion', true, 'WFK', 'Fork a new editable version.'),
      desc('caliberWorkspace', 'transition', true, 'WTR', 'State machine transition (issue is human-only).'),
      desc('caliberWorkspace', 'exportVersion', true, 'WEX', 'Export a version as a JSON archive.'),
      desc('caliberWorkspace', 'importVersion', true, 'WIM', 'Import a JSON archive.'),
      // caliberModel —— O1/O2/O3 模型读写
      desc('caliberModel', 'load', true, 'MLD', 'Load the ontology package model.'),
      desc('caliberModel', 'save', true, 'MSV', 'Save the model (ISSUED refuses).'),
      desc('caliberModel', 'readSources', true, 'MRS', 'Read raw source files.'),
      desc('caliberModel', 'writeSource', true, 'MWS', 'Write one YAML source file.'),
      // caliberValidate
      desc('caliberValidate', 'validate', true, 'VVD', 'Validate and persist quality-report.json.'),
      desc('caliberValidate', 'summary', true, 'VSM', 'Validate without writing the report.'),
      // caliberDerive
      desc('caliberDerive', 'derive', true, 'DDV', 'Generate derived/** + manifest.'),
      desc('caliberDerive', 'gate', true, 'DGT', 'Load gate (DERIVED_DRIFT on mismatch).'),
      // caliberKnowledge
      desc('caliberKnowledge', 'uploadSource', true, 'KUS', 'Upload one knowledge source (sha256 idempotent).'),
      desc('caliberKnowledge', 'parseSource', true, 'KPS', 'Parse into draft candidates (LLM + heuristic fallback).'),
      desc('caliberKnowledge', 'listSources', true, 'KLS', 'List knowledge sources.'),
      desc('caliberKnowledge', 'listCandidates', true, 'KLC', 'List draft candidates.'),
      desc('caliberKnowledge', 'reviewCandidate', true, 'KRC', 'Human review: approve / reject / merge.'),
      desc('caliberKnowledge', 'materialize', true, 'KMZ', 'Materialize approved candidates into the package.'),
      // caliberRuntime
      desc('caliberRuntime', 'listScenarios', true, 'RTS', 'List scenario cards.'),
      desc('caliberRuntime', 'runScenario', true, 'RTR', 'Run one scenario through the pipeline.'),
    ]

    return {
      inject: ['remote'],
      async apply(ctx: Ctx): Promise<void> {
        try {
          await ctx.remote.$mount({ package: '@caliber/backend', descriptors: allDescriptors })
          console.log('[caliber-backend] $mount ok, descriptors:', allDescriptors.length)
        } catch (e) {
          console.error('[caliber-backend] $mount FAILED:', e)
          throw e
        }
      },
    }
  },
})
