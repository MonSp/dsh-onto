# dsh-onto

[English](README.md) | [中文](README.zh.md)

**Business ontology modeling + AI-assisted decision platform** built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).

Turn expert business criteria into machine-validatable, issuable, derivable structures —
O1 objects / O2 behavior rules / O3 scenario cards. One line to remember:

> **Judgment lives in the rule engine; determination lives with humans.**

**Start here for integration:** [User guide — model → runtime → business app / intelligent Q&A](docs/user-guide.en.md)
（中文：[docs/user-guide.zh.md](docs/user-guide.zh.md)）

## Overview

Universal pipeline: **Knowledge → Ontology → Platform assembly → Decision support**.
Any domain swaps package content only — the skeleton stays the same.

![Methodology pipeline: three lanes — modeling (problem definition → on-demand sources → O1/O2/O3 ontology → pre-issue validation → human issue) · delivery (gates · acceptance · activation) · operations (dual entry → rule judgment → human determination → feedback)](docs/overview-pipeline.en.svg)

> Three lanes, not one pipeline. **Modeling** starts from the business problem (goals · scope ·
> expected results · counter-examples), picks source types on demand (LLM drafts only —
> candidates materialize after human approval), builds the O1/O2/O3 ontology with in-package
> bindings (API data contract), then validates before issue — structure check, derived
> artifacts + load check, business replay (a recommended review step, not a hard issue
> gate) — and only then human issue; the post-issue re-derive records fingerprints (= loadable).
> **Delivery** takes an issued version through publish/deploy, the managed gate, go-live
> acceptance (per rail) and human activation: ISSUED ≠ loadable ≠ active. **Operations** run
> from the dual entry (expert agent / business page system) through query & analyze into
> rule-engine judgment, yielding a **run result** (`humanReviewRequired=true` marks “pending
> review”, not a determination) → review queue → human determination; reports branch straight
> from the run result (a projection of run records, no need to wait for review) while actions
> after determination are limited to **approved candidates only** and keep their own approval
> gate. Two feedback loops, each with its own start point: insufficient evidence branches from
> the run result → pending verification (stays with the run, back to query/analyze); human
> corrections branch from determination → experience backfill → draft a candidate if warranted
> → approval → a new version — returning to the candidate-draft → human approval → materialize
> path in the modeling lane (never into ISSUED).
>
> Chinese original: [README.zh.md](README.zh.md) · [docs/overview-pipeline.zh.svg](docs/overview-pipeline.zh.svg)

## From one sentence to a self-running loop

**⓪ Choose before chat.** The new-session hero chip pre-selects an expert preset (AML / TAX /
MED) and the session header keeps the active expert in view. A started session's composition
cannot be hot-switched — use `expert_agent` to delegate to an expert child agent, or open a
new session.

**① Build.** One sentence creates the model: `create_package` (with `humanApproved`) →
skeleton proposal → `save_skeleton` → sliced drafting (`draft_elements`; drafts enter the
queue, never the package) → human review on the canvas → materialization through the **I6
skeleton gate** → validate → derive → load gate → human issue (0 errors + ≥ 1 scenario card +
≥ 1 score rule; review/issue transitions re-derive in the same transaction).

**② Apply.** An issued package is a read-only application — `run_scenario` / `invoke_expert`,
the Web Scenarios tab, or the CLI. Every run yields candidates, risk scores, hit rule IDs,
evidence chains and pending checks with `humanReviewRequired=true`: machines screen clues and
assemble evidence; humans decide.

**③ Operate.** Each run turns the loop: run records (audit + forbidden-phrase scan) →
experience signatures → recall hints (never re-scores) → human annotation → SkillTemplate
drafts → approved methodology upgrades. ISSUED is read-only — evolution forks a new version;
a knowledge side-path (conversation turns, uploaded docs) feeds the model through the
human-approved queue.

## Why

Business judgment criteria usually scatter across code, configs, and individual experts'
heads: every AI capability re-aligns the same semantics, thresholds drift between releases,
and compliance boundaries get bolted on after the fact. dsh-onto makes the criteria the
product: they are modeled as versioned YAML packages, validated by a rule engine, issued
through human review, and derived into fingerprinted runtime contracts — while the LLM is
kept on a short leash (drafting only, never scoring, never issuing verdicts).

## Features

- **Packages** — create / import / export / version fork / human issue (`DRAFT → IN_REVIEW →
  ISSUED`; ISSUED is read-only) · `dsh-onto package *` · Web
- **Conversational modeling** — one sentence → skeleton → sliced drafts → human review →
  materialize behind the I6 skeleton gate · main chat · Web
- **Knowledge pipeline** — 6 source types → LLM parsing → candidate queue → human approval ·
  `dsh-onto knowledge *` · Web
- **Validator & deriver** — reference closure, weights, `derived/**` fingerprints, load gate
  (`DERIVED_DRIFT`) · `dsh-onto validate` / `derive` / `gate`
- **Rule engine** — exclusions then weighted scoring; every score points back to a rule ID · core
- **Scenario runs** — pipeline dispatch, three-layer audit, run history A/B compare, audit
  export · `dsh-onto run` / `runs *` · Web
- **Conversational run reports** — in-chat interactive report for any run (summary card,
  candidate table, evidence expand; filter · expand · navigate) via `show_run_report`, values
  from the same `getRunReport` projection as the page; save a used view as a reusable report
  page and re-apply it to another run (`save_report_page`) · main chat · Web
- **Report components & cross-run compare** — catalog `dsh-onto/report/v1` grows to 18
  components (KeyValue/Badge/Callout/Progress/Timeline/Tabs + Chart bars/line/donut with
  multi-series grouped/stacked, conditional `when`, typed table columns, spark, palette);
  table export copies Markdown/CSV; `show_run_diff` renders a cross-run compare card
  (delta table + hit/excluded add-remove; absent side stays null, never 0) · main chat · Web
- **Trusted business execution** — three-state data status, six-tuple authorization,
  decision→proposal ledger, external receipts + reconciliation (no receipt ⇒ `unknown`),
  ticket-sim & test adapters · lives in **`@dsh-onto/runtime`** · `record_review_decision` /
  `create_action_proposal` / `execute_behavior_action` / `reconcile_action`
- **Declarative release (no restart)** — `publish_business` / `activate_business` /
  `rollback_business`: an issued package joins the release ledger (idempotent by content
  digest) and the active pointer binds new runs; imported-but-not-activated packages are
  rejected **fail-closed** (managed gate); controlled source config (`simulated|formal`,
  https or loopback http, token kept as an env reference) survives restarts via boot restore
  and is written under a cross-process lock · `@dsh-onto/runtime` · main chat
- **Business pages & deploy rails** — `plugin generate` turns an issued package into a
  business run page (**dataset mode** by default: inline data channel, same `runScenario` as
  the Agent; `--source` picks the API-mapping mode; `--fixture` for an explicit run fixture);
  `deploy.ps1` ships an independent-customer rail: build → fixture e2e → replay → profile
  install → import → **human activation** → controlled restart → dual-entry anchors
- **Experience loop** — run records → recall hints → human annotation → SkillTemplate
  upgrades · `dsh-onto exp *` · Web
- **Expert presets** — AML / TAX / MED picked before chat; `expert_agent` dispatches expert
  sub-agents · hero chip · main chat
- **Multi-domain** — AML + MED + TAX + WST + EBC ship as package content only, zero engine
  changes · `packages/`

## Repository layout

Dependency direction: **`core` ← `runtime` ← `backend` (assembly)** · workbench talks to
backend over remote services only · business plugins (`apps/*`) depend on runtime, never the reverse.

```
dsh-onto/
  core/       @dsh-onto/core — pure engine library + CLI (zero harness deps; 307 node --test acceptance tests)
  runtime/    @dsh-onto/runtime — shared run & governance library: data connectors,
              identity/authorization, run records, review/approval, action ledger,
              reconciliation, release ledger & controlled sources (no auto dsh assembly;
              backend and business plugins depend on it — never the reverse)
  backend/    @dsh-onto/backend — dsh bundle: development wires (model/knowledge/issue/release)
              + assembly shell over @dsh-onto/runtime (onto* landing point; 328 tests)
  workbench/  @dsh-onto/workbench — dsh bundle: Web UI (seven tabs + persistent right-rail ontology graph)
  apps/       business plugins as separate dsh bundles:
                aml/  @dsh-aml/app  — governance workbench (review queue, actions)
                tax/  @dsh-tax/app  — RUN-only minimal run page + Agent same path
  mock-services/
              ticket-sim — standalone ticket simulation service (self-persisting SQLite,
              idempotent across processes, fault injection, reconciliation; receipts always `simulated`)
              tax-api — read-only TAX query mock for the second-plugin cold start
              wst-api — read-only WST snapshot API for the self-service onboarding acceptance
  packages/   example business ontology packages (first-class deliverables): aml/1.0.0, med/1.0.0,
              tax/1.0.0, wst/1.0.0, wst-ops/1.0.1, ebike-charging/1.0.0
  examples/   scenario run fixtures (aml-run.json / med-run.json / tax-run.json / ebc-run.json)
  scripts/    setup-profile.ps1 / dev-web.ps1 / dump-config.ps1
              setup-tax-profile.ps1 / dump-tax-config.ps1 / m-tax-seed-release.mjs
              ensure-expert-presets.ps1 (+ expert-presets.json, preset-plugins.standard.yaml: idempotent expert-preset block)
  docs/       user-guide.{zh,en}.md — how to model, mount runtime, ship apps or Q&A
              architecture.md — self-contained concepts & rules (Chinese)
              plugin-authoring.zh.md — second-domain plugin cold-start checklist
              ops-manual.md — formal-action gates & reconciliation
              overview-pipeline.{zh,en}.svg — three-lane methodology pipeline (modeling · delivery · operations)
```

## Requirements

- Node.js ≥ 24.9 and pnpm 11.x
- A [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) checkout as a sibling
  directory (`../deepseek-harness`), already run through `pnpm install && pnpm run build`.
  The harness is a **read-only** dependency — dsh-onto never modifies it.

## Quick start

```powershell
# 1. Create the `dsh-onto` profile, install both bundles, seed the example packages
dsh-onto\scripts\setup-profile.ps1
# 2. Assert the composed profile still contains @dsh-onto/backend + @dsh-onto/workbench
#    (runtime ships as a library dependency of backend, not a separate bundle)
dsh-onto\scripts\dump-config.ps1
# 3. Launch the Web UI (open the printed dsh web URL) → sidebar entry "dsh-onto"
dsh-onto\scripts\dev-web.ps1
```

The workbench exposes seven tabs: **Packages · Modeling · Knowledge · Validate & Derive ·
Scenarios · Access · Experience** (plus a persistent **Ontology graph** in the right rail).

### Second sample: TAX business plugin (RUN-only)

After the full workbench is up, the TAX cold-start loop shows how a **minimal business app**
mounts only the runtime (no backend/workbench in its profile):

```powershell
node dsh-onto\mock-services\tax-api\server.mjs --port 3911
dsh-onto\scripts\setup-tax-profile.ps1
node dsh-onto\scripts\m-tax-seed-release.mjs
dsh-onto\scripts\dump-tax-config.ps1   # TAX present; backend/workbench absent
```

Then either open the **TAX Run** sidebar panel, or ask the agent `run_scenario` with
`name=tax-risk, scenarioId=SCN-TAX-BURDEN-ANOMALY, sourceId=SRC-TAX-CORE` — same rule IDs
both ways. Full walkthrough: [docs/user-guide.en.md](docs/user-guide.en.md) ·
[docs/plugin-authoring.zh.md](docs/plugin-authoring.zh.md).

## CLI (no browser needed)

```powershell
cd dsh-onto\core
pnpm install; pnpm run build

node dist\cli.js package create --name demo --version 1.0.0 --domain DEMO --root ..\workspace
node dist\cli.js package issue --name demo --version 1.0.0 --by <human> --root ..\workspace
node dist\cli.js validate ..\packages\aml\1.0.0
node dist\cli.js derive   ..\packages\aml\1.0.0
node dist\cli.js gate     ..\packages\aml\1.0.0
node dist\cli.js run      ..\packages\aml\1.0.0 SCN-AML-FIND-CLUES --data ..\examples\aml-run.json --out result.json
node dist\cli.js runs compare <runA> <runB> --root ..\workspace
node dist\cli.js knowledge upload --package demo --type LEGACY_SYS --name algo --file algo.txt --root ..\workspace
node dist\cli.js knowledge parse --source <id> --llm deepseek --root ..\workspace
node dist\cli.js exp recall --dir ..\packages\aml\1.0.0 --scenario SCN-AML-FIND-CLUES --data ..\examples\aml-run.json
```

## License

[MIT](LICENSE)
