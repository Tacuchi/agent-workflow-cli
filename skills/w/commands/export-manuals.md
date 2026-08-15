---
description: Use to promote user and operator manuals from N sessions into a numbered dossier under docs/manuals/. Read-only over sessions; `aw export-manuals` owns numbering, INDEX.md and the write. Never automatic.
argument-hint: "[--sessions <ids>] [--since <YYYY-MM-DD>] [--source <alias>]"
allowed-tools: ["Bash", "Read"]
---

## Run

1. `aw export-manuals prepare --format human` (+ `--sessions`/`--since`/`--source`) → corpus, destination, shape, `input_digest`.
2. Answer with one JSON: `version`/`operation`/`input_digest`/`scope` **verbatim** — the `scope` carries the prepared scope, so 3 and 4 never repeat the scope flags; `state: "proposed"`, `artifacts` = `{ path, content }` per file, all inside the destination; `NNN` is advisory: `apply` renumbers.
3. `echo '<json>' | aw export-manuals validate --format human` → preview + `approval_digest`; confirm scope and destination with the user.
4. `echo '<json>' | aw export-manuals apply --approval <digest> [--overwrite]`. On rejection nothing was written: fix and repeat step 3.

## What it produces

- `docs/manuals/NNN-export-manuals-YYYY-MM-DD/`: `README.md` (required) + the manuals, in Markdown.
- `docs/manuals/INDEX.md`: optional; the **only** file an export may replace, with approved `--overwrite`.
- Never write into `docs/` with a file tool: one pass, all or nothing, no session or loop created/touched.
- Authoring ref: no longer loaded on the normal path.

## More context

`aw context-plan --command export-manuals --signal <s> --root "${CLAUDE_PLUGIN_ROOT}/skills/w"` returns the extra documents a case needs; read exactly what it lists:

- `authoring` — the manual's structure or audience is not obvious from the material → [`../exports/export-manuals/EXPORT.md`](../exports/export-manuals/EXPORT.md), no longer loaded on the normal path
