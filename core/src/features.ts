/**
 * 特征投影与派生（subgraph-expansion S4）：把「对象 attrs → 候选 features」的投影
 * 与确定性派生特征（since/count/ratio）从接入示例脚本升格为 core 纯函数。
 *
 * 纯函数、无 IO；A-7：`now` 由调用方经配方注入，本模块禁止 `new Date()` 无参调用。
 * 派生值写入 features 后即参与打分/排除（与 PR#17「可回算特征写入 features」口径一致）。
 * @module @dsh-onto/core/features
 */
import type {
  FeatureOverride,
  FeatureRecipe,
  FeatureSourceRecord,
  OntologyPackage,
  RuntimeBehaviorInstance,
  RuntimeCandidate,
  RuntimeDataset,
  RuntimeRelationInstance,
} from './types.js'

export type { FeatureOverride, FeatureRecipe, FeatureSourceRecord }

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
 * 按 featureSources 声明把对象 attrs 投影进候选 features。
 * 事实优先（可信取数 T1.1）：属性是特征的定义来源，调用方同名预置值一律被
 * 对象事实覆盖并记入 `overrides`——调用方不得经由预置特征改写业务判断。
 * 类型不匹配 / 属性缺失 / 非 number|string 值 → 不写入（预置值保留但无事实依据）；
 * `projected[].keys` 只记成功写入的键（缺口 = 声明集 − keys，供上层转 pendingChecks）。
 * `sources`（R5）：逐候选逐键记录来源状态——声明源缺失的预置值记 `unverified-caller`，
 * 不得伪装为可复算事实。
 */
export function projectFeatures(
  pkg: OntologyPackage,
  dataset: RuntimeDataset,
  candidates: RuntimeCandidate[],
): {
  candidates: RuntimeCandidate[]
  projected: Array<{ candidateId: string; keys: string[] }>
  overrides: FeatureOverride[]
  sources: FeatureSourceRecord[]
} {
  const sources = collectFeatureSources(pkg)
  const objectsById = new Map(dataset.objects.map((o) => [o.id, o]))
  const out: RuntimeCandidate[] = []
  const projected: Array<{ candidateId: string; keys: string[] }> = []
  const overrides: FeatureOverride[] = []
  const sourceRecords: FeatureSourceRecord[] = []
  const trusted = dataset.provenance === 'connector'
  for (const cand of candidates) {
    const keys: string[] = []
    const obj = objectsById.get(cand.objectRef)
    if (obj !== undefined && sources.size > 0) {
      let features: Record<string, number | string> | undefined
      for (const [feat, targets] of sources) {
        if (!targets.has(obj.type)) {
          // 声明目标类型不覆盖本候选对象 → 预置值无事实依据（类型不匹配同缺源）
          if (cand.features[feat] !== undefined) {
            sourceRecords.push({
              candidateId: cand.candidateId,
              key: feat,
              source: 'unverified-caller',
              declared: true,
              detail: `声明源 ${[...targets].join('/')} 与对象类型 ${obj.type} 不匹配`,
            })
          }
          continue
        }
        const v = obj.attrs?.[feat]
        if (typeof v !== 'number' && typeof v !== 'string') {
          if (cand.features[feat] !== undefined) {
            sourceRecords.push({
              candidateId: cand.candidateId,
              key: feat,
              source: 'unverified-caller',
              declared: true,
              detail: `声明源缺失（${[...targets].join('/')} 无可用属性 ${feat}），保留调用方值`,
            })
          }
          continue
        }
        const prior = cand.features[feat]
        if (prior !== undefined && prior !== v) {
          overrides.push({ candidateId: cand.candidateId, key: feat, caller: prior, fact: v })
        }
        features ??= { ...cand.features }
        features[feat] = v
        keys.push(feat)
        sourceRecords.push({
          candidateId: cand.candidateId,
          key: feat,
          source: trusted ? 'connector' : 'object-fact',
          declared: true,
          detail: `对象投影 ${[...targets].join('/')}.${feat}`,
        })
      }
      out.push(features === undefined ? cand : { ...cand, features })
    } else {
      out.push(cand)
    }
    // 来源未声明的调用方值（旧输入面）：留痕但不构成伪装
    const declaredKeys = new Set([...sources.keys()])
    for (const key of Object.keys(cand.features)) {
      if (declaredKeys.has(key)) continue
      sourceRecords.push({
        candidateId: cand.candidateId,
        key,
        source: 'unverified-caller',
        declared: false,
        detail: '来源未声明（未启用 featureSources 投影契约的外部输入）',
      })
    }
    projected.push({ candidateId: cand.candidateId, keys })
  }
  return { candidates: out, projected, overrides, sources: sourceRecords }
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
): number | typeof SKIP {
  if (recipe.source !== 'behaviors' && recipe.source !== 'relations') return SKIP
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
  } else {
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
 * 派生写入以配方计算值为准（配方即显式意图）；覆盖同名预置值时记入 `overrides`
 * （可信取数 T1.1：与 projectFeatures 同一事实优先口径）。
 * `now` 必须由配方注入：同输入两次运行逐字节一致（验收 3 / A-7）。
 * `sources`（R5）：记录实际输入与计算条件——ratio 的 num/den 上游未核实时
 * 状态沿依赖链传播为 `unverified-caller`；上游缺失（SKIP）而保留调用方值时同样显式降级。
 * `prior`：先前来源记录（投影/前序配方），供 ratio 依赖链判定。
 */
export function deriveFeatures(
  candidates: RuntimeCandidate[],
  dataset: RuntimeDataset,
  recipes: FeatureRecipe[],
  prior: FeatureSourceRecord[] = [],
): { candidates: RuntimeCandidate[]; derived: string[]; overrides: FeatureOverride[]; sources: FeatureSourceRecord[] } {
  const objectsById = new Map(dataset.objects.map((o) => [o.id, o]))
  let list = candidates
  const derived: string[] = []
  const overrides: FeatureOverride[] = []
  const sourceRecords: FeatureSourceRecord[] = []
  const pushed = new Set<string>()
  const trusted = dataset.provenance === 'connector'
  // 依赖链状态：candidateId|key → 来源状态（先前记录 + 本轮写入）
  const status = new Map<string, FeatureSourceRecord>()
  for (const r of prior) status.set(`${r.candidateId}|${r.key}`, r)
  for (const recipe of recipes) {
    if (typeof recipe.name !== 'string' || recipe.name === '') continue
    let wrote = false
    list = list.map((cand) => {
      let value: number | typeof SKIP
      if (recipe.kind === 'since') value = computeSince(recipe, cand, objectsById)
      else if (recipe.kind === 'count') value = computeCount(recipe, cand, dataset)
      else if (recipe.kind === 'ratio') value = computeRatio(recipe, cand)
      else value = SKIP
      if (value === SKIP) {
        // 上游缺失 → 不写入；若调用方预置了同名值，不得伪装为派生事实
        if (cand.features[recipe.name] !== undefined) {
          const rec: FeatureSourceRecord = {
            candidateId: cand.candidateId,
            key: recipe.name,
            source: 'unverified-caller',
            declared: true,
            detail: `配方 ${recipe.name}(${recipe.kind}) 缺输入未写入，保留调用方值`,
          }
          sourceRecords.push(rec)
          status.set(`${cand.candidateId}|${recipe.name}`, rec)
        }
        return cand
      }
      wrote = true
      const priorVal = cand.features[recipe.name]
      if (priorVal !== undefined && priorVal !== value) {
        overrides.push({ candidateId: cand.candidateId, key: recipe.name, caller: priorVal, fact: value })
      }
      // 来源状态：ratio 沿依赖链传播；since/count 看数据供数身份
      let rec: FeatureSourceRecord
      if (recipe.kind === 'ratio') {
        const numRec = status.get(`${cand.candidateId}|${String(recipe.num)}`)
        const denRec = status.get(`${cand.candidateId}|${String(recipe.den)}`)
        const upstreamUnverified =
          numRec?.source === 'unverified-caller' || denRec?.source === 'unverified-caller'
        rec = {
          candidateId: cand.candidateId,
          key: recipe.name,
          source: upstreamUnverified ? 'unverified-caller' : 'derived',
          declared: true,
          detail:
            `ratio(num=${String(recipe.num)},den=${String(recipe.den)})`
            + (upstreamUnverified ? ' 上游未核实' : ''),
        }
      } else {
        rec = {
          candidateId: cand.candidateId,
          key: recipe.name,
          source: trusted ? 'connector' : 'derived',
          declared: true,
          detail:
            recipe.kind === 'since'
              ? `since(attr=${String(recipe.attr)},now=${String(recipe.now)})`
              : `count(source=${String(recipe.source)}${recipe.filter?.type !== undefined ? `,type=${recipe.filter.type}` : ''})`,
        }
      }
      sourceRecords.push(rec)
      status.set(`${cand.candidateId}|${recipe.name}`, rec)
      return { ...cand, features: { ...cand.features, [recipe.name]: value } }
    })
    if (wrote && !pushed.has(recipe.name)) {
      pushed.add(recipe.name)
      derived.push(recipe.name)
    }
  }
  return { candidates: list, derived, overrides, sources: sourceRecords }
}

/**
 * 特征来源推断（R5，prep 未启用投影/派生时的入口口径）：
 * 对照 featureSources 声明与对象事实、配方名，逐候选逐键推断来源状态——
 * 声明源缺失的预置值不得伪装为可复算事实；来源未声明的旧输入面只留痕。
 */
export function inferFeatureSources(
  pkg: OntologyPackage,
  dataset: RuntimeDataset,
  candidates: RuntimeCandidate[],
): FeatureSourceRecord[] {
  const declared = collectFeatureSources(pkg)
  const recipeNames = new Set(
    (Array.isArray(pkg.featureRecipes) ? pkg.featureRecipes : []).map((r) => r.name),
  )
  const objectsById = new Map(dataset.objects.map((o) => [o.id, o]))
  const trusted = dataset.provenance === 'connector'
  const out: FeatureSourceRecord[] = []
  for (const cand of candidates) {
    const obj = objectsById.get(cand.objectRef)
    for (const [key, value] of Object.entries(cand.features)) {
      const targets = declared.get(key)
      if (targets !== undefined) {
        const fact = obj !== undefined && targets.has(obj.type) ? obj.attrs?.[key] : undefined
        if (typeof fact === 'number' || typeof fact === 'string') {
          if (fact === value) {
            out.push({
              candidateId: cand.candidateId,
              key,
              source: trusted ? 'connector' : 'object-fact',
              declared: true,
              detail: `对象投影 ${[...targets].join('/')}.${key}`,
            })
            continue
          }
          // 值与对象事实不符：可复算性成立（审计另按篡改口径报不符）
          out.push({
            candidateId: cand.candidateId,
            key,
            source: trusted ? 'connector' : 'object-fact',
            declared: true,
            detail: `对象投影 ${[...targets].join('/')}.${key}（值与事实不符，审计报篡改）`,
          })
          continue
        }
        out.push({
          candidateId: cand.candidateId,
          key,
          source: 'unverified-caller',
          declared: true,
          detail: `声明源缺失（${[...targets].join('/')} 无可用属性 ${key}），保留调用方值`,
        })
        continue
      }
      if (recipeNames.has(key)) {
        out.push({
          candidateId: cand.candidateId,
          key,
          source: 'unverified-caller',
          declared: true,
          detail: `配方 ${key} 未执行（prep 未启用），调用方值不得视为派生事实`,
        })
        continue
      }
      out.push({
        candidateId: cand.candidateId,
        key,
        source: 'unverified-caller',
        declared: false,
        detail: '来源未声明（未启用 featureSources 投影契约的外部输入）',
      })
    }
  }
  return out
}
