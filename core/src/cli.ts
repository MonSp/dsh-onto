#!/usr/bin/env node
/**
 * dsh-onto CLI —— 业务本体建模平台命令行入口（规范 §11.1.8）。
 *
 *   dsh-onto package create --name aml-analysis --version 1.0.0 --domain AML [--root <ws>]
 *   dsh-onto package list [--root <ws>]
 *   dsh-onto package fork --name N --from V --to V2 [--root <ws>]
 *   dsh-onto package review --name N --version V          # DRAFT → IN_REVIEW
 *   dsh-onto package issue --name N --version V --by <human> [--note ...]   仅人工
 *   dsh-onto package export --name N --version V --out F.json
 *   dsh-onto package import --in F.json
 *   dsh-onto validate <versionDir>                        # quality-report.json
 *   dsh-onto derive <versionDir>                          # derived/** + manifest
 *   dsh-onto gate <versionDir>                            # 加载门禁（DERIVED_DRIFT）
 *   dsh-onto run <versionDir> <scenarioId> --data run.json [--out result.json]
 *   dsh-onto runs list|show <runId>|compare <a> <b>|export <runId> [--root <ws>]
 *   dsh-onto knowledge upload --package P --type T --name N --file F [--root <ws>]
 *   dsh-onto knowledge parse --source <id> [--llm heuristic|deepseek] [--root <ws>]
 *   dsh-onto knowledge queue [--package P] [--root <ws>]
 *   dsh-onto knowledge review --id <cid> --action approve|reject|merge [--merge-into NAME]
 *   dsh-onto knowledge materialize --dir <versionDir> --ids a,b,c [--root <ws>]
 *   dsh-onto exp recall --dir <versionDir> --scenario <SCN> --data run.json [--top-k N] [--threshold T]
 *   dsh-onto exp annotate --dir <versionDir> --run <runId> --outcome success|partial|failure|pending-human
 *                         [--reason R] [--counterexample [true|false]] [--reused-from <runId>] [--review-focus a,b]
 *   dsh-onto exp diff --dir <versionDir> --scenario <SCN> --data run.json --source <runId>
 *   dsh-onto exp list
 *   dsh-onto exp abstract --dir <versionDir> [--min-cluster N] [--include-prior-versions] [--data-dir <knowledgeRoot>]
 *   dsh-onto exp compress [--retain-days N] [--apply]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { derivePackage } from './derive.js'
import {
  abstractCounterexampleDrafts,
  abstractSkillDrafts,
  buildDiffTable,
  buildTaskSignature,
  compressExperiences,
  experienceFromRun,
  isLegacySignature,
  listExperienceNotes,
  loadExperienceNote,
  retrieveSimilar,
  saveExperienceNote,
  upgradeLegacySignature,
} from './experience.js'
import { KnowledgeStore } from './knowledge.js'
import { DeepSeekLlm, HeuristicLlm } from './llm.js'
import { verifyDerived } from './loadgate.js'
import {
  buildRunRecord,
  compareRunRecords,
  exportRunArchive,
  listRunRecords,
  loadRunRecord,
  saveRunRecord,
} from './runstore.js'
import { runScenario } from './scenario.js'
import {
  extractPageItems,
  extractSnapshotRows,
  fetchShapeRows,
  previewSourceMaps,
  readPath,
  shapeCollectionKeys,
} from './sourcemap.js'
import { runReplay } from './replay.js'
import { generatePlugin } from './scaffold.js'
import { loadPackage, PackageWorkspace, readPackageMeta } from './store.js'
import type { ApiShape, RuntimeDataset, SourceType } from './types.js'
import { SOURCE_TYPES } from './types.js'
import { buildQualityReport, writeQualityReport, assertIssueReady } from './validate.js'

interface Args {
  _: string[]
  flags: Record<string, string | boolean>
}

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        out.flags[key] = next
        i++
      } else {
        out.flags[key] = true
      }
    } else {
      out._.push(a)
    }
  }
  return out
}

function flagStr(args: Args, name: string, fallback?: string): string {
  const v = args.flags[name]
  if (typeof v === 'string') return v
  if (fallback !== undefined) return fallback
  fail(`missing required --${name}`)
  return ''
}

/** 需要路径值的 flag：给了 flag 却没给值（解析成布尔）→ 显式报错，不静默忽略。 */
function flagFileArg(args: Args, name: string): string | undefined {
  const v = args.flags[name]
  if (v === undefined) return undefined
  if (typeof v !== 'string' || v === '') fail(`--${name} 需要路径值（如 --${name} <file>）`)
  return v
}

function fail(message: string, code = 1): never {
  console.error(`dsh-onto: ${message}`)
  process.exit(code)
}

function workspaceOf(args: Args): PackageWorkspace {
  const root = typeof args.flags['root'] === 'string' ? args.flags['root'] : resolve(process.cwd(), 'workspace')
  return new PackageWorkspace(root)
}

function knowledgeOf(args: Args): KnowledgeStore {
  const root = typeof args.flags['root'] === 'string' ? args.flags['root'] : resolve(process.cwd(), 'workspace')
  return new KnowledgeStore(root)
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2))
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 命令分发
 * ═══════════════════════════════════════════════════════════════════════════ */

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const [group, sub] = args._

  switch (group) {
    case 'package':
      return cmdPackage(sub, args)
    case 'validate':
      return cmdValidate(args)
    case 'derive':
      return cmdDerive(args)
    case 'gate':
      return cmdGate(args)
    case 'run':
      return cmdRun(args)
    case 'runs':
      return cmdRuns(sub, args)
    case 'source':
      return cmdSource(sub, args)
    case 'replay':
      return cmdReplay(args)
    case 'plugin':
      return cmdPlugin(sub, args)
    case 'knowledge':
      return cmdKnowledge(sub, args)
    case 'exp':
      return cmdExp(sub, args)
    case 'help':
    case undefined:
      return help()
    default:
      fail(`unknown command ${group}`)
  }
}

function help(): void {
  console.log(USAGE)
}

const USAGE = `dsh-onto — 业务本体建模平台 CLI
  package create|list|fork|review|issue|export|import
  validate <versionDir>
  derive <versionDir>
  gate <versionDir>
  run <versionDir> <scenarioId> --data run.json [--out result.json]
  runs list|show <runId>|compare <runIdA> <runIdB>|export <runId>
  source probe --dir <versionDir> [--url U | --data F] [--collections a,b] [--samples N]
  source map init|preview --dir <versionDir> [--url U | --data F] [--json] [--strict] [--force]
  replay --dir <versionDir> --scenario <SCN> [--fixture F] [--expected F] [--check]
         [--scope-types A,B] [--against <versionDir>] [--write-expected]
  plugin generate --dir <versionDir> --scenario <SCN> [--source <SRC>] [--fixture <file>] --out <dir> [--force] [--profile P]
    （省略 --source = dataset 模式：纯内容包走内联 dataset 通道；--fixture 显式指定运行夹具）
  knowledge upload|parse|queue|review|materialize
  exp recall|annotate|diff|list|abstract|compress
通用: --root <workspaceDir>（默认 ./workspace）
`

function cmdPackage(sub: string | undefined, args: Args): void {
  const ws = workspaceOf(args)
  switch (sub) {
    case 'create': {
      const dir = ws.createPackage({
        name: flagStr(args, 'name'),
        version: flagStr(args, 'version', '1.0.0'),
        domain: flagStr(args, 'domain'),
      })
      print({ ok: true, dir })
      return
    }
    case 'list': {
      print(ws.listVersions())
      return
    }
    case 'fork': {
      const dir = ws.forkVersion(flagStr(args, 'name'), flagStr(args, 'from'), flagStr(args, 'to'))
      print({ ok: true, dir })
      return
    }
    case 'review': {
      const dir = ws.versionDir(flagStr(args, 'name'), flagStr(args, 'version'))
      ws.transition(flagStr(args, 'name'), flagStr(args, 'version'), 'IN_REVIEW')
      // 状态写盘改 package.yaml → 重派生，防送审即 DERIVED_DRIFT。
      // 与 backend 同口径：半成功态（已送审、派生失败）须受控上墙，不裸抛栈。
      try {
        derivePackage(dir)
      } catch (e) {
        fail(
          `状态已迁移到 IN_REVIEW，但重派生失败（可手动 dsh-onto derive）：${e instanceof Error ? e.message : String(e)}`,
        )
      }
      print({ ok: true, status: 'IN_REVIEW' })
      return
    }
    case 'issue': {
      // 签发 = 人审通过；issuedBy 必须是人工身份（§3.4）
      const dir = ws.versionDir(flagStr(args, 'name'), flagStr(args, 'version'))
      // 签发门禁：0 错 + 场景/规则非空 + 派生 + 加载门禁（空壳/坏包不得签发）。
      const gate = assertIssueReady(dir)
      ws.transition(
        flagStr(args, 'name'),
        flagStr(args, 'version'),
        'ISSUED',
        flagStr(args, 'by'),
        typeof args.flags['note'] === 'string' ? args.flags['note'] : undefined,
      )
      // issueRecord/状态位改写 package.yaml → 再派生，签完即可加载。
      // 门禁内已 derive 过一次；此处必须再 derive（状态位变了），失败同样受控上墙。
      try {
        derivePackage(dir)
      } catch (e) {
        fail(
          `状态已迁移到 ISSUED，但重派生失败（可手动 dsh-onto derive）：${e instanceof Error ? e.message : String(e)}`,
        )
      }
      print({ ok: true, status: 'ISSUED', gate })
      return
    }
    case 'export': {
      const archive = ws.exportVersion(flagStr(args, 'name'), flagStr(args, 'version'))
      const out = flagStr(args, 'out')
      writeFileSync(out, `${JSON.stringify(archive, null, 2)}\n`, 'utf8')
      print({ ok: true, out, files: Object.keys(archive.files).length })
      return
    }
    case 'import': {
      const archive = JSON.parse(readFileSync(flagStr(args, 'in'), 'utf8')) as {
        meta: Parameters<PackageWorkspace['importVersion']>[0]['meta']
        files: Record<string, string>
      }
      const dir = ws.importVersion(archive)
      print({ ok: true, dir })
      return
    }
    default:
      fail(`unknown package subcommand ${String(sub)}`)
  }
}

function cmdValidate(args: Args): void {
  const dir = args._[1]
  if (!dir) fail('validate requires <versionDir>')
  const report = writeQualityReport(resolve(dir))
  print(report)
  if (report.errors.length > 0) process.exit(2)
}

function cmdDerive(args: Args): void {
  const dir = args._[1]
  if (!dir) fail('derive requires <versionDir>')
  const manifest = derivePackage(resolve(dir))
  print({ ok: true, sources: manifest.sources.length, derived: manifest.derived.length, sourceDigest: manifest.sourceDigest })
}

function cmdGate(args: Args): void {
  const dir = args._[1]
  if (!dir) fail('gate requires <versionDir>')
  const result = verifyDerived(resolve(dir))
  print(result)
  if (!result.ok) process.exit(2)
}

/** versionDir（<ws>/packages/<name>/<version>）上溯 workspace root；结构不符返回 null。 */
function workspaceRootOfVersionDir(versionDir: string): string | null {
  const packagesDir = dirname(dirname(versionDir))
  if (basename(packagesDir) !== 'packages') return null
  return dirname(packagesDir)
}

/* ═══════════════════════════════════════════════════════════════════════════
 * source（api-to-plugin S2.2）：probe / map init / map preview
 * ═══════════════════════════════════════════════════════════════════════════ */

interface SampleRows {
  rows: Record<string, Array<Record<string, unknown>>>
  origin: string
}

const TIME_FIELD_RE = /(?:At|Time|Date|Ts|Timestamp|On|Updated)$/i

function normKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function singular(s: string): string {
  return normKey(s).replace(/s$/, '')
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) {
    fail(`采样请求失败 ${url}：${e instanceof Error ? e.message : String(e)}`)
  }
  if (res.status !== 200) fail(`采样请求拒绝 ${url}（${res.status}）`)
  return res.json().catch(() => ({}))
}

/** 采样取行：--data 离线快照 或 --url 在线 GET（collections 只取首页直到 --samples 上限）。 */
async function sampleRows(args: Args, shape: ApiShape, collections: string[], samples: number): Promise<SampleRows> {
  const dataPath = args.flags['data']
  if (typeof dataPath === 'string') {
    const body = JSON.parse(readFileSync(resolve(dataPath), 'utf8')) as unknown
    if (shape.mode === 'snapshot') {
      return { rows: extractSnapshotRows(body, shape), origin: `file:${dataPath}` }
    }
    const rows: SampleRows['rows'] = {}
    const src = body as Record<string, unknown>
    for (const c of collections) {
      const v = src[c]
      rows[c] = Array.isArray(v)
        ? (v.filter((x) => x !== null && typeof x === 'object') as Array<Record<string, unknown>>)
        : extractPageItems(v, shape.itemsPath)
    }
    return { rows, origin: `file:${dataPath}` }
  }
  const baseUrl = flagStr(args, 'url').replace(/\/$/, '')
  const timeoutMs = Number(args.flags['timeout'] ?? 8000)
  const rows = await fetchShapeRows({
    shape,
    collections,
    samples,
    request: (pathWithQuery) => fetchJson(`${baseUrl}${pathWithQuery}`, timeoutMs),
  })
  return { rows, origin: `url:${baseUrl}` }
}

function collectionsFor(pkg: ReturnType<typeof loadPackage>, shape: ApiShape, args: Args): string[] {
  const flag = args.flags['collections']
  if (typeof flag === 'string' && flag !== '') {
    return flag.split(',').map((s) => s.trim()).filter((s) => s !== '')
  }
  const fromMaps = [...new Set((pkg.sourceMaps ?? []).map((m) => m.collection))]
  if (fromMaps.length > 0) return fromMaps
  const fromShape = [...shapeCollectionKeys(shape)]
  if (fromShape.length > 0) return fromShape
  fail('无法确定集合：请给 --collections a,b（或先写 source-maps / shape.collectionPaths）')
  return []
}

function shapeOf(pkg: ReturnType<typeof loadPackage>, args: Args): ApiShape {
  const sourceId = args.flags['source']
  const src =
    typeof sourceId === 'string' && sourceId !== ''
      ? pkg.apiSources.find((s) => s.id === sourceId)
      : pkg.apiSources.find((s) => s.shape !== undefined) ?? pkg.apiSources[0]
  if (src === undefined) fail('包内没有 apiSources')
  if (src.shape === undefined) fail(`${src.id} 未声明 shape（api-sources.yaml 形态块）`)
  return src.shape
}

function probeReport(rows: SampleRows['rows']): unknown {
  const out: Record<string, unknown> = {}
  for (const [c, rs] of Object.entries(rows)) {
    const fields: Record<string, { types: string[]; nonNull: number; samples: unknown[] }> = {}
    for (const r of rs) {
      for (const [k, v] of Object.entries(r)) {
        const f = (fields[k] ??= { types: [], nonNull: 0, samples: [] })
        if (v !== null && v !== undefined) {
          f.nonNull += 1
          const t = Array.isArray(v) ? 'array' : typeof v
          if (!f.types.includes(t)) f.types.push(t)
          if (f.samples.length < 3 && !f.samples.includes(v)) f.samples.push(v)
        }
      }
    }
    out[c] = { rows: rs.length, fields }
  }
  return out
}

function pickIdField(collection: string, fields: string[]): string {
  const want = `${singular(collection)}id`
  const hit = fields.find((f) => normKey(f) === want)
  if (hit !== undefined) return hit
  // 强候选：camel `*Id` / 分隔 `*_id` `*-id` / 裸 `id`；弱候选：`^[a-z]+id$`（cardid 等，排后防 'valid' 抢位）
  const strong = fields.filter((f) => /(_id|-id|Id)$/.test(f) || f === 'id')
  const weak = fields.filter((f) => /^[a-z]+id$/.test(f))
  return (strong[0] ?? weak[0] ?? fields[0]) ?? ''
}

function cmdSource(sub: string | undefined, args: Args): void {
  void (async () => {
    const dir = flagStr(args, 'dir')
    const versionDir = resolve(dir)
    const pkg = loadPackage(versionDir)
    const shape = shapeOf(pkg, args)
    const samples = Number(args.flags['samples'] ?? 50)

    if (sub === 'probe') {
      const collections = collectionsFor(pkg, shape, args)
      const { rows, origin } = await sampleRows(args, shape, collections, samples)
      print({ origin, shape: shape.mode, collections, probe: probeReport(rows) })
      return
    }

    if (sub === 'map') {
      const mode = args._[2]
      if (mode === 'init') {
        const collections = collectionsFor(pkg, shape, args)
        const { rows } = await sampleRows(args, shape, collections, samples)
        const maps: Array<Record<string, unknown>> = []
        const unmatchedCollections: string[] = []
        const usedTypes = new Set<string>()
        for (const [c, rs] of Object.entries(rows)) {
          const objectType = pkg.objects.find(
            (o) => singular(o.id.split('-').pop() ?? o.id) === singular(c) || normKey(o.id) === normKey(c),
          )
          if (objectType === undefined) {
            unmatchedCollections.push(c)
            continue
          }
          usedTypes.add(objectType.id)
          const fields = Object.keys(rs[0] ?? {})
          const timeField = fields.find((f) => TIME_FIELD_RE.test(f))
          maps.push({
            id: `SM-${pkg.meta.domain.toUpperCase().slice(0, 12)}-${c.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 16)}`,
            collection: c,
            objectType: objectType.id,
            idTemplate: `<${pickIdField(c, fields)}>`,
            ...(timeField !== undefined ? { timeField } : {}),
          })
        }
        const outRel = 'bindings/source-maps.yaml'
        const outFile = resolve(versionDir, outRel)
        if (existsSync(outFile) && args.flags['force'] !== true) {
          fail(`${outRel} 已存在；覆盖请加 --force`)
        }
        writeFileSync(
          outFile,
          `kind: O1SourceMaps\nmaps:\n${maps.map((m) => yamlMapEntry(m)).join('')}`,
          'utf8',
        )
        print({
          wrote: outRel,
          maps: maps.map((m) => ({ id: m['id'], collection: m['collection'], objectType: m['objectType'] })),
          unmatchedCollections,
          unmatchedObjectTypes: pkg.objects.filter((o) => !usedTypes.has(o.id)).map((o) => o.id),
          next: '编辑 bindings/source-maps.yaml 后跑 source map preview',
        })
        return
      }
      if (mode === 'preview') {
        const collections = collectionsFor(pkg, shape, args)
        const { rows, origin } = await sampleRows(args, shape, collections, samples)
        const result = previewSourceMaps(pkg, rows)
        if (args.flags['json'] === true) {
          print({ origin, ...result })
        } else {
          print({
            origin,
            counts: result.counts,
            businessWindow: result.businessWindow,
            diagnostics: result.diagnostics,
            evidence: result.evidence,
          })
        }
        const hasError = result.diagnostics.some((d) => d.level === 'error')
        if (hasError && args.flags['strict'] === true) process.exit(2)
        return
      }
      fail('source map 需要子命令 init|preview')
      return
    }

    fail('source 需要子命令 probe|map（map init|map preview）')
  })().catch((e) => {
    fail(e instanceof Error ? e.message : String(e))
  })
}

/** 单条 source-map 的最小 YAML（手写以保注释友好；条目少且结构稳定）。 */
function yamlMapEntry(m: Record<string, unknown>): string {
  const lines = [`  - id: ${m['id']}`]
  for (const [k, v] of Object.entries(m)) {
    if (k === 'id') continue
    if (typeof v === 'string') lines.push(`    ${k}: ${v}`)
    else lines.push(`    ${k}: ${JSON.stringify(v)}`)
  }
  return `${lines.join('\n')}\n`
}

/* ═══════════════════════════════════════════════════════════════════════════
 * replay（api-to-plugin S2.5）：随包快照回放 / 基线对照 / 版本切换 diff
 * ═══════════════════════════════════════════════════════════════════════════ */

function cmdReplay(args: Args): void {
  const dir = flagStr(args, 'dir')
  const scenarioId = flagStr(args, 'scenario')
  const scopeFlag = args.flags['scope-types']
  const againstFlag = args.flags['against']
  const fixtureArg = flagFileArg(args, 'fixture')
  const expectedArg = flagFileArg(args, 'expected')
  try {
    const report = runReplay({
      versionDir: resolve(dir),
      scenarioId,
      ...(fixtureArg !== undefined ? { fixturePath: resolve(fixtureArg) } : {}),
      ...(expectedArg !== undefined ? { expectedPath: resolve(expectedArg) } : {}),
      ...(typeof scopeFlag === 'string' && scopeFlag !== ''
        ? { scopeTypes: scopeFlag.split(',').map((s) => s.trim()).filter((s) => s !== '') }
        : {}),
      ...(typeof args.flags['source'] === 'string' ? { sourceId: args.flags['source'] } : {}),
      ...(typeof againstFlag === 'string' ? { againstDir: resolve(againstFlag) } : {}),
      check: args.flags['check'] === true,
      writeExpected: args.flags['write-expected'] === true,
    })
    print(report)
    if (report.comparison !== undefined && !report.comparison.ok) process.exit(2)
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e))
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * plugin（api-to-plugin S2.4）：脚手架生成最小 DSH 插件（生成 ≠ 签发）
 * ═══════════════════════════════════════════════════════════════════════════ */

function cmdPlugin(sub: string | undefined, args: Args): void {
  if (sub !== 'generate') fail('plugin 需要子命令 generate')
  try {
    const fixtureArg = flagFileArg(args, 'fixture')
    const result = generatePlugin({
      versionDir: resolve(flagStr(args, 'dir')),
      scenarioId: flagStr(args, 'scenario'),
      ...(typeof args.flags['source'] === 'string' ? { sourceId: args.flags['source'] } : {}),
      ...(fixtureArg !== undefined ? { fixturePath: resolve(fixtureArg) } : {}),
      outDir: resolve(flagStr(args, 'out')),
      force: args.flags['force'] === true,
      ...(typeof args.flags['profile'] === 'string' ? { profileName: args.flags['profile'] } : {}),
      ...(typeof args.flags['core-dir'] === 'string' ? { coreDir: resolve(args.flags['core-dir']) } : {}),
      ...(typeof args.flags['runtime-dir'] === 'string' ? { runtimeDir: resolve(args.flags['runtime-dir']) } : {}),
      ...(typeof args.flags['harness-dir'] === 'string' ? { harnessDir: resolve(args.flags['harness-dir']) } : {}),
    })
    print({
      ok: true,
      outDir: result.outDir,
      files: result.files,
      warnings: result.warnings,
      next: 'cd <out> && pnpm install && pnpm run build && node --test tests/*.test.mjs；部署模板见 scripts/ 与 .env.example',
    })
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e))
  }
}


function cmdRun(args: Args): void {
  const dir = args._[1]
  const scenarioId = args._[2]
  if (!dir || !scenarioId) fail('run requires <versionDir> <scenarioId>')
  const dataPath = flagStr(args, 'data')
  // 入口策略（M1-B，Agent/wire/CLI 同一口径）：文件供数打 provenance=file（不得自称 connector）
  const dataset: RuntimeDataset = {
    ...(JSON.parse(readFileSync(dataPath, 'utf8')) as RuntimeDataset),
    provenance: 'file',
  }
  const versionDir = resolve(dir)
  const analysisMode = flagStr(args, 'mode', 'explore') === 'formal' ? 'formal' : 'explore'
  const result = runScenario(versionDir, scenarioId, dataset, { analysisMode })
  // 运行留痕（run-insight S2.1）：root 由 versionDir 上溯、--root 显式覆盖；不可达跳过不破坏既有契约。
  let runRecord: string | null = null
  try {
    const root =
      typeof args.flags['root'] === 'string' ? resolve(args.flags['root']) : workspaceRootOfVersionDir(versionDir)
    if (root !== null) {
      const meta = readPackageMeta(versionDir)
      const pkg = loadPackage(versionDir)
      const scenario = pkg.scenarios.find((s) => s.id === scenarioId)
      const redlines = [
        ...new Set(
          [
            ...result.audit.forbiddenPhraseHits.map((h) => h.phrase),
            ...(scenario?.outputContract.forbiddenPhrases ?? []),
          ].filter((p) => typeof p === 'string' && p !== ''),
        ),
      ]
      const rec = buildRunRecord({
        package: { name: meta.name, version: meta.version },
        dataset: result.effectiveDataset ?? dataset,
        inputDataset: dataset,
        result,
        redlines,
      })
      saveRunRecord(root, rec)
      // S5.4.2 运行回写：经验初稿随 RunRecord 落盘（与 wire/Agent 同口径）
      saveExperienceNote(root, experienceFromRun(rec, pkg))
      runRecord = result.runId
    }
  } catch (e) {
    runRecord = null
    // 落盘失败（磁盘满/权限/结构异常）显式告警，不与「结构不可达跳过」混为一谈。
    console.error(`warn: run record not saved (${e instanceof Error ? e.message : String(e)})`)
  }
  const out = typeof args.flags['out'] === 'string' ? args.flags['out'] : null
  if (out) {
    writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
    print({
      ok: result.audit.passed,
      runId: result.runId,
      candidates: result.candidates.length,
      excluded: result.excluded.length,
      humanReviewRequired: result.humanReviewRequired,
      forbiddenPhraseHits: result.audit.forbiddenPhraseHits.length,
      runRecord: runRecord ?? 'skipped',
      out,
    })
  } else {
    print(result)
  }
  if (!result.audit.passed) process.exit(3)
}

/** 运行记录组（run-insight S2.6）：list / show / compare / export —— CLI 人审面（完整短语）。 */
function cmdRuns(sub: string | undefined, args: Args): void {
  const root = workspaceOf(args).root
  switch (sub) {
    case 'list': {
      print({
        runs: listRunRecords(root).map((r) => ({
          runId: r.runId,
          scenarioId: r.scenarioId,
          package: r.package,
          datasetDigest: r.datasetDigest.slice(0, 12),
          auditPassed: r.result.audit.passed === true,
          startedAt: r.startedAt,
          savedAt: r.savedAt,
        })),
      })
      return
    }
    case 'show': {
      const runId = args._[2]
      if (!runId) fail('runs show requires <runId>')
      print(loadRunRecord(root, runId))
      return
    }
    case 'compare': {
      const a = args._[2]
      const b = args._[3]
      if (!a || !b) fail('runs compare requires <runIdA> <runIdB>')
      print(compareRunRecords(loadRunRecord(root, a), loadRunRecord(root, b)))
      return
    }
    case 'export': {
      const runId = args._[2]
      if (!runId) fail('runs export requires <runId>')
      const { locator, archive } = exportRunArchive(root, runId)
      print({ ok: true, locator, archivedAt: archive.archivedAt, humanReviewRequired: true })
      return
    }
    default:
      fail(`unknown runs subcommand ${String(sub)}`)
  }
}

function summaryOf(dataset: RuntimeDataset): {
  objects: number
  relations: number
  behaviors: number
  candidates: number
} {
  return {
    objects: dataset.objects.length,
    relations: dataset.relations.length,
    behaviors: dataset.behaviors?.length ?? 0,
    candidates: dataset.candidates.length,
  }
}

function loadDatasetFile(path: string): RuntimeDataset {
  const file = resolve(path)
  if (!existsSync(file)) fail(`dataset file not found: ${path}`)
  try {
    // 信任面（可信取数 T1.2）：CLI 载入即标记文件来源。
    return { ...(JSON.parse(readFileSync(file, 'utf8')) as RuntimeDataset), provenance: 'file' }
  } catch {
    fail(`dataset file is not valid JSON: ${path}`)
  }
}

/** 经验闭环组（experience-loop S5）：recall / annotate / diff / list —— CLI 验收面。 */
function cmdExp(sub: string | undefined, args: Args): void {
  const root = workspaceOf(args).root
  switch (sub) {
    case 'recall': {
      const dir = flagStr(args, 'dir')
      const scenarioId = flagStr(args, 'scenario')
      const dataset = loadDatasetFile(flagStr(args, 'data'))
      const pkg = loadPackage(dir)
      const signature = buildTaskSignature({ pkg, scenarioId, datasetSummary: summaryOf(dataset) })
      const topK = typeof args.flags['top-k'] === 'string' ? Number(args.flags['top-k']) : undefined
      const threshold = typeof args.flags['threshold'] === 'string' ? Number(args.flags['threshold']) : undefined
      const result = retrieveSimilar(
        root,
        { signature, externalRefs: pkg.meta.externalRefs },
        { topK, threshold },
      )
      print({
        signature: {
          scenarioId: signature.scenarioId,
          packageScope: signature.packageScope,
          stepShape: signature.stepShape,
          dataBand: signature.dataBand,
          digest: signature.digest.slice(0, 12),
        },
        coldStart: result.coldStart,
        digestMatch: result.digestMatch?.runId ?? null,
        hits: result.hits.map((h) => ({
          runId: h.note.runId,
          score: Number(h.score.toFixed(3)),
          outcome: h.note.outcome,
          counterexample: h.note.counterexample,
          reasons: h.reasons,
        })),
      })
      return
    }
    case 'annotate': {
      const dir = flagStr(args, 'dir')
      const runId = flagStr(args, 'run')
      const outcome = flagStr(args, 'outcome')
      if (!['success', 'partial', 'failure', 'pending-human'].includes(outcome)) {
        fail('--outcome must be success|partial|failure|pending-human')
      }
      const rec = loadRunRecord(root, runId)
      // 闸门复用：审计结果约束 outcome——审计未过不得标 success（除非 counterexample）
      let existing: import('./experience.js').ExperienceNote | null = null
      try {
        existing = loadExperienceNote(root, runId)
      } catch {
        existing = null
      }
      const counterexample = args.flags['counterexample'] === true || args.flags['counterexample'] === 'true'
        ? true
        : args.flags['counterexample'] === 'false'
          ? false
          : existing?.counterexample === true
      if (outcome === 'success' && rec.result.audit.passed !== true && !counterexample) {
        fail('audit not passed — cannot annotate success (use failure/partial or --counterexample)')
      }
      // patch 语义（M2）：已有 note 保留人审字段（misTransfer/reusedFrom/reviewFocus），
      // 只覆写本次显式传入的旗标——CLI 二次标注不得静默抹掉人工判定。
      // 旧版签名（无 ruleShape）：人审触碰即按当前包升版（annotate = 确认仍对当前语义负责）。
      let signature = existing?.signature ?? buildTaskSignature({
        pkg: loadPackage(dir),
        scenarioId: rec.scenarioId,
        datasetSummary: rec.datasetSummary,
      })
      if (existing && isLegacySignature(existing.signature)) {
        const upgraded = upgradeLegacySignature(existing.signature, loadPackage(dir))
        if (upgraded) signature = upgraded
      }
      let reusedFrom: { runId: string; diff: ReturnType<typeof buildDiffTable> } | undefined
      if (typeof args.flags['reused-from'] === 'string') {
        const srcId = args.flags['reused-from']
        const src = loadExperienceNote(root, srcId)
        reusedFrom = { runId: srcId, diff: buildDiffTable(signature, src.signature) }
      } else {
        reusedFrom = existing?.reusedFrom
      }
      const note: import('./experience.js').ExperienceNote = {
        runId,
        signature,
        outcome: outcome as import('./experience.js').ExperienceOutcome,
        outcomeReason:
          typeof args.flags['reason'] === 'string' ? args.flags['reason'] : existing?.outcomeReason,
        skillRefsUsed: existing?.skillRefsUsed ?? signature.skillRefs,
        reusedFrom,
        counterexample,
        misTransfer: existing?.misTransfer,
        reviewFocus:
          typeof args.flags['review-focus'] === 'string'
            ? args.flags['review-focus'].split(',').map((s) => s.trim()).filter(Boolean)
            : existing?.reviewFocus,
        savedAt: new Date().toISOString(),
      }
      const file = saveExperienceNote(root, note)
      print({ ok: true, runId, outcome, counterexample, patched: existing !== null, file: basename(file) })
      return
    }
    case 'diff': {
      const dir = flagStr(args, 'dir')
      const scenarioId = flagStr(args, 'scenario')
      const sourceId = flagStr(args, 'source')
      const dataset = loadDatasetFile(flagStr(args, 'data'))
      const pkg = loadPackage(dir)
      const query = buildTaskSignature({ pkg, scenarioId, datasetSummary: summaryOf(dataset) })
      const source = loadExperienceNote(root, sourceId)
      const draft = buildDiffTable(query, source.signature)
      print({
        query: { scenarioId: query.scenarioId, digest: query.digest.slice(0, 12) },
        source: { runId: source.runId, digest: source.signature.digest.slice(0, 12) },
        draft,
      })
      return
    }
    case 'list': {
      print({
        experiences: listExperienceNotes(root).map((n) => ({
          runId: n.runId,
          scenarioId: n.signature.scenarioId,
          outcome: n.outcome,
          counterexample: n.counterexample,
          legacySignature: isLegacySignature(n.signature),
          reusedFrom: n.reusedFrom?.runId ?? null,
          misTransfer: n.misTransfer?.judged ?? false,
          savedAt: n.savedAt,
        })),
        legacyNote: 'legacySignature=true 表示 0.2.0 前旧签名（无 ruleShape）；annotate 该条时按当前包升版',
      })
      return
    }
    case 'abstract': {
      const dir = flagStr(args, 'dir')
      const pkg = loadPackage(dir)
      const minCluster = typeof args.flags['min-cluster'] === 'string' ? Number(args.flags['min-cluster']) : undefined
      // 断链 B：--include-prior-versions 放行同 meta.name 历史版本经验（含 ISSUED 生产版）参赛，
      // 草案落当前 --dir 指向的 DRAFT 版本。
      const includePriorVersions = args.flags['include-prior-versions'] === true
      const abs = abstractSkillDrafts(root, { pkg, minCluster, includePriorVersions })
      const counters = abstractCounterexampleDrafts(root, { pkg, minCluster, includePriorVersions })
      // knowledge 队列根：优先 --data-dir（L3）；否则按默认布局推断（workspace 目录名约定）。
      // workspace 布局下 dataDir = dirname(workspace)；否则同根。目录改名时请显式传 --data-dir。
      const dataDirFlag = typeof args.flags['data-dir'] === 'string' ? resolve(args.flags['data-dir']) : undefined
      const base = basename(root)
      const dataDir = dataDirFlag ?? (base === 'workspace' ? dirname(root) : root)
      const knowledge = new KnowledgeStore(dataDir)
      const queued: Array<{ id: string; name: string; kind: string; runId: string; members: number }> = []
      for (const a of [...abs, ...counters]) {
        const c = knowledge.addDraft({
          packageId: `${pkg.meta.name}@${pkg.meta.version}`,
          item: a.draft,
          provenance: { runId: a.memberRunIds[0] },
        })
        queued.push({ id: c.id, name: c.name, kind: a.draft.targetKind, runId: a.memberRunIds[0], members: a.memberRunIds.length })
      }
      print({
        queued,
        skills: abs.length,
        counters: counters.length,
        knowledgeRoot: dataDir,
        note: '草案已入队（pending），物化必经人审',
      })
      return
    }
    case 'compress': {
      const retainDays = typeof args.flags['retain-days'] === 'string' ? Number(args.flags['retain-days']) : undefined
      const apply = args.flags['apply'] === true
      const report = compressExperiences(root, { retainDays, apply })
      print({ ...report, applied: apply })
      return
    }
    default:
      fail(`unknown exp subcommand ${String(sub)}`)
  }
}

function cmdKnowledge(sub: string | undefined, args: Args): void {
  const store = knowledgeOf(args)
  switch (sub) {
    case 'upload': {
      const sourceType = flagStr(args, 'type') as SourceType
      if (!SOURCE_TYPES.includes(sourceType)) fail(`--type must be one of ${SOURCE_TYPES.join('|')}`)
      const content = readFileSync(flagStr(args, 'file'), 'utf8')
      const rec = store.uploadSource({
        packageId: flagStr(args, 'package'),
        sourceType,
        name: flagStr(args, 'name'),
        content,
      })
      print(rec)
      return
    }
    case 'parse': {
      const llmName = typeof args.flags['llm'] === 'string' ? args.flags['llm'] : 'heuristic'
      const llm = llmName === 'deepseek' ? new DeepSeekLlm() : new HeuristicLlm()
      void store.parseSource(flagStr(args, 'source'), llm).then(({ added, engine }) => {
        print({
          ok: true,
          engine,
          added: added.map((c) => ({
            id: c.id,
            layer: c.layer,
            kind: c.targetKind,
            name: c.name,
            confidence: c.confidence,
            forcedReview: c.forcedReview,
          })),
        })
      }).catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)))
      return
    }
    case 'queue': {
      const packageId = typeof args.flags['package'] === 'string' ? args.flags['package'] : undefined
      print(store.listCandidates({ packageId }))
      return
    }
    case 'review': {
      const action = flagStr(args, 'action') as 'approve' | 'reject' | 'merge'
      const c = store.reviewCandidate(flagStr(args, 'id'), action, {
        mergeIntoName: typeof args.flags['merge-into'] === 'string' ? args.flags['merge-into'] : undefined,
      })
      print(c)
      return
    }
    case 'materialize': {
      const ids = flagStr(args, 'ids').split(',').map((s) => s.trim()).filter(Boolean)
      const result = store.materialize(resolve(flagStr(args, 'dir')), ids)
      print(result)
      return
    }
    default:
      fail(`unknown knowledge subcommand ${String(sub)}`)
  }
}

/** 审计/测试辅助：仅打印校验摘要（不写 quality-report）。 */
export function validateSummary(dir: string): ReturnType<typeof buildQualityReport> {
  return buildQualityReport(dir)
}

main()
