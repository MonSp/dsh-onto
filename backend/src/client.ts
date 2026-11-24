/**
 * Client half of @dsh-onto/backend —— 手写 Remote 贡献并挂载进 Gateway，
 * 让所有消费方 bundle 能注入 `remote.dsh-onto*` 命名空间。无 UI。
 *
 * Runtime shape: dsh loads bundle clients as CLASSIC scripts, so this file
 * emits with zero runtime import/export. Descriptors are hand-written because
 * `@deepseek-ai/dsh-typert-protocol` is not a module-table seed word; `zod`
 * is a seed word and backs the codecs.
 *
 * Namespaces: ontoWorkspace, ontoModel, ontoValidate, ontoDerive,
 * ontoKnowledge, ontoRuntime, ontoSource.
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
  id: '@dsh-onto/backend',
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
        id: `@dsh-onto/backend#${service}/${method}`,
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
      // ontoWorkspace —— 包管理与签发状态机
      desc('ontoWorkspace', 'listVersions', false, 'WLV', 'List all package versions.'),
      desc('ontoWorkspace', 'createPackage', true, 'WCP', 'Create a new DRAFT package version.'),
      desc('ontoWorkspace', 'forkVersion', true, 'WFK', 'Fork a new editable version.'),
      desc('ontoWorkspace', 'transition', true, 'WTR', 'State machine transition (issue is human-only).'),
      desc('ontoWorkspace', 'exportVersion', true, 'WEX', 'Export a version as a JSON archive.'),
      desc('ontoWorkspace', 'importVersion', true, 'WIM', 'Import a JSON archive.'),
      // ontoModel —— O1/O2/O3 模型读写
      desc('ontoModel', 'load', true, 'MLD', 'Load the ontology package model.'),
      desc('ontoModel', 'save', true, 'MSV', 'Save the model (ISSUED refuses).'),
      desc('ontoModel', 'readSources', true, 'MRS', 'Read raw source files.'),
      desc('ontoModel', 'writeSource', true, 'MWS', 'Write one YAML source file.'),
      desc('ontoModel', 'getGraph', true, 'MGR', 'Build the modeling graph (nodes/edges/issues) for the canvas.'),
      // ontoValidate
      desc('ontoValidate', 'validate', true, 'VVD', 'Validate and persist quality-report.json.'),
      desc('ontoValidate', 'summary', true, 'VSM', 'Validate without writing the report.'),
      // ontoDerive
      desc('ontoDerive', 'derive', true, 'DDV', 'Generate derived/** + manifest.'),
      desc('ontoDerive', 'gate', true, 'DGT', 'Load gate (DERIVED_DRIFT on mismatch).'),
      // ontoKnowledge
      desc('ontoKnowledge', 'uploadSource', true, 'KUS', 'Upload one knowledge source (sha256 idempotent).'),
      desc('ontoKnowledge', 'uploadSources', true, 'KUB', 'Batch-upload knowledge sources in one call.'),
      desc('ontoKnowledge', 'parseSource', true, 'KPS', 'Parse into draft candidates (LLM + heuristic fallback).'),
      desc('ontoKnowledge', 'listSources', true, 'KLS', 'List knowledge sources.'),
      desc('ontoKnowledge', 'listCandidates', true, 'KLC', 'List draft candidates.'),
      desc('ontoKnowledge', 'updateCandidate', true, 'KUP', 'Edit a pending draft before approval.'),
      desc('ontoKnowledge', 'reviewCandidate', true, 'KRC', 'Human review: approve / reject / merge.'),
      desc('ontoKnowledge', 'previewMaterialize', true, 'KPV', 'Dry-run materialize: show what would be written.'),
      desc('ontoKnowledge', 'materialize', true, 'KMZ', 'Materialize approved candidates into the package.'),
      desc('ontoKnowledge', 'saveSkeleton', true, 'KSK', 'Save/confirm the modeling skeleton (I6 gate).'),
      // ontoRuntime
      desc('ontoRuntime', 'listSourceConfigs', true, 'RSC', 'List managed source configs for a package (summary).'),
      desc('ontoRuntime', 'listScenarios', true, 'RTS', 'List scenario cards.'),
      desc('ontoRuntime', 'runScenario', true, 'RTR', 'Run one scenario through the pipeline.'),
      desc('ontoRuntime', 'listRuns', false, 'RLR', 'List persisted run records (summary).'),
      desc('ontoRuntime', 'listReviewQueue', false, 'RLQ', 'Review queue: runs joined with latest ReviewDecision.'),
      desc('ontoRuntime', 'showRun', true, 'RSH', 'Show one run record (human-review face).'),
      desc('ontoRuntime', 'getRunReport', true, 'RGR', 'Run report projection (human-review face).'),
      desc('ontoRuntime', 'listReportPages', false, 'RLP', 'List saved report pages (human-review face).'),
      desc('ontoRuntime', 'getReportPage', true, 'RGP', 'Show one saved report page (human-review face).'),
      desc('ontoRuntime', 'compareRuns', true, 'RCP', 'Compare two run records.'),
      desc('ontoRuntime', 'exportAudit', true, 'REX', 'Export one run audit archive.'),
      desc('ontoRuntime', 'reviewChain', true, 'RVC', 'Review decision -> proposal -> action chain for one run.'),
      desc('ontoRuntime', 'recordReviewDecision', true, 'RRD', 'Record business review decision (UI write).'),
      desc('ontoRuntime', 'createActionProposal', true, 'RCP', 'Create an action proposal (governed, single-use).'),
      desc('ontoRuntime', 'prepareAction', true, 'RPA', 'Issue a UI approval challenge (two-phase approval card).'),
      desc('ontoRuntime', 'executeAction', true, 'REA', 'Execute an action with UI approval proof (page face).'),
      desc('ontoRuntime', 'reconcileAction', true, 'RRL', 'Manual reconcile of an unknown/in-flight action record.'),
      desc('ontoRuntime', 'browseObjects', true, 'RBO', 'Browse entity instances (paged, by type).'),
      desc('ontoRuntime', 'expandEntity', true, 'REX2', 'Expand entity neighborhood subgraph from seeds.'),
      desc('ontoRuntime', 'listExperiences', false, 'EXL', 'List experience notes (summary).'),
      desc('ontoRuntime', 'showExperience', true, 'EXS', 'Show one experience note (human-review face).'),
      desc('ontoRuntime', 'reviewExperience', true, 'EXR', 'Human review write-back: outcome / misTransfer / reviewFocus.'),
      // ontoSource —— 接入面（api-to-plugin S2.6：采样/映射预览/生成/回放）
      desc('ontoSource', 'probe', true, 'SPB', 'Probe a sample API: field/type table (build-time only).'),
      desc('ontoSource', 'preview', true, 'SPV', 'Preview source maps: counts + diagnostics + evidence readiness.'),
      desc('ontoSource', 'generate', true, 'SGN', 'Generate a minimal DSH plugin (workspace-fenced outDir).'),
      desc('ontoSource', 'replay', true, 'SRY', 'Replay fixture report (workspace-fenced paths).'),
    ]

    return {
      inject: ['remote'],
      async apply(ctx: Ctx): Promise<void> {
        try {
          await ctx.remote.$mount({ package: '@dsh-onto/backend', descriptors: allDescriptors })
          console.log('[dsh-onto-backend] $mount ok, descriptors:', allDescriptors.length)
        } catch (e) {
          console.error('[dsh-onto-backend] $mount FAILED:', e)
          throw e
        }
      },
    }
  },
})
