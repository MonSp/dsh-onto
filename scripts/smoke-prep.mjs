/** scenario-prep T5 冒烟：多域批量 + campus-waste 双 digest + compare */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PackageWorkspace,
  runScenario,
  buildRunRecord,
  saveRunRecord,
  compareRunRecords,
} from '../core/dist/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const wsRoot = join(REPO, 'core', 'workspace')

const multi = [
  ['aml-analysis', 'SCN-AML-FIND-CLUES', 'aml-run.json', join(REPO, 'packages', 'aml', '1.0.0')],
  ['med-safety', 'SCN-MED-RISK-NOTICE', 'med-run.json', join(REPO, 'packages', 'med', '1.0.0')],
  ['tax-risk', 'SCN-TAX-FAKE-INVOICE', 'tax-run.json', join(REPO, 'packages', 'tax', '1.0.0')],
]
for (const [name, scen, file, dir] of multi) {
  const data = JSON.parse(readFileSync(join(REPO, 'examples', file), 'utf8'))
  const r = runScenario(dir, scen, data)
  if (!r.audit.passed || !r.humanReviewRequired) throw new Error(`${name} audit/hrr fail`)
  console.log(name, 'candidates', r.candidates.length, 'audit', r.audit.passed)
}

const ws = new PackageWorkspace(wsRoot)
const dir = ws.versionDir('campus-waste', '1.0.0')
const ds = JSON.parse(readFileSync(join(wsRoot, 'campus-waste-adapted.json'), 'utf8'))
const r1 = runScenario(dir, 'SCN-WST-FILL-TRIAGE', ds)
const rec1 = buildRunRecord({
  package: { name: 'campus-waste', version: '1.0.0' },
  dataset: r1.effectiveDataset ?? ds,
  inputDataset: ds,
  result: r1,
  redlines: [],
  savedAt: '2026-11-13T01:00:00.000Z',
})
saveRunRecord(wsRoot, rec1)
const r2 = runScenario(dir, 'SCN-WST-FILL-TRIAGE', ds, { seedIds: ['BIN-03'] })
const rec2 = buildRunRecord({
  package: { name: 'campus-waste', version: '1.0.0' },
  dataset: r2.effectiveDataset ?? ds,
  inputDataset: ds,
  result: r2,
  redlines: [],
  savedAt: '2026-11-13T02:00:00.000Z',
})
saveRunRecord(wsRoot, rec2)
const diff = compareRunRecords(rec1, rec2)
console.log(
  'compare sameDataset',
  diff.sameDataset,
  'candidates',
  Array.isArray(diff.candidates) ? diff.candidates.length : typeof diff.candidates,
)
console.log('rec1 prep', JSON.stringify(rec1.prep), 'input≠eff', rec1.inputDigest !== rec1.datasetDigest)
console.log('rec2 prep', JSON.stringify(rec2.prep))
if (rec1.inputDigest === rec1.datasetDigest) throw new Error('rec1 digests should differ when prep ran')
console.log('SMOKE_OK')
