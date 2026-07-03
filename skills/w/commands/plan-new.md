---
description: Starts or resumes the planning loop (plan-new-loop) from a spec. Turns the "what" (spec) into the "how" (plan). Ideal input: an already refined docs/specs/NNN-spec-<slug>.md.
argument-hint: <docs/specs/NNN-spec-<slug>.md | prompt>
allowed-tools:
  [
    "Bash",
    "Read",
    "Write",
    "Edit",
  ]
---

# plan-new — trampoline to the planning loop

SPEC → PLAN bridge. Turns the "what" (refined spec) into the "how" (plan). Delegates to `plan-new-loop` (Layer 2).

## Input resolution

The skill evaluates `$ARGUMENTS` (specs live in place — `docs/specs/NNN-spec-<slug>.md`; locate via the `docs/specs/NNN-spec-*.md` glob or the exact path):

1. **Refined spec** (`docs/specs/NNN-spec-<slug>.md` that **already has** `## Refinement decisions` / `## Q&A traceability`) → ideal. Proceed straight to `plan-new-loop`.
2. **Draft spec** (same file, but **without** those two sections) → **soft-suggest** running `/w:spec-refine` first; planning over a solid spec produces better plans (the user may proceed anyway).
3. **prompt** (no spec referenced) → propose using the SPEC flow; **by default launch `/w:spec-new`** with that prompt to create the draft, and continue the natural flow from there.

> **Refined vs draft** is distinguished by the **presence** of `## Refinement decisions` / `## Q&A traceability` in the spec, never by the filename (there is no `-refined` anymore).

## Run the loop

`plan-new-loop` is **not** a skill invocable by name — it is this command's operating manual (a sibling doc in the bundle). **Load it and execute it end to end**:

1. **Read** `../loops/plan-new-loop/SKILL.md` (inside the installed `w` skill — e.g. `~/.claude/skills/w/loops/…`).
2. **Follow** its instructions taking `$ARGUMENTS` as input (resolved per the 3 rules above): it detects state/resume, runs the gap-driven engine, creates and manages sessions, converges and reports.

> Do not try `Skill: plan-new-loop` — it is not registered as a skill. The command **is** the entry; the loop is its body.

## Numbering notes

The plan is named `docs/plans/PPP-plan-<slug>.md`. `aw next-number docs/plans` returns JSON (field `next` = `PPP`); the loop builds the full name (slug = short kebab-case from the Requirement: `[a-z0-9-]`, ≤ ~5 words / ≤ 40 chars). It does **not inherit the spec's `NNN`**. The link to the spec is established by reference (`## Origin` / "Derived from") in the plan, never by number.

## UI → design SPECs

If the plan **includes UI**, the loop composes the `ui-design` capability and produces per-screen **design SPECs** (`NNN-SPEC-<SLUG>.md`) as artifacts of its session — the plan's UI Tasks reference them (see `../loops/plan-new-loop/SKILL.md` § *Delta 4* and `../artifacts/artifacts-design/SPEC.md`).

## Plan mode

The skill resolves the input per the 3 rules above and describes the loop actions it would run, without starting the iteration.

## Resources

- Loop skill: `../loops/plan-new-loop/SKILL.md`
- Design reference: `docs/referencias/workflow-commands/plan-new.md`
