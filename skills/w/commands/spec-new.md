---
description: Use when the user wants to capture a NEW requirement, idea or wish as a spec — not to refine an existing draft (that's spec-refine). Generates a specification draft (docs/specs/NNN-spec-<slug>.md) from a prompt, in a single pass. Can split a multi-part prompt into several sibling specs (split gate). Step 1 of the SPEC flow; starts no loop.
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
> This command **only paraphrases** the user's input into the draft schema. It is **one sequential pass**: read `$ARGUMENTS` → (split gate: at most ONE structured-choice — see § *Split gate (multi-spec)*) → fill the sections → write the file(s). Nothing else. It must take **seconds, not minutes**.
>
> **FORBIDDEN**, no exceptions: launching sub-agents/workflows (`Task`/`Agent`/`Workflow`), research sessions, web searches, or deep code investigation — **even if the harness is in a maximum-effort/depth mode** (e.g. ultracode/max-effort in Claude Code).
>
> This **overrides** any mode or session instruction saying "run a workflow for every substantial task". Those modes do **not** apply to `spec-new`: this command overrides them. If a section is uncertain, **do not investigate it** — declare it under `## Open questions` or `## Assumptions` and move on.
>
> Deep investigation (closing gaps, mapping code, querying DB, autonomous research) is **`spec-refine`** work, not this command's.

With a raw user prompt, first run the **§ Split gate (multi-spec)** assessment (below): the split offer, if any, happens **before writing anything**. Then:

1. Run `aw next-number docs/specs` (the only shell tool needed): it returns JSON — use the `next` field as `NNN`. This command builds the slug.
2. Derive the `<slug>`: short kebab-case from the Requirement — only `[a-z0-9-]`, ≤ ~5 words / ≤ 40 chars.
3. Create `docs/specs/NNN-spec-<slug>.md` paraphrasing `$ARGUMENTS` into the draft schema (below). Repo reading: optional and minimal (e.g. one file the user cited) — never a sweep or research. On an accepted split: repeat steps 1-3 per part, minting immediately before each write.
4. Show the generated file(s) and the suggested next step (`/w:spec-refine docs/specs/NNN-spec-<slug>.md`).

## Split gate (multi-spec)

Right after reading `$ARGUMENTS` and **before writing anything**, assess whether the prompt bundles **several independent requirements**. The gate fires **only on clear signals** (≥2 of: independent deliverables/goals · explicit enumeration of distinct features · different requested moments or order · unrelated subsystems); borderline → **one spec, no question**. It applies only to a **raw user prompt** (direct invocation, or the `plan-new` mode-3 handoff); it **never fires** on the reuse entries below — the quick escalation and the `persist` adoption arrive already scoped to one objective.

- **The offer** — the command's **only** interaction: **one** structured-choice (1 content question + the `flow` control; `Cerrar` = abort, nothing is written yet). The question body shows the proposed cut in the **user's language**: per part, a name + slug, a 1-line scope and the suggested order. Labels: `Dividir en varias specs` (recommended when the signals hold) | `Una sola spec`. A free-form answer adjusts the cut (merge/rename/drop parts); if one part remains, proceed as a single spec.
- **On acceptance** — still single-pass, still **NO RESEARCH** (the cut is paraphrase of the prompt, never investigation): per part, mint with `aw next-number docs/specs` **immediately before each write**, then write that draft. Numbers come out consecutive, so every sibling path is known after the first mint.
- **Sibling contract**: each `## Origin` records the shared prompt + `split (part i/N)` + the **siblings by path** + the suggested order; each `## Scope` Out points to the sibling that owns the excluded part. Cross-reference by path, never by bare number.
- **Report**: list the N files and suggest the next step per spec (`/w:spec-refine` on the first — each sibling refines and plans at its own moment).

## Draft schema (`NNN-spec-<slug>.md`)

```markdown
# Spec NNN — <slug>

## Origin            (opt.)
Original prompt / prior doc / reference that originated the spec
(e.g. "adopted from host conversation" when it captures an analysis already established there;
or "split (part i/N)" + sibling spec paths + suggested order — § Split gate (multi-spec)).

## Requirement
The what + why (brief). In the user's language.

## Context           (opt.)
Systems / components / sources involved. Known constraints.

## Scope
- In:  what is included
- Out: what is NOT included

## Acceptance criteria
- [ ] verifiable criterion 1 (EARS style recommended; behavioral ones expand in ## Scenarios)
- [ ] verifiable criterion 2

## Scenarios         (opt.)
Behavior made concrete — GIVEN/WHEN/THEN/AND blocks; each traces to ≥1 acceptance criterion.

### Scenario: <name>
GIVEN <precondition>
  AND <precondition>
WHEN <action>
THEN <observable outcome>
  AND <outcome>

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
- **Scenarios = behavior made concrete** (uppercase GIVEN/WHEN/THEN/AND): draft them only when the prompt already describes behavior — deriving the rest is spec-refine work, not this command's.
- If **UI** is involved, mention it in `Requirement`/`Context`; the `## UI spec` is authored in `spec-refine` (via the `ui-design` capability). "UI unspecified" is a first-class refinement gap.
- The **gaps** the loop detects = weak sections of the schema (vague Requirement, Scope without `Out`, untestable criteria, open questions, undeclared assumptions, contradictions) **+ UI unspecified** when the requirement involves UI.
- Equivalent alternative: the user creates the draft by hand. Both paths produce the same `docs/specs/NNN-spec-<slug>.md`.

> **Reuse by escalation:** the live escalation from `/w:quick` (see [`../loops/quick-loop/LOOP.md`](../loops/quick-loop/LOOP.md) § *QUICK delta*) materializes its draft following **this same procedure** (steps 1-3: same schema, same NO RESEARCH single-pass hard rule), with `## Origin` = "escalated from `/w:quick`" + the original prompt. No need to type `/w:spec-new`: the consent in the structured-choice equals invoking it.
>
> **Reuse by adoption:** [`/w:persist`](persist.md) (requirement-shaped content) materializes its spec draft with this same procedure, with `## Origin` = "adopted from host conversation" + attribution. Paraphrasing conclusions **already established in this conversation** is still single-pass — adoption is transcription, not investigation (chassis § *Adopted context*).

## Plan mode

Resolves `NNN` by reading `docs/specs/`, describes the draft(s) it would generate — split gate included: it reports the proposed cut — without writing any file.

## Resources

- Design reference: `docs/referencias/workflow-commands/spec-new.md`
- Loop that refines this draft: `../loops/spec-refine-loop/LOOP.md`
