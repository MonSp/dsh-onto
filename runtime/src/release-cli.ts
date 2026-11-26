/**
 * 运维发布 CLI（issue #33 缺口6）：发布 / 激活 / 回滚 子命令。
 *
 * 与 wire `publishRelease` / Agent `publish_business` 共用同一收编口径
 * （buildReleaseManifest → buildReleaseBundle → ReleaseStore.importRelease），
 * 与 seed-release.mjs 共用授权口径（host: 归一 + assertAuthorizedActor fail-closed）。
 * 导入不自动激活；激活/回滚须人工授权（--by），ISSUED 只读红线不变。
 *
 * 用法：
 *   node dist/release-cli.js list
 *   node dist/release-cli.js status [name]
 *   node dist/release-cli.js publish <versionDir> [--by <actor>] [--check-replay]
 *   node dist/release-cli.js activate <name> <version> --by <actor>
 *   node dist/release-cli.js rollback <name> --by <actor>
 *
 * 环境：DSH_ONTO_DATA_DIR（数据目录，含 workspace/ 与 releases/；缺省 ~/.dsh/profiles/default/dsh-onto）。
 * @module @dsh-onto/runtime/release-cli
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { PackageWorkspace, loadPackage } from '@dsh-onto/core'
import {
  ReleaseStore,
  ReleaseError,
  buildReleaseManifest,
  buildReleaseBundle,
  type ReleaseManifest,
} from './index.js'
import { runReplayAcceptance } from './agent-tools.js'

export interface ReleaseCliResult {
  code: number
  output: string
}

interface CliArgs {
  command: string
  positional: string[]
  by?: string
  checkReplay: boolean
}

const USAGE = `用法：release-cli <command> [options]
  list                              列出发布台账（manifest + 活动指针）
  status [name]                     活动版本 + 最近历史（可按包名过滤）
  publish <versionDir> [--by <actor>] [--check-replay]
                                    受控导入（不激活）；--check-replay 全场景夹具回放验收
  activate <name> <version> --by <actor>
                                    授权激活（人工授权，host:<userId>）
  rollback <name> --by <actor>      回滚上一活动版本（history 保留）
环境：DSH_ONTO_DATA_DIR（缺省 ~/.dsh/profiles/default/dsh-onto）`

/** 操作者归一（同 seed-release.mjs）：裸名 → host: 形态；已带前缀则规范化小写 host:。 */
export function normalizeActor(raw: string | undefined): string | undefined {
  const t = raw?.trim()
  if (t === undefined || t === '') return undefined
  return /^host:/i.test(t) ? `host:${t.slice(5)}` : `host:${t}`
}

export function parseReleaseCliArgs(argv: readonly string[]): CliArgs {
  const [command = '', ...rest] = argv
  const positional: string[] = []
  let by: string | undefined
  let checkReplay = false
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--by') by = rest[++i]
    else if (a === '--check-replay') checkReplay = true
    else if (a === '--help' || a === '-h') return { command: 'help', positional: [], checkReplay: false }
    else positional.push(a)
  }
  return { command, positional, ...(by !== undefined ? { by } : {}), checkReplay }
}

function readCliVersion(which: 'core' | 'runtime'): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const rel = which === 'runtime' ? '../package.json' : '../../core/package.json'
    const doc = JSON.parse(readFileSync(join(here, rel), 'utf8')) as { version?: unknown }
    return typeof doc.version === 'string' && doc.version !== '' ? doc.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function formatManifest(m: ReleaseManifest, active: string | null): string {
  const mark = active === m.package.version ? ' [active]' : ''
  return `  ${m.package.name}@${m.package.version}${mark}  digest=${m.packageDigest.slice(0, 12)}…  by=${m.releasedBy}`
}

/**
 * 执行发布 CLI。返回码：0 成功；1 业务拒绝（ReleaseError 等）；2 用法错误。
 * 纯进程级封装（无 harness 依赖），可被单测直接调用。
 */
export function runReleaseCli(
  argv: readonly string[],
  opts: { dataDir?: string; log?: (line: string) => void } = {},
): ReleaseCliResult {
  const log = opts.log ?? ((line: string) => console.log(line))
  const args = parseReleaseCliArgs(argv)
  const lines: string[] = []
  const emit = (line: string): void => {
    lines.push(line)
    log(line)
  }

  if (args.command === '' || args.command === 'help') {
    emit(USAGE)
    return { code: args.command === 'help' ? 0 : 2, output: lines.join('\n') }
  }

  const dataDir = opts.dataDir ?? process.env.DSH_ONTO_DATA_DIR
    ?? join(homedir(), '.dsh', 'profiles', 'default', 'dsh-onto')
  const ws = new PackageWorkspace(join(dataDir, 'workspace'))
  const releases = new ReleaseStore({
    root: join(dataDir, 'releases'),
    workspace: ws,
    versions: { core: readCliVersion('core'), runtime: readCliVersion('runtime') },
    capabilities: () => [],
  })

  try {
    switch (args.command) {
      case 'list': {
        const manifests = releases.listManifests()
        if (manifests.length === 0) {
          emit('（无发布台账）')
          break
        }
        for (const m of manifests) {
          emit(formatManifest(m, releases.activeVersion(m.package.name)))
        }
        break
      }
      case 'status': {
        const [name] = args.positional
        const active = releases.readActive()
        if (name !== undefined) {
          emit(`包 ${name} 活动版本：${releases.activeVersion(name) ?? '（未激活）'}`)
        } else if (active !== null) {
          emit(`活动指针（${active.updatedAt} by ${active.updatedBy}）：`)
          for (const [n, v] of Object.entries(active.packages)) emit(`  ${n}@${v}`)
        } else {
          emit('（无活动指针）')
        }
        const hist = releases.readHistory()
          .filter((h) => name === undefined || h.package.name === name)
          .slice(-10)
        emit(`最近历史（${hist.length} 条）：`)
        for (const h of hist) {
          emit(`  ${h.at} ${h.action} ${h.package.name}@${h.package.version} ${h.from ?? '-'} → ${h.to ?? '-'} by ${h.by}`)
        }
        break
      }
      case 'publish': {
        const [dir] = args.positional
        if (dir === undefined) return usageError('publish 需要 <versionDir>', lines, emit)
        if (!existsSync(join(dir, 'package.yaml'))) {
          throw new ReleaseError('RELEASE_NOT_FOUND', `package.yaml missing: ${dir}`)
        }
        const pkg = loadPackage(dir)
        if (args.checkReplay) {
          const checked = runReplayAcceptance(dir, pkg)
          emit(`回放验收：${checked} 个场景全过`)
        }
        const manifest = buildReleaseManifest(dir, {
          coreCompat: { min: '0.2.0' },
          runtimeCompat: { min: '0.2.0' },
          releasedBy: normalizeActor(args.by) ?? `deploy@release-cli`,
        })
        const r = releases.importRelease({ kind: 'controlled-upload', bundle: buildReleaseBundle(dir, manifest) })
        emit(`import: idempotent=${r.idempotent} ${r.package.name}@${r.package.version} digest=${r.packageDigest.slice(0, 12)}…`)
        emit('（导入不自动激活：须授权人 activate）')
        break
      }
      case 'activate': {
        const [name, version] = args.positional
        if (name === undefined || version === undefined) {
          return usageError('activate 需要 <name> <version> --by <actor>', lines, emit)
        }
        const actor = normalizeActor(args.by)
        if (actor === undefined) return usageError('activate 需要 --by <actor>（人工授权）', lines, emit)
        const r = releases.activate(name, version, { authorizedBy: actor })
        emit(`activate: ${r.package.name}@${r.package.version}（previous=${r.previous ?? '-'}）`)
        break
      }
      case 'rollback': {
        const [name] = args.positional
        if (name === undefined) return usageError('rollback 需要 <name> --by <actor>', lines, emit)
        const actor = normalizeActor(args.by)
        if (actor === undefined) return usageError('rollback 需要 --by <actor>（人工授权）', lines, emit)
        const r = releases.rollback(name, { authorizedBy: actor })
        emit(`rollback: ${r.package.name}@${r.package.version}（previous=${r.previous ?? '-'}）`)
        break
      }
      default:
        return usageError(`未知命令：${args.command}`, lines, emit)
    }
  } catch (e) {
    if (e instanceof ReleaseError) {
      emit(`拒绝（${e.code}）：${e.message}`)
      return { code: 1, output: lines.join('\n') }
    }
    throw e
  }
  return { code: 0, output: lines.join('\n') }
}

function usageError(msg: string, lines: string[], emit: (line: string) => void): ReleaseCliResult {
  emit(`用法错误：${msg}`)
  emit(USAGE)
  return { code: 2, output: lines.join('\n') }
}

/* CLI 入口（直接执行时）：node dist/release-cli.js <command> … */
const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedDirectly) {
  const r = runReleaseCli(process.argv.slice(2))
  process.exitCode = r.code
}
