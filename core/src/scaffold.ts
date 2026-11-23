/**
 * 插件脚手架（api-to-plugin S2.4）：由**已签发**包 + 场景 + 逻辑源生成最小 DSH 插件。
 *
 * - 生成 ≠ 签发：不改包状态、不落凭据、不触发激活；地址/令牌只出现在部署模板占位。
 * - 映射契约（shape + source-maps）冻结进生成物 `src/bindings.ts`——运行时转换走
 *   runtime 配置驱动连接器（core 纯转换），生成物内无域专用转换代码。
 * - 模板树：core/templates/plugin/**（`__TOKEN__` 占位替换）。
 * @module @dsh-onto/core/scaffold
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPackage, readPackageMeta } from './store.js'
import type { ApiShape, O1SourceMap, OntologyPackage } from './types.js'

export interface GeneratePluginInput {
  /** 已签发包版本目录。 */
  versionDir: string
  scenarioId: string
  /**
   * 逻辑数据源 id（connector 模式：包内须声明 apiSources shape + source-maps）。
   * 缺省 = dataset 模式（纯内容包）：运行页走内联 dataset 通道，无连接器登记。
   */
  sourceId?: string
  /** 运行夹具显式指定（复制进生成物 tests/fixtures/replay.json）；缺省取包内 fixtures/。 */
  fixturePath?: string
  /** 输出目录（新建或覆盖需 force）。 */
  outDir: string
  force?: boolean
  profileName?: string
  /** 覆盖路径解析（缺省由本模块位置推导 core/runtime，harness 为仓库同级）。 */
  coreDir?: string
  runtimeDir?: string
  harnessDir?: string
}

export interface GeneratePluginResult {
  outDir: string
  files: string[]
  warnings: string[]
  config: Record<string, unknown>
}

function listFilesRecursive(root: string, base = ''): string[] {
  const out: string[] = []
  for (const name of readdirSync(join(root, base)).sort()) {
    const rel = base === '' ? name : `${base}/${name}`
    const full = join(root, rel)
    if (statSync(full).isDirectory()) out.push(...listFilesRecursive(root, rel))
    else out.push(rel)
  }
  return out
}

function toLinkPath(fromDir: string, toDir: string): string {
  const rel = relative(fromDir, toDir)
  return (rel === '' ? '.' : rel).split(sep).join('/')
}

/** 路径 token 统一正斜杠：模板里既进 PowerShell 也进 JS 单引号串（`\1` 等会被当八进制转义）。 */
function toPosixPath(p: string): string {
  return resolve(p).split(sep).join('/')
}

function replaceTokens(text: string, tokens: Record<string, string>): string {
  let out = text
  for (const [k, v] of Object.entries(tokens)) out = out.split(k).join(v)
  return out
}

const TOKEN_RE = /__[A-Z][A-Z0-9_]*__/g

function slugOf(pkg: OntologyPackage): string {
  const raw = (pkg.meta.domain || pkg.meta.name || 'app').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return raw === '' ? 'app' : raw
}

/** 生成最小 DSH 插件（不触碰包；生成物不含真实 URL/密钥）。 */
export function generatePlugin(input: GeneratePluginInput): GeneratePluginResult {
  const versionDir = resolve(input.versionDir)
  const outDir = resolve(input.outDir)
  const pkg = loadPackage(versionDir)
  const meta = readPackageMeta(versionDir)
  const warnings: string[] = []

  // 生成 ≠ 签发：只对已签发包生成（签发是独立人工步骤）
  if (meta.status !== 'ISSUED') {
    throw new Error(`生成要求已签发包（当前 ${meta.status}）：先人工 issue，再 plugin generate`)
  }
  const scenario = pkg.scenarios.find((s) => s.id === input.scenarioId)
  if (scenario === undefined) throw new Error(`场景不存在: ${input.scenarioId}`)
  // 模式分离：--source = connector（须 API 绑定契约）；缺省 = dataset（纯内容包，内联数据通道）
  const sourceId = input.sourceId
  const datasetMode = sourceId === undefined || sourceId === ''
  let source: { shape?: ApiShape } | undefined
  let maps: O1SourceMap[] = []
  if (datasetMode) {
    if (sourceId === '') throw new Error('sourceId 不能是空串（connector 模式传 --source <SRC>；纯内容包省略 --source 走 dataset 模式）')
  } else {
    source = pkg.apiSources.find((s) => s.id === sourceId)
    if (source === undefined) throw new Error(`数据源不存在: ${sourceId}`)
    if (source.shape === undefined) throw new Error(`${sourceId} 未声明 shape`)
    maps = pkg.sourceMaps ?? []
    if (maps.length === 0) throw new Error('包内无 source-maps：先完成映射（source map init/preview）')
  }

  if (existsSync(outDir) && readdirSync(outDir).length > 0 && input.force !== true) {
    throw new Error(`输出目录非空：${outDir}（覆盖请加 force）`)
  }

  const here = dirname(fileURLToPath(import.meta.url))
  const templateDir = resolve(here, '..', 'templates', 'plugin')
  if (!existsSync(join(templateDir, 'package.json'))) {
    throw new Error(`模板树缺失: ${templateDir}`)
  }
  const coreDir = resolve(input.coreDir ?? resolve(here, '..'))
  const runtimeDir = resolve(input.runtimeDir ?? resolve(coreDir, '..', 'runtime'))
  const harnessDir = resolve(input.harnessDir ?? resolve(coreDir, '..', '..', 'deepseek-harness'))

  const slug = slugOf(pkg)
  const tag = slug.toUpperCase().replace(/[^A-Z0-9]/g, '')
  const scopeTypes = [
    ...new Set(
      maps
        .filter((m) => m.kind === undefined || m.kind === 'object')
        .map((m) => (m as { objectType: string }).objectType),
    ),
  ].sort()

  const tokens: Record<string, string> = {
    __PKG_ID__: `@dsh-${slug}/app`,
    __PKG_NAME__: meta.name,
    __PKG_VERSION__: meta.version,
    __PKG_DESC__: datasetMode
      ? `${meta.name} 业务插件：只读自助运行装配（内联 dataset 通道 + 一个场景 + 最小运行页 + Agent 同源）`
      : `${meta.name} 业务插件：只读自助运行装配（一个数据源 + 一个场景 + 最小运行页 + Agent 同源）`,
    __SOURCE_ID__: sourceId ?? '',
    __DATA_MODE__: datasetMode ? 'dataset' : 'connector',
    __SUBTITLE_ZH__: datasetMode
      ? '选场景 → 运行数据（JSON）内联运行 → 候选与证据；与 Agent run_scenario(dataset) 同源'
      : '选场景 → sourceId 取数运行 → 候选与证据；与 Agent run_scenario 同源',
    __SUBTITLE_EN__: datasetMode
      ? 'Pick scenario → run with inline dataset JSON → candidates & evidence; same path as Agent run_scenario(dataset)'
      : 'Pick scenario → sourceId fetch → candidates & evidence; same path as Agent run_scenario',
    __SCENARIO_ID__: input.scenarioId,
    __ENV_API_URL__: `DSH_${tag}_API_URL`,
    __ENV_API_KIND__: `DSH_${tag}_API_KIND`,
    __ENV_API_TOKEN__: `DSH_${tag}_API_TOKEN`,
    __ENV_PROFILE_DIR__: `DSH_${tag}_PROFILE_DIR`,
    __LOG_PREFIX__: `[dsh-${slug}]`,
    __NS__: `dsh-${slug}.run`,
    __PANEL_ID__: `dsh-${slug}-run`,
    __PLUGIN_INSERT_ID__: `dsh-${slug}-app`,
    __PROFILE_NAME__: input.profileName ?? `dsh-${slug}`,
    __PANEL_ZH__: `${meta.domain} 运行`,
    __PANEL_EN__: `${meta.domain} Run`,
    __TITLE_ZH__: `${scenario.name} 最小运行页`,
    __TITLE_EN__: `${input.scenarioId} Minimal Run Page`,
    __DOMAIN__: meta.domain,
    __DOMAIN_LOWER__: meta.domain.toLowerCase(),
    __SCOPE_TYPES__: scopeTypes.join(','),
    __LINK_CORE__: toLinkPath(outDir, coreDir),
    __LINK_RUNTIME__: toLinkPath(outDir, runtimeDir),
    __LINK_CORDIS__: toLinkPath(outDir, join(harnessDir, 'vendor', 'cordis')),
    __LINK_LLM__: toLinkPath(outDir, join(harnessDir, 'packages', 'llm', 'llm')),
    __LINK_SKILL__: toLinkPath(outDir, join(harnessDir, 'packages', 'skill', 'skill')),
    __LINK_TOOLS__: toLinkPath(outDir, join(harnessDir, 'packages', 'core', 'tools')),
    __LINK_TYPERT__: toLinkPath(outDir, join(harnessDir, 'packages', 'typert', 'protocol')),
    __CORE_DIR__: toPosixPath(coreDir),
    __RUNTIME_DIR__: toPosixPath(runtimeDir),
    __HARNESS_DIR__: toPosixPath(harnessDir),
    __SRC_PKG_DIR__: toPosixPath(versionDir),
  }

  mkdirSync(outDir, { recursive: true })
  const files: string[] = []
  for (const rel of listFilesRecursive(templateDir)) {
    const text = readFileSync(join(templateDir, rel), 'utf8')
    const replaced = replaceTokens(text, tokens)
    const leftover = replaced.match(TOKEN_RE)
    if (leftover !== null) {
      throw new Error(`模板占位未替换（${rel}）: ${[...new Set(leftover)].join(', ')}`)
    }
    const target = join(outDir, ...rel.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, replaced, 'utf8')
    files.push(rel)
  }

  // 冻结映射契约（生成物内不写转换逻辑；运行走 createMappedDataConnector + core 纯转换）
  // dataset 模式无契约可冻（纯内容包）：shape=null / maps=[]，运行走内联 dataset 通道。
  const bindingsTs = datasetMode
    ? `/** 生成物：dataset 模式（纯内容包 ${meta.name}@${meta.version}，无 API 绑定契约；api-to-plugin S2.4）。 */
import type { ApiShape, O1SourceMap } from '@dsh-onto/core'

export const BINDINGS = {
  mode: 'dataset' as 'dataset' | 'connector',
  sourceId: '',
  scenarioId: ${JSON.stringify(input.scenarioId)},
  packageName: ${JSON.stringify(meta.name)},
  packageVersion: ${JSON.stringify(meta.version)},
  shape: null as unknown as ApiShape,
  maps: [] as O1SourceMap[],
}
`
    : `/** 生成物：映射契约冻结自已签发包 ${meta.name}@${meta.version}（api-to-plugin S2.4）。 */
import type { ApiShape, O1SourceMap } from '@dsh-onto/core'

export const BINDINGS = {
  mode: 'connector' as 'dataset' | 'connector',
  sourceId: ${JSON.stringify(sourceId)},
  scenarioId: ${JSON.stringify(input.scenarioId)},
  packageName: ${JSON.stringify(meta.name)},
  packageVersion: ${JSON.stringify(meta.version)},
  shape: ${JSON.stringify(source?.shape ?? null, null, 2)} as ApiShape,
  maps: ${JSON.stringify(maps, null, 2)} as O1SourceMap[],
}
`
  writeFileSync(join(outDir, 'src', 'bindings.ts'), bindingsTs, 'utf8')
  files.push('src/bindings.ts')

  const config: Record<string, unknown> = {
    packageName: meta.name,
    packageVersion: meta.version,
    packageDir: versionDir,
    scenarioId: input.scenarioId,
    dataMode: datasetMode ? 'dataset' : 'connector',
    sourceId: sourceId ?? null,
    coreDir,
    runtimeDir,
    harnessDir,
    profileName: tokens.__PROFILE_NAME__,
    env: {
      apiUrl: tokens.__ENV_API_URL__,
      apiKind: tokens.__ENV_API_KIND__,
      apiToken: tokens.__ENV_API_TOKEN__,
      profileDir: tokens.__ENV_PROFILE_DIR__,
    },
    shape: datasetMode ? null : source?.shape ?? null,
    maps,
  }
  writeFileSync(join(outDir, 'plugin.config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  files.push('plugin.config.json')

  // 运行夹具随生成物走（e2e 对着夹具跑）：dataset 模式夹具即数据集本体，connector 模式夹具是源快照。
  // 取位顺序：--fixture 显式指定 > 包内 fixtures/dataset-<SCN>.json > fixtures/replay-<SCN>.json。
  const fixtureDst = join(outDir, 'tests', 'fixtures', 'replay.json')
  const packagedFixture = [datasetMode ? `dataset-${input.scenarioId}.json` : '', `replay-${input.scenarioId}.json`]
    .filter((n) => n !== '')
    .map((n) => join(versionDir, 'fixtures', n))
    .find((p) => existsSync(p))
  const fixtureSrc = input.fixturePath !== undefined && input.fixturePath !== ''
    ? resolve(input.fixturePath)
    : packagedFixture
  if (fixtureSrc !== undefined && existsSync(fixtureSrc)) {
    mkdirSync(join(outDir, 'tests', 'fixtures'), { recursive: true })
    cpSync(fixtureSrc, fixtureDst)
    files.push('tests/fixtures/replay.json')
  } else if (input.fixturePath !== undefined && input.fixturePath !== '') {
    throw new Error(`--fixture 文件不存在: ${input.fixturePath}`)
  } else {
    warnings.push(
      datasetMode
        ? `包内无运行夹具 fixtures/dataset-${input.scenarioId}.json（或 --fixture <file>）：生成的 e2e 需补夹具后才可跑`
        : `包内无回放夹具 fixtures/replay-${input.scenarioId}.json：生成的 e2e 需补夹具后才可跑`,
    )
  }

  return { outDir, files, warnings, config }
}

/** 删除生成物（仅限 scaffold 输出目录标识存在 plugin.config.json；防误删）。 */
export function removeGeneratedPlugin(outDir: string): void {
  const dir = resolve(outDir)
  if (!existsSync(join(dir, 'plugin.config.json'))) {
    throw new Error(`不是脚手架生成目录（缺 plugin.config.json）: ${dir}`)
  }
  rmSync(dir, { recursive: true, force: true })
}
