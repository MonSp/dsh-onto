/**
 * 原样导入已签发的 __PKG_NAME__@__PKG_VERSION__ 到 __PROFILE_NAME__ profile。
 * 用法：node scripts/seed-release.mjs
 * 激活：node scripts/seed-release.mjs activate "<授权部署人>"
 * 环境：__ENV_PROFILE_DIR__（缺省 ~/.dsh/profiles/__PROFILE_NAME__）
 *
 * 导入不改写签发记录或目标版本，激活需要独立的操作。
 */
import { join } from 'node:path'
import { homedir } from 'node:os'
import { PackageWorkspace } from '@dsh-onto/core'
import { ReleaseStore, buildReleaseManifest, buildReleaseBundle } from '@dsh-onto/runtime'

const SRC_PKG_DIR = '__SRC_PKG_DIR__'
const profileDir = process.env.__ENV_PROFILE_DIR__ ?? join(homedir(), '.dsh', 'profiles', '__PROFILE_NAME__')
const wsRoot = join(profileDir, 'dsh-onto', 'workspace')
const releasesRoot = join(profileDir, 'dsh-onto', 'releases')

const [command = 'import', authorizedBy, ...extra] = process.argv.slice(2)
if (extra.length > 0 || !(command === 'import' && authorizedBy === undefined
  || command === 'activate' && authorizedBy?.trim())) {
  throw new Error('Usage: seed-release.mjs [import | activate <authorizedBy>]')
}
const releases = new ReleaseStore({
  root: releasesRoot,
  workspace: new PackageWorkspace(wsRoot),
  versions: { core: '0.2.1', runtime: '0.2.1', plugin: '__PKG_ID__@0.1.0' },
  capabilities: () => ['dryrun'],
})
if (command === 'activate') {
  const act = releases.activate('__PKG_NAME__', '__PKG_VERSION__', { authorizedBy })
  console.log('activate:', JSON.stringify(act))
} else {
  const manifest = buildReleaseManifest(SRC_PKG_DIR, {
    coreCompat: { min: '0.2.0' },
    runtimeCompat: { min: '0.2.0' },
    releasedBy: 'deploy@__PROFILE_NAME__',
  })
  if (manifest.package.name !== '__PKG_NAME__' || manifest.package.version !== '__PKG_VERSION__') {
    throw new Error('Source package does not match the generated plugin binding')
  }
  const bundle = buildReleaseBundle(SRC_PKG_DIR, manifest)
  const r = releases.importRelease({ kind: 'controlled-upload', bundle })
  console.log(`import: idempotent=${r.idempotent} digest=${r.packageDigest.slice(0, 12)}…`)
}
