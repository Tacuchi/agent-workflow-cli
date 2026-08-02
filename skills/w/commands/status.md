---
description: Use when the user asks what got done, what is pending, or where the work stands. Read-only workspace dashboard: pending pipeline by default, full history under `detalle`. Backed by `aw status`; writes nothing.
argument-hint: (none — pass `detalle` for the full inventory)
allowed-tools:
  [
    "Bash",
    "Read",
  ]
---

# status — workspace state

Read-only single pass: no loop, no session, no writes. Transversal.

## Run

1. `aw status --format human`; `--detail` for the full inventory ("detalle", "todo", "historial").
2. **Relay it verbatim.** The CLI already selects, groups and humanizes. Never paraphrase, re-sort, add or drop a line.
3. **Host context, opportunistic.** Host with *cheap* host-memory → append a `▸ CONTEXTO DEL HOST` section with a few recent-focus signals. Otherwise omit silently. Never scan transcripts, never ask.

> **The default view is what is LEFT TO DO** — unrefined specs, refined specs with no plan, plans not `done`. `--detail` brings back history, sessions and discarded items — re-run rather than explain an absence.

> **Automation reads JSON.** Piped or with `--json` / `--format json`, `aw status` emits its machine-readable envelope; `--detail` is human-only.

`initialized: false`, everything empty → say the folder is not an agent-workflow workspace and suggest `/w:workspace-init`.

## More context

`aw context-plan --command status --signal <s> --root "${CLAUDE_PLUGIN_ROOT}/skills/w"` returns the extra documents a case needs; read exactly what it lists.
