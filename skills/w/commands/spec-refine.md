---
description: Use when a spec draft exists and needs disambiguating or completing before planning (close the blocking functional gaps, sharpen criteria, hand the technical ones to PLAN) — not for the first draft (that's spec-new). Starts or resumes the specification refinement loop (spec-refine-loop). Input: docs/specs/NNN-spec-<slug>.md (from spec-new, hand-written, or the quick escalation). Updates it in place and marks it status: ready-for-plan.
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

This command does not refine the spec itself: it delegates to `spec-refine-loop` (Layer 2), which iterates, closes the blocking gaps and leaves the spec ready for planning.

> **Hard floor — applies even if you read nothing beyond this file:**
>
> 1. **Session first** — create/resume the run's session before working: `aw session-create --type refine --name <slug>-spec-refine --objetivo "<one-line objective>"`; keep its `CHECKPOINT.md` updated (`## Completed` · `## Pending / Next`; `## Open questions` only while live doubts exist).
> 2. **Ask, don't invent** — user-dependent decisions go through questions with a recommended option first (≤3 content questions + the `flow` control `Compactar`/`Cerrar`).
> 3. **Write boundary** — this flow edits only `docs/specs/…` (in place, with confirmation), stamping the spec's frontmatter `status: ready-for-plan` on save; nothing else lands in `docs/`.
> 4. **Language** — everything user-facing (questions, option labels, the doc's content) goes in the **user's language**.
> 5. **Converge, do not close everything** — the target is `ready-for-plan`, not a spec without unknowns: close what can change **what** gets built; hand architecture and implementation questions to `PLAN`, recorded in `## Open questions` with their destination.

## Run the loop

`spec-refine-loop` is **not** a skill invocable by name — it is this command's operating manual (a sibling doc in the bundle). **Load it and execute it end to end**:

1. **Read** `../loops/spec-refine-loop/LOOP.md` (inside the installed `w` skill — e.g. `~/.claude/skills/w/loops/…`).
2. **Follow** its instructions taking `$ARGUMENTS` as input: it detects state/resume, runs the gap-driven engine, creates and manages sessions, converges and reports.

> Do not try `Skill: spec-refine-loop` — it is not registered as a skill. The command **is** the entry; the loop is its body.

## State resolution (resumable)

The skill detects prior state before starting, **keying off the `CHECKPOINT`** (never the existence of a "refined" file):

1. Find the spec's refinement session under `.workflow/sessions/` and its `CHECKPOINT.md`.
2. **In progress** (a CHECKPOINT exists) → continue from the recorded progress (resolved gaps, Q&A).
3. **No progress** (no CHECKPOINT and the spec is not `status: ready-for-plan`) → start from zero reading the spec (`NNN-spec*.md`).
4. **Already ready / re-refine on demand** (no open CHECKPOINT but the spec **already declares** `status: ready-for-plan`) → **first-class operation**: while the flow stays in SPEC you can re-run this command over the same spec **as many times as needed** (new requirements, scope changes, re-reads). The loop does `create_or_resume` — it locates the existing refine session (even closed) and **reopens** it instead of duplicating — and re-refines reading the **spec itself**; on `Guardar`, edits in place with confirmation.

> **Compat (legacy):** a spec with no frontmatter that carries `## Refinement decisions` (or the older `## Q&A traceability`) counts as ready — case 4 — but the mark does **not** exempt it from the gate: the re-refine runs it in full and, on `Guardar`, renames that section to `## Decisions` in the same write that stamps `status`. The `NNN-spec*.md` glob also catches old `NNN-spec.md` / `NNN-spec-refined.md` specs; re-running spec-refine edits them in place from then on.

## Plan mode

The skill resolves the state and describes the actions the loop would run (gaps it would close, questions it would ask), without starting the iteration.

## Resources

- Loop manual: `../loops/spec-refine-loop/LOOP.md`
- Design reference: `docs/referencias/workflow-commands/spec-refine.md`
