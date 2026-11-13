/**
 * 接入适配示例：物业 API 快照 → RuntimeDataset（纯结构适配薄壳）
 *
 * 用法：
 *   node scripts/adapt-campus-waste-api.mjs \
 *     examples/campus-waste-api-snapshot.json \
 *     [out-run.json] [--workspace <dir>]
 *
 * 职责（scenario-prep S2.6）：
 * 1. 快照结构适配：实体/关系/行为（dumps → BHV-WST-DUMP；mixEvents → BHV-WST-MIX）
 *    + 同 objectRef 同快照去重：候选保留**首条**（主候选），后到的同桶条目丢弃
 * 2. **不再做**特征投影/派生——场景 prep.features=true 时由 run_scenario 执行层
 *    按包 featureRecipes + featureSources 完成（投影/派生完全交给执行层）
 * 3. 输出标准 RuntimeDataset JSON（features 留空），可直接 CLI run / run_scenario(seedIds?)
 *
 * --workspace / DSH_ONTO_WORKSPACE：campus-waste 包工作区（校验包存在），必填。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { PackageWorkspace } from '../core/dist/index.js'

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

// 包存在性校验（prep 契约的事实源在包里，不在适配脚本）
const ws = new PackageWorkspace(wsRoot)
const versionDir = ws.versionDir('campus-waste', '1.0.0')
if (!existsSync(join(versionDir, 'package.yaml'))) {
  console.error(`campus-waste@1.0.0 not found under ${wsRoot}`)
  process.exit(2)
}

const raw = JSON.parse(readFileSync(resolve(inPath), 'utf8'))

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
  // 纯结构适配：features 留空，投影/派生由场景 prep.features 执行层完成
  features: {},
  tags: Array.isArray(c.tags) ? c.tags : [],
}))

const outDataset = {
  objects,
  relations,
  behaviors,
  candidates,
  meta: {
    source: 'adapt-campus-waste-api',
    snapshotAt: raw.snapshotAt,
    deduped: (raw.candidates ?? []).length - candidates.length,
    note: 'features 留空——prep.features=true 时由 run_scenario 投影/派生',
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
      features: 'deferred-to-prep',
    },
    null,
    2,
  ),
)
