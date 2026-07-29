---
description: Exports a bounded report from N sessions to docs/reports/ as a numbered Markdown document. Backed by `aw export-reports`, which owns the corpus, the numbering and the write. Explicit, separate step — never automatic.
argument-hint: "[--sessions <ids>] [--since <YYYY-MM-DD>] [--source <alias>]"
allowed-tools:
  [
    "Bash",
    "Read",
  ]
---

# export-reports — export a report

Promotes session findings into one numbered report under `docs/reports/`. Single-pass, read-only over sessions. **Transversal**: no flow, no loop, **never creates a session**.

## Run

1. `aw export-reports prepare --format human [--sessions <a,b>] [--since <YYYY-MM-DD>] [--source <alias>]` (`--detail` prints the full response contract). Returns the corpus, the destination, the required shape and an `input_digest`.
2. **Synthesize the deliverable.** Compose one JSON answer: `version`, `operation` and `input_digest` copied **verbatim**; `state: "proposed"`; `artifacts` with one `{ path, content }` per file, every path inside the destination the request declares. The `NNN` is consultative — `apply` reassigns it inside the lock.
3. `echo '<json>' | aw export-reports validate --format human` → preview + `approval_digest`.
4. **Confirm scope and destination with the user**, showing that preview.
5. `echo '<json>' | aw export-reports apply --approval <digest> --format human`.

Every rejection names its cause and one valid next action; nothing was written. Fix the answer and repeat from step 3.

> **The CLI owns everything but the synthesis**: corpus selection and filters, numbering, the shape check, the write authorization and the atomic publication. Never write into `docs/` with a file tool — `Write` is deliberately not in `allowed-tools`. A dossier lands whole or not at all.

## What it produces

- `docs/reports/NNN-<slug>-YYYY-MM-DD.md`: ONE document that declares its audience and its scope in the opening lines.
- Does **not** mutate sessions, touch another `docs/` folder, or open/close loops.

## Plan mode

Run `aw export-reports prepare` (read-only) and describe the deliverable and the destination it would publish, without applying.

## Resources

- CLI: `aw export-reports prepare | validate | apply` (service `export-service` over `semantic-operation/`)
- Report authoring reference: `../exports/export-reports/EXPORT.md` — no longer loaded on the normal path
- Design reference: `docs/referencias/workflow-exports/README.md`
