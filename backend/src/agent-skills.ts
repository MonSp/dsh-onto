/**
 * SKL 方法论模板 → agent skill provider（S2.5）。
 *
 * 每个 O2SkillTemplate 暴露为一个 kebab-case skill；同一 SKL id 多版本并存时
 * 优先 ISSUED，再按版本号降序取一条。包写入路径经 agent-hooks 失效目录。
 * @module @dsh-onto/backend/agent-skills
 */
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {
  SkillCandidate,
  SkillDefinition,
  SkillLookupOptions,
  SkillProvider,
} from '@deepseek-ai/dsh-skill'
import {
  PackageWorkspace,
  loadPackage,
  type O2SkillTemplate,
  type OntologyPackage,
} from '@dsh-onto/core'
import { registerSkillInvalidator } from './agent-hooks.js'
import { resolveDataDir } from './services.js'

/** SKL id → skill 名（`SKL-AML-NARRATIVE` → `skl-aml-narrative`）。 */
export function skillNameFromId(sklId: string): string {
  return sklId.toLowerCase().replace(/[^a-z0-9-]+/g, '-')
}

/** 一个 SKL 模板的来源版本（用于跨版本去重）。 */
export interface SklSource {
  versionDir: string
  status: string
  version: string
  template: O2SkillTemplate
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((s) => Number.parseInt(s, 10) || 0)
  const pb = b.split('.').map((s) => Number.parseInt(s, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

function betterThan(a: SklSource, b: SklSource): boolean {
  const issuedA = a.status === 'ISSUED' ? 1 : 0
  const issuedB = b.status === 'ISSUED' ? 1 : 0
  if (issuedA !== issuedB) return issuedA > issuedB
  return compareVersions(a.version, b.version) > 0
}

/** 同 SKL id 去重：ISSUED 优先，再版本号降序。 */
export function pickSkillSources(sources: SklSource[]): Map<string, SklSource> {
  const best = new Map<string, SklSource>()
  for (const s of sources) {
    const cur = best.get(s.template.id)
    if (cur === undefined || betterThan(s, cur)) best.set(s.template.id, s)
  }
  return best
}

/** skill 正文：模板口径 + 红线声明。 */
export function renderSkillBody(
  template: O2SkillTemplate,
  meta: { name: string; version: string; domain: string },
): string {
  const lines: string[] = []
  lines.push(`# ${template.name}（${template.id}）`)
  lines.push('')
  lines.push(`来源包：${meta.name}@${meta.version}（${meta.domain}）`)
  if (template.description) {
    lines.push('')
    lines.push(template.description)
  }
  if (template.steps && template.steps.length > 0) {
    lines.push('')
    lines.push('## 步骤')
    template.steps.forEach((step, i) => {
      lines.push(`${i + 1}. ${step}`)
    })
  }
  const weights = Object.entries(template.weights)
  if (weights.length > 0) {
    lines.push('')
    lines.push('## 权重集合')
    for (const [ruleId, weight] of weights) {
      lines.push(`- ${ruleId}: ${weight}`)
    }
  }
  if (template.outputTemplate) {
    lines.push('')
    lines.push('## 输出模板')
    lines.push(template.outputTemplate)
  }
  lines.push('')
  lines.push('## 红线')
  lines.push('- 叙述只回填模板与证据，禁止认定性表述（认定/确定为/已构成…）。')
  lines.push('- 结论性表述只允许落场景卡 forbiddenPhrases 红线，不得进入输出契约。')
  lines.push('- 分数与规则命中由规则引擎产生；本模板只做叙述装配，配合 run_scenario 的 SKILL_RUN 步骤使用。')
  return lines.join('\n')
}

export const name = 'dsh-onto-agent-skills'
export const inject = ['skills']

export function apply(ctx: Context): void {
  const dataDir = resolveDataDir(ctx)
  const ws = new PackageWorkspace(join(dataDir, 'workspace'))

  const scan = (): Map<string, SklSource> => {
    const sources: SklSource[] = []
    for (const v of ws.listVersions()) {
      let pkg: OntologyPackage
      try {
        pkg = loadPackage(v.dir)
      } catch {
        continue
      }
      for (const template of pkg.skillTemplates) {
        sources.push({ versionDir: v.dir, status: v.status, version: v.version, template })
      }
    }
    return pickSkillSources(sources)
  }

  ctx.skills.registerProvider((control) => {
    const unregister = registerSkillInvalidator(control.invalidate)
    control.signal.addEventListener('abort', () => unregister(), { once: true })
    const provider: SkillProvider = {
      name: 'onto-skill-templates',
      async list(_options: SkillLookupOptions): Promise<SkillCandidate[]> {
        return [...scan().values()].map((s) => ({
          name: skillNameFromId(s.template.id),
          description: s.template.description ?? s.template.name,
          invocation: { modelInvocable: true, userInvocable: true },
          source: 'runtime',
          provider: 'onto-skill-templates',
          rank: 350,
          locator: { versionDir: s.versionDir, sklId: s.template.id },
        }))
      },
      async get(candidate: SkillCandidate): Promise<SkillDefinition | undefined> {
        const locator = candidate.locator as { versionDir: string; sklId: string }
        let pkg: OntologyPackage
        try {
          pkg = loadPackage(locator.versionDir)
        } catch {
          return undefined
        }
        const template = pkg.skillTemplates.find((t) => t.id === locator.sklId)
        if (template === undefined) return undefined
        return {
          name: candidate.name,
          description: template.description ?? template.name,
          invocation: { modelInvocable: true, userInvocable: true },
          source: 'runtime',
          provider: 'onto-skill-templates',
          content: renderSkillBody(template, {
            name: pkg.meta.name,
            version: pkg.meta.version,
            domain: pkg.meta.domain,
          }),
          metadata: { id: template.id, package: pkg.meta.name, version: pkg.meta.version },
        }
      },
    }
    return provider
  })
}
