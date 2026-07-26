---
description: Use when the user wants to capture a NEW requirement, idea or wish as a spec — not to refine an existing draft (that's spec-refine). Generates a specification draft (docs/specs/NNN-spec-<slug>.md) from a prompt, in a single pass: a bounded reconnaissance of the workspace sources first, then the scope decision — one spec, or several sibling specs (split gate). Step 1 of the SPEC flow; starts no loop.
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
> This command frames the user's input into the draft schema after a **single, bounded look** at the context. It is **one sequential pass**: read `$ARGUMENTS` → adopt what the conversation already settled → **reconnaissance** (see § *Bounded reconnaissance*) → scope hypothesis → (split gate: at most ONE structured-choice — see § *Split gate (multi-spec)*) → fill the sections → write the file(s). Nothing else. It must take **seconds, not minutes**.
>
> **FORBIDDEN**, no exceptions: launching sub-agents/workflows (`Task`/`Agent`/`Workflow`), research sessions, web searches, following implementation chains, running code/tests/apps, querying databases — **even if the harness is in a maximum-effort/depth mode** (e.g. ultracode/max-effort in Claude Code).
>
> This **overrides** any mode or session instruction saying "run a workflow for every substantial task". Those modes do **not** apply to `spec-new`: this command overrides them. If a section stays uncertain after the reconnaissance, **do not dig further** — declare it under `## Open questions` or `## Assumptions` and move on.
>
> Deep investigation (closing gaps, mapping code, querying DB, autonomous research) is **`spec-refine`** work, not this command's.

With a raw user prompt, first run the **§ Bounded reconnaissance** pass, then the **§ Split gate (multi-spec)** assessment (both below): the split offer, if any, happens **before writing anything**. Then:

1. Run `aw next-number docs/specs` (the only shell tool needed beyond the reconnaissance): it returns JSON — use the `next` field as `NNN`. This command builds the slug.
2. Derive the `<slug>`: short kebab-case from the Requirement — only `[a-z0-9-]`, ≤ ~5 words / ≤ 40 chars.
3. Create `docs/specs/NNN-spec-<slug>.md` framing `$ARGUMENTS` into the draft schema (below); the reconnaissance findings land **only** where the filling notes allow. On an accepted split: repeat steps 1-3 per part, minting immediately before each write.
4. Show the generated file(s) and the suggested next step (`/w:spec-refine docs/specs/NNN-spec-<slug>.md`).

## Bounded reconnaissance

A scope decision taken from the prompt alone mistakes **technical** boundaries for **functional** ones. So, before deciding, take **one** shallow look at the terrain — enough to form a reasonable hypothesis of the functional unit, never enough to answer how it will be built.

**Scope:** it runs **only on a raw user prompt** (direct invocation, or the `plan-new` mode-3 handoff). The reuse entries at the end of this file skip it: the quick escalation and the `persist` adoption arrive with their context **already established**, and adopting it is transcription, not reconnaissance (**NO RESEARCH** — chassis § *Adopted context*).

One pass, in this order: **adopt** what the conversation already settled (never re-derive it), **identify** the candidate sources, **look** at their surface, **stop**.

- **Sources allowed** (a permission, not an obligation to read them all):
  - the workspace's registered sources — `aw sources --no-git`, or the `WORKSPACE` block;
  - each candidate source's main instructions file, plus the head of its `README`;
  - build manifests: `package.json`, `pom.xml`, `build.gradle`, `requirements.txt`, equivalents;
  - a top-level directory listing per candidate source;
  - one or two entry points the prompt itself names, plus a handful of search hits.
- **Budget: ≤5 reads + ≤3 searches.** Read a whole file only when a head or a search will not do. The ceiling is a **cap, never a target**.
- **Stop at the first of these:**
  - the evidence already decides one spec vs sibling specs;
  - the next question needs a deep technical chain;
  - it would need running code, tests or services;
  - it would need an external source that is not available;
  - the remaining uncertainty does not block a first draft;
  - the digging starts answering *how it will be built* instead of *what functional unit was asked for*.
- **Never:** follow a full import/call chain, run anything, query a database, search the web, or open a source the prompt gives no reason to open.

**Scope hypothesis (internal).** The pass ends in a short judgement: functional outcome · likely sources · apparent responsibility of each · coupling · independent acceptance · recommended shape · confidence. It is **reasoning, not an artifact** — never persisted, never printed verbatim. It exists so the cut is never intuitive but opaque; its only visible residue is what the filling notes admit.

**Degrade safely.** A missing workspace, unreachable sources or contradictory evidence **never** block the command and **never** justify a speculative cut. Keep **one spec**, declare the assumption used, and record the uncertainty for `spec-refine`. Prefer the functional outcome the user declared over any inference drawn from the code.

## Split gate (multi-spec)

Right after the reconnaissance and **before writing anything**, assess whether the prompt bundles **several independent outcomes**. The unit is the **functional outcome**, not the technical boundary: distinct repos, a frontend/backend pair, several microservices, a migration plus the code it enables — all **secondary evidence**, never on their own a reason to divide.

**Divide only when each part is a result that can be refined, accepted and planned on its own** — its own purpose, its own acceptance criteria, worth delivering even if the other part is dropped. The gate fires **only on clear signals** (≥2 of: independent deliverables/goals · explicit enumeration of distinct features · different requested moments or order · users or value that do not depend on each other). Borderline, or evidence too thin to tell → **one spec, no question**: the hypothesis goes to `## Assumptions` and the doubt to `## Open questions`. It applies only to a **raw user prompt** (direct invocation, or the `plan-new` mode-3 handoff); it **never fires** on the reuse entries below — the quick escalation and the `persist` adoption arrive already scoped to one objective.

- **The offer** — the command's **only** interaction: **one** structured-choice (≤2 content questions + the `flow` control; `Cerrar` = abort, nothing is written yet). The question body shows the proposed cut in the **user's language**: per part, a name + slug, a 1-line scope and the suggested order. Labels: `Dividir en varias specs` (recommended when the signals hold) | `Una sola spec`. A free-form answer adjusts the cut (merge/rename/drop parts); if one part remains, proceed as a single spec.
- **The second content question** is allowed **only** for a functional ambiguity with two incompatible readings that would change the number of specs (or leave the requested outcome unidentifiable). Anything smaller — confirming an observable technology, closing an implementation detail, raising confidence from medium to high — is **not** asked: it goes to `## Assumptions` or `## Open questions`.
- **On acceptance** — still single-pass: the cut comes from the prompt plus the reconnaissance already done, never from a second look. Per part, mint with `aw next-number docs/specs` **immediately before each write**, then write that draft. Numbers come out consecutive, so every sibling path is known after the first mint.
- **Sibling contract**: each `## Origin` records the shared prompt + `split (part i/N)` + the **siblings by path** + the suggested order; each `## Scope` Out points to the sibling that owns the excluded part. Cross-reference by path, never by bare number.
- **Report**: list the N files and suggest the next step per spec (`/w:spec-refine` on the first — each sibling refines and plans at its own moment).

## Draft schema (`NNN-spec-<slug>.md`)

```markdown
---
status: draft
---

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

> **`Open questions` goes last** — the refined spec **inserts before `Open questions`** `## UI spec` (if there is UI) + `## Decisions`, and may add `## Affected capabilities` / `## Behavioral changes` right after `Context` when the change touches behavior that already exists (refined schema in the [`spec-refine-loop`](../loops/spec-refine-loop/LOOP.md); the refine drops `Open questions` when it empties). Same skeleton: the draft and the refined spec share the order.

**Filling notes:**

- The draft's **content** is written in the **user's language** (the schema headings stay as-is).
- No `Type` field — `plan-new` infers the how.
- **`status: draft`** in the frontmatter is the draft's maturity mark. This command writes no other value: only the `spec-refine` gate promotes a spec to `ready-for-plan`.
- `Scope` always carries `Out` (what stays out).
- **Where the reconnaissance lands** — `Context`: the facts that place the request (sources apparently involved, a module's observed responsibility, the relevant technology), with **at most one path per component** as an anchor; never a technical inventory. `Assumptions`: the inferences that let the draft advance. `Open questions`: what would need walking the implementation, a human decision, or a source that is not available.
- **The code found never widens `Scope`** and never becomes a requirement: **acceptance criteria derive from the user's intent**. The reconnaissance may lend the right vocabulary, name existing actors and boundaries, and avoid obvious contradictions. It must not invent behavior nobody asked for, turn a current technical decision into a user requirement, or impose an implementation as a criterion.
- **Acceptance criteria = static testable criteria** (the "what"): `plan-exec` validates them, but progress is tracked in the PLAN (its Tasks), never by ticking these `- [ ]` in the spec; the spec never mutates by execution, only by a re-refine.
- **Scenarios = behavior made concrete** (uppercase GIVEN/WHEN/THEN/AND): draft them only when the prompt already describes behavior — deriving the rest is spec-refine work, not this command's. A scenario earns its place only when it adds GIVEN setup or edge semantics the criterion does not capture — **never restate a criterion 1:1**.
- If **UI** is involved, mention it in `Requirement`/`Context`; the `## UI spec` is authored in `spec-refine` (via the `ui-design` capability). "UI unspecified" is a first-class refinement gap.
- The **gaps** the loop detects = weak sections of the schema (vague Requirement, Scope without `Out`, untestable criteria, open questions, undeclared assumptions, contradictions) **+ UI unspecified** when the requirement involves UI.
- Equivalent alternative: the user creates the draft by hand. Both paths produce the same `docs/specs/NNN-spec-<slug>.md`.

> **Reuse by escalation:** the live escalation from `/w:quick` (see [`../loops/quick-loop/LOOP.md`](../loops/quick-loop/LOOP.md) § *QUICK delta*) materializes its draft following **this same procedure** (steps 1-3: same schema, same single-pass hard rule — with **NO RESEARCH** and no reconnaissance: the objective and its context arrive adopted), with `## Origin` = "escalated from `/w:quick`" + the original prompt. No need to type `/w:spec-new`: the consent in the structured-choice equals invoking it.
>
> **Reuse by adoption:** [`/w:persist`](persist.md) (requirement-shaped content) materializes its spec draft with this same procedure, with `## Origin` = "adopted from host conversation" + attribution. Paraphrasing conclusions **already established in this conversation** is still single-pass, and needs no reconnaissance — adoption is transcription, not investigation (chassis § *Adopted context*).

## Plan mode

Resolves `NNN` by reading `docs/specs/`, runs the same bounded reconnaissance (read-only in either mode) and describes the draft(s) it would generate — split gate included: it reports the proposed cut — without writing any file.

## Resources

- Design reference: `docs/referencias/workflow-commands/spec-new.md`
- Loop that refines this draft: `../loops/spec-refine-loop/LOOP.md`
