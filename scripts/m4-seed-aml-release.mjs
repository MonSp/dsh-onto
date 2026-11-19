/**
 * Seed dsh-aml profile: ISSUED aml-analysis 1.0.0 + 1.1.0, controlled import, activate 1.0.0.
 * Usage: node scripts/m4-seed-aml-release.mjs
 */
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  PackageWorkspace,
  derivePackage,
  readPackageMeta,
} from '@dsh-onto/core'
import {
  ReleaseStore,
  buildReleaseManifest,
  buildReleaseBundle,
} from '@dsh-onto/runtime'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const AML_SRC = join(REPO, 'packages', 'aml', '1.0.0')
const profileDir = process.env.DSH_AML_PROFILE_DIR
  ?? join(homedir(), '.dsh', 'profiles', 'dsh-aml')
const wsRoot = join(profileDir, 'dsh-onto', 'workspace')
const releasesRoot = join(profileDir, 'dsh-onto', 'releases')

function installVersion(version) {
  const dir = join(wsRoot, 'packages', 'aml-analysis', version)
  mkdirSync(join(dir, '..'), { recursive: true })
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  cpSync(AML_SRC, dir, { recursive: true })
  const pkgYaml = join(dir, 'package.yaml')
  let text = readFileSync(pkgYaml, 'utf8')
  text = text.replace(/^version:.*$/m, `version: ${version}`)
  text = text.replace(/^status:.*$/m, 'status: DRAFT')
  text = text.replace(/^issueRecord:.*$/m, 'issueRecord: []')
  if (/issueRecord:\s*\n\s*-/.test(text)) {
    text = text.replace(/issueRecord:\s*\n(?:[ \t]+.*\n?)*/, 'issueRecord: []\n')
  }
  writeFileSync(pkgYaml, text, 'utf8')
  const raw = readFileSync(pkgYaml, 'utf8')
  if (raw.includes('manifestDigest')) {
    writeFileSync(
      pkgYaml,
      raw.split('\n').filter((l) => !l.includes('manifestDigest')).join('\n'),
      'utf8',
    )
  }

  const ws = new PackageWorkspace(wsRoot)
  const meta = readPackageMeta(dir)
  if (meta.status !== 'ISSUED') {
    if (meta.status === 'DRAFT') ws.transition('aml-analysis', version, 'IN_REVIEW')
    ws.transition('aml-analysis', version, 'ISSUED', '张三（人工）', 'M4 浏览器冒烟签发')
  }
  derivePackage(dir)
  return dir
}

const ws = new PackageWorkspace(wsRoot)
for (const v of ['1.0.0', '1.1.0']) {
  const dir = installVersion(v)
  const manifest = buildReleaseManifest(dir, {
    coreCompat: { min: '0.2.0' },
    runtimeCompat: { min: '0.2.0' },
    releasedBy: 'deploy@m4-browser-smoke',
  })
  const bundle = buildReleaseBundle(dir, manifest)
  const releases = new ReleaseStore({
    root: releasesRoot,
    workspace: ws,
    versions: { core: '0.2.1', runtime: '0.2.1', plugin: '@dsh-aml/app@0.1.0' },
    capabilities: () => ['dryrun'],
  })
  const r = releases.importRelease({ kind: 'controlled-upload', bundle })
  console.log(`import ${v}: idempotent=${r.idempotent} digest=${r.packageDigest.slice(0, 12)}…`)
}

const releases = new ReleaseStore({
  root: releasesRoot,
  workspace: ws,
  versions: { core: '0.2.1', runtime: '0.2.1', plugin: '@dsh-aml/app@0.1.0' },
  capabilities: () => ['dryrun'],
})
const act = releases.activate('aml-analysis', '1.0.0', { authorizedBy: 'ops-smoke' })
console.log('activate:', JSON.stringify(act))
console.log('active map:', JSON.stringify(Object.fromEntries(releases.activeMap() ?? [])))
console.log('history:', releases.readHistory().length, 'entries')
