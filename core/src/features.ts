/**
 * 特征投影与派生（subgraph-expansion S4）：把「对象 attrs → 候选 features」的投影
 * 与确定性派生特征（since/count/ratio）从接入示例脚本升格为 core 纯函数。
 *
 * 纯函数、无 IO；A-7：`now` 由调用方经配方注入，本模块禁止 `new Date()` 无参调用。
 * 派生值写入 features 后即参与打分/排除（与 PR#17「可回算特征写入 features」口径一致）。
 * @module @dsh-onto/core/features
 */
import type { OntologyPackage, RuntimeBehaviorInstance, RuntimeCandidate, RuntimeDataset, RuntimeRelationInstance } from './types.js'

export interface FeatureRecipe {
  /** 写入 features 的键。 */
  name: string
  kind: 'since' | 'count' | 'ratio'
  /** since：对象上的时间戳属性名。 */
  attr?: string
  /** count：计数源。 */
  source?: 'behaviors' | 'relations'
  /** count：实例过滤（type 精确匹配；attr+equals 同时给出才过滤字段值）。 */
  filter?: { type?: string; attr?: string; equals?: string | number }
  /** ratio：分子/分母特征键。 */
  num?: string
  den?: string
  /** ratio：分母下限，den < minDen → 缺省（待核实）。 */
  minDen?: number
  /** since：基准时刻 ISO；缺省 = 调用方注入（测试/回放固定 now）。 */
  now?: string
}

/** 单配方对该候选算不出值时的哨兵。 */
const SKIP = Symbol('skip')

/** 包内全部规则的 featureSources 并集：特征名 → 声明的 OBJ/REL 目标集。 */
function collectFeatureSources(pkg: OntologyPackage): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const rule of [...pkg.scoreRules, ...pkg.exclusionRules]) {
    for (const [feat, target] of Object.entries(rule.featureSources ?? {})) {
      const set = out.get(feat)
      if (set === undefined) out.set(feat, new Set([target]))
      else set.add(target)
    }
  }
  return out
}

/**
 * 按 featureSources 声明把对象 attrs 投影进候选 features（已存在的键不覆盖）。
 * 类型不匹配 / 属性缺失 / 非 number|string 值 → 不写入；`projected[].keys`
 * 只记成功写入的键（缺口 = 声明集 − keys，供上层转 pendingChecks）。
 */
export function projectFeatures(
  pkg: OntologyPackage,
  dataset: RuntimeDataset,
  candidates: RuntimeCandidate[],
  opts: { overwrite?: boolean } = {},
): { candidates: RuntimeCandidate[]; projected: Array<{ candidateId: string; keys: string[] }> } {
  const overwrite = opts.overwrite ?? false
  const sources = collectFeatureSources(pkg)
  const objectsById = new Map(dataset.objects.map((o) => [o.id, o]))
  const out: RuntimeCandidate[] = []
  const projected: Array<{ candidateId: string; keys: string[] }> = []
  for (const cand of candidates) {
    const keys: string[] = []
    const obj = objectsById.get(cand.objectRef)
    if (obj !== undefined && sources.size > 0) {
      let features: Record<string, number | string> | undefined
      for (const [feat, targets] of sources) {
        if (!targets.has(obj.type)) continue
        const v = obj.attrs?.[feat]
        if (typeof v !== 'number' && typeof v !== 'string') continue
        if (!overwrite && cand.features[feat] !== undefined) continue
        features ??= { ...cand.features }
        features[feat] = v
        keys.push(feat)
      }
      out.push(features === undefined ? cand : { ...cand, features })
    } else {
      out.push(cand)
    }
    projected.push({ candidateId: cand.candidateId, keys })
  }
  return { candidates: out, projected }
}

/** since 配方：now − Date(attr) 小时数（round 0.1）；缺 now/坏日期/负值 → SKIP。 */
function computeSince(
  recipe: FeatureRecipe,
  cand: RuntimeCandidate,
  objectsById: Map<string, { attrs: Record<string, unknown> }>,
): number | typeof SKIP {
  if (typeof recipe.attr !== 'string' || typeof recipe.now !== 'string') return SKIP
  const obj = objectsById.get(cand.objectRef)
  if (obj === undefined) return SKIP
  const raw = obj.attrs?.[recipe.attr]
  if (typeof raw !== 'string' && typeof raw !== 'number') return SKIP
  const at = new Date(raw).getTime()
  const now = new Date(recipe.now).getTime()
  if (!Number.isFinite(at) || !Number.isFinite(now)) return SKIP
  const ms = now - at
  if (ms < 0) return SKIP
  return Math.round((ms / 36e5) * 10) / 10
}

/** count 配方：候选 objectRef 关联（behavior: anchorRef/objectRef；relation: from/to）的匹配实例计数。 */
function computeCount(
  recipe: FeatureRecipe,
  cand: RuntimeCandidate,
  dataset: RuntimeDataset,
): number {
  const filter = recipe.filter
  const match = (linked: boolean, inst: RuntimeBehaviorInstance | RuntimeRelationInstance): boolean => {
    if (!linked) return false
    if (filter?.type !== undefined && inst.type !== filter.type) return false
    if (filter?.attr !== undefined && filter.equals !== undefined) {
      const holder = inst as unknown as Record<string, unknown>
      const direct = holder[filter.attr]
      const attrs = holder['attrs']
      const bag =
        direct !== undefined
          ? direct
          : attrs !== null && typeof attrs === 'object'
            ? (attrs as Record<string, unknown>)[filter.attr]
            : undefined
      if (bag !== filter.equals) return false
    }
    return true
  }
  let n = 0
  if (recipe.source === 'behaviors') {
    for (const b of dataset.behaviors ?? []) {
      if (match(b.anchorRef === cand.objectRef || b.objectRef === cand.objectRef, b)) n++
    }
  } else if (recipe.source === 'relations') {
    for (const r of dataset.relations) {
      if (match(r.from === cand.objectRef || r.to === cand.objectRef, r)) n++
    }
  }
  return n
}

/** ratio 配方：num/den；非有限数、0 分母、den < minDen → SKIP。 */
function computeRatio(recipe: FeatureRecipe, cand: RuntimeCandidate): number | typeof SKIP {
  if (typeof recipe.num !== 'string' || typeof recipe.den !== 'string') return SKIP
  const num = cand.features[recipe.num]
  const den = cand.features[recipe.den]
  if (typeof num !== 'number' || typeof den !== 'number') return SKIP
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return SKIP
  if (recipe.minDen !== undefined && den < recipe.minDen) return SKIP
  return num / den
}

/**
 * 按配方派生特征写入候选 features（配方顺序生效，后续配方可见先前写入）。
 * `now` 必须由配方注入：同输入两次运行逐字节一致（验收 3 / A-7）。
 */
export function deriveFeatures(
  candidates: RuntimeCandidate[],
  dataset: RuntimeDataset,
  recipes: FeatureRecipe[],
): { candidates: RuntimeCandidate[]; derived: string[] } {
  const objectsById = new Map(dataset.objects.map((o) => [o.id, o]))
  let list = candidates
  const derived: string[] = []
  const pushed = new Set<string>()
  for (const recipe of recipes) {
    if (typeof recipe.name !== 'string' || recipe.name === '') continue
    let wrote = false
    list = list.map((cand) => {
      let value: number | typeof SKIP
      if (recipe.kind === 'since') value = computeSince(recipe, cand, objectsById)
      else if (recipe.kind === 'count') value = computeCount(recipe, cand, dataset)
      else if (recipe.kind === 'ratio') value = computeRatio(recipe, cand)
      else value = SKIP
      if (value === SKIP) return cand
      wrote = true
      return { ...cand, features: { ...cand.features, [recipe.name]: value } }
    })
    if (wrote && !pushed.has(recipe.name)) {
      pushed.add(recipe.name)
      derived.push(recipe.name)
    }
  }
  return { candidates: list, derived }
}
