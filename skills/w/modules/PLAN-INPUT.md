# PLAN-INPUT — what the argument to a plan command actually is

Loaded when the input is not plainly a `ready-for-plan` spec (signal `input`).

## plan-new — four modes

1. **Ready spec** (`docs/specs/NNN-spec-<slug>.md`, `status: ready-for-plan`) → proceed.
2. **Spec not ready** (`draft`, `refining`, or no mark) → **soft-suggest** `/w:spec-refine`, never a block. `PLAN` questions remain input here.
3. **Prompt** (no spec) → propose and normally launch `/w:spec-new`, then continue.
4. **External plan** (host, hand-written, another agent) → **adopt once, NO RESEARCH** at `docs/plans/PPP-plan-<slug>.md`. Normalize only supplied material; set `## Origin` to "adopted from <source>" + host/model/date; offer `/w:plan-refine` or `/w:plan-exec`. A matching Origin resumes; never overwrite a plan-doc.

> **Mode 3 vs 4:** a prompt that *describes a wish* → SPEC (mode 3); content that *already is a plan* → adopt (mode 4).

> Adoption is CLI-owned: the deterministic steps below are decided by the CLI (`aw flow advance`), not by this document.

> **Source-bounded:** new/refined plans declare `> Límite de ejecución: checkout`; each phase `> Fuentes:`; each task `_(fuentes: …)_`. `workspace` is reserved; other aliases exist in `AGENTS.md > Fuentes`; task sources are a phase subset. A legacy/manual plan without this form is adopted but **cannot execute**: `/w:plan-refine` adds it.

> **Ready vs not** is read from the spec's frontmatter `status`, never from the filename. **Legacy compat:** a spec with no frontmatter that carries `## Refinement decisions` — or the older `## Q&A traceability` — counts as ready the same way.

## plan-refine — three modes

1. **Existing plan** (`docs/plans/PPP-plan-<slug>.md`) → proceed regardless of provenance.
2. **No plan** → soft-suggest `/w:plan-new`; the user decides.
3. **Returned by `plan-exec`** (unexecutable entry or structural deviation) → retain `validada` phases and redesign only pending work.

> **Spec-less plans are legitimate input.** The coherence gate **degrades gracefully**: criteria trace to the plan's own Final behavior block instead of spec criteria, and the "spec criteria uncovered" gap does not apply.

## Numbering

The name is `docs/plans/PPP-plan-<slug>.md`; `aw next-number docs/plans --claim plan-<slug>.md --code <NNN>` claims it for this run. The slug comes from the Requirement. It does not inherit the spec `NNN`: `## Origin` carries that link.
