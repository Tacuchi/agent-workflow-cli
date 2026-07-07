---
name: spec-refine-loop
description: >-
  Refines a draft spec (docs/specs/NNN-spec-<slug>.md) by editing it IN PLACE
  until it is unambiguous. Heir of the chassis (loops/CHASSIS.md). Deltas:
  spec gap taxonomy, analyze gate, ## UI spec section via the ui-design
  capability, and adds Refinement decisions + Q&A traceability — the refined
  mark plan-new detects. Started by /w:spec-refine (or the live escalation
  from quick-loop); resumable via CHECKPOINT and re-runnable on demand.
  Invoke to refine/disambiguate a specification before planning.
---

# spec-refine-loop

> **Heir** of the common chassis — **only** the SPEC deltas live here. The engine is never repeated.

## Inherits

Read **[`../CHASSIS.md`](../CHASSIS.md)** — the loop's **full engine** — **always before** these deltas. *(If `../` does not resolve: `CHASSIS.md` next to this file — global layout rule, chassis § Reference resolution.)*

## Flow
SPEC

## Layer
2 — the AI runs it end to end (gap-driven). The user does not drive the cycle; they only answer content questions and steer the lifecycle via the `flow` control.

## Started by
`/w:spec-refine` — **resumable**. Detects prior state (via CHECKPOINT) and starts accordingly (see *Compact / resume — SPEC keys*).

It is also started by the **live escalation from `quick-loop`** (entry gate or mid-loop — see [`../quick-loop/LOOP.md`](../quick-loop/LOOP.md) § *QUICK delta*): quick materializes the draft (`spec-new` procedure) and **loads this loop** over that spec — same semantics as if the user had run `/w:spec-refine`.

## Reads
- `docs/specs/NNN-spec*.md` (glob — locates the spec by number; also catches the legacy `NNN-spec.md`), **or** the exact path passed as the command argument. **Always the spec itself**: this loop edits it in place; there is no separate "refined" file.

## Writes
Updates `docs/specs/NNN-spec-<slug>.md` **in place** (when the user picks `Guardar especificación refinada`): completes sections and **adds** `## Refinement decisions` + `## Q&A traceability`, closing `Open questions` as they get resolved. Since it overwrites an existing doc, it asks the user's **confirmation**.

> **Boundary invariant:** this loop writes **only** into `docs/specs`. It never graduates/exports other artifacts to `docs/` — that is separate `export-*` work (chassis § *docs/ boundary*).

## Internal sessions — SPEC instance

Full doctrine in the chassis (§ *Internal sessions* + *Numbering*). This loop's instance:

| Session | When | Artifacts | Role |
|---|---|---|---|
| **refine session** `NNN-<slug>-spec-refine/` | when the loop starts (or resumes) | `SESSION.md` · `CHECKPOINT.md` (· `BACKLOG.md` only if something is deferred) | Owns the run. Type = `refine`; descriptor `<slug>-spec-refine` (the `<slug>` comes from the input spec). |

> **Origin on escalation:** when the run is born from quick-loop's live escalation, the session's `## Origin` records "escalated from `/w:quick`" + the origin quick session if it exists (its `DECISION`/`SCRIPTS.sql` are referenceable context — never migrated).

> **Compat (legacy):** old workspaces may hold `NNN-spec.md` / `NNN-spec-refined.md` and separate `*-research-*` sessions — historical, left as-is. The `NNN-spec*.md` glob still finds the base spec, and re-running spec-refine edits it in place from then on.

## Composes

The **UI unspecified** gap (when the requirement involves UI; see *Gap taxonomy*) is resolved by **composing** the **`ui-design`** capability (built-in default `ui-spec`; rebindable via `.workflow/skills.toml`): it authors the UI spec natively (structure, vocabulary, Markdown format). It is a third gap-resolution mode (next to *research* and *human*): the loop contributes iteration/Q&A (design system, theme, variants, disambiguation) **via the same structured-choice**, and integrates the result as the spec's `## UI spec` section.

> **Two levels of the same capability:** here (SPEC) it produces `## UI spec` — the UI's *what*, coarse grain; in PLAN the plan loops produce **per-screen design SPECs** derived from that section (see [`SPEC.md`](../../artifacts/artifacts-design/SPEC.md)).

Other transversal capabilities the engine always uses: `research` (**inline** — chassis § *Research*), `sql` (DB rule inside research — chassis). All resolved by config; `off` → the loop continues without the capability and, if it was needed, says so or asks. The spec's **prose** follows the **ambient** writing conventions (the host auto-applies an installed writing skill if present), not a composed role.

> **Ambient conventions (not roles):** code/testing/writing standards and `creating-tools` are standalone skills the host auto-discovers by `description` — Workline neither binds nor depends on them. Full doctrine: [../../roles/README.md](../../roles/README.md).

## Deliverable schema (the spec, edited in place)

The spec is completed **in place**: the draft's sections get **completed** + two new ones are **added** (`Refinement decisions`, `Q&A traceability`). NO separate file is created.

```markdown
# Spec NNN — <slug>

> Refined in place by spec-refine-loop

## Origin                 (opt. — preserved from the draft)
## Requirement            (sharpened, unambiguous)
## Context                (complete)
## Scope                  (clear In / Out)
## Acceptance criteria    (testable, - [ ]; EARS / Given-When-Then style recommended)
## Assumptions            (declared)

## UI spec                (opt. — if UI is involved; via the ui-design capability / ui-spec skill)
Structured Markdown description (screens → regions/components). See [`ui-spec`](../../roles/ui-spec/ROLE.md).

## Refinement decisions   ← NEW (ADDED)
What was defined while refining and why. Includes what inline research
resolved (with a reference to the session's CONCLUSIONS).

## Q&A traceability       ← NEW (ADDED)
Every doubt asked to the human + the chosen answer.

## Open questions         (ideally "None"; whatever remains is deferred)
```

> **Refined mark (contract with PLAN):** the presence of `## Refinement decisions` + `## Q&A traceability` distinguishes a refined spec from a draft — plan-new detects it this way, NOT by filename; without those 2 sections plan-new soft-suggests spec-refine.

> **Acceptance criteria = static testable criteria** (the "what"): plan-exec validates them, but progress is tracked in the PLAN (its Tasks), never by ticking these `- [ ]` in the spec; the spec never mutates by execution, only by a re-refine.

## Gap taxonomy (= weak sections of the schema)

`detect_gaps(work)` looks for these signals; each has a resolver:

| Gap | Signal | Resolved by |
|---|---|---|
| Vague requirement | the what/why is ambiguous | **human** |
| Incomplete context | systems/components unidentified | **research** |
| Blurry scope | `Out` missing, or In/Out overlap | **human** |
| Untestable criteria | acceptance not verifiable | **human** (derive + confirm) |
| Open questions pending | explicit doubts | by nature |
| Hidden assumptions | the spec assumes unstated things | **research** validates / **human** confirms |
| Internal contradiction | sections contradict each other | **human** |
| UI unspecified *(if it applies)* | the requirement involves UI but `## UI spec` is missing | **`ui-design` capability** |

## Sequence

```
spec-refine-loop(spec):
  input = glob(NNN-spec*.md) | argument (path)          # always the spec itself (in place)
  refine_session = create_or_resume("<slug>-spec-refine") # <slug> from the input spec; CLI prepends global NNN; resume locates by descriptor/origin
  seed SESSION.Success criteria = acceptance criteria + analyze-gate checklist   # verification-first: BEFORE iterating
  work = read(input)  (+ apply checkpoint progress if resuming)
  attempts = {}                                          # anti re-fire per gap
  repeat:
    gaps = detect_gaps(work)  minus the "exhausted" gaps
    if gaps == ∅: break
    batch = top ≤3 gaps ; pending_human = []
    seed CHECKPOINT.Pending/Next = batch (refine_session) # BEFORE: seed the intent (artifact-first)
    for each gap in batch:
      if gap = UI (requirement involves UI, ## UI spec missing):
        compose ui-design → author ## UI spec    # design-system/theme via structured-choice (counts in the batch)
        work = integrate(work, ui)               # → ## UI spec
      else if factual(gap) and attempts[gap] < MAX:
        if it needs DB and >1 MCP without default → queue "MCP choice" in pending_human
        res = research_inline(gap)           # in the current session: ANALYSIS-FILE → CONCLUSIONS (+read-only SCRIPTS.sql)
        if res.conclusive: work = integrate(work, res)     # → Refinement decisions
        else: attempts[gap]++ ; if attempts[gap] >= MAX → pending_human.push(gap)
      else:
        pending_human.push(gap)
    update CHECKPOINT (refine_session)        # AFTER: Pending→Completed, at every gap boundary (chassis § artifact-first cycle)
    if pending_human not empty:
      ans = structured_choice(content: pending_human (≤3), flow: [Compactar, Cerrar])
      switch(flow):
        Compactar → write CHECKPOINT (refine_session) ; compact(harness) ; continue
        Cerrar    → goto finalize
      work = integrate(work, ans)            # → Q&A traceability / Open questions
  # no material gaps → analyze gate = Success criteria green (read-only) before offering Guardar:
  issues = analyze(work)   # criteria trace to the Requirement · no contradictions · coherent Scope · Open questions closed/deferred
  if issues: gaps += issues ; continue            # findings come back into the loop as gaps
  ans = structured_choice(content: [Guardar refinada, Preguntar algo más],
                        flow: [Compactar, Cerrar])
  Guardar            → edit_in_place_with_confirm(spec)  # completes sections + inserts UI spec/Refinement decisions/Q&A ; goto finalize
  Preguntar algo más → continue
  flow Compactar/Cerrar → handle the same way
finalize:
  write CHECKPOINT (refine_session)                     # always persisted
  if deferred/follow-ups exist → write/update BACKLOG (reason + deferred Open questions)
  close refine_session ; report
```

## Compact / resume — SPEC keys

Full mechanism (3 cases, `Compactar`, re-run on demand with `--reopen`) in the chassis (§ *Compact / resume*). SPEC keys:

- The **prior-work mark** is the presence of `## Refinement decisions` + `## Q&A traceability` in the spec (the *refined mark*, see *Deliverable schema*).
- Re-refining on demand is a **first-class operation** while the flow stays in SPEC (new requirements, scope changes, after re-reading the spec): it always reads the **spec itself**, incremental re-refinement; on `Guardar`, edits in place with confirmation.

## Convergence / exit

- **No material gaps** → **analyze gate** (read-only) = **`Success criteria` green** (*verification-first*; the SPEC instance of the chassis convergence gate): every acceptance criterion traces to the `Requirement`, no internal contradictions, coherent `Scope` In/Out, `Open questions` closed or explicitly deferred. Whatever fails **comes back as a gap**; if it passes → offer `Guardar especificación refinada`.
- `Guardar` → `edit_in_place_with_confirm(spec)` and `finalize`.
- `Cerrar` → the chassis `finalize` (always persists `CHECKPOINT`; `BACKLOG` **only if** something is deferred — here: close reason + deferred `Open questions`).

## Integration (where each resolution lands)

- Resolved via **inline research** → the spec's `## Refinement decisions` (+ ref to the session's `CONCLUSIONS`).
- Resolved via **human** → the spec's `## Q&A traceability`.
- Resolved via the **`ui-design` capability** (UI gap) → the spec's `## UI spec` section.
- **Inconclusive or unresolved research** → the spec's `## Open questions` (deferred) + the refine session's `BACKLOG.md` (only if something is deferred).
