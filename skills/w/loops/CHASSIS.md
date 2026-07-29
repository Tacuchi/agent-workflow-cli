# CHASSIS — the loop engine

This document is the **common engine** of the Workline loops: the doctrine every loop runs underneath its deltas. **It is not a skill** — it is a referenced document: every loop orders it read from its `## Inherits`, **always, before its deltas**. If you edit the engine, edit it **here** — heirs never repeat it, they only reference it.

## Heirs (canonical list)

The **5 loops** run this engine; each adds only its deltas:

- [`spec-refine-loop`](spec-refine-loop/LOOP.md) — refines the **spec** in place.
- [`plan-new-loop`](plan-new-loop/LOOP.md) — generates the **plan** from the spec.
- [`plan-refine-loop`](plan-refine-loop/LOOP.md) — refines the **plan** in place (auxiliary).
- [`plan-exec-loop`](plan-exec-loop/LOOP.md) — **executes** the plan: code, DB and git.
- [`quick-loop`](quick-loop/LOOP.md) — **minimal ceremony** (the prompt *is* the objective).

The two that edit code also apply [`CODE-POLICIES.md`](CODE-POLICIES.md).

## Persistent objective

A loop **is a persistent objective**: it exists to fulfill the `SESSION.Objective` declared at start, and **it is not finished until the convergence gate confirms the objective was met**. Gap-driven iteration is the *method*; the artifacts are the *record*; the objective is the *frame*.

"Don't stop until convergence" is sustained by the loop itself — its `repeat:` plus the convergence gate — never by a host hook, which is what makes it harness-agnostic. Each heir instantiates the frame: `spec-refine` pursues the spec; the plan loops pursue the plan up to their gate; `plan-exec` up to its final validation; `quick-loop` most directly of all (the prompt *is* the objective).

> **Inter-turn continuity.** The same `CHECKPOINT`+resume governs the **next prompt**: the objective persists **across turns**, not only within a run. The canonical rules (command = new work line · re-run = `create_or_resume` · bare prompt = continue the most recent session · reopening closed sessions · consented escalation) live in [`../SKILL.md`](../SKILL.md) § *Operating context* — **single source**; this engine executes them via *Compact / resume* (case 3).

## Verification-first

The persistent objective needs a **checkable done-condition** — otherwise the loop cannot know when it is done (or chases a target it invented). That condition is **seeded BEFORE executing**, never improvised at the end: it is **generalized TDD**. Together with artifact-first (next section) these are the **two seeds** of every gap/phase: *how will I know it worked* + *what am I about to do*.

**Where it lives:** in `SESSION.Success criteria` — a `[ ]` checklist of **falsifiable** criteria (that *can* fail). `CHECKPOINT.Pending/Completed` tracks the **red→green** progress. Two forms, by deliverable:

| Deliverable | Criterion = | Cycle |
|---|---|---|
| code / script / fix / feature | **runnable tests** (unit, build, lint, bug repro) | literal TDD: red → green → refactor |
| DB migration (not executable; invariant 4) | **rubric**: `SCRIPTS.sql` valid + reviewed (never executed) | rubric |
| spec / plan | **rubric** = the document's acceptance criteria (referenced, not duplicated) | rubric |
| analysis / design | **rubric falsifiable by inspection** (e.g. "every affected site with `file:line`"; "each decision: rationale + ≥1 alternative") | rubric |

- **Form and weight scale**: a chore = "existing tests/build stay green" (one line); a feature = real acceptance tests. The rule is "**always declare the check before**", not "always write new tests".
- **Subjective deliverable** (analysis/design): the AI **proposes** the rubric and the **human ratifies** it before pursuing it.
- **Unresolvable criterion** (no evidence, DB unavailable): closes as `inconclusive` and the loop **degrades** — **never iterates against a fake target**.

> The **convergence gate** is, operationally, **"all `Success criteria` green"**. The per-heir gates are **instances** of it, with the criteria seeded at start.

**Gate integrity (anti-gaming + independent verification).** The gate only counts if it is not gamed to pass. The loop does **not**: modify the check or loosen a `Success criterion` to force green; weaken, delete or skip tests/validations; use trivial or tautological asserts that always pass (the expected value comes from an independent source, never from the output itself); patch the test instead of fixing the cause (prefer fixing production code).

Facing a real blocker it **stops and reports it** (→ `Open questions`/`BACKLOG`) instead of gaming the metric. The verdict counts **only the check's output, never the implementer's self-declaration**: when the deliverable warrants it, the final verification is an **independent** pass (subagent or clean re-read) that does not assume the implementation is correct — *only command output counts*.

**Minimality (anti-over-engineering).** Passing the criteria is **necessary, not sufficient**: the gate also rejects a deliverable **heavier than its `Success criteria` require** — YAGNI at the deliverable's altitude. A spec can be coherent yet over-specified; a plan sound yet over-engineered; a diff green yet padded with reinvented stdlib, speculative abstractions or dead flexibility. At its own altitude the gate asks the laziest-that-works questions:

- **does each part need to exist at all?** — speculative → cut it (the strongest lever, cheapest at spec/plan altitude);
- **is it already there?** — in the codebase, the stdlib or the platform → reuse it, never reinvent;
- **could it be smaller?** — same behavior, fewer moving parts → shrink it.

This is a **built-in floor** owed by every gate with **no external skill**; the code-editing loops *raise* it with the installed ambient conventions (`CODE-POLICIES.md` § *Closing review gate*) but never fall below it. Bounded by *Gate integrity*: never trim validation at trust boundaries, error handling, security, accessibility or anything the spec explicitly requires — minimality cuts over-building, never correctness. Each heir instantiates the lens: **spec** = over-specified/gold-plated scope · **plan** = over-engineered solution / needless phase-task · **code** = the `delete`/`stdlib`/`native`/`yagni`/`shrink` diff lens.

## Artifacts as a live log — the artifact-first cycle

The loop works **artifact-first**: the artifact is **seeded before** executing and **updated after**, not only on close. Every gap/phase/task runs the **3-beat** cycle:

1. **BEFORE — seed the intent.** Before executing, record in the artifact what is **about to** be done: `CHECKPOINT.Pending`/`Next` = the imminent work (`SESSION.Objective` already fixed the run's what).
2. **EXECUTE.** Resolve the gap / run the phase / edit the code.
3. **AFTER — bring to actual state.** `CHECKPOINT.Pending → Completed`; `DECISION` records the non-obvious **as it is decided**; `BACKLOG` **only if** something is deferred/follow-up (`session-close` no longer fabricates an empty BACKLOG).

> The artifact expresses the **intent** (before) and then the **result** (after), at **every** gap/phase boundary — not only on `Compactar`/`Cerrar`. Session artifacts are the run's live log; the spec/plan is the **guiding base**.

> **Fixed form (hard rule):** an artifact keeps its template's `##` headings **exactly** and is updated **in place** — appending a **duplicate heading** is a contract violation. A filled section **replaces** its `<!-- … -->` guidance comment. Canonical headings per artifact: its template under [`../artifacts/`](../artifacts/) (CHECKPOINT: `Completed` · `Pending / Next`; `Open questions` only while live doubts exist).

## Gap-driven convergent engine

The common cycle — each heir instantiates it in its `## Sequence` with its own gap taxonomy:

1. `detect_gaps(work)`, minus the *exhausted* gaps (see *Research*).
2. If `∅` → **convergence gate** (see *Convergence / exit*).
3. If there are gaps: take a batch (≤3) and **seed** `CHECKPOINT.Pending/Next` (*artifact-first*).
4. Resolve each gap with its **resolver** per the *ask-vs-research rule*: human (structured-choice) · inline research · a probe (PoC) · a composed capability (e.g. `ui-design`).
5. **Integrate**, update `CHECKPOINT` → repeat.

## Internal sessions (managed) — one session per run

The loop creates and manages its session under `.workflow/sessions/`; **the user never creates it**. **A single session per run**: it keeps progress live (`CHECKPOINT`) and enables resume. Artifacts: `SESSION.md` · `CHECKPOINT.md` (· `BACKLOG.md` only if something is deferred; code-editing loops add `DECISION` and `SCRIPTS.sql`). Each heir declares its descriptor and `Type` in its own `## Internal sessions`.

> Research is **inline** — an activity inside this same session, never a session of its own — and the flow's input document (spec/plan) **never** goes inside a session; it lives in `docs/`.

**CLI**: `aw session-create --type <type> --name <slug>-<flow> --objetivo "<one-line objective>"` opens it · `aw checkpoint-write` / `aw checkpoint-read` keep it resumable · `aw session-close` closes it and upserts its HISTORY.md row.

> The caller passes **only the descriptor** via `--name` — **never** a number; the CLI owns the global `NNN`. How it is assigned, how a session is located or reopened, and how a failed history upsert is repaired, are in the `sessions` module.

## Ask-vs-research rule (the discriminator)

For every gap, a single question picks the resolver:

> *"Was this already established in the current conversation?"* → **adopt it** (`adopted` module) — never re-ask or re-research settled conclusions.
> *"Can I answer this by reading the repo/data?"* → **research** (autonomous).
> *"Can I only answer it by RUNNING a small experiment?"* → **probe** (`probe` module).
> *"Does it depend on what the user wants?"* → **ask the human** (structured-choice).

## Research: autonomy, scope & failure

Investigation is **inline**: an activity **inside the run's current session**, never a separate session. It writes its artifacts (`ANALYSIS-FILE` → `CONCLUSIONS`, + read-only `SCRIPTS.sql` if it queries DB) **into the session's own folder**.

- **Autonomous**: the AI investigates inline and reports **without asking permission**. The human learns of it at integration time and keeps control via the `flow` control.
- **Scope**: the current conversation (settled conclusions are reused, never re-derived) + workspace + associated repos + DB MCPs.
- **DB rule** — the single exception to autonomy: it lives in the `db` module and is loaded **before** any query runs.
- **Inconclusive research** (DB unavailable, insufficient evidence, unresolvable factual gap): the investigation closes with status **`inconclusive`** in `CONCLUSIONS` and reports why. The loop **degrades** the gap — to a human question, or failing that to the flow doc's `## Open questions` (the session's `BACKLOG` when the flow has no doc) — and marks it **"already tried via research"** (`attempts[gap]++`, `MAX` cap) so `detect_gaps` does **not** re-fire it in a loop. That is what guarantees convergence.

## Structured-choice (design & batching)

**Canonical rule (single source — the rest of the corpus only references it):** *structured-choice* = **≤3 content questions + 1 `flow` control**, always. Per-harness binding in [`../harness/HARNESS.md`](../harness/HARNESS.md) (Claude Code: `AskUserQuestion`, max 4 questions/call; without structured choice it degrades to **numbered markdown**).

- **`flow` control** (lifecycle, always present): `Compactar` | `Cerrar`. Answering only the content questions = keep iterating. Under context pressure the loop **raises the choice itself**, with `Compactar` recommended.
- **Content questions** are: human doubts (non-factual gaps) · MCP choice (DB rule), before running queries · at **convergence**, the loop's own closing action — each heir defines it in its *Convergence / exit* (e.g. `Guardar especificación refinada` · `Cerrar tarea`) — | `Preguntar algo más`.
- **Batching**: up to 3 human gaps per call; with more pending, prioritize the ones that unblock others and defer the rest.
- **Recommended answer per question**: every content question **always** carries the AI's recommended answer — the first option, marked *recommended*. Never ask "cold": the human ratifies or corrects a proposal, never starts from zero. The recommendation comes from what was researched (ask-vs-research rule), never from an empty default.

> **Label language:** the literal option labels (`Compactar`, `Cerrar`, `Guardar plan`, …) are **canonical product strings** — present them **verbatim**. All other user-facing output follows [`../SKILL.md`](../SKILL.md) § *Language policy*.

## Compact / resume

Resume **keys off the `CHECKPOINT`** of the run's session, not the existence of a separate file. Three cases when the flow's command runs over an input:

1. **In progress** (a `CHECKPOINT.md` exists in the session) → resume from the recorded progress (resolved gaps, Q&A, `attempts`, in-flight inline research).
2. **No progress** (no CHECKPOINT and the input doc does **not** have the flow's prior-work mark) → start from zero reading the input doc (plus any settled in-conversation conclusions, which are input, not something to re-derive).
3. **Already converged / re-run on demand** (no open CHECKPOINT but the doc **already has** the mark) → **first-class operation**: while the flow stays in its stage, re-running the command over the same input **as many times as needed** is supported. `create_or_resume` finds the existing session — typically **closed** after convergence — by descriptor + `## Origin` and **reopens** it; incremental work reading the **doc itself**.

> Each heir defines its **prior-work mark**: spec-refine the spec's frontmatter `status`; plan-refine `## Refinement decisions`; plan-exec the plan-doc's `- [x]` checkboxes; quick has no doc (CHECKPOINT only).

> **`Compactar`** (the `flow` control, across all 3 cases) → write `CHECKPOINT.md` in the session → trigger the harness compaction → resume by reading the checkpoint. **CHECKPOINT before compacting** is invariant. The proactive raise, its two modes and their host binding live in the `compaction` module.

## Convergence / exit

- **No material gaps** → **convergence gate** (read-only) = **`Success criteria` green** (*verification-first*). Whatever fails **comes back as a gap**; if it passes → the loop **flips the green criteria** in `SESSION.md` (`- [ ]` → `- [x]`) and offers its closing action. The checklist must reflect the real final state: a criterion left unchecked at `finalize` needs an explicit reason. Each heir names its own instance of this gate.
- `Cerrar` (the `flow` control, at any time) → `finalize`. **`finalize` always persists `CHECKPOINT.md`** (resumable) and, **only if** something was deferred, writes `BACKLOG.md` (close reason + the deferred items); closes the session and reports. Progress survives even without a prior `Compactar`.

## docs/ boundary — no auto-export (hard rule)

A loop writes into `docs/` **only** its own flow's doc (spec-refine: `docs/specs` · the three plan flows: `docs/plans` · quick: **none** — it never touches `docs/`). No loop **graduates/promotes artifacts** into `docs/`: migrations → `docs/scripts`, manuals → `docs/manuals`, diagrams → `docs/diagrams` are done by the separate **`export-*`** skills, as an explicit later step; artifacts stay in their sessions until then. A task that creates a tool/utility has it documented in `docs/tools` by the ambient `creating-tools` skill (auto-discovered; Workline does not bind it).

## Conditional modules

The engine above is what every run needs. The branches below apply only under their signal, and `aw context-plan` returns them exactly then — never just in case:

- `adopted` → [`../modules/ADOPTED-CONTEXT.md`](../modules/ADOPTED-CONTEXT.md) · `probe` → [`../modules/PROBE.md`](../modules/PROBE.md) · `db` → [`../modules/DB-RESEARCH-RULE.md`](../modules/DB-RESEARCH-RULE.md)
- `compaction` → [`../modules/COMPACTION.md`](../modules/COMPACTION.md) · `sessions` → [`../modules/SESSION-NUMBERING.md`](../modules/SESSION-NUMBERING.md)
- `code` → [`CODE-POLICIES.md`](CODE-POLICIES.md), which the two code-editing loops order read from their `## Inherits`

## Reference resolution (global layout rule) — and what the chassis is NOT

Applies to **every** relative reference in the doctrine — never repeated per link:

1. **Normal install** (the `w/` tree): the relative path resolves as-is.
2. **Synthesized command skills** (hosts without a commands dir): each command installs as a sibling skill `w-<command>/` with its references rewritten into the bundle (`../loops/…` → `../w/loops/…`).
3. A reference that does not resolve = **optional deep-dive** — this engine is self-contained.

> `aw context-plan` hands back **absolute** paths, so a run that asks the CLI for its read-set resolves no relative reference at all. This rule is the fallback for one that does not ask.

The chassis **is not a skill** (no frontmatter; never invoked nor bound): it enters the context only because a loop orders it read from its `## Inherits`. It does not define flow, deliverable or gap taxonomy — that belongs to each heir.
