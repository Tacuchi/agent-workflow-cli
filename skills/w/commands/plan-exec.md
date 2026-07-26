---
description: Use when a plan is ready to implement — this is where the real work happens: code edits, proposed SQL scripts, created tools. Starts or resumes the execution loop (plan-exec-loop) over an existing plan, phase by phase, validating each phase before closing it. Checks executability on entry; structural or functional deviations return to plan-refine / spec-refine. Git-safe (proposes commits, never push/--amend/--no-verify). Not for creating or refining the plan (plan-new / plan-refine).
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

Starts or resumes `plan-exec-loop` (Layer 2), which executes the real work phase by phase — each phase a **verifiable state of the system**, not a batch of technical chores. The plan (`docs/plans/PPP-plan-<slug>.md`) is a living document the loop keeps updated: each `### Fn` carries its own `> Estado:` line (`pendiente` | `en ejecución` | `bloqueada` | `validada`) next to its task checkboxes.

> **Hard floor — applies even if you read nothing beyond this file:**
>
> 1. **Session first** — create/resume the run's session before touching code: `aw session-create --type exec --name <slug>-plan-exec --objetivo "<one-line objective>"`; keep its `CHECKPOINT.md` updated (`## Completed` · `## Pending / Next`; `## Open questions` only while live doubts exist).
> 2. **Git/DB** — verify each source's expected branch before editing (`aw check-branch`); commits are **proposed**, never executed without approval; **never** `push`/`--amend`/`--no-verify`; never execute DML/DDL (SQL goes to the session's `SCRIPTS.sql`).
> 3. **Ask, don't invent** — user-dependent decisions go through questions with a recommended option first (≤3 content questions + the `flow` control `Compactar`/`Cerrar`).
> 4. **Language** — everything user-facing (questions, option labels, reports) goes in the **user's language**.

## Run the loop

`plan-exec-loop` is **not** a skill invocable by name — it is this command's operating manual (a sibling doc in the bundle). **Load it and execute it end to end**:

1. **Read** `../loops/plan-exec-loop/LOOP.md` (inside the installed `w` skill — e.g. `~/.claude/skills/w/loops/…`).
2. **Follow** its instructions taking `$ARGUMENTS` as input: it detects CHECKPOINT/resume, executes phase by phase (git-safe, DB scripts-only), keeps the plan alive and reports.

> Do not try `Skill: plan-exec-loop` — it is not registered as a skill. The command **is** the entry; the loop is its body.

## What the loop does (summary)

- **Executability check on entry**: reads the plan **and its spec** and verifies each phase declares its result, its exit condition and its proof, and that the simulation boundary is identifiable. A minor gap is normalized **with your consent** (`Normalizar y ejecutar` | `Ir a plan-refine`); a structural one is recorded and handed off to `/w:plan-refine` — it never invents the plan's structure (see `../loops/plan-exec-loop/LOOP.md` § *Entry gate — executability*).
- **Deviation gate**: local detail (a name, a helper, internal layout) is resolved inline. A **structural** deviation — a contract, the participating components, the phase order, the simulation boundary — stops execution and returns to `/w:plan-refine`; a **functional** change (result, scope, business rule, acceptance criterion) returns to `/w:spec-refine` (§ *Deviation gate*).
- **Validation before closing each phase**: the phase's own proof plus the justified focused tests run first; the phase flips to `validada` only with the exit condition true and the review gate green — **never** just because its checkboxes are ticked (§ *Delta 4*).
- Reads and updates `docs/plans/PPP-plan-<slug>.md` (living doc: phase state, task checkboxes, deferrals).
- Edits code in the workspace sources (a single execution session per run; execution is still phase by phase, there is just no session per phase).
- If it creates a tool/utility, the ambient `creating-tools` skill documents it in `docs/tools/` (auto-discovered; Workline does not bind it).
- **Closing review gate** at every phase boundary, **before proposing the commits**: re-reads the diff (independent pass) applying the **installed ambient conventions** and fixes or defers findings — nothing reaches a commit unreviewed (see `../loops/plan-exec-loop/LOOP.md` § *Delta 5*).
- **Probe (PoC) tasks** run as throwaway code in the session folder — never committed; verdict recorded (`CONCLUSIONS`/`DECISION`), failed probes surface to the human (see `../loops/plan-exec-loop/LOOP.md` § *Delta 7*).
- Proposes commits per source (git-safe: verifies the branch, proposes, never push/--amend/--no-verify).
- Generates session artifacts (`DECISION`, `SCRIPTS.sql`) under `.workflow/sessions/`.
- **Never exports** to `docs/scripts`, `docs/manuals`, `docs/diagrams`, `docs/reports` — the `export-*` do that as a separate step.
- DB scripts (migrations) go to `SCRIPTS.sql` type B; the AI **never executes DML/DDL**, only read-only reads via MCP.

## Resumable

Same pattern as the other loops: it detects an existing CHECKPOINT and continues from there.

## Plan mode

The skill describes, phase by phase, what it would execute, which files it would touch, and which commits it would propose, without applying changes.

## Resources

- Loop manual: `../loops/plan-exec-loop/LOOP.md`
- Design reference: `docs/referencias/workflow-commands/plan-exec.md`
