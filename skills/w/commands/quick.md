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

Delegates to `quick-loop` (Layer 2); git is its only record — unless the **entry size gate** escalates first.

> **Minimum context — a guide; only Git/DB is fixed. Read even if nothing else is:**
>
> 1. **Size gate BEFORE any work** — if the objective exceeds a quick (≥2 signals: architecture · ≥2 sources · several deliverables · large refactor · ambiguous requirements), ask first, verbatim: `Cambiar a SPEC` *(recommended)* · `Seguir en quick` · `Recortar alcance`. If it escalates, nothing is written.
> 2. **Git is the record** — an interrupted quick shows only in `git status` of its source.
> 3. **Git/DB** — `aw flow propose-commit` for exact paths (`--checkout <path>` when the work lives in a unit or worktree), then `aw flow commit` only with the approved digest; never execute DML/DDL (SQL goes as a file in `docs/scripts/`).
> 4. **Language** — everything user-facing goes in the **user's language**.

## Run the loop

1. Read [`quick-loop`](../loops/quick-loop/LOOP.md).
2. Follow it end to end with `$ARGUMENTS` as the task: size gate, minimal ceremony, escalation if it grows, report.

> `quick-loop` is **not** a skill invocable by name — it is this command's operating manual. The command **is** the entry; the loop is its body.

## Two things this command never does

- **It never writes `docs/`**; a changed product promise escalates.
- **It never re-derives what the conversation already settled** — that analysis is *input* (`## Origin` = adopted).

## More context

`aw context-plan --command quick --signal <s> --root "${CLAUDE_PLUGIN_ROOT}/skills/w"` returns the extra documents a case needs; read exactly what it lists:

- `db` — the task reads or writes a database → [`../modules/DB-SCRIPTS-ONLY.md`](../modules/DB-SCRIPTS-ONLY.md)
- `probe` — a runnable doubt has to be settled by running something → [`../modules/PROBE.md`](../modules/PROBE.md)
- `adopted` — the conversation already established the analysis → [`../modules/ADOPTED-CONTEXT.md`](../modules/ADOPTED-CONTEXT.md)
