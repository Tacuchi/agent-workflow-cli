---
description: Exports architecture/flow diagrams from N sessions to docs/diagrams/ as a numbered dossier. Backed by `aw export-diagrams`, which owns the corpus, the numbering, the shape check and the atomic publication. Explicit, separate step — never automatic.
argument-hint: "[--sessions <ids>] [--since <YYYY-MM-DD>] [--source <alias>]"
allowed-tools:
  [
    "Bash",
    "Read",
  ]
---

# export-diagrams — export diagrams

Promotes diagram material from `.workflow/sessions/` into a numbered dossier under `docs/diagrams/`. Single-pass, read-only over sessions. **Transversal**: no flow, no loop, **never creates a session**.

## Run

1. `aw export-diagrams prepare --format human [--sessions <a,b>] [--since <YYYY-MM-DD>] [--source <alias>]` (`--detail` prints the full response contract). Returns the corpus, the destination, the required shape and an `input_digest`.
2. **Synthesize the deliverable.** Compose one JSON answer: `version`, `operation` and `input_digest` copied **verbatim**; `state: "proposed"`; `artifacts` with one `{ path, content }` per file, every path inside the destination the request declares. The `NNN` is consultative — `apply` reassigns it inside the lock.
3. `echo '<json>' | aw export-diagrams validate --format human` → preview + `approval_digest`.
4. **Confirm scope and destination with the user**, showing that preview.
5. `echo '<json>' | aw export-diagrams apply --approval <digest> --format human`.

Every rejection names its cause and one valid next action; nothing was written. Fix the answer and repeat from step 3.

> **The CLI owns everything but the synthesis**: corpus selection and filters, numbering, the shape check, the write authorization and the atomic publication. Never write into `docs/` with a file tool — `Write` is deliberately not in `allowed-tools`. A dossier lands whole or not at all.

## What it produces

- `docs/diagrams/NNN-export-diagrams-YYYY-MM-DD/`: `README.md` (required) + the diagrams in Markdown, plus their DSL (`.dsl`/`.puml`/`.mmd`) when it helps.
- Does **not** mutate sessions, touch another `docs/` folder, or open/close loops.

## Plan mode

Run `aw export-diagrams prepare` (read-only) and describe the deliverable and the destination it would publish, without applying.

## Resources

- CLI: `aw export-diagrams prepare | validate | apply` (service `export-service` over `semantic-operation/`)
- Diagram authoring reference: `../exports/export-diagrams/EXPORT.md` (engine `--engine`, notation) — no longer loaded on the normal path
- Design reference: `docs/referencias/workflow-exports/README.md`
