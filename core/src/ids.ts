/**
 * ID 命名与属性引用语法（规范 §3.3）。
 *
 * `<TYPE>-<PKG_TAG>-<NAME>`  例：OBJ-AML-ACCOUNT、RULE-AML-SCORE-FANOUT
 * `dict-<slug>`              例：dict-txn-type
 * 属性引用：`<OBJ|REL ID>.<attrName>`
 */

export const ID_TYPES = [
  'PKG',
  'OBJ',
  'REL',
  'BHV',
  'RULE',
  'SKL',
  'SCN',
  'TOOL',
  'FM',
  'SRC',
  'AGT',
  'AUD',
] as const

export type IdType = (typeof ID_TYPES)[number]

/** 允许未被引用的派生端点前缀（§7.1 warn 豁免）。 */
export const UNREFERENCED_EXEMPT_PREFIXES = ['AGT-', 'AUD-', 'TOOL-'] as const

const ID_PATTERN = /^[A-Z]+-[A-Z0-9]+(?:-[A-Z0-9]+)*$/
const DICT_PATTERN = /^dict-[a-z0-9]+(?:-[a-z0-9]+)*$/
const ATTR_REF_PATTERN = /^([A-Z]+-[A-Z0-9]+(?:-[A-Z0-9]+)*)\.([A-Za-z_][A-Za-z0-9_]*)$/
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * 判断字符串是否是本体 ID（`TYPE-TAG-NAME` 或 `dict-<slug>`）。
 */
export function isCaliberId(value: string): boolean {
  return ID_PATTERN.test(value) || DICT_PATTERN.test(value)
}

/**
 * 判断字符串是否是合法的字典 ID。
 */
export function isDictId(value: string): boolean {
  return DICT_PATTERN.test(value)
}

/**
 * 校验 `<TYPE>-<PKG_TAG>-<NAME>` 语法；返回解析出的类型前缀，非法返回 null。
 */
export function parseIdType(value: string): IdType | null {
  if (!ID_PATTERN.test(value)) return null
  const prefix = value.split('-')[0]
  return (ID_TYPES as readonly string[]).includes(prefix) ? (prefix as IdType) : null
}

/**
 * 校验 ID 语法是否符合 §3.3（含类型前缀合法性）。
 */
export function isValidId(value: string): boolean {
  if (DICT_PATTERN.test(value)) return true
  return parseIdType(value) !== null
}

/**
 * 判断是否是合法 slug（包短名、字典名等）。
 */
export function isValidSlug(value: string): boolean {
  return SLUG_PATTERN.test(value)
}

export interface AttrRef {
  ownerId: string
  attrName: string
}

/**
 * 解析属性引用 `<OBJ|REL ID>.<attrName>`；非引用返回 null。
 */
export function parseAttrRef(value: string): AttrRef | null {
  const m = ATTR_REF_PATTERN.exec(value)
  if (!m) return null
  return { ownerId: m[1], attrName: m[2] }
}

/**
 * 从任意文本中提取所有形如 `<ID>.<attr>` 的属性引用。
 */
export function extractAttrRefs(text: string): AttrRef[] {
  const out: AttrRef[] = []
  const re = /[A-Z]+-[A-Z0-9]+(?:-[A-Z0-9]+)*\.[A-Za-z_][A-Za-z0-9_]*/g
  for (const m of text.matchAll(re)) {
    const ref = parseAttrRef(m[0])
    if (ref) out.push(ref)
  }
  return out
}

/**
 * 从任意文本中提取所有本体 ID 引用（不含属性引用的 owner 部分单独处理）。
 */
export function extractIdRefs(text: string): string[] {
  const out: string[] = []
  const re = /\b(?:[A-Z]+-[A-Z0-9]+(?:-[A-Z0-9]+)*|dict-[a-z0-9]+(?:-[a-z0-9]+)*)\b/g
  for (const m of text.matchAll(re)) {
    if (isValidId(m[0])) out.push(m[0])
  }
  return out
}

/** 生成候选记录 ID（知识库运行时用；非 Schema ID）。 */
export function draftCandidateId(seed: string): string {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return `dc-${(h >>> 0).toString(16).padStart(8, '0')}`
}

/** 生成知识原料记录 ID。 */
export function knowledgeSourceId(seed: string): string {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return `ks-${(h >>> 0).toString(16).padStart(8, '0')}`
}
