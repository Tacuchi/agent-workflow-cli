---
description: Use when a plan is ready to implement — the real work: code edits, proposed SQL scripts, created tools. Starts or resumes plan-exec-loop over docs/plans/PPP-plan-<slug>.md, phase by phase, validating each before closing it. Git-safe (proposes commits, never push/--amend).
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

Starts or resumes `plan-exec-loop` (Layer 2), which executes the real work phase by phase — each phase a **verifiable state of the system**, not a batch of technical chores. The plan is a living document the loop keeps updated: each `### Fn` carries its own `> Estado:` line (`pendiente` | `en ejecución` | `bloqueada` | `validada`) next to its task checkboxes.

> **Hard floor — applies even if you read nothing beyond this file:**
>
> 1. **Session first** — create/resume the run's session before touching code: `aw session-create --type exec --name <slug>-plan-exec --objetivo "<one-line objective>"`; keep its `CHECKPOINT.md` updated (`## Completed` · `## Pending / Next`; `## Open questions` only while live doubts exist).
> 2. **Git/DB** — verify each source's expected branch before editing (`aw check-branch`); commits are **proposed**, never executed without approval; **never** `push`/`--amend`/`--no-verify`; never execute DML/DDL (SQL goes to the session's `SCRIPTS.sql`).
> 3. **Ask, don't invent** — user-dependent decisions go through questions with a recommended option first (≤3 content questions + the `flow` control `Compactar`/`Cerrar`).
> 4. **Language** — everything user-facing (questions, option labels, reports) goes in the **user's language**.

## Run the loop

1. `aw context-plan --command plan-exec --root "${CLAUDE_PLUGIN_ROOT}/skills/w"` — read exactly the documents it lists, in order.
2. Follow the loop manual end to end, taking `$ARGUMENTS` as input: it checks executability on entry, executes phase by phase (git-safe, DB scripts-only), keeps the plan alive and reports.

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
