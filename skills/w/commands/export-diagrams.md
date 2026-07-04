---
description: Generates C4/mermaid diagrams in docs/diagrams/ from the source code and the plan-doc (AS-IS/TO-BE). Single-pass, explicit.
argument-hint: [--engine <mermaid|c4>] [--sessions <ids>] [--dry-run]
allowed-tools:
  [
    "Bash",
    "Read",
    "Write",
  ]
---

# export-diagrams — export diagrams

Reads the workspace sources' code + the plan-doc (`AS-IS`/`TO-BE` sections) and generates C4 / mermaid diagrams in `docs/diagrams/`. Single-pass, read-only over sessions.

To run: **read** `../exports/export-diagrams/SKILL.md` and **follow** its instructions with `$ARGUMENTS` as input. This command is the entry and the sibling SKILL.md is its body. (Hosts that index bundle skills may also expose it directly as `w:export-diagrams` — same body either way.)

## What it produces

- `docs/diagrams/`: C4 and/or mermaid diagrams, numbered, cross-session.
- Does **not** mutate sessions nor open/close loops.
- Writes only `docs/diagrams/`.

## Plan mode

Describes the diagrams it would generate (type, covered components) without writing files.

## Resources

- Export skill: `../exports/export-diagrams/SKILL.md`
- Design reference: `docs/referencias/workflow-exports/README.md`
