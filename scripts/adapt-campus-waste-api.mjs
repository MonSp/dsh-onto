/**
 * P0-3/P0-4 接入适配示例：物业 API 快照 → RuntimeDataset
 *
 * 用法：
 *   node scripts/adapt-campus-waste-api.mjs \
 *     examples/campus-waste-api-snapshot.json \
 *     [out-run.json]
 *
 * 职责（方案 §2.2 P0-3 / P0-4）：
 * 1. 把排除/打分需要的字段从对象 attrs 投影进 candidate.features（zone 必进）
 * 2. 同 objectRef 同快照去重：候选保留**首条**（主候选），后到的同桶条目视为
 *    重复丢弃——快照注释标了「同桶重复候选，适配层应去重」的就是后到条目；
 *    反向 keep-last 会丢掉正牌候选、留下重复项（再被白名单规则排掉 → 整桶消失）
 * 3. 由 lastEmptiedAt / mixEvents 回算 overdueHours、hazardMixCount（不收裸数字）
 * 4. 输出标准 RuntimeDataset JSON，可直接 CLI run / run_scenario
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const [, , inPath, outPath] = process.argv
if (!inPath) {
  console.error('usage: adapt-campus-waste-api.mjs <api-snapshot.json> [out-run.json]')
  process.exit(2)
}

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

/** P0-4：overdueHours = snapshotAt - lastEmptiedAt（小时） */
function overdueHours(bin, now) {
  if (!bin.lastEmptiedAt) return undefined
  const ms = now - new Date(bin.lastEmptiedAt)
  if (!Number.isFinite(ms) || ms < 0) return undefined
  return Math.round((ms / 36e5) * 10) / 10
}

/** P0-4：hazardMixCount = mixEvents.length */
function hazardMixCount(bin) {
  return Array.isArray(bin.mixEvents) ? bin.mixEvents.length : 0
}

/** P0-3：条件字段投影（zone 必进 features） */
function projectFeatures(bin) {
  const f = {
    fillLevel: bin.fillLevel,
    zone: bin.zone,
    wasteType: bin.wasteType,
    binNo: bin.binNo,
  }
  const oh = overdueHours(bin, snapshotAt)
  if (oh !== undefined) f.overdueHours = oh
  f.hazardMixCount = hazardMixCount(bin)
  return f
}

// 候选：同 binId 去重——保留首条主候选，丢弃后到重复项（见文件头职责 2）
const candByBin = new Map()
for (const c of raw.candidates ?? []) {
  if (!binsById.has(c.binId)) continue
  if (candByBin.has(c.binId)) continue
  candByBin.set(c.binId, c)
}

const candidates = [...candByBin.values()].map((c) => ({
  candidateId: c.candidateId,
  objectRef: c.binId,
  features: projectFeatures(binsById.get(c.binId)),
  tags: Array.isArray(c.tags) ? c.tags : [],
}))

const dataset = {
  objects,
  relations,
  behaviors,
  candidates,
  meta: {
    source: 'adapt-campus-waste-api',
    snapshotAt: raw.snapshotAt,
    projected: ['zone', 'fillLevel', 'overdueHours', 'hazardMixCount', 'binNo'],
    deduped: (raw.candidates ?? []).length - candidates.length,
  },
}

const out = outPath ? resolve(outPath) : resolve(inPath.replace(/\.json$/, '') + '.runtime.json')
writeFileSync(out, `${JSON.stringify(dataset, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ ok: true, out, objects: objects.length, candidates: candidates.length, deduped: dataset.meta.deduped }, null, 2))
