/**
 * Seed dsh-tax profile: install ISSUED tax-risk 1.0.0 + controlled release import + activate.
 * Usage: node scripts/m-tax-seed-release.mjs
 * Env:   DSH_TAX_PROFILE_DIR (default ~/.dsh/profiles/dsh-tax)
 *
 * 包状态迁移仅用于已入库 ISSUED 包的 profile 播种；正式签发步骤见 docs/plugin-authoring.zh.md。
 */
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { PackageWorkspace, derivePackage, readPackageMeta } from '../core/dist/index.js'
import { ReleaseStore, buildReleaseManifest, buildReleaseBundle } from '../runtime/dist/index.js'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const TAX_SRC = join(REPO, 'packages', 'tax', '1.0.0')
const profileDir = process.env.DSH_TAX_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'dsh-tax')
const wsRoot = join(profileDir, 'dsh-onto', 'workspace')
const releasesRoot = join(profileDir, 'dsh-onto', 'releases')

const dir = join(wsRoot, 'packages', 'tax-risk', '1.0.0')
mkdirSync(join(dir, '..'), { recursive: true })
if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
cpSync(TAX_SRC, dir, { recursive: true })

// 源包可能已带 ISSUED/manifestDigest；profile 播种重走状态机（与 m4-seed 同口径）
const pkgYaml = join(dir, 'package.yaml')
let text = readFileSync(pkgYaml, 'utf8')
text = text.replace(/^status:.*$/m, 'status: DRAFT')
if (/^issueRecord:/m.test(text)) {
  text = text.replace(/^issueRecord:\s*\n(?:[ \t]+.*\n?)*/m, 'issueRecord: []\n')
}
text = text
  .split('\n')
  .filter((l) => !l.includes('manifestDigest'))
  .join('\n')
writeFileSync(pkgYaml, text, 'utf8')

const ws = new PackageWorkspace(wsRoot)
const meta = readPackageMeta(dir)
if (meta.status !== 'ISSUED') {
  if (meta.status === 'DRAFT') ws.transition('tax-risk', '1.0.0', 'IN_REVIEW')
  ws.transition('tax-risk', '1.0.0', 'ISSUED', '张三（人工）', '第二插件 profile 播种签发')
}
derivePackage(dir)

const manifest = buildReleaseManifest(dir, {
  coreCompat: { min: '0.2.0' },
  runtimeCompat: { min: '0.2.0' },
  releasedBy: 'deploy@tax-second-plugin',
})
const bundle = buildReleaseBundle(dir, manifest)
const releases = new ReleaseStore({
  root: releasesRoot,
  workspace: ws,
  versions: { core: '0.2.1', runtime: '0.2.1', plugin: '@dsh-tax/app@0.1.0' },
  capabilities: () => ['dryrun'],
})
const r = releases.importRelease({ kind: 'controlled-upload', bundle })
console.log(`import: idempotent=${r.idempotent} digest=${r.packageDigest.slice(0, 12)}…`)
const act = releases.activate('tax-risk', '1.0.0', { authorizedBy: 'ops-tax-seed' })
console.log('activate:', JSON.stringify(act))
