import { applyRun } from '@dsh-onto/runtime/agent-tools'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { homedir } from 'node:os'

const tools = new Map()
const ctx = {
  root: {
    get(k) {
      if (k === 'profileContext') return { dir: join(homedir(), '.dsh', 'profiles', 'dsh-aml') }
      return undefined
    },
  },
  effect() {},
  on() {},
  logger() { return { warn() {}, info() {} } },
  get() { return undefined },
  tools: {
    register(def) { tools.set(def.name, def) },
    guard() {},
  },
  skills: { registerProvider() {} },
}

applyRun(ctx)

const names = [...tools.keys()]
const devTools = ['create_package','save_skeleton','draft_elements','apply_draft','reject_draft','list_drafts','upload_knowledge_source','write_quality_report','get_model_graph']
const runTools = ['run_scenario','list_runs','export_audit','compare_runs','list_packages','list_scenarios','list_capabilities','expand_entity']

for (const d of devTools) {
  assert.ok(!names.includes(d), `DEV tool must not register: ${d}`)
}
for (const r of runTools) {
  assert.ok(names.includes(r), `RUN tool must register: ${r}`)
}

console.log(JSON.stringify({
  toolCount: names.length,
  hasAllRun: runTools.every((r) => names.includes(r)),
  hasAnyDev: devTools.filter((d) => names.includes(d)),
  names: names.sort(),
}, null, 2))