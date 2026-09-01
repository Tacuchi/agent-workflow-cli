---
name: spec-refine-loop
description: >-
  Refines a draft spec (docs/specs/NNN-spec-<slug>.md) by editing it IN PLACE
  until PLAN can design without inventing behavior, scope or product
  decisions. Heir of the chassis (loops/CHASSIS.md). Deltas: current-behavior
  baseline, change-shape gate, gap taxonomy classified by destination,
  conditional ideation gate, ## Design references via the design capability, and
  the ready-for-plan gate that stamps the status frontmatter plan-new reads.
  Started by /w:spec-refine (or the live escalation from quick-loop);
  resumable via CHECKPOINT and re-runnable on demand.
---

# spec-refine-loop

> **Heir** of the common chassis — **only** the SPEC deltas live here. The engine is never repeated.

## Inherits

Read **[`../CHASSIS.md`](../CHASSIS.md)** — the loop's **full engine** — **always before** these deltas. *(If `../` does not resolve: `CHASSIS.md` next to this file — global layout rule, chassis § Reference resolution.)*

## Flow
SPEC

## Layer
2 — the AI runs it end to end (gap-driven). The user does not drive the cycle; they only answer content questions and steer the lifecycle via the `flow` control.

## Started by
`/w:spec-refine` — **resumable**. Detects prior state (via CHECKPOINT) and starts accordingly (see *Compact / resume — SPEC keys*).

It is also started by the **live escalation from `quick-loop`** (entry gate or mid-loop — see [`../quick-loop/LOOP.md`](../quick-loop/LOOP.md) § *QUICK delta*): quick materializes the draft (`spec-new` procedure) and **loads this loop** over that spec — same semantics as if the user had run `/w:spec-refine`.

## Convergence target

> **READY FOR PLAN, NOT PERFECTLY CLOSED**
>
> Converge when the spec defines behavior and scope well enough that PLAN can design the solution without inventing functional decisions. Do NOT close in SPEC the architecture or implementation questions that can be answered later without changing the contract.

Closing *every* gap turns the spec into a premature plan. Close what changes **what** gets built; what only changes **how** travels to `PLAN` with its destination declared (§ *Gap taxonomy*).

## Reads
- `docs/specs/NNN-spec*.md` (glob — locates the spec by number; also catches the legacy `NNN-spec.md`), **or** the exact path passed as the command argument. **Always the spec itself**: this loop edits it in place; there is no separate "refined" file.

> **Boundary with `spec-new`:** the draft arrives from a **bounded reconnaissance** of the surface ([`../../modules/RECONNAISSANCE.md`](../../modules/RECONNAISSANCE.md), `spec-new`'s `reconnaissance` module) — hypotheses, not verified facts. **Deep investigation is this loop's**: walk the dependencies, check those hypotheses, and close the doubts parked in `## Open questions`.

**Adopt, do not repeat.** `spec-new`'s **facts** are reused; its **assumptions** are re-validated **only when one blocks a gap**; its `Open questions` are re-classified by destination; its one-vs-many hypothesis is re-judged at the *Change-shape gate*. The shallow sweep is never re-run wholesale. Keep the labels distinct — a spec that blurs them cannot be gated: **fact** (backed by repo, data or docs) · **inference** (unproven) · **user decision** · **deferred decision** (owner declared) · **open question** (can still move the contract).

## Writes
Updates `docs/specs/NNN-spec-<slug>.md` **in place** (when the user picks `Aprobar y guardar`): completes sections, **adds** `## Decisions`, closes `Open questions` as they get resolved, and stamps the frontmatter `status: ready-for-plan`. The stamp travels **inside the proposed bytes** — it is a projection of the same save, not a second write to authorize afterwards. Since it overwrites an existing doc, the preview says so and the person approves it **once**.

> **Not every shape decision creates a file** (§ *Change-shape gate*). An accepted **split** writes the reduced original **and** the extracted sibling specs; a replacement by **`Crear una nueva spec`** writes one new file and leaves this one untouched; **`Reformular esta spec`** creates nothing — it edits this same file, same number, same path. Every write, new or overwriting, is confirmed first.

> **Boundary invariant:** this loop writes **only** into `docs/specs` and, when the requirement involves UI, the **design package** it composes under `docs/designs` (chassis § *docs/ boundary* — the package is the capability's own deliverable, not a graduated artifact). It never graduates/exports anything else to `docs/` — that is separate `export-*` work.

## Internal sessions — SPEC instance

Full doctrine in the chassis (§ *Internal sessions* + *Numbering*). This loop's instance:

| Session | When | Artifacts | Role |
|---|---|---|---|
| **refine session** `NNN-<slug>-spec-refine/` | when the loop starts (or resumes) | `SESSION.md` · `CHECKPOINT.md` (· `BACKLOG.md` only if something is deferred) | Owns the run. Type = `refine`; descriptor `<slug>-spec-refine` (the `<slug>` comes from the input spec). |

> **Origin on escalation:** when the run is born from quick-loop's live escalation, the session's `## Origin` records "escalated from `/w:quick`" + the origin quick session if it exists (its `DECISION`/`SCRIPTS.sql` are referenceable context — never migrated).

> **Compat (legacy):** old workspaces may hold `NNN-spec.md` / `NNN-spec-refined.md` and separate `*-research-*` sessions — historical, left as-is. The `NNN-spec*.md` glob still finds the base spec, and re-running spec-refine edits it in place from then on.

## Composes

The **UI unspecified** gap (when the requirement involves UI; see *Gap taxonomy*) is resolved by the composed **`design`** capability ([`../../roles/design/ROLE.md`](../../roles/design/ROLE.md)) over the **UI Design Package v1**: reuse a compatible baseline or open an `outline` revision when expanded; a compact delta publishes its `handoff` in one pass. Publish it through the CLI, and leave in the spec **only** its `## Design references` — package, baseline hint and digest. The loop contributes iteration/Q&A (design system, theme, variants, disambiguation) **via the same structured-choice**; the capability contributes what a correct package looks like. Full rule: [`DESIGN-REFERENCES.md`](../../modules/DESIGN-REFERENCES.md).

> **Two levels of the same capability:** a compact SPEC may already close its exact roots at `handoff`; otherwise SPEC keeps an `outline` reference and PLAN promotes exactly the closure it implements. A valid handoff is reused, never re-authored. One package, two questions — never two formats.

> **Compound publication:** a new baseline carries this final spec as `consumer_document`
> (path + base digest); package, manifest and spec publish or roll back together.

Other transversal capabilities the engine always uses: `research` (**inline** — chassis § *Research*), `sql` (DB rule inside research — chassis). All resolved by config; `off` → the loop continues without the capability and, if it was needed, says so or asks. The spec's **prose** follows the **ambient** writing conventions (the host auto-applies an installed writing skill if present), not a composed role.

> **Ambient conventions (not roles):** code/testing/writing standards and `creating-tools` are standalone skills the host auto-discovers by `description` — Workline neither binds nor depends on them. Full doctrine: [../../roles/README.md](../../roles/README.md).

## Current-behavior baseline (brownfield first)

When the project already exists, establish the current behavior the change rests on **before** describing the change: what happens today, which actor starts or receives it, which capabilities take part, which existing rules and observable limits shape the request — each with its source.

**Stop when the baseline is enough to state and accept the functional change** — not when the system is documented. Digging on to pick an architecture, anticipate tasks or map every dependency is `PLAN` work, and gold-plating here. Greenfield has no baseline: skip it — that is what makes `## Behavioral changes` earn its place or not.

## Deliverable schema (the spec, edited in place)

The spec is completed **in place**: the draft's sections get **completed**, a few are **added**, and the frontmatter `status` is stamped. NO separate file is created.

```markdown
---
status: ready-for-plan    ← stamped on Guardar (vocabulary: draft | refining | ready-for-plan)
---

# Spec NNN — <slug>

## Origin                 (opt. — preserved from the draft)
## Requirement            (sharpened, unambiguous)
## Context                (complete)
## Affected capabilities  (opt. — functional boundaries, NOT a repo list; only when the
                           change touches capabilities that already exist. The repos that
                           implement them belong in Context, as evidence or location)
## Behavioral changes     (opt. — behavior added / modified / removed / preserved; only
                           when existing behavior is touched — greenfield omits it)
## Scope                  (clear In / Out)
## Acceptance criteria    (functional, observable, product-level; - [ ] AC-nn; EARS style;
                           behavioral ones expand in ## Scenarios)
## Scenarios              (opt. — GIVEN/WHEN/THEN/AND blocks; each traces to ≥1 criterion.
                           Only when it adds GIVEN setup or edge semantics the criterion
                           does not capture — NEVER a 1:1 restatement of a criterion)
## Assumptions            (declared)

## Design references      (opt. — if UI is involved; via the composed design capability)
The exact package, baseline hint and digest — never the design itself. See [`design`](../../roles/design/ROLE.md).

## Decisions              ← ADDED — the material decisions, NOT the run's history
The choices a reader needs in order to interpret the contract, each with its why.

## Open questions         (each entry declares its destination; OMIT the section when empty)
```

> **Ready mark (contract with PLAN):** the frontmatter **`status`** is the mark — `ready-for-plan` means this gate passed and plan-new can proceed; `draft` and `refining` make it soft-suggest a refine first. It is machine state, never prose. *(Legacy specs carry no frontmatter: `## Refinement decisions` — and the older `## Q&A traceability` — still count as ready. A legacy mark does NOT skip the gate on a re-refine.)*

> **`## Decisions` is contract, not expedient.** Only the material decisions, each with its why — not the transcript of every question asked, file read, discarded alternative or progress step: that detail lives in the session (`CONCLUSIONS`, `CHECKPOINT`), which is where a reader of the contract should not have to go. *(It replaces `## Refinement decisions`, which stays the name of plan-refine's audit trace — that one has no `status` to take over as its prior-work mark.)*

> **`## Open questions` carries destinations.** Each entry states why it is still open, whether it blocks `ready-for-plan`, and where it goes: `PLAN`, the user, later research, another spec. A question may survive convergence **only** if it does not force `PLAN` to invent behavior.

> **Acceptance criteria = functional, observable outcomes at product level** (the "what"), each labeled `AC-nn` — the label is what makes it addressable: a decision note amends it as `S{NNN}/AC-nn`, with `S{NNN}` derived from the spec's file number (the full id spelled on the line reads the same, never twice). A note naming a criterion the spec does not state is refused (`CONTRACT_ASSERTION_ABSENT`). **The verification strategy — tests, evidence, commands — is the PLAN's** (its `## Validations`): here goes the outcome, there goes how it is proven. Progress is tracked in the PLAN (its Tasks), never by ticking these `- [ ]` in the spec; the spec never mutates by execution, only by a re-refine.

## Who decides what

> **Directed tranche:** the deterministic steps below are decided by the CLI (`aw flow advance`), not by this document — it opens the session, resolves the shape gate, decides when the ideation offer and the ambiguity question appear, evaluates the ready-for-plan gate and holds the save until its result comes back. What stays here is the *why*: the taxonomy, the checklist and what each branch means. The split gate keeps its rule in [`../../modules/SPLIT-GATE.md`](../../modules/SPLIT-GATE.md), which the PLAN flows still read.

## Gap taxonomy — signal, resolver, destination

`detect_gaps(work)` looks for these signals. Each is **classified by destination before its resolver is chosen**: closing a `PLAN`-owned question here is the failure mode this taxonomy exists to prevent.

| Gap | Signal | Resolved by | Destination |
|---|---|---|---|
| Vague requirement | the what/why is ambiguous | **human** | SPEC — blocking |
| Blurry scope | `Out` missing, or In/Out overlap | **human** | SPEC — blocking |
| Business rule undefined | which condition decides an outcome | **research** or **human** | SPEC — blocking |
| Unverifiable criterion | the outcome is not observable at product level | **human** (make the OUTCOME observable — often as a `### Scenario`) | SPEC — blocking |
| Test-shaped criterion | the criterion prescribes evidence or test mechanics instead of an outcome | the AI proposes the functional rewrite + **human** confirms | SPEC (the mechanics travel to PLAN) |
| Internal contradiction | sections contradict each other | **human** | SPEC — blocking |
| Current behavior unknown | the baseline the change rests on is missing | **research** (inline) | SPEC → `Context` / `Behavioral changes` |
| Incomplete context | systems/components unidentified | **research** | SPEC |
| Scenario missing | behavioral criterion whose behavior is NOT captured by its WHEN/THEN (needs GIVEN setup or edge semantics; a criterion a scenario would only restate 1:1 is not a gap) | the AI drafts GIVEN/WHEN/THEN + **human** confirms | SPEC |
| Hidden assumptions | the spec assumes unstated things | **research** validates / **human** confirms | SPEC |
| Over-specified requirement | scope/criteria gold-plated — beyond the actual need (chassis § *Minimality*) | **human** (AI proposes the cut, human ratifies) | SPEC |
| Unexplored solution space *(conditional)* | the spec settles on the first conceivable approach **and** a trigger fires (see *Ideation gate*) | **human consents** → **ideation** | SPEC — only on a trigger |
| UI unspecified *(if it applies)* | the requirement involves UI but `## Design references` is missing | composed **`design`** capability | SPEC |
| Architecture | how to distribute technical responsibilities | — | **`PLAN`** — declare, never close here |
| Implementation | library, class, method, pattern, folder layout | — | **`PLAN`** / `EXEC` — outside the spec |
| Executable technical risk | whether an integration really works | — | **`PLAN`** (probe), unless the answer changes the contract |
| Non-blocking detail | does not change what will be built | — | deferred, with destination |

**Blocking or not.** A gap **blocks SPEC** when its answer can change the outcome, the scope, a business rule, an actor, an acceptance criterion, or the one-vs-many decision. Anything else is recorded with its destination and the loop moves on.

**Resolution order** — the chassis *ask-vs-research rule* with the destination step in front: settled in the conversation → **adopt** · provable by reading repos or data → **research inline** · depends on what the user wants → **ask** · defines the technical solution without changing behavior → **hand to `PLAN`** · answerable later without touching the contract → **defer explicitly**.

## Sequence

```
spec-refine-loop(spec):
  input = glob(NNN-spec*.md) | argument (path)          # always the spec itself (in place)
  refine_session = the run's session          # the CLI opens or resumes it and verifies its seed
  SESSION.Success criteria = acceptance criteria + ready-for-plan checklist  # what its gate evaluates later
  work = read(input)  (+ apply checkpoint progress if resuming)
  adopt(spec-new facts + assumptions + open questions + conversation)  # never re-derive (§ Reads)
  baseline = resolve_current_behavior(work)      # inline research, ONLY what the change rests on
  on the shape branch (see ../../modules/SPEC-CHANGE-SHAPE.md for what each one means):
    `Una sola spec`           → keep refining this spec
    `Dividir en varias specs` → the accepted cut is fixed now; its writes wait for `Guardar specs`
    `Crear una nueva spec`    → mint draft with confirmation (## Origin) ; THIS spec untouched ;
                                CHECKPOINT.Next = refine it ; goto finalize
    `Reformular esta spec`    → same number/path ; re-run baseline before any stamp
  attempts = {}                                          # anti re-fire per gap
  repeat:
    gaps = classify_by_destination(detect_gaps(work)) minus the "exhausted" gaps
    record(gaps.plan_owned + gaps.deferrable) → ## Open questions with destination  # never closed here
    blocking = gaps.spec_blocking
    if blocking == ∅: break
    batch = top ≤3 blocking ; pending_human = []   # gap questions ONLY — the shape was resolved above
    seed CHECKPOINT.Pending/Next = batch (refine_session) # BEFORE: seed the intent (artifact-first)
    for each gap in batch:
      if gap = UI (requirement involves UI, ## Design references missing):
        compose design → reuse a compatible baseline OR publish an `outline` revision
                                                 # design-system/theme via structured-choice (counts in the batch)
        work = integrate(work, design)           # → ## Design references (package + hint + digest)
      else if gap = Unexplored solution space:
        declare the trigger signal               # the CLI decides whether the offer appears
      else if factual(gap) and attempts[gap] < MAX:
        if it needs DB and >1 MCP without default → queue "MCP choice" in pending_human
        res = research_inline(gap)           # current session: ANALYSIS-FILE → CONCLUSIONS (+read-only SCRIPTS.sql)
        if res.conclusive: work = integrate(work, res)   # → Context / Behavioral changes / Decisions
        else: attempts[gap]++ ; if attempts[gap] >= MAX → pending_human.push(gap)
      else:
        pending_human.push(gap)
    update CHECKPOINT (refine_session)        # AFTER: Pending→Completed, at every gap boundary (chassis)
    if pending_human not empty:
      ans = structured_choice(content: pending_human (≤3), flow: [Compactar, Cerrar])
      switch(flow):
        Compactar → write CHECKPOINT (refine_session) ; compact(harness) ; continue
        Cerrar    → goto finalize
      work = integrate(work, ans)            # → Decisions / Open questions
      ideation offer accepted → run the round NOW, then its verdicts as a NEW ≤3+flow batch (§ Ideation gate)
      ideation offer declined → mark that gap exhausted    # anti re-fire; on-demand entry stays open
  # no BLOCKING gaps → the CLI evaluates the ready-for-plan gate over the run's
  # Success criteria and asks for their real state; whatever fails comes back as a gap.
  hand the CLI the exact bytes of the refined spec, with status: ready-for-plan already stamped in them
                       # split branch → the same bytes carry the extracted siblings as status: draft
  the CLI seals them into ONE proposal and shows its preview: destination, weight, what it replaces
  Aprobar y guardar  → the CLI writes every file of the preview, together or not at all ; goto finalize
  Refinar            → nothing is written and the refinement stays open
  flow Compactar/Cerrar → handle the same way
finalize:
  write CHECKPOINT (refine_session)                     # always persisted
  if deferred/follow-ups exist → write/update BACKLOG (reason + deferred Open questions)
  close refine_session ; report
```

## Convergence / exit

- **No blocking gaps** → **ready-for-plan gate** (read-only) = **`Success criteria` green** (*verification-first*; the SPEC instance of the chassis convergence gate). The checklist:
  - the requested outcome is understandable, the relevant current behavior is established, and the behavior change is described whenever existing behavior is touched;
  - `Scope` separates In from Out; every acceptance criterion traces to the `Requirement`; scenarios trace to ≥1 criterion and add GIVEN setup or edge semantics beyond it, without contradicting `Scope` (a 1:1 restatement is gold-plating: cut it);
  - no criterion prescribes verification mechanics (test names, evidence, commands) or an internal mechanism: that travels to `PLAN` with its destination declared;
  - every criterion carries its `AC-nn` label — what a decision note amends as `S{NNN}/AC-nn`; an unlabeled criterion is one no decision can address;
  - no material contradictions; the one-vs-many shape was validated at the *Change-shape gate*;
  - every **blocking** functional decision is resolved, and every remaining question carries its destination;
  - **Minimality** — no gold-plating: every criterion and scope item earns its place (chassis § *Minimality*); speculative scope is cut or deferred, and no technical solution was imposed that the requirement did not ask for;
  - `PLAN` can continue without inventing behavior, scope or product decisions.
  - its gate evidence is checkout-bounded: local inspection/commands may establish it; a deployed product, host runtime or remote query is context or handoff, never a closing condition.
- Whatever fails **comes back as a gap**. A question owned by `PLAN` **never** fails the gate: it is recorded with its destination, not closed.
- Passes → `edit_in_place_with_confirm(spec)` + `status: ready-for-plan` → `finalize`. The stamp only counts once the document really carries it.
- `Cerrar` → the chassis `finalize` (always persists `CHECKPOINT`; `BACKLOG` **only if** something is deferred — here: close reason + deferred `Open questions`).

## Integration (where each resolution lands)

- **Inline research** → the fact lands in `## Context` / `## Behavioral changes`; if it settles a choice, the choice goes to `## Decisions` (+ ref to the session's `CONCLUSIONS`).
- **Ideation** → per verdict (§ *Ideation gate*): `Adoptar` → the spec's sections + `## Decisions` · `Descartar` → `CONCLUSIONS` · `Aparcar` → `## Open questions`.
- **Human** → `## Decisions`, as the decision plus its why. **Not** a `Q:` transcript: the question-by-question trace stays in the session.
- **Composed `design`** (UI gap) → the package under `docs/designs/` (published through the CLI) + the spec's `## Design references` section, and nothing else in the spec.
- **Owned by `PLAN` or deferred** → `## Open questions` with its destination, and nothing else in the spec.
- **Inconclusive or unresolved research** → `## Open questions` (deferred) + the refine session's `BACKLOG.md` (only if something is deferred).

## Conditional modules

- `shape` — the change-shape gate and its split / replace branches → `../../modules/SPEC-CHANGE-SHAPE.md`
- `ui` — what the spec keeps when the requirement involves UI → `../../modules/DESIGN-REFERENCES.md`
- `web` — the conditional ideation gate, its triggers and verdicts → `../../modules/IDEATION-GATE.md`
- `resume` — the SPEC keys of compact / resume → `../../modules/SPEC-REFINE-KEYS.md`
