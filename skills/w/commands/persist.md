---
description: Use when work already produced in this conversation (analysis, conclusions, a plan) should be saved into docs/ — classifies its shape and routes it. analysis → docs/research/ · requirement → spec draft (docs/specs) · plan → plan adoption (docs/plans). Backed by `aw persist`, which owns the inventory, the anti-duplicate check, the numbering, the destination and the write. Transversal (no flow, no loop, no session); records ## Origin + attribution.
argument-hint: [what to persist — empty = the conversation's latest finished deliverable]
allowed-tools:
  [
    "Bash",
    "Read",
  ]
---

# persist — persist in-conversation work into `docs/`

Captures **work already produced in this conversation** — with or without host-native features (a `/goal` run, plan mode, plain chat analysis) — and persists it into `docs/`, classified by shape. The explicit form of *direct no-flow authoring* (`../SKILL.md` § *Operating context*, row 3) and the doctrinal entry for **host as producer** (`../loops/CHASSIS.md` § *Adopted context*). The host→`docs/` counterpart of `export-*`.

> **Hard floor — applies even if you read nothing beyond this file:**
>
> 1. **Adopt, don't re-derive** — single pass, **NO RESEARCH**: transcribe/organize what the conversation already established. New investigation is flow work (`spec-refine`, `quick`), never this command's.
> 2. **You classify and write; the CLI decides everything else** — inventory, anti-duplicate, numbering, destination, authorization and the write itself belong to `aw persist`. Never write into `docs/` with a file tool here; `Write`/`Edit` are deliberately not in `allowed-tools`.
> 3. **Never invent the number** — the `NNN` you put in the path is consultative; `apply` reassigns it inside the lock. Do not renumber it.
> 4. **Confirm before writing** — classification and destination go through **structured-choice**; `apply` refuses without the digest `validate` returned. **Never creates sessions** (sessions are loop-created only).
> 5. **Language** — headings in English (parse contract); content in the **user's language**.

## Input

`$ARGUMENTS` names what to persist (or is empty → the conversation's most recent finished deliverable). The **source is the conversation itself**. If nothing persistable exists yet, say so and stop — do not manufacture content.

## Run

1. `aw persist prepare --format human` (`--detail` prints the full response contract). Returns the inventory of the three categories, the consultative numbering, the allowed destinations, the limits and an `input_digest`.
2. **Classify and write.** Compose one JSON answer:
   - `version`, `operation`, `input_digest` copied **verbatim** from the request;
   - `state`: `proposed`, or `ambiguous` when the inventory already holds this work (explain in `reason` — the CLI turns that into a question, never a write);
   - `decisions`: `{ category, slug, mode }`, plus `target` + `target_digest` when `mode` is `update`;
   - `artifacts`: exactly one `{ path, content }`.
3. `echo '<json>' | aw persist validate --format human` → preview + `approval_digest`.
4. **Confirm classification and destination** with the user via structured-choice, showing that preview.
5. `echo '<json>' | aw persist apply --approval <digest> --format human`.

Every rejection names its cause and one valid next action; nothing was written. Fix the answer and repeat from step 3.

## Classification → routing

| Shape | Signals | Category → destination |
|---|---|---|
| **Analysis / conclusions / design notes** | findings, comparisons, diagnoses, adjudications, recommendations | `research` → `docs/research/NNN-research-<slug>.md` |
| **Requirement** | describes a *wish*: what should exist/change, acceptance criteria derivable | `spec` → `docs/specs/NNN-spec-<slug>.md`, born `status: draft`, `## Origin` = "adopted from host conversation" → offer `/w:spec-refine` |
| **Plan** | already answers the *how*: phases/tasks/solution — e.g. the host plan-mode output | `plan` → `docs/plans/NNN-plan-<slug>.md` (adoption, [`plan-new`](plan-new.md) § *Input resolution* mode 4) → offer `/w:plan-refine` / `/w:plan-exec` |
| Mixed / ambiguous | e.g. analysis that ends in a requirement | one `persist` per document, each confirmed; a research doc plus a spec draft that cites it is a valid split |

Requires a **workspace** (`docs/` is the managed surface). Without one → degrade: propose `/w:workspace-init`.

## `docs/research/` — the analysis home (owned by this command)

`docs/research` hosts standalone analyses: neither spec nor plan, but worth keeping. Belongs to **no flow**; `export-*` never writes it; loops never read it implicitly (a flow uses it by **reference** — cited in a spec's `## Origin` or a quick prompt). It is git-shareable, unlike sessions (gitignored, machine-local, loop-owned), which makes it the exchange surface for **N agents analyzing the same situation**.

> **Anti-duplicate is a decision, not an accident.** The inventory carries each existing document's summary and digest. Same work already there → `mode: "update"` (proving you saw the current bytes via `target_digest`) or `state: "ambiguous"` so the user chooses between updating and writing a sibling perspective. A second near-identical document is never created silently.

## Plan mode

Describe the classification, the destination and the document it would write. Running `prepare` is fine (read-only); never `apply`.

## Resources

- CLI: `aw persist prepare | validate | apply` (service `persist-service` over `semantic-operation/`)
- Siblings: the four `export-*` commands (session → `docs/`), same handshake
- Design reference: `docs/referencias/workflow-skills/persist.md`
