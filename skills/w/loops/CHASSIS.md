# CHASSIS — the loop engine

This document is the **common engine** of the Workline loops: the doctrine every loop runs underneath its deltas. **It is not a skill** — it is a referenced document: every loop orders it read from its `## Inherits`, **always, before its deltas**. If you edit the engine, edit it **here** — heirs never repeat it, they only reference it.

> **When each step below happens is no longer this document's call:** the deterministic steps below are decided by the CLI (`aw flow advance`), not by this document. They consume no model worker, subagent or external process: the CLI advances them locally to the first real frontier. What stays is what each rule is FOR — the half no engine carries. Answering the frontier it stops at is `aw flow submit`, and its envelope — which fields each kind of frontier demands, and where each digest comes from — is **read** with `aw flow --help`, never guessed.

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

"Don't stop until convergence" is sustained by the loop itself — its `repeat:` plus the convergence gate — never by a host hook, which is what makes it harness-agnostic. Each heir instantiates the frame: `spec-refine` pursues the spec; the plan loops pursue the plan up to their gate; `plan-exec` up to its final validation; `quick-loop` its prompt.

> **Inter-turn continuity.** The same `CHECKPOINT`+resume governs the **next prompt**: the objective persists **across turns**, not only within a run. The canonical rules (command = new work line · re-run = `create_or_resume` · bare prompt = continue the most recent session · reopening closed sessions · consented escalation) are the **single source** in [`../SKILL.md`](../SKILL.md) § *Operating context*; this engine executes them via *Compact / resume* (case 3).

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
- **Cert-only**: a criterion needing **production or the deployed product** is not a done-condition — nobody in the run can run it, so the phase waits forever. Verify in cert.

**Gate integrity (anti-gaming + independent verification).** The gate only counts if it is not gamed to pass. The loop does **not**: modify the check or loosen a `Success criterion` to force green; weaken, delete or skip tests/validations; use trivial or tautological asserts that always pass (the expected value comes from an independent source, never from the output itself); patch the test instead of fixing the cause (prefer fixing production code).

Facing a real blocker it **stops and reports it** (→ `Open questions`/`BACKLOG`) instead of gaming the metric. The verdict counts **only the check's output, never the implementer's self-declaration**: when the deliverable warrants it, the final verification is an **independent** pass (subagent only when the CLI's independent-partition rule admits it, or a clean re-read) that does not assume the implementation is correct — *only command output counts*.

**Minimality (anti-over-engineering).** Passing the criteria is **necessary, not sufficient**: the gate also rejects a deliverable **heavier than its `Success criteria` require** — YAGNI at the deliverable's altitude. A spec can be coherent yet over-specified; a plan sound yet over-engineered; a diff green yet padded with reinvented stdlib, speculative abstractions or dead flexibility. At its own altitude the gate asks the laziest-that-works questions:

- **does each part need to exist at all?** — speculative → cut it (the strongest lever, cheapest at spec/plan altitude);
- **is it already there?** — in the codebase, the stdlib or the platform → reuse it, never reinvent;
- **could it be smaller?** — same behavior, fewer moving parts → shrink it.

A **built-in floor** owed by every gate with **no external skill**; the code-editing loops *raise* it with the installed ambient conventions (`CODE-POLICIES.md` § *Closing review gate*), never lower it. Bounded by *Gate integrity*: minimality cuts over-building, never correctness — never trim validation at trust boundaries, error handling, security, accessibility or anything the spec requires. Each heir's lens: **spec** = over-specified scope · **plan** = over-engineered solution / needless phase-task · **code** = the `delete`/`stdlib`/`native`/`yagni`/`shrink` diff lens.

## Artifacts as a live log — the artifact-first cycle

The loop works **artifact-first**: the artifact is **seeded before** executing and **updated after**, not only on close. Every gap/phase/task runs the **3-beat** cycle:

1. **BEFORE — seed the intent.** Before executing, record in the artifact what is **about to** be done: `CHECKPOINT.Pending`/`Next` = the imminent work (`SESSION.Objective` already fixed the run's what).
2. **EXECUTE.** Resolve the gap / run the phase / edit the code.
3. **AFTER — bring to actual state.** `CHECKPOINT.Pending → Completed`; `DECISION` records the non-obvious **as it is decided**; `BACKLOG` **only if** something is deferred/follow-up.

> The artifact expresses the **intent** (before) and then the **result** (after), at **every** gap/phase boundary — not only on `Compactar`/`Cerrar`. Session artifacts are the run's live log; the spec/plan is the **guiding base**.

> **Fixed form (hard rule):** an artifact keeps its template's `##` headings **exactly** and is updated **in place** — appending a **duplicate heading** is a contract violation. A filled section **replaces** its `<!-- … -->` guidance comment. Canonical headings per artifact: its template under [`../artifacts/`](../artifacts/) (CHECKPOINT: `Completed` · `Pending / Next`; `Open questions` only while live doubts exist).

## Gap-driven convergent engine

The common cycle — each heir instantiates it in its `## Sequence` with its own gap taxonomy: detect the gaps, seed `CHECKPOINT.Pending/Next` (*artifact-first*), resolve each with its resolver, integrate, repeat until none is left and the convergence gate can run. Pacing is the CLI's — one open boundary at a time, meeting the ≤3 ceiling by construction. Why gap-driven at all: a plan fixed up front cannot notice what it did not know.

## Internal sessions (managed) — one session per run

The loop creates and manages its session under `.workflow/sessions/`; **the user never creates it**. **A single session per run**: it keeps progress live (`CHECKPOINT`) and enables resume. Artifacts: `SESSION.md` · `CHECKPOINT.md` (· `BACKLOG.md` only if something is deferred; code-editing loops add `DECISION` and `SCRIPTS.sql`). Each heir declares its descriptor and `Type` in its own `## Internal sessions`.

> The flow's input document (spec/plan) **never** goes inside a session; it lives in `docs/`.

**CLI**: `aw session-create --type <type> --name <slug>-<flow> --objetivo "<one-line objective>"` opens it · `aw checkpoint-write` / `aw checkpoint-read` keep it resumable. **Closing it is the CLI's own move**, run at `finalize`: a loop never issues the close itself, and one issued mid-run leaves the next `advance`/`submit` standing on a closed session.

> The caller passes **only the descriptor** via `--name` — **never** a number; the CLI owns the global `NNN`. How it is assigned, how a session is located or reopened, and how a failed history upsert is repaired, are in the `sessions` module.

## Ask-vs-research rule (the discriminator)

Which resolver a gap gets is the kind of thing it is, and the CLI classifies it: a boundary's kind IS its resolver. Already **established in this conversation** → adopt it (`adopted` module), never re-ask a settled conclusion · answerable by **reading** the repo/data → research, autonomously · answerable only by **RUNNING a small experiment** → a probe (`probe` module) · dependent on **what the user wants** → ask the human. Why: asking a person what a file already says wastes the one resource the loop cannot regenerate, and guessing what only they decide is worse.

## Research: autonomy, scope & failure

Investigation is **inline**: an activity **inside the run's current session**, never a separate session. It writes its artifacts (`ANALYSIS-FILE` → `CONCLUSIONS`, + read-only `SCRIPTS.sql` if it queries DB) **into the session's own folder**.

- **Autonomous**: the AI investigates inline and reports **without asking permission**. The human learns of it at integration time and keeps control via the `flow` control.
- **Scope**: the current conversation (settled conclusions are reused, never re-derived) + workspace + associated repos + DB MCPs.
- **DB rule** — the single exception to autonomy: it lives in the `db` module and is loaded **before** any query runs.
- **Inconclusive research** (DB unavailable, insufficient evidence, unresolvable factual gap): the investigation closes **`inconclusive`** in `CONCLUSIONS` with its reason. The loop **degrades** the gap — to a human question, or failing that to the flow doc's `## Open questions` (the session's `BACKLOG` when the flow has no doc) — instead of re-firing it. Capping the attempts is the CLI's; declaring where a degraded gap GOES is doctrine's, because a gap dropped without a destination is this engine's promised convergence, faked.

## Structured-choice (design & batching)

**Canonical form:** *structured-choice* = **≤3 content questions + 1 `flow` control**, always. Each option is a **short semantic label + one functional sentence** (outcome/trade-off or simple example), never a positional code. The CLI builds it and refuses a question that does not hold this form. Present it with the richest current binding in [`HARNESS.md`](../harness/HARNESS.md); otherwise labeled markdown.

- **Flow:** `Compactar` | `Cerrar`, appended to every boundary with alternatives — never the question's to omit, because one nobody can pause or leave is not a question. An unanswered control means continue (`Continuar` when the UI requires it). Under context pressure the loop **raises the choice itself**, recommending `Compactar`.
- **Content/batching:** human gaps, pre-query MCP choice and the convergence action | `Preguntar algo más`; at most 3 per call. Honor a smaller native ceiling by reserving one question slot for `flow`; carry overflow, prioritizing blockers.
- **Options/encoding:** prefer 2–3 alternatives. Map label/sentence to separate fields or `Label — functional sentence`. If it cannot fit, use labeled markdown; never truncate or merge candidates or duplicate a host-provided free-text option.
- **Recommendation:** exactly one option is *recommended*, it comes first, and it comes from research; the human ratifies or corrects it, never starts cold.
- **Text fallback:** answer by label; `Aceptar recomendaciones` accepts all first options. Never require composite coordinates such as `1A, 2A, 3A`.

> Canonical labels (`Continuar`, `Compactar`, `Cerrar`, `Aprobar y guardar`, `Refinar`, …) stay verbatim; other user-facing text follows [`SKILL.md`](../SKILL.md) § *Language policy*.

## Compact / resume

Resume **keys off the `CHECKPOINT`** of the run's session, not the existence of a separate file. Three cases when the flow's command runs over an input:

1. **In progress** (a `CHECKPOINT.md` exists in the session) → resume from the recorded progress (resolved gaps, Q&A, `attempts`, in-flight inline research).
2. **No progress** (no CHECKPOINT and the input doc does **not** have the flow's prior-work mark) → start from zero reading the input doc (plus any settled in-conversation conclusions, which are input, not something to re-derive).
3. **Already converged / re-run on demand** (no open CHECKPOINT but the doc **already has** the mark) → **first-class operation**: while the flow stays in its stage, re-running the command over the same input **as many times as needed** is supported. `create_or_resume` finds the existing session — typically **closed** after convergence — by descriptor + `## Origin` and **reopens** it; incremental work reading the **doc itself**.

> Each heir defines its **prior-work mark**: spec-refine the spec's frontmatter `status`; plan-refine `## Refinement decisions`; plan-exec the plan-doc's `- [x]` checkboxes; quick has no doc (CHECKPOINT only).

> **`Compactar`** (the `flow` control, across all 3 cases) → write `CHECKPOINT.md` in the session → trigger the harness compaction → resume by reading the checkpoint. **CHECKPOINT before compacting** is invariant. The proactive raise, its two modes and their host binding live in the `compaction` module.

## Convergence / exit

- **No material gaps** → **convergence gate** (read-only) = **`Success criteria` green** (*verification-first*). Whatever fails **comes back as a gap**; if it passes → the loop **flips the green criteria** in `SESSION.md` (`- [ ]` → `- [x]`) and offers its closing action. The checklist must reflect the real final state: a criterion left unchecked at `finalize` needs an explicit reason. Each heir names its own instance of this gate, and those instances are what realize it.
- `Cerrar` (the `flow` control, at any time) → `finalize`, the last step of every journey. **`finalize` always persists `CHECKPOINT.md`** (resumable) and, **only if** something was deferred, writes `BACKLOG.md` (close reason + the deferred items); closes the session and reports. Progress survives even without a prior `Compactar`.

## docs/ boundary — no auto-export (hard rule)

A loop writes into `docs/` **only** its own flow's doc plus, when it composes a capability whose own deliverable is a `docs/` category, that category — today only the **UI Design Package** under `docs/designs` (`design`). Which folders that is per flow, and refusing any delegated step whose target leaves them, is the CLI's. **Published, never graduated**: the test is the origin, not the folder. No loop **graduates/promotes artifacts** into `docs/` — migrations → `docs/scripts`, manuals → `docs/manuals`, diagrams → `docs/diagrams` are the separate **`export-*`** skills', an explicit later step; artifacts stay in their sessions until then. A task creating a tool has it documented in `docs/tools` by the ambient `creating-tools` skill (auto-discovered; Workline does not bind it).

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
