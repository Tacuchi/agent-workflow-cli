---
description: Generates an executive/functional report in docs/reports/ consolidating the session corpus (spec, CONCLUSIONS, DECISION), the plan-doc and the docs/ state. Single-pass, explicit.
argument-hint: [--sessions <ids>] [--audience <gerencia|tecnica>] [--dry-run]
allowed-tools:
  [
    "Bash",
    "Read",
    "Write",
  ]
---

# export-reports — export reports

Consolidates the full session corpus (`CONCLUSIONS`, `DECISION`, spec) + plan-doc (state) + `docs/` and generates an executive or functional report in `docs/reports/`. Single-pass, read-only over sessions.

To run: **read** `../exports/export-reports/EXPORT.md` and **follow** its instructions with `$ARGUMENTS` as input. This command is the entry and the sibling EXPORT.md is its body.

## What it produces

- `docs/reports/`: a consolidated, cross-session report with dedup and progress state.
- Does **not** mutate sessions nor open/close loops.
- Writes only `docs/reports/`.

## Plan mode

Describes the scope and index of the report it would generate (sections, source sessions, progress state) without writing files.

## Resources

- Export manual: `../exports/export-reports/EXPORT.md`
- Design reference: `docs/referencias/workflow-exports/README.md`
