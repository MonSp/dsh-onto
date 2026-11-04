/**
 * 业务本体包的文件系统存储与签发状态机（规范 §3.4 / §6）。
 *
 * 工作区布局：
 *   <workspace>/packages/<name>/<version>/
 *     package.yaml
 *     o1-objects/{object-types.yaml,relation-types.yaml,dictionaries/*.yaml}
 *     o2-behavior-rules/{behavior-types.yaml,rules/*.yaml,skill-templates/*.yaml}
 *     o3-scenarios/*.yaml
 *     bindings/{field-maps.yaml,api-sources.yaml}
 *     derived/**            派生物（只读、可再生成）
 *     quality-report.json
 *
 * 状态机：DRAFT → IN_REVIEW → ISSUED。ISSUED 后源文件只读；
 * 要改须 fork 出新版本。签发端点仅人工调用（issuedBy 必填且不得为 agent/llm）。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type {
  O1ApiSource,
  O1Dictionary,
  O1FieldMap,
  O1ObjectType,
  O1RelationType,
  O2BehaviorType,
  O2ExclusionRule,
  O2ScoreRule,
  O2SkillTemplate,
  OntologyPackage,
  PackageMeta,
  PackageStatus,
} from './types.js'
import { dumpYaml, loadYaml } from './yamlio.js'

export class PackageStoreError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'PackageStoreError'
    this.code = code
  }
}

/** dir 必须严格落在 root 内（相对 root 有余段且首段非 `..`）；防 name/version 目录穿越。 */
function isInsideDir(root: string, dir: string): boolean {
  const rel = relative(resolve(root), resolve(dir))
  if (rel === '' || isAbsolute(rel)) return false
  return rel.split(/[\\/]/)[0] !== '..'
}

/** 源文件清单（派生 manifest 要登记指纹的全部源）。 */
export const SOURCE_FILE_LAYOUT = {
  meta: 'package.yaml',
  objectTypes: 'o1-objects/object-types.yaml',
  relationTypes: 'o1-objects/relation-types.yaml',
  dictionariesDir: 'o1-objects/dictionaries',
  behaviorTypes: 'o2-behavior-rules/behavior-types.yaml',
  scoreRules: 'o2-behavior-rules/rules/score-rules.yaml',
  exclusionRules: 'o2-behavior-rules/rules/exclusion-rules.yaml',
  skillTemplatesDir: 'o2-behavior-rules/skill-templates',
  scenariosDir: 'o3-scenarios',
  fieldMaps: 'bindings/field-maps.yaml',
  apiSources: 'bindings/api-sources.yaml',
} as const

export const DERIVED_DIR = 'derived'
export const QUALITY_REPORT_FILE = 'quality-report.json'

/* ═══════════════════════════════════════════════════════════════════════════
 * 低层读写
 * ═══════════════════════════════════════════════════════════════════════════ */

function readYamlFile<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback
  const text = readFileSync(path, 'utf8')
  const doc = loadYaml(text)
  if (doc === null || doc === undefined) return fallback
  return doc as T
}

function writeYamlFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, dumpYaml(value), 'utf8')
}

function listYamlFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort()
    .map((f) => join(dir, f))
}

/** 收集包版本目录下全部源文件的相对路径（排序稳定）。 */
export function listSourceFiles(versionDir: string): string[] {
  const rel: string[] = []
  const push = (p: string): void => {
    const full = join(versionDir, p)
    if (existsSync(full) && statSync(full).isFile()) rel.push(p)
  }
  push(SOURCE_FILE_LAYOUT.meta)
  push(SOURCE_FILE_LAYOUT.objectTypes)
  push(SOURCE_FILE_LAYOUT.relationTypes)
  for (const f of listYamlFiles(join(versionDir, SOURCE_FILE_LAYOUT.dictionariesDir))) {
    rel.push(`${SOURCE_FILE_LAYOUT.dictionariesDir}/${f.split(/[\\/]/).pop()}`)
  }
  push(SOURCE_FILE_LAYOUT.behaviorTypes)
  push(SOURCE_FILE_LAYOUT.scoreRules)
  push(SOURCE_FILE_LAYOUT.exclusionRules)
  for (const f of listYamlFiles(join(versionDir, SOURCE_FILE_LAYOUT.skillTemplatesDir))) {
    rel.push(`${SOURCE_FILE_LAYOUT.skillTemplatesDir}/${f.split(/[\\/]/).pop()}`)
  }
  for (const f of listYamlFiles(join(versionDir, SOURCE_FILE_LAYOUT.scenariosDir))) {
    const base = f.split(/[\\/]/).pop() as string
    rel.push(`${SOURCE_FILE_LAYOUT.scenariosDir}/${base}`)
  }
  push(SOURCE_FILE_LAYOUT.fieldMaps)
  push(SOURCE_FILE_LAYOUT.apiSources)
  return rel
}

/** 读取单个源文件文本（相对版本目录）。 */
export function readSourceFile(versionDir: string, relPath: string): string {
  return readFileSync(join(versionDir, relPath), 'utf8')
}

/** 写入单个源文件（带签发守卫）。 */
export function writeSourceFile(versionDir: string, relPath: string, text: string): void {
  assertWritable(versionDir)
  const full = join(versionDir, relPath)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, text, 'utf8')
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 签发状态机守卫
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 读取包元数据（不加载全量模型）。 */
export function readPackageMeta(versionDir: string): PackageMeta {
  const doc = readYamlFile<Partial<PackageMeta>>(join(versionDir, SOURCE_FILE_LAYOUT.meta), {})
  if (!doc.name || !doc.version) {
    throw new PackageStoreError('PACKAGE_MALFORMED', `missing package.yaml meta in ${versionDir}`)
  }
  return {
    kind: 'BusinessOntologyPackage',
    name: doc.name,
    version: doc.version,
    domain: doc.domain ?? '',
    metaFrameworkVersion: doc.metaFrameworkVersion ?? '1.0',
    status: (doc.status as PackageStatus) ?? 'DRAFT',
    issueRecord: Array.isArray(doc.issueRecord) ? doc.issueRecord : [],
    externalRefs: Array.isArray(doc.externalRefs) ? doc.externalRefs : [],
  }
}

/** ISSUED 包只读守卫：任何源写入前调用。包尚不存在时视为可写（新建路径）。 */
export function assertWritable(versionDir: string): void {
  if (!existsSync(join(versionDir, SOURCE_FILE_LAYOUT.meta))) return
  const meta = readPackageMeta(versionDir)
  if (meta.status === 'ISSUED') {
    throw new PackageStoreError(
      'PACKAGE_READONLY',
      `package ${meta.name}@${meta.version} is ISSUED (read-only); fork a new version to edit`,
    )
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 包加载 / 保存
 * ═══════════════════════════════════════════════════════════════════════════ */

interface ObjectTypesDoc {
  objects?: O1ObjectType[]
}
interface RelationTypesDoc {
  relations?: O1RelationType[]
}
interface BehaviorsDoc {
  behaviors?: O2BehaviorType[]
}
interface ScoreRulesDoc {
  rules?: O2ScoreRule[]
}
interface ExclusionRulesDoc {
  rules?: O2ExclusionRule[]
}
interface SkillTemplatesDoc {
  templates?: O2SkillTemplate[]
  template?: O2SkillTemplate
}
interface ScenariosDoc {
  scenario?: unknown
}

/**
 * 场景卡键名归一：规范 §6.3 的 `output_contract`/`review_gate` 与
 * 内存模型的 `outputContract`/`reviewGate` 双向兼容。
 */
function normalizeScenario(raw: Record<string, unknown>): OntologyPackage['scenarios'][number] {
  const outputContract = (raw['outputContract'] ?? raw['output_contract'] ?? {
    mustInclude: [],
    forbiddenPhrases: [],
  }) as OntologyPackage['scenarios'][number]['outputContract']
  const reviewGate = (raw['reviewGate'] ?? raw['review_gate'] ?? {
    required: true,
    threshold: 0.75,
  }) as OntologyPackage['scenarios'][number]['reviewGate']
  return {
    id: String(raw['id'] ?? ''),
    name: String(raw['name'] ?? ''),
    goal: String(raw['goal'] ?? ''),
    boundary: String(raw['boundary'] ?? ''),
    inputs: (raw['inputs'] as OntologyPackage['scenarios'][number]['inputs']) ?? [],
    outputs: (raw['outputs'] as OntologyPackage['scenarios'][number]['outputs']) ?? { fields: [] },
    pipeline: (raw['pipeline'] as OntologyPackage['scenarios'][number]['pipeline']) ?? [],
    outputContract,
    reviewGate,
    auditChecks: (raw['auditChecks'] as string[]) ?? [],
  }
}

/** 场景卡落盘形态（规范 §6.3：output_contract / review_gate 用 snake_case）。 */
function scenarioToYaml(s: OntologyPackage['scenarios'][number]): Record<string, unknown> {
  return {
    id: s.id,
    name: s.name,
    goal: s.goal,
    boundary: s.boundary,
    inputs: s.inputs,
    outputs: s.outputs,
    pipeline: s.pipeline,
    output_contract: s.outputContract,
    review_gate: s.reviewGate,
    auditChecks: s.auditChecks,
  }
}
interface FieldMapsDoc {
  maps?: O1FieldMap[]
}
interface ApiSourcesDoc {
  sources?: O1ApiSource[]
}

/** 加载一个包版本目录为内存模型。 */
export function loadPackage(versionDir: string): OntologyPackage {
  const meta = readPackageMeta(versionDir)
  const objects = readYamlFile<ObjectTypesDoc>(join(versionDir, SOURCE_FILE_LAYOUT.objectTypes), {})
    .objects ?? []
  const relations = readYamlFile<RelationTypesDoc>(
    join(versionDir, SOURCE_FILE_LAYOUT.relationTypes),
    {},
  ).relations ?? []
  const dictionaries: O1Dictionary[] = []
  for (const f of listYamlFiles(join(versionDir, SOURCE_FILE_LAYOUT.dictionariesDir))) {
    const doc = readYamlFile<Partial<O1Dictionary>>(f, {})
    if (doc.id) dictionaries.push(doc as O1Dictionary)
  }
  const behaviors = readYamlFile<BehaviorsDoc>(join(versionDir, SOURCE_FILE_LAYOUT.behaviorTypes), {})
    .behaviors ?? []
  const scoreRules = readYamlFile<ScoreRulesDoc>(join(versionDir, SOURCE_FILE_LAYOUT.scoreRules), {})
    .rules ?? []
  const exclusionRules = readYamlFile<ExclusionRulesDoc>(
    join(versionDir, SOURCE_FILE_LAYOUT.exclusionRules),
    {},
  ).rules ?? []
  const skillTemplates: O2SkillTemplate[] = []
  for (const f of listYamlFiles(join(versionDir, SOURCE_FILE_LAYOUT.skillTemplatesDir))) {
    const doc = readYamlFile<SkillTemplatesDoc>(f, {})
    if (doc.template) skillTemplates.push(doc.template)
    if (Array.isArray(doc.templates)) skillTemplates.push(...doc.templates)
  }
  const scenarios = []
  for (const f of listYamlFiles(join(versionDir, SOURCE_FILE_LAYOUT.scenariosDir))) {
    const doc = readYamlFile<Record<string, unknown>>(f, {})
    const raw = doc['scenario']
    if (raw) scenarios.push(normalizeScenario(raw as Record<string, unknown>))
  }
  const fieldMaps = readYamlFile<FieldMapsDoc>(join(versionDir, SOURCE_FILE_LAYOUT.fieldMaps), {})
    .maps ?? []
  const apiSources = readYamlFile<ApiSourcesDoc>(join(versionDir, SOURCE_FILE_LAYOUT.apiSources), {})
    .sources ?? []

  return {
    meta,
    objects,
    relations,
    dictionaries,
    behaviors,
    scoreRules,
    exclusionRules,
    skillTemplates,
    scenarios,
    fieldMaps,
    apiSources,
  }
}

/** 将内存模型写回包版本目录（全量覆写源文件；ISSUED 拒绝）。 */
export function savePackage(versionDir: string, pkg: OntologyPackage): void {
  assertWritable(versionDir)
  writeYamlFile(join(versionDir, SOURCE_FILE_LAYOUT.meta), pkg.meta)
  writeYamlFile(join(versionDir, SOURCE_FILE_LAYOUT.objectTypes), {
    kind: 'O1ObjectTypes',
    objects: pkg.objects,
  })
  writeYamlFile(join(versionDir, SOURCE_FILE_LAYOUT.relationTypes), {
    kind: 'O1RelationTypes',
    relations: pkg.relations,
  })
  const dictDir = join(versionDir, SOURCE_FILE_LAYOUT.dictionariesDir)
  rmSync(dictDir, { recursive: true, force: true })
  for (const d of pkg.dictionaries) {
    writeYamlFile(join(dictDir, `${d.id}.yaml`), { kind: 'O1Dictionary', ...d })
  }
  writeYamlFile(join(versionDir, SOURCE_FILE_LAYOUT.behaviorTypes), {
    kind: 'O2BehaviorTypes',
    behaviors: pkg.behaviors,
  })
  writeYamlFile(join(versionDir, SOURCE_FILE_LAYOUT.scoreRules), {
    kind: 'O2ScoreRules',
    rules: pkg.scoreRules,
  })
  writeYamlFile(join(versionDir, SOURCE_FILE_LAYOUT.exclusionRules), {
    kind: 'O2ExclusionRules',
    rules: pkg.exclusionRules,
  })
  const sklDir = join(versionDir, SOURCE_FILE_LAYOUT.skillTemplatesDir)
  rmSync(sklDir, { recursive: true, force: true })
  for (const s of pkg.skillTemplates) {
    writeYamlFile(join(sklDir, `${s.id}.yaml`), { kind: 'O2SkillTemplate', template: s })
  }
  const scnDir = join(versionDir, SOURCE_FILE_LAYOUT.scenariosDir)
  rmSync(scnDir, { recursive: true, force: true })
  for (const sc of pkg.scenarios) {
    writeYamlFile(join(scnDir, `${sc.id}.yaml`), { kind: 'O3ScenarioCard', scenario: scenarioToYaml(sc) })
  }
  writeYamlFile(join(versionDir, SOURCE_FILE_LAYOUT.fieldMaps), {
    kind: 'O1FieldMaps',
    maps: pkg.fieldMaps,
  })
  writeYamlFile(join(versionDir, SOURCE_FILE_LAYOUT.apiSources), {
    kind: 'O1ApiSources',
    sources: pkg.apiSources,
  })
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 工作区操作：创建 / fork / 签发 / 导入导出
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 工作区根（含 packages/ 子目录）。 */
export class PackageWorkspace {
  readonly root: string

  constructor(root: string) {
    this.root = resolve(root)
    mkdirSync(this.packagesDir, { recursive: true })
  }

  get packagesDir(): string {
    return join(this.root, 'packages')
  }

  /**
   * 解析包版本目录。优先 `packages/<name>/<version>`；
   * 若目录键与 meta.name 不一致（如按域命名的目录），按 meta.name 扫描回退。
   * name/version 归一后必须落在 packagesDir 内——含 `..` 段的穿越输入 fail-loud。
   */
  versionDir(name: string, version: string): string {
    const direct = join(this.packagesDir, name, version)
    if (!isInsideDir(this.packagesDir, direct)) {
      throw new PackageStoreError('PACKAGE_MALFORMED', `invalid package path: ${name}@${version}`)
    }
    if (existsSync(join(direct, SOURCE_FILE_LAYOUT.meta))) return direct
    for (const v of this.listVersions()) {
      if (v.name === name && v.version === version) return v.dir
    }
    return direct
  }

  /** 列出全部包版本（name + version + status）。 */
  listVersions(): Array<{ name: string; version: string; status: PackageStatus; domain: string; dir: string }> {
    const out: Array<{ name: string; version: string; status: PackageStatus; domain: string; dir: string }> = []
    if (!existsSync(this.packagesDir)) return out
    for (const name of readdirSync(this.packagesDir).sort()) {
      const nameDir = join(this.packagesDir, name)
      if (!statSync(nameDir).isDirectory()) continue
      for (const version of readdirSync(nameDir).sort()) {
        const dir = join(nameDir, version)
        if (!statSync(dir).isDirectory()) continue
        if (!existsSync(join(dir, SOURCE_FILE_LAYOUT.meta))) continue
        try {
          const meta = readPackageMeta(dir)
          out.push({ name: meta.name, version: meta.version, status: meta.status, domain: meta.domain, dir })
        } catch {
          /* skip malformed */
        }
      }
    }
    return out
  }

  /** 创建新包（首个版本，状态 DRAFT）。 */
  createPackage(meta: {
    name: string
    version: string
    domain: string
    metaFrameworkVersion?: string
  }): string {
    const dir = this.versionDir(meta.name, meta.version)
    if (existsSync(join(dir, SOURCE_FILE_LAYOUT.meta))) {
      throw new PackageStoreError('PACKAGE_EXISTS', `${meta.name}@${meta.version} already exists`)
    }
    mkdirSync(dir, { recursive: true })
    const full: PackageMeta = {
      kind: 'BusinessOntologyPackage',
      name: meta.name,
      version: meta.version,
      domain: meta.domain,
      metaFrameworkVersion: meta.metaFrameworkVersion ?? '1.0',
      status: 'DRAFT',
      issueRecord: [],
      externalRefs: [],
    }
    const pkg: OntologyPackage = {
      meta: full,
      objects: [],
      relations: [],
      dictionaries: [],
      behaviors: [],
      scoreRules: [],
      exclusionRules: [],
      skillTemplates: [],
      scenarios: [],
      fieldMaps: [],
      apiSources: [],
    }
    savePackage(dir, pkg)
    return dir
  }

  /**
   * fork 出新版本：复制整棵源树到新版本目录，状态回到 DRAFT。
   * 已签发版本保持只读。
   */
  forkVersion(
    name: string,
    fromVersion: string,
    toVersion: string,
  ): string {
    const src = this.versionDir(name, fromVersion)
    if (!existsSync(join(src, SOURCE_FILE_LAYOUT.meta))) {
      throw new PackageStoreError('PACKAGE_NOT_FOUND', `${name}@${fromVersion} not found`)
    }
    const dst = this.versionDir(name, toVersion)
    if (existsSync(join(dst, SOURCE_FILE_LAYOUT.meta))) {
      throw new PackageStoreError('PACKAGE_EXISTS', `${name}@${toVersion} already exists`)
    }
    copyDir(src, dst)
    // 新版本：状态 DRAFT、版本号更新；issueRecord 保留历史沿革。
    const meta = readPackageMeta(dst)
    meta.version = toVersion
    meta.status = 'DRAFT'
    writeYamlFile(join(dst, SOURCE_FILE_LAYOUT.meta), meta)
    return dst
  }

  /** 状态迁移：DRAFT → IN_REVIEW → ISSUED。 */
  transition(name: string, version: string, to: PackageStatus, issuedBy?: string, note?: string): void {
    const dir = this.versionDir(name, version)
    const meta = readPackageMeta(dir)
    const order: PackageStatus[] = ['DRAFT', 'IN_REVIEW', 'ISSUED']
    const fromIdx = order.indexOf(meta.status)
    const toIdx = order.indexOf(to)
    if (fromIdx < 0 || toIdx < 0) {
      throw new PackageStoreError('PACKAGE_BAD_STATUS', `unknown status target ${to}`)
    }
    if (toIdx <= fromIdx) {
      throw new PackageStoreError(
        'PACKAGE_BAD_TRANSITION',
        `cannot transition ${meta.status} → ${to} (state machine is DRAFT → IN_REVIEW → ISSUED)`,
      )
    }
    if (toIdx - fromIdx > 1) {
      throw new PackageStoreError(
        'PACKAGE_BAD_TRANSITION',
        `cannot skip states: ${meta.status} → ${to}`,
      )
    }
    meta.status = to
    if (to === 'ISSUED') {
      // 签发 = 人审通过：issuedBy 必须是人工身份（§3.4）。
      if (!issuedBy || !issuedBy.trim()) {
        throw new PackageStoreError('PACKAGE_ISSUE_REQUIRES_HUMAN', 'issue requires issuedBy (human)')
      }
      if (/^(agent|llm|ai|bot|system)$/i.test(issuedBy.trim())) {
        throw new PackageStoreError(
          'PACKAGE_ISSUE_REQUIRES_HUMAN',
          'agent/LLM may not call the issue endpoint (§3.4)',
        )
      }
      meta.issueRecord.push({
        version,
        issuedAt: new Date().toISOString(),
        issuedBy: issuedBy.trim(),
        note,
      })
    }
    writeYamlFile(join(dir, SOURCE_FILE_LAYOUT.meta), meta)
  }

  /** 导出为单文件 JSON 归档（全部源文件 + 元数据）。 */
  exportVersion(name: string, version: string): {
    format: 'dsh-onto-package/1'
    meta: PackageMeta
    files: Record<string, string>
  } {
    const dir = this.versionDir(name, version)
    if (!existsSync(join(dir, SOURCE_FILE_LAYOUT.meta))) {
      throw new PackageStoreError('PACKAGE_NOT_FOUND', `${name}@${version} not found`)
    }
    const files: Record<string, string> = {}
    for (const rel of listSourceFiles(dir)) {
      files[rel] = readSourceFile(dir, rel)
    }
    return { format: 'dsh-onto-package/1', meta: readPackageMeta(dir), files }
  }

  /** 从 JSON 归档导入（同名同版本已存在则拒绝，保持幂等）。 */
  importVersion(archive: { meta: PackageMeta; files: Record<string, string> }): string {
    const { name, version } = archive.meta
    const dir = this.versionDir(name, version)
    if (existsSync(join(dir, SOURCE_FILE_LAYOUT.meta))) {
      throw new PackageStoreError('PACKAGE_EXISTS', `${name}@${version} already exists`)
    }
    mkdirSync(dir, { recursive: true })
    for (const [rel, text] of Object.entries(archive.files)) {
      const full = join(dir, rel)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, text, 'utf8')
    }
    return dir
  }
}

function copyDir(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.name === 'derived' || entry.name === QUALITY_REPORT_FILE) continue
    const from = join(src, entry.name)
    const to = join(dst, entry.name)
    if (entry.isDirectory()) copyDir(from, to)
    else writeFileSync(to, readFileSync(from))
  }
}
