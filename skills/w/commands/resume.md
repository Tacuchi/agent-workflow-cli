---
description: Use when the user asks to resume or pick up pending work — an open session, a spec to refine, a plan mid-execution. `aw resume` derives the priority and the re-entry command. Read-only, transversal.
argument-hint: "[docs/specs/… | docs/plans/… | NNN | --code <session>]"
allowed-tools:
  [
    "Bash",
    "Read",
  ]
---

# resume — pending work

Read-only **with or without an argument**: no loop, no session, and it writes nothing in `docs/` or `.workflow/`. Sibling of `aw status`; not `aw session-resume` / `aw resume-summary` (internals).

1. **Never re-decide** — priority, ties, the spec→plan link and the command are the CLI's. No re-sort by date, no slug match, no tie broken.
2. Output in the **user's language**.

## Run

1. `aw resume --format human`. For one artifact, **pass it as the positional** (`aw resume docs/plans/009-plan-x.md`, or its `NNN`); for a session, `aw resume --code <NNN | folder>`; neither walks the pipeline.
2. **Relay it verbatim**, then offer the choice.

## Choose and continue

No target → **every** pending item as `candidates` in the CLI's order, `proposal` the recommended one. It runs no route and writes nothing: continuing is yours.

1. **Analyse briefly first** — what is pending, what you recommend, why. From that envelope alone: no transcript, no repo walk.
2. **One option per candidate** — only for CLI candidates, in its order — each with its re-entry command, plus the `flow` slot. Canonical [option shape](../loops/CHASSIS.md#structured-choice-design--batching) and [host binding](../harness/HARNESS.md#harness-binding-matrix): the title is the label, `Progreso` + `Siguiente` the sentence.
3. **Past the host's ceiling**, group by class into ≤3 questions; if a class still will not fit, present them **all** as labelled markdown and declare the degradation. Nothing trimmed, merged or dropped.
4. **Choosing invokes that command in the same turn.** The destination flow opens its own session and consent boundaries.
5. **No candidates** → nothing is pending: say it and stop, opening no choice; cheap host-memory may add a recent-focus note, never expensive or blocking. No workspace → offer `/w:workspace-init`.

## What the CLI decides (do not re-derive)

- **Priority**: unrefined spec → refined spec with no plan → plan not `done`; started first. A loose session is a notice, never a candidate.
- **Ties**: equal priority and progress → no single recommendation; date never splits.
- **Spec→plan link**: `Derived from` or `## Origin`, never the slug; unproven stays unplanned.
- **The route**: `/w:spec-refine`, `/w:plan-new`, `/w:plan-exec`, `aw session-resume --reopen`.

> A plan is not finished because its boxes are ticked: re-entry is the first phase not `validada`, a `bloqueada` phase with its declared reason, or — phases green, plan never closed — the final validation. One declaring `done` over open work comes back as inconsistent. An obligation leaving it neither runnable nor closable is said before its percentage.

## More context

`aw context-plan --command resume --signal <s> --root "${CLAUDE_PLUGIN_ROOT}/skills/w"` returns the extra documents a case needs; read exactly what it lists.
