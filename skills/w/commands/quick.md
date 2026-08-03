---
description: Use for a scoped, direct task that warrants no spec or plan — a fix, a tweak, a chore ("fix this bug", "rename X"). Starts quick-loop with minimal ceremony; never touches docs/. Escalates when the objective exceeds a quick: to SPEC live with consent, to PLAN deferred.
argument-hint: <prompt with the scoped task>
allowed-tools:
  [
    "Bash",
    "Read",
    "Write",
    "Edit",
  ]
---

# quick — trampoline to the lightweight loop

Delegates to `quick-loop` (Layer 2). Creates a light session (traceability + resume) — unless the **entry size gate** escalates first.

> **Hard floor — applies even if you read nothing beyond this file:**
>
> 1. **Size gate BEFORE any session** — if the objective exceeds a quick (≥2 clear signals: needs architecture · ≥2 sources · several deliverables · large feature/refactor · ambiguous requirements), ask first with these verbatim options: `Cambiar a SPEC` *(recommended)* · `Seguir en quick` · `Recortar alcance`. If it escalates, create **no** quick session.
> 2. **Session first** — otherwise, before touching code, create/resume the run's session: `aw session-create --type quick --name <slug>-quick --objetivo "<one-line objective>"`; keep its `CHECKPOINT.md` updated (`## Completed` · `## Pending / Next`; `## Open questions` only while live doubts exist).
> 3. **Git/DB** — commits are **proposed**, never executed without approval; **never** `push`/`--amend`/`--no-verify`; never execute DML/DDL (SQL goes to the session's `SCRIPTS.sql`).
> 4. **Language** — everything user-facing (questions, option labels, reports) goes in the **user's language**.

## Run the loop

1. `aw context-plan --command quick --root "${CLAUDE_PLUGIN_ROOT}/skills/w"` — read exactly the documents it lists, in order.
2. Follow the loop manual end to end, taking `$ARGUMENTS` as the task: it evaluates the size gate, creates the light session, works with minimal ceremony (git-safe), escalates if the task grows, and reports.

> `quick-loop` is **not** a skill invocable by name — it is this command's operating manual. The command **is** the entry; the loop is its body.

## Two things this command never does

- **It never writes `docs/`** and it exports nothing. It may READ a design package; changing one escalates.
- **It never re-derives what the conversation already settled** — that analysis is *input* (`## Origin` = adopted).

## More context

`aw context-plan --command quick --signal <s> --root "${CLAUDE_PLUGIN_ROOT}/skills/w"` returns the extra documents a case needs; read exactly what it lists:

- `db` — the task reads or writes a database → [`../modules/DB-SCRIPTS-ONLY.md`](../modules/DB-SCRIPTS-ONLY.md)
- `probe` — a runnable doubt has to be settled by running something → [`../modules/PROBE.md`](../modules/PROBE.md)
- `adopted` — the conversation already established the analysis → [`../modules/ADOPTED-CONTEXT.md`](../modules/ADOPTED-CONTEXT.md)
