---
description: Exports DB scripts (type-B SCRIPTS.sql) from N sessions to docs/scripts/ as numbered forwards + rollback. Explicit, separate step — never automatic.
argument-hint: [--sessions <ids>] [--dry-run]
allowed-tools:
  [
    "Bash",
    "Read",
    "Write",
  ]
---

# export-scripts — export DB scripts

Promotes the `SCRIPTS.sql` artifacts (type B — migrations) of N sessions from `.workflow/sessions/` to `docs/scripts/`. Single-pass, read-only over sessions.

To run: **read** `../exports/export-scripts/SKILL.md` and **follow** its instructions with `$ARGUMENTS` as input. This command is the entry and the sibling SKILL.md is its body. (Hosts that index bundle skills may also expose it directly as `w:export-scripts` — same body either way.)

## What it produces

- `docs/scripts/`: continuously numbered forwards (cross-session, dedup) + `00-ROLLBACK.sql`.
- Does **not** mutate sessions nor open/close loops.
- The AI **never executes** the scripts — it only consolidates and delivers them.

## Plan mode

Describes the scripts it would consolidate and the `docs/scripts/` structure it would generate, without writing files.

## Resources

- Export skill: `../exports/export-scripts/SKILL.md`
- Design reference: `docs/referencias/workflow-exports/README.md`
