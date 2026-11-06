# dsh-onto

[English](README.md) | [中文](README.zh.md)

**Business ontology modeling + AI-assisted decision platform** built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).

Turn expert business criteria into machine-validatable, issuable, derivable structures —
O1 objects / O2 behavior rules / O3 scenario cards. One line to remember:

> **Judgment lives in the rule engine; determination lives with humans.**

## Overview

Universal pipeline: **Knowledge → Ontology → Platform assembly → Decision support**.
Any domain swaps package content only — the skeleton stays the same.

![Universal pipeline: Knowledge → Ontology → Platform assembly → Decision support](docs/overview-pipeline.en.svg)

> Chinese original: [README.zh.md](README.zh.md) · [docs/overview-pipeline.zh.svg](docs/overview-pipeline.zh.svg)

## Why

Business judgment criteria usually scatter across code, configs, and individual experts'
heads: every AI capability re-aligns the same semantics, thresholds drift between releases,
and compliance boundaries get bolted on after the fact. dsh-onto makes the criteria the
product: they are modeled as versioned YAML packages, validated by a rule engine, issued
through human review, and derived into fingerprinted runtime contracts — while the LLM is
kept on a short leash (drafting only, never scoring, never issuing verdicts).

## Features

| Capability | Entry point |
|---|---|
| Package management: create / import / export / version fork / issue state machine (DRAFT → IN_REVIEW → ISSUED; ISSUED is read-only) | `dsh-onto package *` · Web · Packages tab |
| Modeling: structured O1/O2/O3 editing + YAML import | Web · Modeling tab · `ontoModel.writeSource` |
| Knowledge pipeline: 5 source types → LLM parsing (heuristic fallback) → candidate queue → human review | `dsh-onto knowledge *` · Web · Knowledge tab |
| Validator: reference closure / weights sum to 1.0 / dictionaries / event discipline / attribute resolution + quality score | `dsh-onto validate` · Web · Validate tab |
| Deriver: `derived/**` + manifest fingerprints + load gate (`DERIVED_DRIFT`) | `dsh-onto derive` · `dsh-onto gate` |
| Rule engine: exclusions (before-scoring) → weighted scoring (weights come from O2); every score points back to a rule ID | core engine |
| Scenario execution: minimal-step pipeline dispatch + three-layer audit closure + human-review fields | `dsh-onto run` · Web · Scenarios tab |
| Multi-domain by design: AML (anti-money-laundering) + MED (clinical) ship as package content only — zero engine changes | `packages/` |

## Repository layout

```
dsh-onto/
  core/       @dsh-onto/core — pure engine library + CLI (zero harness deps; 110 node --test acceptance tests)
  backend/    @dsh-onto/backend — dsh bundle: onto* wire services (single backend landing point)
  workbench/  @dsh-onto/workbench — dsh bundle: Web UI (five tabs)
  packages/   example business ontology packages (first-class deliverables): aml/1.0.0, med/1.0.0
  examples/   scenario run fixtures (aml-run.json / med-run.json)
  scripts/    setup-profile.ps1 / dev-web.ps1 / dump-config.ps1
  docs/       architecture.md — self-contained concepts & rules (Chinese)
              overview-pipeline.{zh,en}.svg — end-to-end pipeline diagrams
```

## Requirements

- Node.js ≥ 22.19 and pnpm 11.x
- A [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) checkout as a sibling
  directory (`../deepseek-harness`), already run through `pnpm install && pnpm run build`.
  The harness is a **read-only** dependency — dsh-onto never modifies it.

## Quick start

```powershell
# 1. Create the `dsh-onto` profile, install both bundles, seed the example packages
dsh-onto\scripts\setup-profile.ps1
# 2. Assert the composed profile contains both @dsh-onto/* bundles
dsh-onto\scripts\dump-config.ps1
# 3. Launch the Web UI (open the printed dsh web URL) → sidebar entry "dsh-onto"
dsh-onto\scripts\dev-web.ps1
```

The workbench exposes five tabs: **Packages · Modeling · Knowledge · Validate & Derive · Scenarios**.

## CLI (no browser needed)

```powershell
cd dsh-onto\core
pnpm install; pnpm run build

node dist\cli.js package create --name demo --version 1.0.0 --domain DEMO --root ..\workspace
node dist\cli.js validate ..\packages\aml\1.0.0
node dist\cli.js derive   ..\packages\aml\1.0.0
node dist\cli.js gate     ..\packages\aml\1.0.0
node dist\cli.js run      ..\packages\aml\1.0.0 SCN-AML-FIND-CLUES --data ..\examples\aml-run.json --out result.json
node dist\cli.js knowledge upload --package demo --type LEGACY_SYS --name algo --file algo.txt --root ..\workspace
node dist\cli.js knowledge parse --source <id> --root ..\workspace
node dist\cli.js knowledge queue --root ..\workspace
```

## Product discipline (hard rules)

1. Business judgment content lives **only** in O2/O3; the rule engine is the single scoring
   path — **LLMs never score**.
2. The LLM only drafts candidates (with confidence). Raw material **never writes into a
   package** directly; materialization happens only after human approval.
3. Verdict-style phrasing ("认定…", "guilty of…", …) may only land in a scenario's
   `forbiddenPhrases` red lines — **never** in the output contract.
4. **Determination is always human**: every run returns `humanReviewRequired = true`; the
   issue endpoint requires a human identity (`issuedBy`).
5. Derived artifacts are read-only but regenerable; hand-editing one → `DERIVED_DRIFT`
   refuses to load; re-deriving restores service.
6. Every output must include: candidate list, risk score, hit rule IDs, evidence chains,
   and pending checks — with a zero-tolerance scan for forbidden phrases.

## Testing

`core/tests/` ships 110 acceptance tests (`node --test tests/*.test.mjs`) covering:
validator interceptions, six-source knowledge parsing, conclusion phrases kept out of O3,
forced review for low confidence, ISSUED read-only + fork, derived-drift refusal and
recovery, end-to-end scenario output contract, rule-ID/evidence-chain/forbidden-phrase
guarantees, and a second domain running on the untouched engine.

## Boundaries (stated honestly)

- Knowledge parsing defaults to a deterministic lexical heuristic; the DeepSeek API path
  needs `DEEPSEEK_API_KEY` (e.g. in `~/.dsh/.env`).
- The modeling surface is structured editing + YAML import — not a free-form canvas
  (explicitly out of scope).
- Runtime verdicts are out of scope by design: the platform screens candidates and
  assembles evidence; humans decide.

## License

[MIT](LICENSE)
