---
description: Use to consolidate the workspace's pending SQL into a docs/scripts/ bundle from a declared origin — continuous forwards plus rollback. `aw export-scripts` checks shape and NEVER executes SQL. Never automatic.
argument-hint: "[--code <session>] [--from sessions|bundles|workspace] [--exclude <nombre>] [--environment <ambiente>] [--sessions <ids>] [--since <YYYY-MM-DD>] [--source <alias>]"
allowed-tools: ["Bash", "Read"]
---

## Run

1. `aw export-scripts prepare --format human` (+ the flags above) → origin, material, destination, `input_digest`.
2. Answer with one JSON — `aw export-scripts --help` publishes the envelope. Copy `scope` **verbatim**, including `scope.seal`; 3 and 4 never repeat flags. The approved `NNN` is immutable.
3. `echo '<json>' | aw export-scripts validate --format human` → preview + `approval_digest`; confirm origin and destination.
4. `echo '<json>' | aw export-scripts apply --approval <digest>`. On rejection nothing was written: fix and repeat step 3.

## What it produces

- Bundle: README; forwards `01-ddl-tablas/`…`05-grants/NN-<nombre>.sql`; reverses in `rollback/<categoría>/`, global in `rollback/00-global/00-ROLLBACK.sql`.
- Nothing here executes SQL: applying the bundle is a handoff to an authorized operator.
- Never write into `docs/` with a file tool: one pass, all or nothing; no session touched.

## Net final state

Publish the final state, not a chronology: omit transients, write migrations in final form, reconcile the code.
Rollback safely reverses it; exclude concrete identities and test seeds. A previous bundle in the
origin is `MATERIAL A RECONCILIAR`, not history: two that contradict publish their net state, not their sum.
`ESTADO FINAL NETO` · `orden seguro para las dependencias` · `objetos compartidos y necesarios para el estado final`

## More context

`aw context-plan --command export-scripts --signal <s> --root "${CLAUDE_PLUGIN_ROOT}/skills/w"` returns the extra documents a case needs; read exactly those:

- `authoring` — the origin or the rollback is not obvious → [`../exports/export-scripts/EXPORT.md`](../exports/export-scripts/EXPORT.md), no longer loaded on the normal path
