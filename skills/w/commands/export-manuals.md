---
description: Generates user/operations manuals in docs/manuals/ consolidating sessions, DECISION, plan-doc and source code. Single-pass, explicit.
argument-hint: [--sessions <ids>] [--mode <complement|regenerate>] [--dry-run]
allowed-tools:
  [
    "Bash",
    "Read",
    "Write",
  ]
---

# export-manuals — export manuals

Consolidates sessions + `DECISION` artifacts + plan-doc (the Final behavior block of `Solution`) + source code and generates user/operations documentation in `docs/manuals/`. Single-pass, read-only over sessions.

To run: **read** `../exports/export-manuals/EXPORT.md` and **follow** its instructions with `$ARGUMENTS` as input. This command is the entry and the sibling EXPORT.md is its body.

## What it produces

- `docs/manuals/`: consolidated, cross-session, deduplicated manuals.
- Does **not** mutate sessions nor open/close loops.
- Writes only `docs/manuals/`.

## Plan mode

Describes the scope of the manuals it would generate (sections, source sessions) without writing files.

## Resources

- Export manual: `../exports/export-manuals/EXPORT.md`
- Design reference: `docs/referencias/workflow-exports/README.md`
