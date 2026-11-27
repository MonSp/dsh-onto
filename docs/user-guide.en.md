# User Guide: Model → Runtime → Business App / Intelligent Q&A

> Audience: integrators and business users who will **build ontology models** with our plugins,
> then either **ship a business application** on the runtime or **ask questions in natural language**
> through the agent.
> Self-contained concepts and rules: [architecture.md](architecture.md) · second-domain cold start:
> [plugin-authoring.zh.md](plugin-authoring.zh.md) (Chinese).
>
> Chinese version: [user-guide.zh.md](user-guide.zh.md)

## 0. One-line overview

**Write business criteria into an ontology package (validatable, issuable) → a plugin mounts the
runtime into dsh → page or agent calls the same scenario and the same `sourceId` → the rule engine
scores → every result is `humanReviewRequired=true` for human determination.**

```text
Modeling: knowledge/edit → O1/O2/O3 → validate/derive/gate → human issue (ISSUED)
Runtime:  business plugin (connector + RUN tools) + deploy-registered sourceId → OntoRuntime
Consume:  business UI  ‖  agent run_scenario   —— same path ——►  human review
```

Four non-negotiables:

1. **Judgment lives in the rule engine** — scoring only in `core/src/rules.ts`; UI, connectors, and the LLM never re-score.
2. **Determination lives with humans** — output is always `humanReviewRequired=true`; issue is a human act.
3. **ISSUED is read-only** — evolve via `package fork`; hand-edited `derived/**` → `DERIVED_DRIFT`.
4. **Data sources are deny-by-default** — URLs/credentials only from deploy config; packages carry logical `sourceId` only.

---

## 1. Two roles, two product paths

| | **Full workbench path** (sample: AML) | **Minimal business plugin path** (sample: TAX) |
|---|---|---|
| Install | `@dsh-onto/backend` + `@dsh-onto/workbench` | Only `@dsh-aml/app` / `@dsh-tax/app` (RUN-only) |
| Can do | Packages, modeling, knowledge review, validate/derive, scenario runs, governance chain | Wire data → mappings → issue → minimal run page + agent (same path) |
| For | Teams that keep iterating criteria | Teams that only **run** issued scenarios |
| Must not | — | Register DEV services; modify `core` / `runtime` |

Both paths share the same engine and runtime contracts.

---

## 2. Build an ontology model (modeling phase)

A package is a YAML tree with three layers:

| Layer | Contents | Question it answers |
|---|---|---|
| **O1 objects** | Types, relations, dictionaries, attributes, ID rules | What exists in the business world, how it links |
| **O2 behavior rules** | Score rules (weights sum to 1.0), exclusion rules, skill templates | How to judge; how to phrase evidence |
| **O3 scenarios** | Goal, I/O, pipeline, output contract, review gate, forbidden phrases | What problem to solve; what may be said |

### 2.1 How to author

**① Workbench UI** (AML profile)

Sidebar **dsh-onto** → **Packages · Modeling · Knowledge · Validate & Derive · Scenarios · Experience**
(persistent ontology graph on the right rail).

**② Knowledge pipeline (recommended start)**

```text
Upload sources → LLM parse into drafts (with confidence) → candidate queue
  → human approve/reject → materialize into the package
```

Six source types: `LEGACY_SYS` / `CASE_SAMPLE` / `POLICY` / `SCHEMA_API` / `WORK_ORDER` / `CONVERSATION`.  
Sources never write the package directly; confidence &lt; 0.75 forces human review; the LLM never scores or edits issued content.

**③ Edit `packages/<name>/<version>/` directly**

Common for cold start (TAX filled `bindings/` this way). Always run validate/derive/gate afterward.

**④ Conversational modeling**

One sentence in main chat → `create_package` (requires `humanApproved`) → skeleton → sliced `draft_elements`
→ canvas review → materialize behind the I6 skeleton gate → validate / derive / issue.

### 2.2 Validate → derive → load gate

```powershell
cd core
node dist\cli.js validate ..\packages\tax\1.0.0   # errors must be []
node dist\cli.js derive   ..\packages\tax\1.0.0   # write derived/** + manifest
node dist\cli.js gate     ..\packages\tax\1.0.0   # gate ok:true
cd ..
```

- **Errors block**: reference closure, weight sum, dictionaries, resolvable attributes, etc.
- **`ID_UNREFERENCED` warnings can ship** (especially `FM-*` / `SRC-*`; a low score ≠ broken maps).
- Derived files are fingerprinted: hand-edit → `DERIVED_DRIFT`; re-`derive` restores.

### 2.3 Issue (human only)

```powershell
cd core
node dist\cli.js package review --name tax-risk --version 1.0.0 --root ..
node dist\cli.js package issue  --name tax-risk --version 1.0.0 --by "Zhang San (human)" --root ..
cd ..
```

State machine: `DRAFT → IN_REVIEW → ISSUED`.  
`issuedBy` must not be agent/llm. ISSUED sources are read-only; changes require a fork.

Repo samples: `packages/aml`, `packages/med`, `packages/tax` (tax-risk, already ISSUED).

### 2.4 Bindings (wire real fields to O1)

| File | Role |
|---|---|
| `bindings/api-sources.yaml` | Logical source (e.g. `SRC-TAX-CORE`, `endpoint: api://tax-query`, **no real URL**) |
| `bindings/field-maps.yaml` | Source field → `OBJ-*.attr` (targets must close) |

Real URLs and credentials live only in **deploy env vars**, never in the package.

### 2.5 Zero-concept loop (materials → objects & rules, reversible trial)

No ontology concepts needed: **upload a document material → draft → trial run → compare → adopt or discard**.

1. **Upload material**: Knowledge panel, `DOCUMENT` kind (PDF-extracted text / table text / manuals;
   POLICY and CASE_SAMPLE kinds work too).
2. **Draft**: hit Parse to get draft candidates (objects/attributes/rules/red-lines) — drafts queue only,
   **never write into the package**.
3. **Trial run**: tick drafts and hit "Trial run" → Run tab, pick data, run the scenario — drafts are
   applied to the rule surface **in memory** (package untouched, issuance gates intact); the run record
   carries a trial marker.
4. **Compare**: tick two runs in the run list and Compare — hit additions/removals and score deltas.
5. **Adopt or discard**: keep them with Materialize (the only write path, still human-reviewed);
   discard with Reject — **zero package change, fully reversible at any point**.

Note: when a scenario declares rule scope (scoreRefs/exclusionRefs), trialed create-drafts join the
trial config explicitly; after adoption wire the new rules into the scenario scope for formal runs.

---

## 3. Mount the ontology runtime (runtime phase)

### 3.1 What a business plugin contains (`apps/tax` example)

| Module | Role |
|---|---|
| `src/index.ts` | Registers `OntoRuntime` + RUN tools/skills; no DEV services; `runtime.claim()` (one provider per host) |
| `src/tax-connector.ts` | Read-only `DataConnector`: business API → O1 objects/relations/candidates |
| `src/client/*` | Minimal run page: pick scenario → `runScenario` |
| `cordis.patch.yml` | dsh bundle patch |

`apps/aml` is the same shape plus the review workbench and governance actions.

### 3.2 Four deploy steps (TAX cold start)

```powershell
# 1) Install plugin into a dedicated profile
scripts\setup-tax-profile.ps1

# 2) Seed the issued package and activate (strict mode needs an active release)
node scripts\m-tax-seed-release.mjs

# 3) Composition assert: TAX present; backend/workbench absent
scripts\dump-tax-config.ps1

# 4) Env + data source + host
$env:DSH_TAX_API_URL     = 'http://127.0.0.1:3911'   # unset → sourceId runs deny
$env:DSH_BIZ_USER_ID     = 'user-tax-1'
$env:DSH_BIZ_TENANT      = 'tenant-tax'
$env:DSH_BIZ_ROLES       = 'analyst'
$env:DSH_BIZ_SCOPE_TYPES = 'OBJ-TAX-TAXPAYER,OBJ-TAX-INVOICE,...'

node mock-services\tax-api\server.mjs --port 3911
cd ..\deepseek-harness
pnpm dsh --profile dsh-tax --no-open
```

Full AML workbench: `scripts\setup-profile.ps1` → `dump-config.ps1` → `dev-web.ps1` (see root README).

### 3.3 Dual entry, one path

| Entry | Call | Result |
|---|---|---|
| **Page** | `runScenario({ name, version, scenarioId, sourceId })` | Candidates, riskScore, hit rules, evidence |
| **Agent** | `run_scenario` same args | Same rule IDs, same scores, zero forbidden phrases |
| **Chat report** | `show_run_report(runId, surface?)` | In-conversation interactive report (summary / candidates / evidence; filter / expand / navigate) |

Scores never depend on the entry point — computed once in the rule engine; page and chat report
share the same `getRunReport` projection. A view used in chat can be saved via `save_report_page`
as a reusable plugin report page and re-applied to another runId.

---

## 4. Path A — Build a business application

### 4.1 Minimal app (self-service: configure a read-only API → generate the plugin)

For “one read-only JSON API + one scenario + one result page + one agent entry” — **no hand-written connector, no engine changes**:

1. Author the business package (objects/rules/scenario); `validate`/`derive` pass (DRAFT is fine to start).
2. Declare the logical source + `shape` (envelope/pagination) in `bindings/api-sources.yaml` → `source probe` to sample fields.
3. Map object ids/attributes/relations/candidates/behaviors in `bindings/source-maps.yaml` → `source map preview`
   reports missing fields / type mismatches / broken refs, plus evidence readiness (sufficient vs pending).
4. Replay baseline: `fixtures/replay-<SCN>.json` + `replay --write-expected`; before upgrades `replay --check`.
5. Human `issue` (issuing = human review) → `plugin generate` produces the minimal plugin (result page + agent entry + deploy templates).
6. Generated bundle: `pnpm install/build/test` → `setup-profile` → `seed-release` (import ≠ activate) → `dump-config` assert → env launch.
7. Dual-entry check: page and Agent `run_scenario` share scenario + sourceId; candidates/scores/ruleIds identical.

Boundaries: same scenario + `sourceId` for page and agent; no scoring outside core; generated bundles are RUN-only (no backend/workbench imports); credentials only in deploy env.

Full checklist: [plugin-authoring.zh.md](plugin-authoring.zh.md).

### 4.2 Full governance app (copy AML)

- Run history / review queue / evidence detail  
- `record_review_decision` (business review)  
- Actions: `create_action_proposal` → approval card → `execute_behavior_action` (idempotent ledger)  
- Audit `export_audit`; reconciliation in [ops-manual.md](ops-manual.md)

For teams productizing “run → review → act → reconcile”.

### 4.3 Typical page flow

```text
Open “TAX Run” → pick SCN-TAX-BURDEN-ANOMALY → Run (sourceId=SRC-TAX-CORE)
  → candidate table: riskScore / hitRuleIds / evidence / pending checks
  → human determination (always humanReviewRequired=true)
  → optional review decision / action proposal — AI never clicks approve
  → optional: open the same run's interactive report in chat via show_run_report,
    save it as a reusable report page via save_report_page
```

---

## 5. Path B — Intelligent business Q&A (agent)

No UI required first — ask in a dsh session that has the RUN tool face.

### 5.1 Main tools

| Intent | Tool | Notes |
|---|---|---|
| What scenarios exist? | `list_scenarios` | Cards by package/version |
| Score a risk question | `run_scenario` | Fetch + exclude + score + evidence + audit |
| Batch | `run_scenarios` | Same contract per item |
| Expand graph neighborhood | `expand_entity` | Data prep only — **does not score** |
| View interactive report | `show_run_report` | Renders one run in chat (optional surface organizes the view) |
| Save report page | `save_report_page` / `list_report_pages` | Persist a used view as a reusable plugin page |
| Cross-run compare | `show_run_diff` | Compare card: delta table + hit/excluded add-remove (absent side stays null, never 0) |
| Read package | `get_package` etc. | Read-only |
| Change criteria | `apply_draft` | Draft queue — **never writes ISSUED** |

Sandbox: package writes via `apply_draft`, data via `run_scenario`, human review via workbench/approval cards.

### 5.2 Example asks

**Capabilities:**
> Which tax scenarios can we run? What does burden anomaly in tax-risk 1.0.0 expect as input?

**A judgment (same path as the page):**
> Run SCN-TAX-BURDEN-ANOMALY on tax-risk@1.0.0 with source SRC-TAX-CORE; list high-risk taxpayers, hit rules, and evidence.

Equivalent parameters:

```text
run_scenario(
  name=tax-risk, version=1.0.0,
  scenarioId=SCN-TAX-BURDEN-ANOMALY,
  sourceId=SRC-TAX-CORE
)
```

AML sample scenario: `SCN-AML-FIND-CLUES` (package `aml-analysis`).

**“Why?”** — read `evidenceChains` (`ruleId` + template fill + score); answers must cite rule IDs.  
**“Is it confirmed?”** — machines screen and assemble evidence; `humanReviewRequired=true`; humans determine; forbidden phrases are zero-tolerance.

### 5.3 Result shape

```text
Candidate TAX-CAND-001 (object 91110000T001)
  riskScore / hitRuleIds / evidenceChains / pendingChecks
  humanReviewRequired: true
  dataStatus · contractStatus · audit
```

Same execution path as the page table, different presentation; `show_run_report` also opens
an interactive report over the same projection in chat (summary card / candidate table /
evidence expand), and a used view can be saved as a reusable report page and re-applied to
another run. Report surfaces are organized with `dsh-onto/report/v1` components (18 total:
KeyValue/Badge/Callout/Progress/Timeline/Tabs + Chart bars/line/donut multi-series, `when`
conditional display, typed table columns; export copies Markdown/CSV); `show_run_diff`
opens a cross-run compare card (delta table + hit/excluded add-remove, absent side stays
null never 0) — numeric slots always accept field bindings only.

### 5.4 Pre-flight checks

| Symptom | Check |
|---|---|
| `data source not registered: SRC-…` | Data-source env unset or host not restarted |
| `Business identity is unavailable` | `DSH_BIZ_USER_ID/TENANT/ROLES` incomplete |
| `RELEASE_NOT_ACTIVE` | Seed not run / wrong profile |
| `DERIVED_DRIFT` | Sources changed without `derive` |
| Tools missing | Plugin not in this profile, or descriptors not mounted |

---

## 6. Two samples side by side

| | **AML** (full) | **TAX** (minimal loop) |
|---|---|---|
| Package | `packages/aml` aml-analysis | `packages/tax` tax-risk@1.0.0 |
| Scenarios | `SCN-AML-FIND-CLUES` | `SCN-TAX-BURDEN-ANOMALY` + 2 more |
| Plugin | `apps/aml` | `apps/tax` |
| Data | mock / ext-api | `mock-services/tax-api` + `SRC-TAX-CORE` |
| Profile | `dsh-onto` | `dsh-tax` |
| Acceptance | Five tabs + agent `run_scenario` | Page + agent same rule IDs; `dump-tax-config` |
| Docs | architecture / ops-manual | **plugin-authoring** + this guide |

**Suggested path:** ① AML workbench to learn O1/O2/O3 and human review → ② TAX guide for cold start → ③ clone TAX for your domain.

---

## 7. Shortest-path checklists

**Q&A only (package issued, plugin running):**

1. Plugin in profile, data-source env set, release seeded/active.  
2. New session: ask naturally, or agent `list_scenarios` → `run_scenario`.  
3. Read rule IDs/evidence; escalate to humans for determination.

**Build a business app:**

1. Follow [plugin-authoring.zh.md](plugin-authoring.zh.md): package → shape/mapping → preview → issue → replay baseline → `plugin generate`.  
2. Assemble the generated bundle (setup-profile / seed-release / dump-config) + env-registered `sourceId`.  
3. Page and agent share one `runScenario`; always surface `humanReviewRequired=true`; real actions behind approval cards.

**Iterate criteria over time:**

1. Knowledge upload → human-approved materialization.  
2. Edit DRAFT → validate/derive/gate → issue or fork.  
3. Never hand-edit ISSUED or `derived/**`.

---

## 8. Related docs

| Doc | Content |
|---|---|
| [architecture.md](architecture.md) | Concepts, three-layer ontology, validate/derive/engine rules (self-contained) |
| [plugin-authoring.zh.md](plugin-authoring.zh.md) | Self-service onboarding: configure a read-only API → mapping preview → replay → generate plugin (Chinese) |
| [ops-manual.md](ops-manual.md) | Formal action gates, reconciliation, shutdown |
| [../README.md](../README.md) | Quick start and CLI |
| [user-guide.zh.md](user-guide.zh.md) | Chinese version of this guide |
