/**
 * 图谱与能力面（conversational-modeling P4）：wire 与 agent 工具共用的数据组装。
 *
 * - 不依赖 services（防模块环）；不写包。
 * - DRAFT 即可用：建模发生在 O 层，L 层执行才过派生门禁（loadToolPackage）。
 * - issues 经 buildModelGraph 归一（元素级定位 / 包级 'package'，I3）。
 * @module @dsh-onto/backend/model-face
 */
import { statSync } from 'node:fs'
import { join } from 'node:path'
import {
  KnowledgeStore,
  PackageWorkspace,
  buildModelGraph,
  listSourceFiles,
  loadPackage,
  readManifest,
  validatePackage,
  type DerivedManifest,
  type ModelGraph,
  type OntologyPackage,
} from '@dsh-onto/core'

/** 画布修订号：草案队列 + 包源文件的最新 mtime（毫秒），刷新信号用。 */
export function graphRevision(knowledgeRoot: string, versionDir: string): number {
  let rev = 0
  const bump = (p: string): void => {
    try {
      rev = Math.max(rev, statSync(p).mtimeMs)
    } catch {
      /* 缺省文件跳过 */
    }
  }
  bump(join(knowledgeRoot, 'queue.json'))
  for (const rel of listSourceFiles(versionDir)) bump(join(versionDir, rel))
  return Math.round(rev)
}

/** 组装画布图谱：包元素 + 草案队列 + 校验 issues + 骨架状态（get_model_graph / ontoModel.getGraph 同源）。 */
export function buildGraphForTool(input: {
  ws: PackageWorkspace
  knowledge: KnowledgeStore
  name: string
  version: string
}): ModelGraph {
  const dir = input.ws.versionDir(input.name, input.version)
  const pkg: OntologyPackage = loadPackage(dir)
  const candidates = input.knowledge.listCandidates({ packageId: input.name })
  const skeleton = input.knowledge.skeletons.get(input.name)
  const { errors, warnings, info } = validatePackage(pkg, dir, { skeleton })
  const revision = graphRevision(input.knowledge.root, dir)
  return buildModelGraph({ pkg, candidates, issues: [...errors, ...warnings, ...info], skeleton, revision })
}

/**
 * L1–L5 能力清单（list_capabilities / 会话可发现「这个包能干什么」）。
 * 有 manifest 时按 layer 标注分组（P4）；无派生时 derived=false，仍给出 O 层可预览的能力面。
 */
export function buildCapabilities(pkg: OntologyPackage, manifest: DerivedManifest | null): Record<string, unknown> {
  const filesOf = (layer: 'L2' | 'L3' | 'L4'): string[] => [
    ...(manifest?.sources.filter((e) => e.layer === layer).map((e) => e.path) ?? []),
    ...(manifest?.derived.filter((e) => e.layer === layer).map((e) => e.path) ?? []),
  ]
  return {
    package: `${pkg.meta.name}@${pkg.meta.version}`,
    status: pkg.meta.status,
    derived: manifest !== null,
    L1: {
      name: '应用 · 入口',
      entries: pkg.scenarios.map((s) => ({
        scenarioId: s.id,
        name: s.name,
        inputs: s.inputs.map((i) => i.name),
      })),
    },
    L2: {
      name: '工具池 · 家伙',
      files: filesOf('L2'),
      apiSources: pkg.apiSources.map((s) => ({ id: s.id, name: s.name, sourceType: s.sourceType })),
      fieldMapCount: pkg.fieldMaps.length,
      // 对象/关系 → tool-contracts.tools 1:1（derive：object-read/relation-read 各一条）；
      // 未派生时为投影数，派生后即派生文件内的工具条目数。
      toolContractCount: pkg.objects.length + pkg.relations.length,
    },
    L3: {
      name: '技能 · 怎么组合用',
      skills: pkg.skillTemplates.map((s) => ({ id: s.id, name: s.name })),
      files: filesOf('L3'),
    },
    L4: {
      name: '专家 · 谁来干',
      experts: pkg.scenarios.map((s) => ({
        scenarioId: s.id,
        name: s.name,
        steps: s.pipeline.length,
        humanGate: s.pipeline.some((p) => p.stepType === 'HUMAN_REVIEW'),
      })),
      files: filesOf('L4'),
    },
    L5: {
      name: '助手 · 门面',
      note: 'dsh 会话 + workbench 门面（平台自身，不派生）',
    },
  }
}

/** 读取包的 L 层能力清单（含 manifest 读取；未派生返回 derived=false）。 */
export function capabilitiesFor(ws: PackageWorkspace, name: string, version: string): Record<string, unknown> {
  const dir = ws.versionDir(name, version)
  const pkg = loadPackage(dir)
  return buildCapabilities(pkg, readManifest(dir))
}
