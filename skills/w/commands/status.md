---
description: Use when the user asks what got done, what is pending, or where the work stands. Read-only hub dashboard: pending pipeline by default, full history under `detalle`. Backed by `aw status`; writes nothing.
argument-hint: (none — `detalle` full inventory, `todos` every hub)
allowed-tools:
  [
    "Bash",
    "Read",
  ]
---

# status — hub state

Read-only single pass: no loop, no session, no writes. Transversal.

## Run

1. `aw status --format human`; `--detail` for the full inventory ("detalle", "todo", "historial"); `todos` → `aw hubs status --format human`.
2. **Relay it verbatim**: never paraphrase, re-sort, add or drop a line.
3. **Host context, opportunistic.** Cheap host-memory → append a `▸ CONTEXTO DEL HOST` section with a few recent-focus signals. Otherwise omit silently; never scan transcripts, never ask.

> **The default view is what is LEFT TO DO** — unrefined specs, refined specs with no plan, plans not `done` — and each says **what it still owes**, under its title. `--detail` brings back history, sessions and discarded items: re-run, never explain an absence.

> **An obligation comes before the percentage.** What leaves an item neither runnable nor closable — an unresolvable design reference, a pending reconciliation, an unprovable baseline — takes the title, and the progress drops below it. A plan at `100%` with every phase `validada` is not finished either: it owes its final validation and its close.

> **Sessions are not the user's work.** One carrying work with no document of its own is a **notice**, never a pending row.

> **Automation reads JSON** (piped or `--json`): the human view's scope; `--detail` the full inventory; `--plan`/`--spec` one record.

Nothing pending → one line, no empty section. In an implicit hub that is genuinely "nothing pending"; this read creates no marker or other file.

## More context

`aw context-plan --command status --signal <s> --root "${CLAUDE_PLUGIN_ROOT}/skills/w"` returns the extra documents a case needs; read exactly what it lists.
