# PLAN-INPUT — what the argument to a plan command actually is

Loaded when the input is not plainly a `ready-for-plan` spec (signal `input`).

## plan-new — four modes

1. **Ready spec** (`docs/specs/NNN-spec-<slug>.md` whose frontmatter declares `status: ready-for-plan`) → ideal. Proceed straight to the loop.
2. **Spec not ready** (`status: draft` / `refining`, or no mark at all) → **soft-suggest** running `/w:spec-refine` first, **never a block**. Questions the spec left with destination `PLAN` are this flow's **input**, not a reason to send it back.
3. **Prompt** (no spec referenced) → propose the SPEC flow; **by default launch `/w:spec-new`** with that prompt and continue the natural flow from there.
4. **External plan content** — the argument carries an **already-built plan** (host plan mode, hand-written, another agent's) → **adopt it**. Single pass, **NO RESEARCH**: materialize as `docs/plans/PPP-plan-<slug>.md`, normalized to the rich-plan schema with only what the source provides. `## Origin` = "adopted from <source>" + attribution (host · model · date). Then offer `/w:plan-refine` or `/w:plan-exec`. Anti-duplicate: a plan whose `## Origin` matches this objective is resumed, never duplicated. Adoption **never regenerates over** an existing plan-doc.

> **Mode 3 vs 4:** a prompt that *describes a wish* → SPEC (mode 3); content that *already is a plan* → adopt (mode 4).

> **What adoption may do once the mode is settled is not this document's call:** the deterministic steps below are decided by the CLI (`aw flow advance`), not by this document.

> **Ready vs not** is read from the spec's frontmatter `status`, never from the filename. **Legacy compat:** a spec with no frontmatter that carries `## Refinement decisions` — or the older `## Q&A traceability` — counts as ready the same way.

## plan-refine — three modes

1. **Existing plan** (`docs/plans/PPP-plan-<slug>.md`) → proceed, **regardless of provenance**: generated, hand-written, or adopted. Existence is the only requirement.
2. **No plan** → **soft-suggest** `/w:plan-new` first; the user decides.
3. **Returned by `plan-exec`** (its entry check found the plan unexecutable, or execution stopped on a structural deviation) → proceed carrying that finding: phases already `validada` stay, only pending work is re-designed.

> **Spec-less plans are legitimate input.** The coherence gate **degrades gracefully**: criteria trace to the plan's own Final behavior block instead of spec criteria, and the "spec criteria uncovered" gap does not apply.

## Numbering

The plan is named `docs/plans/PPP-plan-<slug>.md`; `aw next-number docs/plans --claim plan-<slug>.md` claims it; the slug comes from the Requirement. It does **not inherit the spec's `NNN`** — the link is established by reference in `## Origin`, never by number.
