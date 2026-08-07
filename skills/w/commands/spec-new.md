---
description: "Use when a NEW requirement, idea or wish must be captured as a spec draft (docs/specs/NNN-spec-<slug>.md) in one pass — not to refine an existing draft (that is spec-refine). Step 1 of the SPEC flow; starts no loop."
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

> ## ⛔ Single-pass — BOUNDED RECONNAISSANCE, NO DEEP RESEARCH (hard rule)
>
> One sequential pass: read `$ARGUMENTS` → adopt what the conversation already settled → reconnaissance → scope hypothesis → split gate (at most ONE structured-choice, using the canonical [option shape](../loops/CHASSIS.md#structured-choice-design--batching) + [per-host binding](../harness/HARNESS.md#harness-binding-matrix)) → fill the sections → write the file(s). Nothing else. It must take **seconds, not minutes**.
>
> **FORBIDDEN**, no exceptions: launching sub-agents/workflows (`Task`/`Agent`/`Workflow`), research sessions, web searches, following implementation chains, running code/tests/apps, querying databases — **even if the harness is in a maximum-effort/depth mode**. This **overrides** any mode or session instruction saying "run a workflow for every substantial task".
>
> A section still uncertain after the reconnaissance → **do not dig further**: declare it under `## Open questions` or `## Assumptions` and move on. Deep investigation (closing gaps, mapping code, querying DB, autonomous research) is **`spec-refine`** work.

## Run

1. **Reconnaissance** — one shallow look at the terrain before any scope decision: adopt what the conversation settled, identify the candidate sources (`aw sources --no-git`, or the `WORKSPACE` block), look at their surface, stop. **Budget: ≤5 reads + ≤3 searches** — a cap, never a target. Never run code, query a database or search the web. Full rules: module `RECONNAISSANCE`.
2. **Split gate** — before writing anything, judge whether the prompt bundles several **independent functional outcomes**. Borderline or thin evidence → **one spec, no question** (hypothesis to `## Assumptions`, doubt to `## Open questions`). Only clear signals earn the command's single structured-choice offer. Full rules: module `SPLIT-GATE`.
3. **Number and slug** — `aw next-number docs/specs --claim spec-<slug>.md` CLAIMS the number and returns `claimed_path`. Derive `<slug>` from the Requirement: short kebab-case, only `[a-z0-9-]`, ≤ ~5 words / ≤ 40 chars.
4. **Write** `docs/specs/NNN-spec-<slug>.md`, framing `$ARGUMENTS` into the draft schema below; reconnaissance findings land **only** where the filling notes allow. On an accepted split: repeat 3-4 per part, minting immediately before each write.
5. **Report** the generated file(s) and the next step (`/w:spec-refine docs/specs/NNN-spec-<slug>.md`).

Steps 1-2 run **only on a raw user prompt** (direct invocation, or the `plan-new` mode-3 handoff). The reuse entries at the end skip them: their context arrives already established, and adopting it is transcription, not investigation.

## Draft schema (`NNN-spec-<slug>.md`)

```markdown
---
status: draft
---

# Spec NNN — <slug>

## Origin            (opt.)
Original prompt / prior doc / reference that originated the spec
(e.g. "adopted from host conversation" when it captures an analysis already established there;
or "split (part i/N)" + sibling spec paths + suggested order).

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

> **`Open questions` goes last** — the refined spec **inserts before `Open questions`** `## Design references` (if there is UI) + `## Decisions`, and may add `## Affected capabilities` / `## Behavioral changes` right after `Context` when the change touches behavior that already exists (refined schema in the [`spec-refine-loop`](../loops/spec-refine-loop/LOOP.md); the refine drops `Open questions` when it empties). Draft and refined spec share the same skeleton and order.

**Filling notes:**

- The draft's **content** is written in the **user's language** (schema headings stay as-is).
- No `Type` field — `plan-new` infers the how.
- **`status: draft`** is the draft's maturity mark. This command writes no other value: only the `spec-refine` gate promotes a spec to `ready-for-plan`.
- `Scope` always carries `Out`.
- **Where the reconnaissance lands** — `Context`: the facts that place the request (sources apparently involved, a module's observed responsibility, the relevant technology), **at most one path per component** as an anchor, never a technical inventory. `Assumptions`: the inferences that let the draft advance. `Open questions`: what would need walking the implementation, a human decision, or an unavailable source.
- **The code found never widens `Scope`** and never becomes a requirement: **acceptance criteria derive from the user's intent**. The reconnaissance may lend vocabulary, name existing actors and boundaries, and avoid obvious contradictions. It must not invent behavior nobody asked for, turn a current technical decision into a user requirement, or impose an implementation as a criterion.
- **Acceptance criteria = static testable criteria** (the "what"): `plan-exec` validates them, but progress is tracked in the PLAN (its Tasks), never by ticking these `- [ ]`; the spec never mutates by execution, only by a re-refine.
- **Scenarios = behavior made concrete** (uppercase GIVEN/WHEN/THEN/AND): draft them only when the prompt already describes behavior — deriving the rest is spec-refine work. A scenario earns its place only when it adds GIVEN setup or edge semantics the criterion does not capture — **never restate a criterion 1:1**.
- If **UI** is involved, **record the need and stop there**: mention it in `Requirement`/`Context`. This command creates **no design package** and writes no `## Design references` — the design is composed in `spec-refine` (via the [`design`](../roles/design/ROLE.md) capability, which publishes the package the spec then references). Minting a package from a draft would pin an identity before the requirement is even closed. "UI unspecified" is a first-class refinement gap.
- The **gaps** the loop detects = weak sections of the schema (vague Requirement, Scope without `Out`, untestable criteria, open questions, undeclared assumptions, contradictions) **+ UI unspecified** when the requirement involves UI.
- Equivalent alternative: the user writes the draft by hand. Both paths produce the same file.

> **Reuse by escalation:** the live escalation from `/w:quick` (see [`../loops/quick-loop/LOOP.md`](../loops/quick-loop/LOOP.md) § *QUICK delta*) materializes its draft with **this same procedure** (same schema, same single-pass hard rule — **NO RESEARCH**, no reconnaissance: objective and context arrive adopted), with `## Origin` = "escalated from `/w:quick`" + the original prompt. The consent in the structured-choice equals invoking this command.
>
> **Reuse by adoption:** [`/w:persist`](persist.md) (requirement-shaped content) materializes its spec draft the same way, with `## Origin` = "adopted from host conversation" + attribution. Paraphrasing conclusions **already established in this conversation** is still single-pass and needs no reconnaissance — adoption is transcription, not investigation.

## More context

`aw context-plan --command spec-new --signal <s> --root "${CLAUDE_PLUGIN_ROOT}/skills/w"` returns the extra documents a case needs; read exactly what it lists:

- `reconnaissance` — the terrain is unfamiliar and the scope decision needs a bounded look first → [`../modules/RECONNAISSANCE.md`](../modules/RECONNAISSANCE.md)
- `split` — the prompt may carry more than one independent outcome → [`../modules/SPLIT-GATE.md`](../modules/SPLIT-GATE.md)
