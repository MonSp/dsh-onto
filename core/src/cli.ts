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
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { derivePackage } from './derive.js'
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
import { loadPackage, PackageWorkspace, readPackageMeta } from './store.js'
import type { RuntimeDataset, SourceType } from './types.js'
import { SOURCE_TYPES } from './types.js'
import { buildQualityReport, writeQualityReport } from './validate.js'

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
    case 'knowledge':
      return cmdKnowledge(sub, args)
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
  knowledge upload|parse|queue|review|materialize
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
      ws.transition(flagStr(args, 'name'), flagStr(args, 'version'), 'IN_REVIEW')
      print({ ok: true, status: 'IN_REVIEW' })
      return
    }
    case 'issue': {
      // 签发 = 人审通过；issuedBy 必须是人工身份（§3.4）
      ws.transition(
        flagStr(args, 'name'),
        flagStr(args, 'version'),
        'ISSUED',
        flagStr(args, 'by'),
        typeof args.flags['note'] === 'string' ? args.flags['note'] : undefined,
      )
      print({ ok: true, status: 'ISSUED' })
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

function cmdRun(args: Args): void {
  const dir = args._[1]
  const scenarioId = args._[2]
  if (!dir || !scenarioId) fail('run requires <versionDir> <scenarioId>')
  const dataPath = flagStr(args, 'data')
  const dataset = JSON.parse(readFileSync(dataPath, 'utf8')) as RuntimeDataset
  const versionDir = resolve(dir)
  const result = runScenario(versionDir, scenarioId, dataset)
  // 运行留痕（run-insight S2.1）：root 由 versionDir 上溯、--root 显式覆盖；不可达跳过不破坏既有契约。
  let runRecord: string | null = null
  try {
    const root =
      typeof args.flags['root'] === 'string' ? resolve(args.flags['root']) : workspaceRootOfVersionDir(versionDir)
    if (root !== null) {
      const meta = readPackageMeta(versionDir)
      const scenario = loadPackage(versionDir).scenarios.find((s) => s.id === scenarioId)
      const redlines = [
        ...new Set(
          [
            ...result.audit.forbiddenPhraseHits.map((h) => h.phrase),
            ...(scenario?.outputContract.forbiddenPhrases ?? []),
          ].filter((p) => typeof p === 'string' && p !== ''),
        ),
      ]
      saveRunRecord(
        root,
        buildRunRecord({
          package: { name: meta.name, version: meta.version },
          dataset,
          result,
          redlines,
        }),
      )
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
