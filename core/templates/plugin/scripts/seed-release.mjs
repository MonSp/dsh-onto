/**
 * 播种 __PROFILE_NAME__ profile：安装已签发 __PKG_NAME__@__PKG_VERSION__ + 受控导入 + 激活。
 * 用法：node scripts/seed-release.mjs
 * 环境：__ENV_PROFILE_DIR__（缺省 ~/.dsh/profiles/__PROFILE_NAME__）
 *
 * 导入 ≠ 激活：importRelease 受控导入、activate 显式激活（api-to-plugin S2.4）。
 * 包状态迁移仅用于已入库 ISSUED 包的 profile 播种；正式签发是人工步骤。
 */
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { PackageWorkspace, derivePackage, readPackageMeta } from '@dsh-onto/core'
import { ReleaseStore, buildReleaseManifest, buildReleaseBundle } from '@dsh-onto/runtime'

const SRC_PKG_DIR = '__SRC_PKG_DIR__'
const profileDir = process.env.__ENV_PROFILE_DIR__ ?? join(homedir(), '.dsh', 'profiles', '__PROFILE_NAME__')
const wsRoot = join(profileDir, 'dsh-onto', 'workspace')
const releasesRoot = join(profileDir, 'dsh-onto', 'releases')

const dir = join(wsRoot, 'packages', '__PKG_NAME__', '__PKG_VERSION__')
mkdirSync(join(dir, '..'), { recursive: true })
if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
cpSync(SRC_PKG_DIR, dir, { recursive: true })

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
  if (meta.status === 'DRAFT') ws.transition('__PKG_NAME__', '__PKG_VERSION__', 'IN_REVIEW')
  ws.transition('__PKG_NAME__', '__PKG_VERSION__', 'ISSUED', '部署播种（人工授权）', 'profile 播种签发')
}
derivePackage(dir)

const manifest = buildReleaseManifest(dir, {
  coreCompat: { min: '0.2.0' },
  runtimeCompat: { min: '0.2.0' },
  releasedBy: 'deploy@__PROFILE_NAME__',
})
const bundle = buildReleaseBundle(dir, manifest)
const releases = new ReleaseStore({
  root: releasesRoot,
  workspace: ws,
  versions: { core: '0.2.1', runtime: '0.2.1', plugin: '__PKG_ID__@0.1.0' },
  capabilities: () => ['dryrun'],
})
const r = releases.importRelease({ kind: 'controlled-upload', bundle })
console.log(`import: idempotent=${r.idempotent} digest=${r.packageDigest.slice(0, 12)}…`)
const act = releases.activate('__PKG_NAME__', '__PKG_VERSION__', { authorizedBy: 'ops-seed' })
console.log('activate:', JSON.stringify(act))
