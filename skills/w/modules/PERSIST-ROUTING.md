# PERSIST-ROUTING — which shape goes where

Loaded when classifying what to persist (signal `classification`).

| Shape | Signals | Category → destination |
|---|---|---|
| **Analysis / conclusions / design notes** | findings, comparisons, diagnoses, adjudications, recommendations | `research` → `docs/research/NNN-research-<slug>.md` |
| **Requirement** | describes a *wish*: what should exist/change, acceptance criteria derivable | `spec` → `docs/specs/NNN-spec-<slug>.md`, born `status: draft`, `## Origin` = "adopted from host conversation" → offer `/w:spec-refine` |
| **Plan** | already answers the *how*: phases/tasks/solution — e.g. the host plan-mode output | `plan` → `docs/plans/NNN-plan-<slug>.md` (adoption) → offer `/w:plan-refine` / `/w:plan-exec` |
| **Durable UI idea** | screens, flows, states meant to last | `spec` **first**, then the design in the package it identifies ([`DESIGN-REFERENCES.md`](DESIGN-REFERENCES.md)); never a Screen Specification *instead of* the Requirement, and `persist` writes no package |
| Mixed / ambiguous | e.g. analysis that ends in a requirement | one `persist` per document, each confirmed; a research doc plus a spec draft that cites it is a valid split |

## `docs/research/` — the analysis home (owned by this command)

`docs/research` hosts standalone analyses: neither spec nor plan, but worth keeping. Belongs to **no flow**; `export-*` never writes it; loops never read it implicitly (a flow uses it by **reference** — cited in a spec's `## Origin` or a quick prompt). It is git-shareable, unlike sessions (gitignored, machine-local, loop-owned), which makes it the exchange surface for **N agents analyzing the same situation**.

> **Anti-duplicate is a decision, not an accident.** The inventory carries each existing document's summary and digest. Same work already there → `mode: "update"` (proving you saw the current bytes via `target_digest`) or `state: "ambiguous"` so the user chooses between updating and writing a sibling perspective. A second near-identical document is never created silently.
