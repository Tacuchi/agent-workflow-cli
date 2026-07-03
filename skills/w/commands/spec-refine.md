---
description: Starts or resumes the specification refinement loop (spec-refine-loop). Input: docs/specs/NNN-spec-<slug>.md (a draft — from spec-new, hand-written, or materialized by the quick escalation). Updates docs/specs/NNN-spec-<slug>.md in place.
argument-hint: <docs/specs/NNN-spec-<slug>.md>
allowed-tools:
  [
    "Bash",
    "Read",
    "Write",
    "Edit",
  ]
---

# spec-refine — trampoline to the refinement loop

This command does not refine the spec itself: it delegates to `spec-refine-loop` (Layer 2), which iterates, closes gaps and produces the refined spec.

## Run the loop

`spec-refine-loop` is **not** a skill invocable by name — it is this command's operating manual (a sibling doc in the bundle). **Load it and execute it end to end**:

1. **Read** `../loops/spec-refine-loop/SKILL.md` (inside the installed `w` skill — e.g. `~/.claude/skills/w/loops/…`).
2. **Follow** its instructions taking `$ARGUMENTS` as input: it detects state/resume, runs the gap-driven engine, creates and manages sessions, converges and reports.

> Do not try `Skill: spec-refine-loop` — it is not registered as a skill. The command **is** the entry; the loop is its body.

## State resolution (resumable)

The skill detects prior state before starting, **keying off the `CHECKPOINT`** (never the existence of a "refined" file):

1. Find the spec's refinement session under `.workflow/sessions/` and its `CHECKPOINT.md`.
2. **In progress** (a CHECKPOINT exists) → continue from the recorded progress (resolved gaps, Q&A).
3. **No progress** (no CHECKPOINT and the spec does **not** have `## Refinement decisions`/`## Q&A traceability`) → start from zero reading the spec (`NNN-spec*.md`).
4. **Already refined / re-refine on demand** (no open CHECKPOINT but the spec **already has** the 2 sections) → **first-class operation**: while the flow stays in SPEC you can re-run this command over the same spec **as many times as needed** (new requirements, scope changes, re-reads). The loop does `create_or_resume` — it locates the existing refine session (even closed) and **reopens** it instead of duplicating — and re-refines reading the **spec itself**; on `Guardar`, edits in place with confirmation.

> **Compat (legacy):** the `NNN-spec*.md` glob also catches old `NNN-spec.md` / `NNN-spec-refined.md` specs. Re-running spec-refine edits them in place from then on.

## Plan mode

The skill resolves the state and describes the actions the loop would run (gaps it would close, questions it would ask), without starting the iteration.

## Resources

- Loop skill: `../loops/spec-refine-loop/SKILL.md`
- Design reference: `docs/referencias/workflow-commands/spec-refine.md`
