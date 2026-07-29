---
description: Exports DB scripts (type-B SCRIPTS.sql) from N sessions to docs/scripts/ as a bundle with continuous forwards + rollback. Backed by `aw export-scripts`, which validates the bundle shape and NEVER executes SQL. Explicit, separate step — never automatic.
argument-hint: "[--sessions <ids>] [--since <YYYY-MM-DD>] [--source <alias>]"
allowed-tools:
  [
    "Bash",
    "Read",
  ]
---

# export-scripts — export DB scripts

Promotes the `SCRIPTS.sql` artifacts (type B — migrations) of N sessions from `.workflow/sessions/` into a bundle under `docs/scripts/`. Single-pass, read-only over sessions. **Transversal**: no flow, no loop, **never creates a session**.

## Run

1. `aw export-scripts prepare --format human [--sessions <a,b>] [--since <YYYY-MM-DD>] [--source <alias>]` (`--detail` prints the full response contract). Returns the corpus, the destination, the required shape and an `input_digest`.
2. **Synthesize the deliverable.** Compose one JSON answer: `version`, `operation` and `input_digest` copied **verbatim**; `state: "proposed"`; `artifacts` with one `{ path, content }` per file, every path inside the destination the request declares. The `NNN` is consultative — `apply` reassigns it inside the lock.
3. `echo '<json>' | aw export-scripts validate --format human` → preview + `approval_digest`.
4. **Confirm scope and destination with the user**, showing that preview.
5. `echo '<json>' | aw export-scripts apply --approval <digest> --format human`.

Every rejection names its cause and one valid next action; nothing was written. Fix the answer and repeat from step 3.

> **The CLI owns everything but the synthesis**: corpus selection and filters, numbering, the shape check, the write authorization and the atomic publication. Never write into `docs/` with a file tool — `Write` is deliberately not in `allowed-tools`. A dossier lands whole or not at all.

## What it produces

- `docs/scripts/NNN-export-scripts-YYYY-MM-DD/`: `00-ROLLBACK.sql` and `README.md` (both required) + the forwards `NN-<nombre>.sql`, numbered **continuously from 01** — the CLI rejects a gap.
- The AI **never executes** the SQL, and neither does the CLI: the bundle is for a human/DBA to apply.
- Does **not** mutate sessions, touch another `docs/` folder, or open/close loops.

## Plan mode

Run `aw export-scripts prepare` (read-only) and describe the deliverable and the destination it would publish, without applying.

## Resources

- CLI: `aw export-scripts prepare | validate | apply` (service `export-service` over `semantic-operation/`)
- SQL bundle reference: `../exports/export-scripts/EXPORT.md` (rollback derivation, ordering) — no longer loaded on the normal path
- Design reference: `docs/referencias/workflow-exports/README.md`
