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

1. **Read-only** — never run the route; the user does.
2. **Never re-decide** — priority, ties, the spec→plan link and the command come from the CLI. No re-sort by date, no slug match, no tie broken.
3. **Ask via structured-choice** only for CLI candidates: one option each, in order, plus `flow`.
4. Output in the **user's language**.

## Run

1. `aw resume --format human`. For one artifact, **pass it as the positional** (`aw resume docs/plans/009-plan-x.md` or its `NNN`); for a session, `aw resume --code <NNN | folder>`; none walks the pipeline.
2. **Relay it verbatim.**
3. Nothing pending → say so and stop; cheap host-memory may add a recent-focus note, never expensive or blocking.

## What the CLI decides (do not re-derive)

- **Priority**: unrefined spec → refined spec with no plan → incomplete plan → loose checkpoint; started plans first.
- **Ties**: equal priority and progress → candidates; date never splits.
- **Spec→plan link**: the plan's `Derived from` or `## Origin`, never the slug; unproven stays unplanned.
- **The route**: `/w:spec-refine`, `/w:plan-new`, `/w:plan-exec` or `aw session-resume --reopen`.

> A plan is not finished because its boxes are ticked. `aw resume` re-enters at the first phase not `validada`, names a `bloqueada` phase with its declared reason, and when the phases are green but the plan never closed, the final validation remains. A plan declaring `done` over open work comes back as inconsistent — repair first.

## More context

`aw context-plan --command resume --signal <s>` returns the extra documents a case needs; read exactly what it lists.
