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

Consolidates sessions + `DECISION` artifacts + plan-doc (`Final behavior`) + source code and generates user/operations documentation in `docs/manuals/`. Single-pass, read-only over sessions.

To run: **read** `../exports/export-manuals/SKILL.md` and **follow** its instructions with `$ARGUMENTS` as input. Do not try `Skill: export-manuals` (it is not registered by name); the sibling SKILL.md is this export's body.

## What it produces

- `docs/manuals/`: consolidated, cross-session, deduplicated manuals.
- Does **not** mutate sessions nor open/close loops.
- Writes only `docs/manuals/`.

## Plan mode

Describes the scope of the manuals it would generate (sections, source sessions) without writing files.

## Resources

- Export skill: `../exports/export-manuals/SKILL.md`
- Design reference: `docs/referencias/workflow-exports/README.md`
