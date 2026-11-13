/**
 * 子图扩展（subgraph-expansion S3.1）：从种子实体沿实例关系 BFS 扩出邻域闭包。
 *
 * 纯函数、无 IO、无 now——实例图就是传入的 RuntimeDataset，扩图只做数据准备，
 * 不打分（判定仍在规则引擎 rules.ts）。不变量：
 * - 子 dataset 诱导子图：relations 两端 ⊆ objects（A-3，杜绝悬空 from/to）；
 * - hops 硬上限 3（防邻域爆炸）；触及上限仍有外沿必须置 truncated（不静默截断）；
 * - 关系类型过滤只约束「行走」的边，输出为邻域顶点集上的全量诱导子图；
 * - 种子缺失记 missingSeedIds 不抛错（全部缺失由工具面转 INVALID_ARGS）。
 * @module @dsh-onto/core/subgraph
 */
import type { RuntimeDataset } from './types.js'

/** 最大跳数硬上限（S3.1 / A-2）。 */
export const MAX_EXPAND_HOPS = 3

export interface ExpandOptions {
  /** 最大跳数，默认 1，硬上限 3（防邻域爆炸）。 */
  hops?: number
  /** 只沿这些关系类型扩展；缺省 = 数据集中出现的全部类型。 */
  relationTypes?: string[]
  /** 扩展方向：out | in | both，默认 both（无向 BFS，实例图不假设方向语义）。 */
  direction?: 'out' | 'in' | 'both'
  /** 扩出的邻域是否附带 behaviors（anchorRef/objectRef 命中邻域才收），默认 true。 */
  includeBehaviors?: boolean
}

export interface ExpandResult {
  /** 邻域闭包：objects + relations + behaviors + candidates。 */
  dataset: RuntimeDataset
  /** 实际命中的种子（不存在的 ID 单列）。 */
  seedIds: string[]
  missingSeedIds: string[]
  /** 触及 hops 上限仍有外沿。 */
  truncated: boolean
  stats: { seeds: number; objects: number; relations: number; candidates: number }
}

/** hops 收口：非有限数按默认 1；夹到 [0, MAX_EXPAND_HOPS]（A-2 硬上限在核心也兜底）。 */
function clampHops(raw: number | undefined): number {
  if (raw === undefined) return 1
  if (!Number.isFinite(raw)) return 1
  return Math.min(MAX_EXPAND_HOPS, Math.max(0, Math.floor(raw)))
}

export function expandEntity(
  dataset: RuntimeDataset,
  seedIds: string[],
  opts: ExpandOptions = {},
): ExpandResult {
  const hops = clampHops(opts.hops)
  const direction = opts.direction ?? 'both'
  const relationTypes = opts.relationTypes
  const includeBehaviors = opts.includeBehaviors ?? true

  const objectsById = new Map(dataset.objects.map((o) => [o.id, o]))
  const uniqSeeds = [...new Set(seedIds)]
  const hitSeeds: string[] = []
  const missingSeedIds: string[] = []
  for (const id of uniqSeeds) {
    if (objectsById.has(id)) hitSeeds.push(id)
    else missingSeedIds.push(id)
  }

  // 邻接表：类型过滤在边上做（未知类型也照走，包级闭合归 ingestDataset/校验）。
  const adj = new Map<string, string[]>()
  const link = (near: string, far: string): void => {
    if (near === far) return
    const list = adj.get(near)
    if (list === undefined) adj.set(near, [far])
    else if (!list.includes(far)) list.push(far)
  }
  for (const r of dataset.relations) {
    if (relationTypes !== undefined && !relationTypes.includes(r.type)) continue
    if (direction === 'out' || direction === 'both') link(r.from, r.to)
    if (direction === 'in' || direction === 'both') link(r.to, r.from)
  }

  // BFS：visited 防环；终点无对象条目（输入数据集畸形）不入邻域、不穿越。
  const visited = new Set<string>(hitSeeds)
  let frontier = [...hitSeeds]
  for (let depth = 0; depth < hops && frontier.length > 0; depth++) {
    const next: string[] = []
    for (const node of frontier) {
      for (const far of adj.get(node) ?? []) {
        if (!objectsById.has(far) || visited.has(far)) continue
        visited.add(far)
        next.push(far)
      }
    }
    frontier = next
  }
  // truncated：最后一层（depth = hops，含 hops=0 的种子层）仍有通往未访问对象的边。
  let truncated = false
  for (const node of frontier) {
    for (const far of adj.get(node) ?? []) {
      if (objectsById.has(far) && !visited.has(far)) {
        truncated = true
        break
      }
    }
    if (truncated) break
  }

  const objects = dataset.objects.filter((o) => visited.has(o.id))
  // 诱导子图：两端都在邻域内的边全收（不按 relationTypes 裁剪输出——过滤只约束行走）。
  const relations = dataset.relations.filter((r) => visited.has(r.from) && visited.has(r.to))
  const behaviors = includeBehaviors
    ? (dataset.behaviors ?? []).filter((b) => visited.has(b.anchorRef) || visited.has(b.objectRef))
    : []
  const candidates = dataset.candidates.filter((c) => visited.has(c.objectRef))

  return {
    dataset: { objects, relations, behaviors, candidates },
    seedIds: hitSeeds,
    missingSeedIds,
    truncated,
    stats: {
      seeds: hitSeeds.length,
      objects: objects.length,
      relations: relations.length,
      candidates: candidates.length,
    },
  }
}
