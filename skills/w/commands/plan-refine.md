---
description: Use when a plan must become executable before running it. Starts plan-refine-loop, which re-shapes docs/plans/PPP-plan-<slug>.md in place into verifiable functional states and re-infers its execution batches.
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

> **Minimum context — a guide; only Git/DB is fixed. Read even if nothing else is:**
>
> 1. **Read first** — `aw flow read --flow plan-refine --doc <document>` returns the state and `read_digest`. Save with `aw flow save --flow plan-refine ... --read-digest <read_digest>` on both calls: preview, then write with `--approval <approval_digest>`. The document is the record; nothing is kept between turns.
> 2. **Ask, don't invent** — user-dependent decisions go through questions with a recommended option first (≤3 content questions + the `flow` control `Compactar`/`Cerrar`).
> 3. **Write boundary** — this flow edits only `docs/plans/…` (in place, with confirmation); nothing else lands in `docs/`.
> 4. **Language** — everything user-facing (questions, option labels, the plan's content) goes in the **user's language**.

## Run the loop

1. Read [`plan-refine-loop`](../loops/plan-refine-loop/LOOP.md).
2. Follow the loop manual end to end, taking `$ARGUMENTS` as input: it detects state/resume, runs the gap-driven engine, converges and reports.

> `plan-refine-loop` is **not** a skill invocable by name — it is this command's operating manual. The command **is** the entry; the loop is its body.

**Expected output: an executable plan.** Each phase has evidence and an exit condition;
**only when the change carries temporary behavior**, it declares that boundary. The complete partition follows
[`PLAN-EXECUTION-BATCHES`](../modules/PLAN-EXECUTION-BATCHES.md), so execution need not invent or
ask about units.

## More context

`aw context-plan --command plan-refine --signal <s> --root "${CLAUDE_PLUGIN_ROOT}/skills/w"` returns the extra documents a case needs; read exactly what it lists:

- `input` — where this plan came from, and what a plan returned by `plan-exec` means → [`../modules/PLAN-INPUT.md`](../modules/PLAN-INPUT.md)
- `resume` — a prior refinement of this plan may exist → [`../modules/PLAN-REFINE-KEYS.md`](../modules/PLAN-REFINE-KEYS.md)
- `replan` — work already executed has to be re-planned around → [`../modules/REPLANNING.md`](../modules/REPLANNING.md)
- `simulation` — the change carries temporary behavior, so **only when** it does, its boundary is declared → [`../modules/SIMULATION-LIFECYCLE.md`](../modules/SIMULATION-LIFECYCLE.md)
