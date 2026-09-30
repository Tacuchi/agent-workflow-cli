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

> **Minimum context — a guide; only Git/DB is fixed. Read even if nothing else is:**
>
> 1. **Session first** — open or resume the run before touching code: `aw flow start --flow plan-exec --name <slug> --objetivo "<one-line objective>" --root "${CLAUDE_PLUGIN_ROOT}/skills/w"`; keep its `CHECKPOINT.md` updated (`## Completed` · `## Pending / Next`; `## Open questions` only while live doubts exist).
> 2. **Git/DB** — verify declared branches at each batch's local precondition; the CLI commits exact changed paths once per source
>    after batch checks and that batch's approval.
>    DML/DDL stays in `SCRIPTS.sql`.
> 3. **Ask, don't invent** — user-dependent decisions go through questions with a recommended option first (≤3 content questions + the `flow` control `Compactar`/`Cerrar`).
> 4. **Language** — everything user-facing (questions, option labels, reports) goes in the **user's language**.

## Run the loop

1. Read, in order, the `read_set` entries it returned that are not `loaded`.
2. Follow it end to end: check executability, infer live batches, execute each without internal
   validation pauses (compiling after each change), then validate/commit at its close.

Answer each boundary per `aw flow --help`; the CLI fills what it knows. A stuck frontier: `aw flow recover` or `aw flow restart`; `aw flow annul` reopens a miscredited batch.

> `plan-exec-loop` is **not** a skill invocable by name — it is this command's operating manual. The command **is** the entry; the loop is its body. It is **resumable**: an existing CHECKPOINT continues from there.

## Two gates that send work back

- **Entry gate** — a plan that would force execution to invent its own structure is not run in silence. A minor gap is normalized **with your consent**; a structural one hands off to `/w:plan-refine`.
- **Deviation gate** — the loop owns it, with **four** exits. Local detail is resolved inline. A divergence that leaves the promise intact registers a decision note on `S{NNN}/AC-nn` and execution continues. A **structural** one (a contract, the components, the phase order, the simulation boundary) returns to `/w:plan-refine`; a moved **promise of the product** (result, scope, business rule, the outcome a criterion states) returns to `/w:spec-refine`. What does not compose against this lineage at all escalates to a spec of its own.

## More context

`aw context-plan --command plan-exec --signal <s> --root "${CLAUDE_PLUGIN_ROOT}/skills/w"` returns the extra documents a case needs; read exactly what it lists:

- `db` — the plan touches a database → [`../modules/EXEC-DB-POLICY.md`](../modules/EXEC-DB-POLICY.md)
- `probe` — a task is a PoC → [`../modules/EXEC-PROBE-TASKS.md`](../modules/EXEC-PROBE-TASKS.md)
- `simulation` — **only when the change carries temporary behavior**, its boundary is declared and its retirement identified → [`../modules/SIMULATION-LIFECYCLE.md`](../modules/SIMULATION-LIFECYCLE.md)
