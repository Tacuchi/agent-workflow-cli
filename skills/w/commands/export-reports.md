---
description: Use to promote findings from N sessions into ONE numbered Markdown report under docs/reports/. Read-only over sessions; `aw export-reports` owns the corpus, the numbering and the write. Never automatic.
argument-hint: "[--sessions <ids>] [--since <YYYY-MM-DD>] [--source <alias>]"
allowed-tools: ["Bash", "Read"]
---

## Run

1. `aw export-reports prepare --format human` (+ `--sessions`/`--since`/`--source`) → corpus, destination, shape, `input_digest`.
2. Answer with one JSON: `version`/`operation`/`input_digest`/`scope` **verbatim** — the `scope` carries the prepared scope, so 3 and 4 never repeat the scope flags; `state: "proposed"`, `artifacts` = `{ path, content }` per file, all inside the destination; `NNN` is advisory: `apply` renumbers.
3. `echo '<json>' | aw export-reports validate --format human` → preview + `approval_digest`; confirm scope and destination with the user.
4. `echo '<json>' | aw export-reports apply --approval <digest>`. On rejection nothing was written: fix and repeat step 3.

## What it produces

- `docs/reports/NNN-<slug>-YYYY-MM-DD.md`: ONE document that declares its audience and its scope in the opening lines.
- Never write into `docs/` with a file tool: one pass, all or nothing, no session or loop created/touched.
- Authoring ref: no longer loaded on the normal path.

## More context

`aw context-plan --command export-reports --signal <s> --root "${CLAUDE_PLUGIN_ROOT}/skills/w"` returns the extra documents a case needs; read exactly what it lists:

- `authoring` — the report's structure or audience is not obvious from the material → [`../exports/export-reports/EXPORT.md`](../exports/export-reports/EXPORT.md), no longer loaded on the normal path
