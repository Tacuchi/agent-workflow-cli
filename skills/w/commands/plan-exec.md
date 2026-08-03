---
description: Use when a plan is ready to implement. Starts/resumes plan-exec-loop over docs/plans/PPP-plan-<slug>.md, re-inferring continuous batches and deferring their validation, review and single-per-source commits to batch close.
argument-hint: <docs/plans/PPP-plan-<slug>.md>
allowed-tools:
  [
    "Bash",
    "Read",
    "Write",
    "Edit",
  ]
---

# plan-exec — trampoline to the execution loop

Starts or resumes `plan-exec-loop` (Layer 2). Phases remain verifiable states; effective batches are
execution units. The loop re-infers them from live state using
[`PLAN-EXECUTION-BATCHES`](../modules/PLAN-EXECUTION-BATCHES.md), then updates each phase's
checkboxes and `> Estado:` line in the living plan.

> **Hard floor — applies even if you read nothing beyond this file:**
>
> 1. **Session first** — create/resume the run's session before touching code: `aw session-create --type exec --name <slug>-plan-exec --objetivo "<one-line objective>"`; keep its `CHECKPOINT.md` updated (`## Completed` · `## Pending / Next`; `## Open questions` only while live doubts exist).
> 2. **Git/DB** — branch-check before a batch; exactly one commit per affected source after its
>    checks/review. Use one final approval unless the user explicitly pre-authorized green commits.
>    Never `push`/`--amend`/`--no-verify`; DML/DDL stays in `SCRIPTS.sql`.
> 3. **Ask, don't invent** — user-dependent decisions go through questions with a recommended option first (≤3 content questions + the `flow` control `Compactar`/`Cerrar`).
> 4. **Language** — everything user-facing (questions, option labels, reports) goes in the **user's language**.

## Run the loop

1. `aw context-plan --command plan-exec --root "${CLAUDE_PLUGIN_ROOT}/skills/w"` — read exactly the documents it lists, in order.
2. Follow it end to end: check executability, infer live batches, execute each without internal
   validation pauses, then validate/review/commit at its close.

> `plan-exec-loop` is **not** a skill invocable by name — it is this command's operating manual. The command **is** the entry; the loop is its body. It is **resumable**: an existing CHECKPOINT continues from there.

## Two gates that send work back

- **Entry gate** — a plan that would force execution to invent its own structure is not run in silence. A minor gap is normalized **with your consent**; a structural one hands off to `/w:plan-refine`.
- **Deviation gate** — local detail is resolved inline. A **structural** deviation (a contract, the participating components, the phase order, the simulation boundary) stops execution and returns to `/w:plan-refine`; a **functional** change (result, scope, business rule, acceptance criterion) returns to `/w:spec-refine`.

## More context

`aw context-plan --command plan-exec --signal <s> --root "${CLAUDE_PLUGIN_ROOT}/skills/w"` returns the extra documents a case needs; read exactly what it lists:

- `db` — the plan touches a database → [`../modules/EXEC-DB-POLICY.md`](../modules/EXEC-DB-POLICY.md)
- `probe` — a task is a PoC → [`../modules/EXEC-PROBE-TASKS.md`](../modules/EXEC-PROBE-TASKS.md)
- `simulation` — **only when the change carries temporary behavior**, its boundary is declared and its retirement identified → [`../modules/SIMULATION-LIFECYCLE.md`](../modules/SIMULATION-LIFECYCLE.md)
- `ui` — the plan references design SPECs → [`../modules/PLAN-DESIGN-SPECS.md`](../modules/PLAN-DESIGN-SPECS.md)
