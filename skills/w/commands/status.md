---
description: Read-only workspace dashboard — what got done / what is missing / what was discarded, with dates humanized in the user's language. Backed by `aw status`. Transversal command (not a flow); writes nothing.
argument-hint: (no arguments)
allowed-tools:
  [
    "Bash",
    "Read",
  ]
---

# status — workspace state (read-only)

Shows, simple and direct, the workspace state grouped as **Done / Missing / Discarded**. Single-pass, read-only: no loop, no sessions, writes nothing in `docs/` or `.workflow/`. **Transversal** command (belongs to no flow).

## Run

1. Run `aw status` (returns JSON; backed by `status-service`).
2. Render a readable summary from the JSON — do **not** show the raw JSON. Use the `relative` field verbatim (it comes pre-humanized in the user's language — Spanish). Head it with `workspace.name`.
3. Group into three blocks (the dashboard is user-facing → render it in the user's language; the canonical Spanish labels below):
   - `▸ HECHO` — specs with `refined: true`; plans with their progress (`tasks_done`/`tasks_total`, `progress_pct`); `closed` sessions.
   - `▸ FALTA` — `active` sessions; plans with pending tasks (`tasks_total − tasks_done`); specs with `open_questions > 0`.
   - `▸ DESCARTÓ` — every item in `discarded[]` (`kind: deferred` = deferred in BACKLOG; `kind: excluded` = excluded in CHECKPOINT), with its `text`.
4. Every line ends with its relative date after ` · ` (e.g. `· ayer en la mañana`). An empty section shows `— (nada)`. Never invent data not present in the JSON.
5. If `workspace.initialized` is `false` and everything is empty → say the folder is not an agent-workflow workspace (no `.workflow/`) and suggest `/w:workspace-init`.

Suggested format (plain text; user-facing labels in Spanish):

```
Workspace: <name>

▸ HECHO
  • plan <slug> — <done>/<total> tareas (<pct>%) · <relative>
  • spec <slug> — refinado · <relative>
  • <folder> (<type>) — cerrada · <relative>

▸ FALTA
  • <folder> (<type>) — activa · <relative>
  • plan <slug> — <pendientes> tareas pendientes
  • spec <slug> — <n> preguntas abiertas

▸ DESCARTÓ
  • <text> (<kind>) · <relative>
```

## Plan mode

Same as execution: run `aw status` (read-only) and show the summary. There are no changes to apply.

## Resources

- CLI: `aw status` (service `status-service`; dates via `humanize-es`)
- Design reference: `docs/referencias/workflow-skills/status.md`
