/**
 * 原样导入已签发的 __PKG_NAME__@__PKG_VERSION__ 到 __PROFILE_NAME__ profile。
 * 用法：node scripts/seed-release.mjs
 * 激活：node scripts/seed-release.mjs activate "<授权部署人>"
 * 回滚：node scripts/seed-release.mjs rollback "<授权部署人>"（回到上一个活动版本，history 保留）
 * 环境：__ENV_PROFILE_DIR__（缺省 ~/.dsh/profiles/__PROFILE_NAME__）
 *
 * 导入不改写签发记录或目标版本，激活/回滚需要独立的人工授权。
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
const needsHuman = command === 'activate' || command === 'rollback'
if (extra.length > 0 || !(command === 'import' && authorizedBy === undefined
  || needsHuman && authorizedBy?.trim())) {
  throw new Error('Usage: seed-release.mjs [import | activate <authorizedBy> | rollback <authorizedBy>]')
}
const releases = new ReleaseStore({
  root: releasesRoot,
  workspace: new PackageWorkspace(wsRoot),
  versions: { core: '0.2.3', runtime: '0.2.3', plugin: '__PKG_ID__@0.1.0' },
  capabilities: () => ['dryrun'],
})
// 激活/回滚操作者须为宿主可信身份 host:<userId>（assertAuthorizedActor fail-closed）：
// 运维传裸名（如 "张三"）时归一为 host: 形态，显式带前缀则原样保留
const actor = authorizedBy === undefined ? undefined
  : authorizedBy.trim().startsWith('host:') ? authorizedBy.trim() : `host:${authorizedBy.trim()}`
if (command === 'activate') {
  const act = releases.activate('__PKG_NAME__', '__PKG_VERSION__', { authorizedBy: actor })
  console.log('activate:', JSON.stringify(act))
} else if (command === 'rollback') {
  // 版本回滚同机制（图注「激活」）：history 保留、目标不存在 fail-loud
  const rolled = releases.rollback('__PKG_NAME__', { authorizedBy: actor })
  console.log('rollback:', JSON.stringify(rolled))
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
