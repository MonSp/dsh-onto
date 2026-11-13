/**
 * P0-3/P0-4 接入适配示例：物业 API 快照 → RuntimeDataset（薄壳；算法单源 core）
 *
 * 用法：
 *   node scripts/adapt-campus-waste-api.mjs \
 *     examples/campus-waste-api-snapshot.json \
 *     [out-run.json] [--workspace <dir>]
 *
 * 职责（subgraph-expansion S4.3②）：
 * 1. 快照结构适配：实体/关系/行为（dumps → BHV-WST-DUMP；mixEvents → BHV-WST-MIX）
 *    + 同 objectRef 同快照去重：候选保留**首条**（主候选），后到的同桶条目丢弃
 * 2. 特征投影/派生全部走 core，不再自研：
 *    - projectFeatures：按 campus-waste 包 featureSources 把对象 attrs 投影进 features
 *    - deriveFeatures：overdueHours ← since(lastEmptiedAt, now=snapshotAt)；
 *      hazardMixCount ← count(behaviors, type=BHV-WST-MIX)
 * 3. 输出标准 RuntimeDataset JSON，可直接 CLI run / run_scenario
 *
 * --workspace / DSH_ONTO_WORKSPACE：campus-waste 包工作区（featureSources 来源），必填。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  PackageWorkspace,
  loadPackage,
  projectFeatures,
  deriveFeatures,
} from '../core/dist/index.js'

const argv = process.argv.slice(2)
function flagValue(flag) {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : undefined
}
const wsRoot = flagValue('--workspace') ?? process.env.DSH_ONTO_WORKSPACE
if (!wsRoot) {
  console.error('missing workspace: pass --workspace <dir> or set DSH_ONTO_WORKSPACE')
  process.exit(2)
}
const positional = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--workspace') {
    i++
    continue
  }
  if (argv[i].startsWith('--')) continue
  positional.push(argv[i])
}
const [inPath, outPath] = positional
if (!inPath) {
  console.error('usage: adapt-campus-waste-api.mjs <api-snapshot.json> [out-run.json] --workspace <dir>')
  process.exit(2)
}

// featureSources 来源：campus-waste 包（投影契约的唯一事实源）
const ws = new PackageWorkspace(wsRoot)
const pkg = loadPackage(ws.versionDir('campus-waste', '1.0.0'))

const raw = JSON.parse(readFileSync(resolve(inPath), 'utf8'))
const snapshotAt = new Date(raw.snapshotAt ?? Date.now())

/** 对象实体：同 binId 后写覆盖前写（实体快照语义 = 最新状态） */
const binsById = new Map()
for (const b of raw.bins ?? []) binsById.set(b.binId, b)

const objects = []
for (const b of binsById.values()) {
  objects.push({
    id: b.binId,
    type: 'OBJ-WST-BIN',
    attrs: {
      binNo: b.binNo,
      zone: b.zone,
      wasteType: b.wasteType,
      fillLevel: b.fillLevel,
      lastEmptiedAt: b.lastEmptiedAt ?? null,
    },
  })
}
for (const r of raw.routes ?? []) {
  objects.push({
    id: r.routeId,
    type: 'OBJ-WST-ROUTE',
    attrs: { routeId: r.routeNo, stopCount: r.stopCount, plannedMinutes: r.plannedMinutes },
  })
}

const relations = []
for (const r of raw.routes ?? []) {
  for (const binId of r.covers ?? []) {
    relations.push({ id: `R-${r.routeId}-${binId}`, type: 'REL-WST-COVERS', from: r.routeId, to: binId })
  }
}

const behaviors = (raw.dumps ?? []).map((d, i) => ({
  id: `B-DUMP-${i + 1}`,
  type: 'BHV-WST-DUMP',
  anchorRef: d.binId,
  objectRef: d.binId,
  occurredAt: new Date(d.at).toISOString(),
}))
// mixEvents 物化为混投行为（hazardMixCount 的计数源；结构适配属接入层职责）
for (const b of binsById.values()) {
  ;(b.mixEvents ?? []).forEach((m, i) => {
    behaviors.push({
      id: `B-MIX-${b.binId}-${i + 1}`,
      type: 'BHV-WST-MIX',
      anchorRef: b.binId,
      objectRef: b.binId,
      occurredAt: new Date(m.at).toISOString(),
    })
  })
}

// 候选：同 binId 去重——保留首条主候选，丢弃后到重复项（快照注释标「同桶重复候选」的即后到条目）
const candByBin = new Map()
for (const c of raw.candidates ?? []) {
  if (!binsById.has(c.binId)) continue
  if (candByBin.has(c.binId)) continue
  candByBin.set(c.binId, c)
}

const candidates = [...candByBin.values()].map((c) => ({
  candidateId: c.candidateId,
  objectRef: c.binId,
  features: {},
  tags: Array.isArray(c.tags) ? c.tags : [],
}))

const dataset = { objects, relations, behaviors, candidates }

// 投影：按包 featureSources（fillLevel/zone/overdueHours/hazardMixCount → OBJ-WST-BIN）
const proj = projectFeatures(pkg, dataset, dataset.candidates)
// 派生：now 取快照时刻（同一 snapshot 两次运行逐字节一致）
const recipes = [
  { name: 'overdueHours', kind: 'since', attr: 'lastEmptiedAt', now: snapshotAt.toISOString() },
  { name: 'hazardMixCount', kind: 'count', source: 'behaviors', filter: { type: 'BHV-WST-MIX' } },
]
const der = deriveFeatures(proj.candidates, dataset, recipes)

const outDataset = {
  ...dataset,
  candidates: der.candidates,
  meta: {
    source: 'adapt-campus-waste-api',
    snapshotAt: raw.snapshotAt,
    projected: [...new Set([...proj.projected.flatMap((p) => p.keys), ...der.derived])],
    deduped: (raw.candidates ?? []).length - candidates.length,
  },
}

const out = outPath ? resolve(outPath) : resolve(inPath.replace(/\.json$/, '') + '.runtime.json')
writeFileSync(out, `${JSON.stringify(outDataset, null, 2)}\n`, 'utf8')
console.log(
  JSON.stringify(
    {
      ok: true,
      out,
      objects: objects.length,
      candidates: candidates.length,
      deduped: outDataset.meta.deduped,
      derived: der.derived,
    },
    null,
    2,
  ),
)
