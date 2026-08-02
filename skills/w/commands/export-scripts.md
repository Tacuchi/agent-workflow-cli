---
description: Use to promote the type-B `SCRIPTS.sql` artifacts of N sessions into a docs/scripts/ bundle — continuous forwards plus rollback. `aw export-scripts` checks the bundle shape and NEVER executes SQL. Never automatic.
argument-hint: "[--sessions <ids>] [--since <YYYY-MM-DD>] [--source <alias>]"
allowed-tools: ["Bash", "Read"]
---

## Run

1. `aw export-scripts prepare --format human` (+ `--sessions`/`--since`/`--source`) → corpus, destination, shape, `input_digest`.
2. Answer with one JSON: `version`/`operation`/`input_digest` **verbatim**, `state: "proposed"`, `artifacts` = `{ path, content }` per file, all inside the destination; `NNN` is advisory: `apply` renumbers.
3. `echo '<json>' | aw export-scripts validate --format human` → preview + `approval_digest`; confirm scope and destination with the user.
4. `echo '<json>' | aw export-scripts apply --approval <digest>`. On rejection nothing was written: fix and repeat step 3.

## What it produces

- `docs/scripts/NNN-export-scripts-YYYY-MM-DD/`: `00-ROLLBACK.sql` and `README.md`, both required, + forwards `NN-<nombre>.sql` numbered **continuously from 01**; the CLI rejects a gap.
- Neither the AI nor the CLI executes the SQL: the bundle is for a human or DBA to apply.
- Never write into `docs/` with a file tool: one pass, all or nothing, no session or loop created/touched.

## More context

`aw context-plan --command export-scripts --signal <s> --root "${CLAUDE_PLUGIN_ROOT}/skills/w"` returns the extra documents a case needs; read exactly what it lists:

- `authoring` — the rollback derivation or the ordering is not obvious from the material → [`../exports/export-scripts/EXPORT.md`](../exports/export-scripts/EXPORT.md), no longer loaded on the normal path
