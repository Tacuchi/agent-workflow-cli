---
name: spec-refine-loop
description: >-
  Refines a draft spec (docs/specs/NNN-spec-<slug>.md) by editing it IN PLACE
  until PLAN can design without inventing behavior, scope or product
  decisions. Heir of the chassis (loops/CHASSIS.md). Deltas: current-behavior
  baseline, change-shape gate, gap taxonomy classified by destination,
  conditional ideation gate, ## UI spec via the ui-design capability, and the
  ready-for-plan gate that stamps the status frontmatter plan-new reads.
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

> **Boundary with `spec-new`:** the draft arrives from a **bounded reconnaissance** of the surface ([`../../commands/spec-new.md`](../../commands/spec-new.md) § *Bounded reconnaissance*) — hypotheses, not verified facts. **Deep investigation is this loop's**: walk the dependencies, check those hypotheses, and close the doubts parked in `## Open questions`.

**Adopt, do not repeat.** `spec-new`'s **facts** are reused; its **assumptions** are re-validated **only when one blocks a gap**; its `Open questions` are re-classified by destination; its one-vs-many hypothesis is re-judged at the *Change-shape gate*. The shallow sweep is never re-run wholesale. Keep the labels distinct — a spec that blurs them cannot be gated: **fact** (backed by repo, data or docs) · **inference** (unproven) · **user decision** · **deferred decision** (owner declared) · **open question** (can still move the contract).

## Writes
Updates `docs/specs/NNN-spec-<slug>.md` **in place** (when the user picks `Guardar especificación refinada`): completes sections, **adds** `## Decisions`, closes `Open questions` as they get resolved, and stamps the frontmatter `status: ready-for-plan`. Since it overwrites an existing doc, it asks the user's **confirmation**. An accepted split — or an accepted replacement — also **creates** new spec files (§ *Change-shape gate*).

> **Boundary invariant:** this loop writes **only** into `docs/specs`. It never graduates/exports other artifacts to `docs/` — that is separate `export-*` work (chassis § *docs/ boundary*).

## Internal sessions — SPEC instance

Full doctrine in the chassis (§ *Internal sessions* + *Numbering*). This loop's instance:

| Session | When | Artifacts | Role |
|---|---|---|---|
| **refine session** `NNN-<slug>-spec-refine/` | when the loop starts (or resumes) | `SESSION.md` · `CHECKPOINT.md` (· `BACKLOG.md` only if something is deferred) | Owns the run. Type = `refine`; descriptor `<slug>-spec-refine` (the `<slug>` comes from the input spec). |

> **Origin on escalation:** when the run is born from quick-loop's live escalation, the session's `## Origin` records "escalated from `/w:quick`" + the origin quick session if it exists (its `DECISION`/`SCRIPTS.sql` are referenceable context — never migrated).

> **Compat (legacy):** old workspaces may hold `NNN-spec.md` / `NNN-spec-refined.md` and separate `*-research-*` sessions — historical, left as-is. The `NNN-spec*.md` glob still finds the base spec, and re-running spec-refine edits it in place from then on.

## Composes

The **UI unspecified** gap (when the requirement involves UI; see *Gap taxonomy*) is resolved by **composing** the **`ui-design`** capability (built-in default `ui-spec`; rebindable via `.workflow/skills.toml`): it authors the UI spec natively (structure, vocabulary, Markdown format). It is the chassis' composed-capability resolution mode (next to *research*, *probe* and *human*): the loop contributes iteration/Q&A (design system, theme, variants, disambiguation) **via the same structured-choice**, and integrates the result as the spec's `## UI spec` section.

> **Two levels of the same capability:** here (SPEC) it produces `## UI spec` — the UI's *what*, coarse grain; in PLAN the plan loops produce **per-screen design SPECs** derived from that section (see [`SPEC.md`](../../artifacts/artifacts-design/SPEC.md)).

Other transversal capabilities the engine always uses: `research` (**inline** — chassis § *Research*), `sql` (DB rule inside research — chassis). All resolved by config; `off` → the loop continues without the capability and, if it was needed, says so or asks. The spec's **prose** follows the **ambient** writing conventions (the host auto-applies an installed writing skill if present), not a composed role.

> **Ambient conventions (not roles):** code/testing/writing standards and `creating-tools` are standalone skills the host auto-discovers by `description` — Workline neither binds nor depends on them. Full doctrine: [../../roles/README.md](../../roles/README.md).

## Current-behavior baseline (brownfield first)

When the project already exists, establish the current behavior the change rests on **before** describing the change: what happens today, which actor starts or receives it, which capabilities take part, which existing rules and observable limits shape the request — each with its source.

**Stop when the baseline is enough to state and accept the functional change** — not when the system is documented. Digging on to pick an architecture, anticipate tasks or map every dependency is `PLAN` work, and gold-plating here. Greenfield has no baseline: skip it — that is what makes `## Behavioral changes` earn its place or not.

## Change-shape gate

Runs once the baseline exists and **before** closing details: the investigation can reveal the draft's shape was wrong. Does the spec still carry **one** functional outcome, did its purpose survive, can the delivery be accepted as a unit? The verdict is **one of three shapes** — `same` | `split` | `replace` — each with its own branch; only the last two ask anything.

- same outcome — more clarity, or more technical components → **`same`**: no shape question, keep refining this spec;
- independent functional outcomes discovered → **`split`** (below);
- purpose fundamentally changed → **`replace`** (below);
- refactor indispensable to the outcome → a consideration for `PLAN`, never its own spec; refactor with no functional change → out of the contract;
- evidence insufficient → **`same`** + the uncertainty recorded. Thin evidence never justifies a cut.

**Split criterion** — the one `spec-new` already uses ([`../../commands/spec-new.md`](../../commands/spec-new.md) § *Split gate (multi-spec)*), never a different one: divide **only** when each part can be refined, accepted and planned on its own. Repos, technologies, layers or teams are **secondary evidence**, never the reason.

**Split semantics (in place).** The offer enters the batch as a content question — `Dividir en varias specs` | `Una sola spec`; declining marks it **exhausted** for the run. On acceptance: the original **keeps its number/path**, rewritten reduced to its remaining outcome; each extracted outcome is minted with `aw next-number docs/specs` right before its write and is born **`status: draft`**. Siblings are **not** elaborated here — unlike the multi-plan gate, where `plan-exec` would break on a plan with no `## Tasks`; a draft spec is legitimate input to this very loop — so the run keeps refining the **reduced original** and reports `/w:spec-refine` as each sibling's next step. Every `## Origin` records "split from `docs/specs/NNN-spec-<slug>.md`" + the siblings **by path**. Closing action on this branch: `Guardar specs`.

**Replace semantics.** Its offer is its own — `Crear una nueva spec` | `Reformular esta spec`, **never** the split labels: what gets decided is which identity carries the new purpose. Recommend **a new spec** when the main functional outcome or the actor/consumer changed; **reformulating** when the user confirms this file is still the same unit of work and wants to keep its identity.

- **New spec:** this one is **preserved**, its purpose never silently rewritten; the new one is minted with `aw next-number docs/specs`, born **`status: draft`**, its `## Origin` recording the origin spec, the replaced purpose and the user's decision. Its path goes to the `CHECKPOINT`; the run closes reporting `/w:spec-refine <new path>` as the next step.
- **Reformulate:** same number/path, the work treated as `refining` while rewritten; baseline, gap classification and the *ready-for-plan gate* run again over the new purpose; `status` is stamped only on the save that follows the passing gate, and the material decision lands in `## Decisions`.

Neither branch adds a `superseded` status or archives the replaced spec: a historical close needs its own runtime contract, out of scope here.

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
## Acceptance criteria    (testable, - [ ]; EARS style; behavioral ones expand in ## Scenarios)
## Scenarios              (opt. — GIVEN/WHEN/THEN/AND blocks; each traces to ≥1 criterion.
                           Only when it adds GIVEN setup or edge semantics the criterion
                           does not capture — NEVER a 1:1 restatement of a criterion)
## Assumptions            (declared)

## UI spec                (opt. — if UI is involved; via the ui-design capability / ui-spec skill)
Structured Markdown description (screens → regions/components). See [`ui-spec`](../../roles/ui-spec/ROLE.md).

## Decisions              ← ADDED — the material decisions, NOT the run's history
The choices a reader needs in order to interpret the contract, each with its why.

## Open questions         (each entry declares its destination; OMIT the section when empty)
```

> **Ready mark (contract with PLAN):** the frontmatter **`status`** is the mark — `ready-for-plan` means this gate passed and plan-new can proceed; `draft` and `refining` make it soft-suggest a refine first. It is machine state, never prose. *(Legacy specs carry no frontmatter: `## Refinement decisions` — and the older `## Q&A traceability` — still count as ready. A legacy mark does NOT skip the gate on a re-refine.)*

> **`## Decisions` is contract, not expedient.** Only the material decisions, each with its why — not the transcript of every question asked, file read, discarded alternative or progress step: that detail lives in the session (`CONCLUSIONS`, `CHECKPOINT`), which is where a reader of the contract should not have to go. *(It replaces `## Refinement decisions`, which stays the name of plan-refine's audit trace — that one has no `status` to take over as its prior-work mark.)*

> **`## Open questions` carries destinations.** Each entry states why it is still open, whether it blocks `ready-for-plan`, and where it goes: `PLAN`, the user, later research, another spec. A question may survive convergence **only** if it does not force `PLAN` to invent behavior.

> **Acceptance criteria = static testable criteria** (the "what"): plan-exec validates them, but progress is tracked in the PLAN (its Tasks), never by ticking these `- [ ]` in the spec; the spec never mutates by execution, only by a re-refine.

## Gap taxonomy — signal, resolver, destination

`detect_gaps(work)` looks for these signals. Each is **classified by destination before its resolver is chosen**: closing a `PLAN`-owned question here is the failure mode this taxonomy exists to prevent.

| Gap | Signal | Resolved by | Destination |
|---|---|---|---|
| Vague requirement | the what/why is ambiguous | **human** | SPEC — blocking |
| Blurry scope | `Out` missing, or In/Out overlap | **human** | SPEC — blocking |
| Business rule undefined | which condition decides an outcome | **research** or **human** | SPEC — blocking |
| Untestable criteria | acceptance not verifiable | **human** (derive + confirm — often as a `### Scenario`) | SPEC — blocking |
| Internal contradiction | sections contradict each other | **human** | SPEC — blocking |
| Current behavior unknown | the baseline the change rests on is missing | **research** (inline) | SPEC → `Context` / `Behavioral changes` |
| Incomplete context | systems/components unidentified | **research** | SPEC |
| Scenario missing | behavioral criterion whose behavior is NOT captured by its WHEN/THEN (needs GIVEN setup or edge semantics; a criterion a scenario would only restate 1:1 is not a gap) | the AI drafts GIVEN/WHEN/THEN + **human** confirms | SPEC |
| Hidden assumptions | the spec assumes unstated things | **research** validates / **human** confirms | SPEC |
| Over-specified requirement | scope/criteria gold-plated — beyond the actual need (chassis § *Minimality*) | **human** (AI proposes the cut, human ratifies) | SPEC |
| Unexplored solution space *(conditional)* | the spec settles on the first conceivable approach **and** a trigger fires (see *Ideation gate*) | **human consents** → **ideation** | SPEC — only on a trigger |
| UI unspecified *(if it applies)* | the requirement involves UI but `## UI spec` is missing | **`ui-design` capability** | SPEC |
| Architecture | how to distribute technical responsibilities | — | **`PLAN`** — declare, never close here |
| Implementation | library, class, method, pattern, folder layout | — | **`PLAN`** / `EXEC` — outside the spec |
| Executable technical risk | whether an integration really works | — | **`PLAN`** (probe), unless the answer changes the contract |
| Non-blocking detail | does not change what will be built | — | deferred, with destination |

**Blocking or not.** A gap **blocks SPEC** when its answer can change the outcome, the scope, a business rule, an actor, an acceptance criterion, or the one-vs-many decision. Anything else is recorded with its destination and the loop moves on.

**Resolution order** — the chassis *ask-vs-research rule* with the destination step in front: settled in the conversation → **adopt** · provable by reading repos or data → **research inline** · depends on what the user wants → **ask** · defines the technical solution without changing behavior → **hand to `PLAN`** · answerable later without touching the contract → **defer explicitly**.

## Ideation gate (creativity)

The loop's one **divergent** gate: every other resolver closes a gap; this one widens the option space before the spec hardens around its first idea. **Unexplored solution space is not a universal gap** — it stays shut unless a trigger fires, because exploring what is already decided burns context and invites gold-plating.

**Triggers (≥1).** The user knows the problem but not the desired outcome · several functional directions carry materially different consequences · the spec adopted the first alternative prematurely · a choice can materially change scope · the alternatives change experience, rules or acceptance · the user asks to explore.

**Not triggers.** More than one technical solution exists · no library is chosen yet · the system uses several technologies · every implementation admits alternatives · the request is already functionally clear. Purely technical alternatives belong to `PLAN`.

1. **Offer & consent.** The gap enters the batch as a content question — `Explorar ideas` vs `Seguir sin ideación` — carrying the AI's recommendation like any other. Declining marks the gap **exhausted** (never re-offered this run); an explicit user request for ideas at any point counts as an accepted offer (on-demand entry). Alternatives already weighed in the conversation are *adopted context* — the gap does not fire.
2. **Ideation round** (one per consent). Propose fresh ideas and **combinations** (the user's + found ones). If the host exposes **web-research** ([`../../harness/HARNESS.md`](../../harness/HARNESS.md)), the accepted offer also authorizes that round's web searches — no per-search consent; findings + sources land in the session's `CONCLUSIONS`, like inline research. Without the capability, ideate offline (own knowledge + workspace + repos) and **declare it** — never silently.

**Verdicts (back to convergence).** Present the top ≤3 ideas via the same structured-choice, each with a recommended verdict: `Adoptar` → integrate into `Requirement`/`Scope`/criteria + record it in `## Decisions` (the choice and its why, with the source/URL when web-found) · `Descartar` → the reason goes to `CONCLUSIONS`, not to the spec · `Aparcar` → `## Open questions` with its destination. Ideas beyond the top 3 stay summarized in `CONCLUSIONS`. Divergence is bounded by *Minimality* (chassis): nothing enters the spec without an explicit `Adoptar`. This gate exists **only** in this loop — `spec-new` stays single-pass (bounded reconnaissance at most, no web) and the plan/quick loops inherit none of it.

## Sequence

```
spec-refine-loop(spec):
  input = glob(NNN-spec*.md) | argument (path)          # always the spec itself (in place)
  refine_session = create_or_resume("<slug>-spec-refine")  # <slug> from the spec; CLI prepends global NNN
  seed SESSION.Success criteria = acceptance criteria + ready-for-plan checklist  # verification-first, BEFORE
  work = read(input)  (+ apply checkpoint progress if resuming)
  adopt(spec-new facts + assumptions + open questions + conversation)  # never re-derive (§ Reads)
  baseline = resolve_current_behavior(work)      # inline research, ONLY what the change rests on
  shape = change_shape_gate(work, baseline)      # BEFORE closing details → same | split | replace
  if shape == split:   pending_human.push(split offer)     # `Dividir en varias specs` | `Una sola spec`
  if shape == replace: pending_human.push(replace offer)   # `Crear una nueva spec` | `Reformular esta spec`
  attempts = {}                                          # anti re-fire per gap
  repeat:
    gaps = classify_by_destination(detect_gaps(work)) minus the "exhausted" gaps
    record(gaps.plan_owned + gaps.deferrable) → ## Open questions with destination  # never closed here
    blocking = gaps.spec_blocking
    if blocking == ∅: break
    batch = top ≤3 blocking ; pending_human = []
    seed CHECKPOINT.Pending/Next = batch (refine_session) # BEFORE: seed the intent (artifact-first)
    for each gap in batch:
      if gap = UI (requirement involves UI, ## UI spec missing):
        compose ui-design → author ## UI spec    # design-system/theme via structured-choice (counts in the batch)
        work = integrate(work, ui)               # → ## UI spec
      else if gap = Unexplored solution space and a trigger fires:
        pending_human.push("ideation offer")     # `Explorar ideas` | `Seguir sin ideación`
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
      work = integrate(work, ans)            # → Decisions / Open questions / the accepted shape
      accepted `Crear una nueva spec`  → mint draft (## Origin) ; this one untouched ; CHECKPOINT.Next = refine it ; goto finalize
      accepted `Reformular esta spec`  → same number/path ; re-run baseline + gaps + ready-for-plan gate before any stamp
      ideation offer accepted → run the round NOW, then its verdicts as a NEW ≤3+flow batch (§ Ideation gate)
      ideation offer declined → mark that gap exhausted    # anti re-fire; on-demand entry stays open
  # no BLOCKING gaps → ready-for-plan gate = Success criteria green (read-only) before offering Guardar:
  issues = ready_for_plan(work)   # § Convergence / exit — PLAN-owned questions never fail it
  if issues: blocking += issues ; continue        # findings come back into the loop as gaps
  ans = structured_choice(content: [Guardar refinada | Guardar specs, Preguntar algo más],
                        flow: [Compactar, Cerrar])
  Guardar            → edit_in_place_with_confirm(spec) + stamp status: ready-for-plan ; goto finalize
                       # split branch → also mint + write the extracted siblings as status: draft
  Preguntar algo más → continue
  flow Compactar/Cerrar → handle the same way
finalize:
  write CHECKPOINT (refine_session)                     # always persisted
  if deferred/follow-ups exist → write/update BACKLOG (reason + deferred Open questions)
  close refine_session ; report
```

## Compact / resume — SPEC keys

Full mechanism (3 cases, `Compactar`, re-run on demand with `--reopen`) in the chassis (§ *Compact / resume*). SPEC keys:

- The **prior-work mark** is the frontmatter `status: ready-for-plan` (legacy specs: `## Refinement decisions`, older ones also `## Q&A traceability`).
- Re-refining on demand is a **first-class operation** while the flow stays in SPEC (new requirements, scope changes, after re-reading the spec): it always reads the **spec itself**, incremental re-refinement; on `Guardar`, edits in place with confirmation.
- **Legacy migration happens only here.** A re-refined legacy spec runs the gate like any other; on `Guardar`, its `## Refinement decisions` is renamed `## Decisions` and pruned to the material decisions — **in the same write that stamps `status`**, so the spec is never left with no mark. Specs nobody re-refines are not migrated.
- **`Cerrar` before converging leaves the spec untouched**: the progress lives in the `CHECKPOINT`, and `status` is neither invented nor downgraded. `refining` is understood **on read** (a hand-written spec may declare it) — this loop never writes a partial spec.

## Convergence / exit

- **No blocking gaps** → **ready-for-plan gate** (read-only) = **`Success criteria` green** (*verification-first*; the SPEC instance of the chassis convergence gate). The checklist:
  - the requested outcome is understandable, the relevant current behavior is established, and the behavior change is described whenever existing behavior is touched;
  - `Scope` separates In from Out; every acceptance criterion traces to the `Requirement`; scenarios trace to ≥1 criterion and add GIVEN setup or edge semantics beyond it, without contradicting `Scope` (a 1:1 restatement is gold-plating: cut it);
  - no material contradictions; the one-vs-many shape was validated at the *Change-shape gate*;
  - every **blocking** functional decision is resolved, and every remaining question carries its destination;
  - **Minimality** — no gold-plating: every criterion and scope item earns its place (chassis § *Minimality*); speculative scope is cut or deferred, and no technical solution was imposed that the requirement did not ask for;
  - `PLAN` can continue without inventing behavior, scope or product decisions.
- Whatever fails **comes back as a gap**. A question owned by `PLAN` **never** fails the gate: it is recorded with its destination, not closed.
- Passes → offer `Guardar especificación refinada` (split branch: `Guardar specs`) → `edit_in_place_with_confirm(spec)` + `status: ready-for-plan` → `finalize`.
- `Cerrar` → the chassis `finalize` (always persists `CHECKPOINT`; `BACKLOG` **only if** something is deferred — here: close reason + deferred `Open questions`).

## Integration (where each resolution lands)

- **Inline research** → the fact lands in `## Context` / `## Behavioral changes`; if it settles a choice, the choice goes to `## Decisions` (+ ref to the session's `CONCLUSIONS`).
- **Ideation** → per verdict (§ *Ideation gate*): `Adoptar` → the spec's sections + `## Decisions` · `Descartar` → `CONCLUSIONS` · `Aparcar` → `## Open questions`.
- **Human** → `## Decisions`, as the decision plus its why. **Not** a `Q:` transcript: the question-by-question trace stays in the session.
- **`ui-design` capability** (UI gap) → the spec's `## UI spec` section.
- **Owned by `PLAN` or deferred** → `## Open questions` with its destination, and nothing else in the spec.
- **Inconclusive or unresolved research** → `## Open questions` (deferred) + the refine session's `BACKLOG.md` (only if something is deferred).
