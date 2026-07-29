---
description: Use to promote diagram material from N sessions into a numbered dossier under docs/diagrams/. Read-only over sessions; `aw export-diagrams` owns the corpus, the numbering and the write. Never automatic.
argument-hint: "[--sessions <ids>] [--since <YYYY-MM-DD>] [--source <alias>]"
allowed-tools: ["Bash", "Read"]
---

## Run

1. `aw export-diagrams prepare --format human` (+ `--sessions`/`--since`/`--source`) → corpus, destination, shape, `input_digest`.
2. Answer with one JSON: `version`/`operation`/`input_digest` **verbatim**, `state: "proposed"`, `artifacts` = `{ path, content }` per file, all inside the destination; `NNN` is advisory: `apply` renumbers.
3. `echo '<json>' | aw export-diagrams validate --format human` → preview + `approval_digest`; confirm scope and destination with the user.
4. `echo '<json>' | aw export-diagrams apply --approval <digest>`. On rejection nothing was written: fix and repeat step 3.

## What it produces

- `docs/diagrams/NNN-export-diagrams-YYYY-MM-DD/`: `README.md` (required) + the diagrams in Markdown, plus their DSL (`.dsl`/`.puml`/`.mmd`) when it helps.
- Never write into `docs/` with a file tool: one pass, all or nothing, no session or loop created/touched.

## More context

`aw context-plan --command export-diagrams --signal <s>` returns the extra documents a case needs; read exactly what it lists:

- `authoring` — the notation or the `--engine` choice is not obvious from the material → [`../exports/export-diagrams/EXPORT.md`](../exports/export-diagrams/EXPORT.md), no longer loaded on the normal path
