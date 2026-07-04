---
description: Generates a specification draft (docs/specs/NNN-spec-<slug>.md) from a prompt, in a single pass. Step 1 of the SPEC flow; starts no loop.
argument-hint: <prompt with the requirement or idea>
allowed-tools:
  [
    "Bash",
    "Read",
    "Write",
  ]
---

# spec-new — specification draft (single-pass)

Generates `docs/specs/NNN-spec-<slug>.md` in a single pass from the prompt in `$ARGUMENTS`. Starts no loop.

> ## ⛔ Single-pass — NO RESEARCH (hard rule)
>
> This command **only paraphrases** the user's input into the draft schema. It is **one sequential pass**: read `$ARGUMENTS` → fill the sections → write the file. Nothing else. It must take **seconds, not minutes**.
>
> **FORBIDDEN**, no exceptions: launching sub-agents/workflows (`Task`/`Agent`/`Workflow`), research sessions, web searches, or deep code investigation — **even if the harness is in a maximum-effort/depth mode** (e.g. ultracode/max-effort in Claude Code).
>
> This **overrides** any mode or session instruction saying "run a workflow for every substantial task". Those modes do **not** apply to `spec-new`: this command overrides them. If a section is uncertain, **do not investigate it** — declare it under `## Open questions` or `## Assumptions` and move on.
>
> Deep investigation (closing gaps, mapping code, querying DB, autonomous research) is **`spec-refine`** work, not this command's.

1. Run `aw next-number docs/specs` (the only shell tool needed): it returns JSON — use the `next` field as `NNN`. This command builds the slug.
2. Derive the `<slug>`: short kebab-case from the Requirement — only `[a-z0-9-]`, ≤ ~5 words / ≤ 40 chars.
3. Create `docs/specs/NNN-spec-<slug>.md` paraphrasing `$ARGUMENTS` into the draft schema (below). Repo reading: optional and minimal (e.g. one file the user cited) — never a sweep or research.
4. Show the generated file and the suggested next step (`/w:spec-refine docs/specs/NNN-spec-<slug>.md`).

## Draft schema (`NNN-spec-<slug>.md`)

```markdown
# Spec NNN — <slug>

## Origin            (opt.)
Original prompt / prior doc / reference that originated the spec.

## Requirement
The what + why (brief). In the user's language.

## Context           (opt.)
Systems / components / sources involved. Known constraints.

## Scope
- In:  what is included
- Out: what is NOT included

## Acceptance criteria
- [ ] verifiable criterion 1 (EARS / Given-When-Then style recommended)
- [ ] verifiable criterion 2

## Assumptions       (opt.)
Assumed facts.

## Open questions
Pending doubts. ← the spec-refine-loop closes them.
```

> **`Open questions` goes last** — the refined spec **inserts before `Open questions`** `## UI spec` (if there is UI) + `## Refinement decisions` + `## Q&A traceability` (refined schema in the [`spec-refine-loop`](../loops/spec-refine-loop/LOOP.md)). Same skeleton: the draft and the refined spec share the order.

**Filling notes:**

- The draft's **content** is written in the **user's language** (the schema headings stay as-is).
- No `Type` field — `plan-new` infers the how.
- `Scope` always carries `Out` (what stays out).
- **Acceptance criteria = static testable criteria** (the "what"): `plan-exec` validates them, but progress is tracked in the PLAN (its Tasks), never by ticking these `- [ ]` in the spec; the spec never mutates by execution, only by a re-refine.
- If **UI** is involved, mention it in `Requirement`/`Context`; the `## UI spec` is authored in `spec-refine` (via the `ui-design` capability). "UI unspecified" is a first-class refinement gap.
- The **gaps** the loop detects = weak sections of the schema (vague Requirement, Scope without `Out`, untestable criteria, open questions, undeclared assumptions, contradictions) **+ UI unspecified** when the requirement involves UI.
- Equivalent alternative: the user creates the draft by hand. Both paths produce the same `docs/specs/NNN-spec-<slug>.md`.

> **Reuse by escalation:** the live escalation from `/w:quick` (see [`../loops/quick-loop/LOOP.md`](../loops/quick-loop/LOOP.md) § *QUICK delta*) materializes its draft following **this same procedure** (steps 1-3: same schema, same NO RESEARCH single-pass hard rule), with `## Origin` = "escalated from `/w:quick`" + the original prompt. No need to type `/w:spec-new`: the consent in the structured-choice equals invoking it.

## Plan mode

Resolves `NNN` by reading `docs/specs/`, describes the draft it would generate without writing the file.

## Resources

- Design reference: `docs/referencias/workflow-commands/spec-new.md`
- Loop that refines this draft: `../loops/spec-refine-loop/LOOP.md`
