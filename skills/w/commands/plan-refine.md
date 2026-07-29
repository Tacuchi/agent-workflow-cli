---
description: Use when a plan must become executable before running it — new requirements, scope tweaks, phases shaped as file lists, or a structural deviation returned by plan-exec. Starts plan-refine-loop, which re-shapes docs/plans/PPP-plan-<slug>.md in place into verifiable functional states.
argument-hint: <docs/plans/PPP-plan-<slug>.md>
allowed-tools:
  [
    "Bash",
    "Read",
    "Write",
    "Edit",
  ]
---

# plan-refine — trampoline to the plan refinement loop

`spec-refine`'s twin, over the **plan**. An **auxiliary, NOT mandatory** step: `plan-new` already produces a plan from the refined spec, and `plan-exec` runs **any** plan that is already executable. This exists for when changes arise before executing — new requirements, scope adjustments, deps or risks spotted while re-reading — worth incorporating without regenerating from scratch.

> **Hard floor — applies even if you read nothing beyond this file:**
>
> 1. **Session first** — create/resume the run's session before working: `aw session-create --type refine --name <slug>-plan-refine --objetivo "<one-line objective>"`; keep its `CHECKPOINT.md` updated (`## Completed` · `## Pending / Next`; `## Open questions` only while live doubts exist).
> 2. **Ask, don't invent** — user-dependent decisions go through questions with a recommended option first (≤3 content questions + the `flow` control `Compactar`/`Cerrar`).
> 3. **Write boundary** — this flow edits only `docs/plans/…` (in place, with confirmation); nothing else lands in `docs/`.
> 4. **Language** — everything user-facing (questions, option labels, the plan's content) goes in the **user's language**.

## Run the loop

1. `aw context-plan --command plan-refine` — read exactly the documents it lists, in order.
2. Follow the loop manual end to end, taking `$ARGUMENTS` as input: it detects state/resume, runs the gap-driven engine, manages sessions, converges and reports.

> `plan-refine-loop` is **not** a skill invocable by name — it is this command's operating manual. The command **is** the entry; the loop is its body.

**Expected output: an executable plan.** The loop converges on its **executability gate** — each phase a verifiable state with its evidence, its exit condition and, **only when the change carries temporary behavior**, its simulation boundary — so `plan-exec` implements it without inventing contracts, observable states, order or evidence.

## More context

`aw context-plan --command plan-refine --signal <s>` returns the extra documents a case needs; read exactly what it lists:

- `input` — where this plan came from, and what a plan returned by `plan-exec` means → [`../modules/PLAN-INPUT.md`](../modules/PLAN-INPUT.md)
- `resume` — a prior refinement of this plan may exist → [`../modules/PLAN-REFINE-KEYS.md`](../modules/PLAN-REFINE-KEYS.md)
- `replan` — work already executed has to be re-planned around → [`../modules/REPLANNING.md`](../modules/REPLANNING.md)
- `simulation` — the change carries temporary behavior, so **only when** it does, its boundary is declared → [`../modules/SIMULATION-LIFECYCLE.md`](../modules/SIMULATION-LIFECYCLE.md)
- `ui` — the refine touches UI → [`../modules/PLAN-REFINE-DESIGN-SPECS.md`](../modules/PLAN-REFINE-DESIGN-SPECS.md)
