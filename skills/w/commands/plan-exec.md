---
description: Starts or resumes the execution loop (plan-exec-loop) over an existing plan. The real work happens here - code edits, proposed SQL scripts, created tools. Git-safe.
argument-hint: <docs/plans/PPP-plan-<slug>.md>
allowed-tools:
  [
    "Bash",
    "Read",
    "Write",
    "Edit",
  ]
---

# plan-exec — trampoline to the execution loop

Starts or resumes `plan-exec-loop` (Layer 2), which executes the real work phase by phase. The plan (`docs/plans/PPP-plan-<slug>.md`) is a living document the loop keeps updated (phase and task state).

## Run the loop

`plan-exec-loop` is **not** a skill invocable by name — it is this command's operating manual (a sibling doc in the bundle). **Load it and execute it end to end**:

1. **Read** `../loops/plan-exec-loop/SKILL.md` (inside the installed `w` skill — e.g. `~/.claude/skills/w/loops/…`).
2. **Follow** its instructions taking `$ARGUMENTS` as input: it detects CHECKPOINT/resume, executes phase by phase (git-safe, DB scripts-only), keeps the plan alive and reports.

> Do not try `Skill: plan-exec-loop` — it is not registered as a skill. The command **is** the entry; the loop is its body.

## What the loop does (summary)

- Reads and updates `docs/plans/PPP-plan-<slug>.md` (living doc: phase/task state).
- Edits code in the workspace sources (a single execution session per run; execution is still phase by phase, there is just no session per phase).
- If it creates a tool/utility, the ambient `creating-tools` skill documents it in `docs/tools/` (auto-discovered; the workflow does not bind it).
- **Closing review gate** at every phase boundary, **before proposing the commits**: re-reads the diff (independent pass) applying the **installed ambient conventions** and fixes or defers findings — nothing reaches a commit unreviewed (see `../loops/plan-exec-loop/SKILL.md` § *Delta 5*).
- Proposes commits per source (git-safe: verifies the branch, proposes, never push/--amend/--no-verify).
- Generates session artifacts (`DECISION`, `SCRIPTS.sql`) under `.workflow/sessions/`.
- **Never exports** to `docs/scripts`, `docs/manuals`, `docs/diagrams`, `docs/reports` — the `export-*` do that as a separate step.
- DB scripts (migrations) go to `SCRIPTS.sql` type B; the AI **never executes DML/DDL**, only read-only reads via MCP.

## Resumable

Same pattern as the other loops: it detects an existing CHECKPOINT and continues from there.

## Plan mode

The skill describes, phase by phase, what it would execute, which files it would touch, and which commits it would propose, without applying changes.

## Resources

- Loop skill: `../loops/plan-exec-loop/SKILL.md`
- Design reference: `docs/referencias/workflow-commands/plan-exec.md`
