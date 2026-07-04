# CHASSIS — the loop engine

This document is the **common engine** of the agent-workflow loops: the doctrine every loop runs underneath its deltas. **It is not a skill** — it is a referenced document: every loop orders it read from its `## Inherits`, **always, before its deltas**. If you edit the engine, edit it **here** — heirs never repeat it, they only reference it.

## Heirs (canonical list)

The **5 loops** run this engine; each adds only its deltas:

- [`spec-refine-loop`](spec-refine-loop/LOOP.md) — refines the **spec** in place; deltas: spec gap taxonomy, analyze gate, `## UI spec` via the `ui-design` capability.
- [`plan-new-loop`](plan-new-loop/LOOP.md) — generates the **plan** from the spec; deltas: rich plan + plan gap taxonomy (+ per-screen design SPECs when the plan includes UI).
- [`plan-refine-loop`](plan-refine-loop/LOOP.md) — refines the **plan** in place (auxiliary, not mandatory); reuses the gap taxonomy + coherence gate of `plan-new-loop`. It is to `plan-new` what `spec-refine` is to `spec-new`.
- [`plan-exec-loop`](plan-exec-loop/LOOP.md) — **executes** the plan: code/DB/git, a single session per run, per-phase progress in the plan-doc, no auto-export. Applies the policies in [`CODE-POLICIES.md`](CODE-POLICIES.md).
- [`quick-loop`](quick-loop/LOOP.md) — the engine with **minimal ceremony** (the prompt *is* the objective); also applies [`CODE-POLICIES.md`](CODE-POLICIES.md) (proportional gate).

## Persistent objective

A loop **is a persistent objective**: it exists to fulfill the `SESSION.Objective` declared at start, and **it is not finished until the convergence gate confirms the objective was met**. Gap-driven iteration is the *method*; the artifacts are the *record*; the persistent objective is the *frame* that governs them.

This is **harness-agnostic doctrine**, not a host dependency: "don't stop until convergence" is sustained by the loop itself (its `repeat:` + the convergence gate), not by a host hook — and it **leaves a durable record** (artifact-first) that survives compaction and resume. *(Rationale and the `/goal` analogy: see the design, `workflow-loops/chassis.md`.)*

> Each heir instantiates the frame: `spec-refine` pursues the spec; `plan-new`/`plan-refine` pursue the plan up to their gate; `plan-exec` pursues the plan up to its final validation; `quick-loop` is the most direct embodiment (the prompt *is* the objective).

> **Inter-turn continuity.** The same `CHECKPOINT`+resume also governs the **next prompt**: the objective persists **across turns**, not only within a run. The canonical rules (command = new work line · re-run = `create_or_resume` · bare prompt = continue the most recent session · reopening closed sessions · consented escalation) live in [`../SKILL.md`](../SKILL.md) § *Operating context* — **single source**; this engine executes them via *Compact / resume* (case 3).

## Verification-first

The persistent objective needs a **checkable done-condition** — otherwise the loop cannot know when it is done (or chases a target it invented). That condition is **seeded BEFORE executing**, never improvised at the end: it is **generalized TDD**. Together with artifact-first (next section) these are the **two seeds** of every gap/phase: *how will I know it worked* + *what am I about to do*.

**Where it lives:** in `SESSION.Success criteria` (see [`../artifacts/artifacts-core/SESSION.md`](../artifacts/artifacts-core/SESSION.md)) — a `[ ]` checklist of **falsifiable** criteria (that *can* fail). `CHECKPOINT.Pending/Completed` tracks the **red→green** progress. Two forms, by deliverable:

| Deliverable | Criterion = | Cycle |
|---|---|---|
| code / script / fix / feature | **runnable tests** (unit, build, lint, bug repro) | literal TDD: red → green → refactor |
| DB migration (not executable; invariant 4) | **rubric**: `SCRIPTS.sql` valid + reviewed (never executed) | rubric |
| spec / plan | **rubric** = the document's acceptance criteria (referenced, not duplicated) | rubric |
| analysis / design | **rubric falsifiable by inspection** (e.g. "every affected site with `file:line`"; "each decision: rationale + ≥1 alternative") | rubric |

- **Form and weight scale** (quick's minimal ceremony preserved): a chore = "existing tests/build stay green" (one line); a feature = real acceptance tests. The rule is "**always declare the check before**", not "always write new tests".
- **Subjective deliverable** (analysis/design): the AI **proposes** the rubric and the **human ratifies** it (structured-choice) before pursuing it.
- **Unresolvable criterion** (no evidence, DB unavailable): closes as `inconclusive` and the loop **degrades** (asks the human, or defers to `Open questions`/`BACKLOG`) — **never iterates against a fake target**.

> The **convergence gate** (section *Convergence / exit*) is, operationally, **"all `Success criteria` green"**. The per-heir gates (analyze gate; plan coherence — plan-new and plan-refine; final validation; proportional spot validation) are **instances** of it, with the criteria seeded at start.

**Gate integrity (anti-gaming + independent verification).** The gate only counts if it is not gamed to pass. The loop does **not**:

- modify the check or loosen a `Success criterion` to force green;
- weaken, delete or skip tests/validations;
- use trivial or tautological asserts that always pass (the expected value comes from an independent source, never from the output itself);
- patch the test instead of fixing the cause (prefer fixing production code).

Facing a real blocker it **stops and reports it** (→ `Open questions`/`BACKLOG`) instead of gaming the metric. The verdict counts **only the check's output, never the implementer's self-declaration**: when the deliverable warrants it, the final verification is an **independent** pass (subagent or clean re-read) that does not assume the implementation is correct — *only command output counts*.

## Artifacts as a live log — the artifact-first cycle

The loop works **artifact-first**: the artifact is **seeded before** executing and **updated after**, not only on close. Every gap/phase/task runs the **3-beat** cycle:

1. **BEFORE — seed the intent.** Before executing, record in the artifact what is **about to** be done: `CHECKPOINT.Pending`/`Next` = the imminent work (`SESSION.Objective` already fixed the run's what).
2. **EXECUTE.** Resolve the gap / run the phase / edit the code.
3. **AFTER — bring to actual state.** `CHECKPOINT.Pending → Completed`; `DECISION` records the non-obvious **as it is decided**; `BACKLOG` **only if** something is deferred/follow-up (`session-close` no longer fabricates an empty BACKLOG).

> The artifact expresses the **intent** (Pending/Next, before) and then the **result** (Completed/DECISION, after), at **every** gap/phase boundary — not only on `Compactar`/`Cerrar`. Session artifacts are the run's live log; the spec/plan is the **guiding base**.

> **Fixed form (hard rule):** an artifact keeps its template's `##` headings **exactly** and is updated **in place** — appending a **duplicate heading** is a contract violation. When a scaffolded section is filled, its `<!-- … -->` guidance comment is **replaced** by the real content. Canonical headings per artifact: its template under [`../artifacts/`](../artifacts/) (CHECKPOINT contract: `Completed` · `Pending / Next` · `Open questions`).

## Gap-driven convergent engine

The common cycle — each heir instantiates it in its `## Sequence` with its own gap taxonomy:

1. `detect_gaps(work)`, minus the *exhausted* gaps (see *Research*).
2. If `∅` → **convergence gate** (see *Convergence / exit*).
3. If there are gaps: take a batch (≤3) and **seed** `CHECKPOINT.Pending/Next` (*artifact-first*).
4. Resolve each gap with its **resolver** per the *ask-vs-research rule*: human (structured-choice) · inline research · a composed capability (e.g. `ui-design`).
5. **Integrate**, update `CHECKPOINT` → repeat.

## Internal sessions (managed) — one session per run

The loop creates and manages its session under `.workflow/sessions/`. **The user never creates it.** **A single session per run**, owning the run: it keeps progress live (`CHECKPOINT`) and enables resume. Artifacts: `SESSION.md` · `CHECKPOINT.md` (· `BACKLOG.md` only if something is deferred; code-editing loops add `DECISION` and `SCRIPTS.sql`). Each heir declares its descriptor and `Type` in its own `## Internal sessions`.

> **INLINE research** — investigation is **not** a separate session: it is an activity **inside the current session** that writes its artifacts (`ANALYSIS-FILE`/`CONCLUSIONS`, + read-only `SCRIPTS.sql` if it queries DB) **into the run's own session folder**. See *Research: autonomy, scope & failure*.

> The flow's input document (spec/plan) **never** goes inside a session; it lives in `docs/`.

### Session numbering (hard rule)

The **CLI owns the number**: `aw session-create` prepends a **global, sequential** `NNN` by scanning **all** sessions under `.workflow/sessions/` (any type). The caller passes **only the descriptor** via `--name` — **never** a number. Numbering neither restarts per type nor collides, and every folder is **self-describing**: `NNN-<slug>-<flow>` (e.g. `002-correo-otp-spec-refine`, `003-correo-otp-plan-new`, `004-correo-otp-plan-exec`, `005-validacion-correo-quick`).

> `<run>` = the session's **descriptor** (no number), always shaped **`<slug>-<flow>`**: `<slug>-spec-refine`, `<slug>-plan-new`, `<slug>-plan-refine`, `<slug>-plan-exec`, `<slug>-quick`. The `<slug>` is **descriptive** and comes from the flow's input doc — `docs/specs/NNN-spec-<slug>.md` for spec-refine/plan-new; `docs/plans/PPP-plan-<slug>.md` for plan-refine/plan-exec; the prompt for quick — so the folder says at a glance what it is about, not just which flow created it. Research being **inline** in this same session, there are no child `*-research-*` sessions to number (compat: old ones are historical).
>
> **Resume**: locate the existing session by **scanning** `.workflow/sessions/` for descriptor + `## Origin` (which spec/plan), **not** by reconstructing the number (global, not derivable from the artifact). `aw session-resume --code <NNN | folder>` resolves both forms.

**CLI**:

- `aw session-create --type <type> --name <slug>-<flow> --objetivo "<one-line objective>"` → creates `NNN-<slug>-<flow>` / `aw session-resume --code <…>` (detects `CHECKPOINT`).
- `aw checkpoint-write` / `aw checkpoint-read` for resume.
- `aw session-close` on close — also upserts the session's HISTORY.md row (the durable record; sessions/ is gitignored). Non-fatal: on `history_error` in its output, re-run `aw history-update --code <NNN> --state closed`. `aw session-artifacts` to inspect.
- **Reopen to continue** (operating context, row 2): `aw session-resume --code <NNN> --reopen` reactivates a **closed** session (removes `.closed` → active) to keep working in it; without `--reopen`, resume is read-only. To detect the most recent closed one: `aw resume-summary --include-recent-closed` (or `aw sessions --state all`).

## Ask-vs-research rule (the discriminator)

For every gap, a single question picks the resolver:

> *"Can I answer this by reading the repo/data?"* → **research** (autonomous).
> *"Does it depend on what the user wants?"* → **ask the human** (structured-choice).

## Research: autonomy, scope & failure

Investigation is **inline**: an activity **inside the run's current session**, never a separate session. It writes its artifacts (`ANALYSIS-FILE` → `CONCLUSIONS`, + read-only `SCRIPTS.sql` if it queries DB) into the **session's own folder**.

- **Autonomous**: the AI investigates inline and reports **without asking permission**. The human learns of it at integration time (in the flow's decision record — e.g. `## Refinement decisions` in the refine loops, `DECISION` in the code-editing ones) and keeps control via the `flow` control.
- **Scope**: workspace + associated repos (sources) + DB MCPs.
- **DB rule** (the single exception to autonomy):
  1. **MCP choice**: if the gap needs DB and there is **>1 candidate MCP with no configured default**, the AI asks which one to use. That question goes through the **same structured-choice** as a **content question** (counts inside the ≤3 + `flow` limit), **before** running queries. A single MCP or a default → no question.
  2. Write the queries **first** into the session's `SCRIPTS.sql`.
  3. Execute them **read-only** via MCP (respect `sql-mutation-guard`: never DML/DDL).
- **Inconclusive research** (DB unavailable, insufficient evidence, unresolvable factual gap):
  - The investigation closes with status **`inconclusive`** in `CONCLUSIONS` and reports why.
  - The loop **degrades** the gap: to a **human question** (next batch → the flow's Q&A record: `Q&A traceability` in refine loops, `DECISION` in code-editing ones) or, failing that, **defers** it to the flow doc's `## Open questions` (spec/plan) — or the session's `BACKLOG` when the flow has no doc (quick).
  - The gap is marked **"already tried via research"** (`attempts[gap]++`, `MAX` cap) so `detect_gaps` does **not** re-fire it in a loop → guarantees convergence.

## Structured-choice (design & batching)

**Canonical rule (single source — the rest of the corpus only references it):** *structured-choice* = **≤3 content questions + 1 `flow` control**, always. Per-harness binding in [`../harness/HARNESS.md`](../harness/HARNESS.md) (Claude Code: `AskUserQuestion`, max 4 questions/call; without structured choice it degrades to **numbered markdown**).

- Since the `flow` control is **always** present → **≤3 content questions + 1 `flow` control**.
- **`flow` control** (lifecycle, always present): `Compactar` | `Cerrar`. Answering only the content questions (not touching `flow`) = keep iterating.
- **Content questions** can be:
  - human doubts (non-factual gaps);
  - MCP choice (DB rule) — before running queries;
  - at **convergence**, the loop's own closing action — **each heir defines it in its *Convergence / exit*** (e.g. `Guardar especificación refinada` · `Cerrar tarea`) — | `Preguntar algo más`.
- **Batching**: group up to 3 human gaps in one call. With more than 3 pending, prioritize (the ones that unblock other gaps first) and defer the rest to the next round.
- **Recommended answer per question**: every content question **always** carries the AI's recommended answer — as the first option (marked *recommended*) in `AskUserQuestion`, or flagged in the numbered-markdown fallback. Never ask "cold": the human ratifies or corrects a proposal, never starts from zero. The AI recommends based on what it researched (ask-vs-research rule), never on an empty default.

> **Label language:** the literal option labels (`Compactar`, `Cerrar`, `Guardar plan`, …) are **canonical product strings** — present them **verbatim**; they are user-facing, authored in the product's user language (Spanish). All other user-facing output follows [`../SKILL.md`](../SKILL.md) § *Language policy*.

## Compact / resume

Resume **keys off the `CHECKPOINT`** of the run's session, not the existence of a separate file. Three cases when the flow's command runs over an input:

1. **In progress** (a `CHECKPOINT.md` exists in the session) → resume from the recorded progress (resolved gaps, Q&A, `attempts`, in-flight inline research).
2. **No progress** (no CHECKPOINT and the input doc does **not** have the flow's prior-work mark) → start from zero reading the input doc.
3. **Already converged / re-run on demand** (no open CHECKPOINT but the doc **already has** the mark) → **first-class operation**: while the flow stays in its stage, re-running the command over the same input **as many times as needed** is supported. `create_or_resume` finds the existing session — typically **closed** after convergence — by descriptor + `## Origin` and **reopens** it (see *Internal sessions*: detection via `aw sessions --state all` / `aw resume-summary --include-recent-closed`, reopening via `aw session-resume --code <NNN> --reopen`); incremental work reading the **doc itself**.

> Each heir defines its **prior-work mark**: in the refine loops, the presence of `## Refinement decisions` + `## Q&A traceability` in the doc; in plan-exec, the plan-doc's `- [x]` checkboxes; quick has no doc (resume by CHECKPOINT only).

> **`Compactar`** (the `flow` control, across all 3 cases) → write `CHECKPOINT.md` in the session (in-flight progress, remaining gaps, Q&A, `attempts`) → trigger the harness **compaction** (Claude Code: `/compact`; see [`../harness/HARNESS.md`](../harness/HARNESS.md)) → resume by reading the checkpoint.

## Convergence / exit

- **No material gaps** → **convergence gate** (read-only) = **`Success criteria` green** (*verification-first*). Whatever fails **comes back as a gap**; if it passes → the loop **flips the green criteria** in `SESSION.md` (`- [ ]` → `- [x]`) and offers its closing action. The checklist must reflect the real final state: a criterion left unchecked at `finalize` needs an explicit reason (`Open questions`/`BACKLOG`). The heirs are **instances** of the same gate: `spec-refine` = analyze gate, `plan-new` and `plan-refine` = plan coherence, `plan-exec` = final validation, `quick` = proportional spot validation.
- `Cerrar` (the `flow` control, at any time) → `finalize`. **`finalize` always persists `CHECKPOINT.md`** (resumable) and, **only if something was deferred/follow-up**, writes `BACKLOG.md` (close reason + the deferred items); closes the session and reports. Progress survives even without a prior `Compactar`.

## docs/ boundary — no auto-export (hard rule)

A loop writes into `docs/` **only** its own flow's doc (spec-refine: `docs/specs` · plan-new/plan-refine/plan-exec: `docs/plans` · quick: **none** — it never touches `docs/`). No loop **graduates/promotes artifacts** into `docs/`: everything else (migrations → `docs/scripts`, manuals → `docs/manuals`, diagrams → `docs/diagrams`, …) is done by the separate **`export-*`** skills, as an explicit later step. Artifacts stay in their sessions until then. If a task creates a tool/utility, the ambient skill `creating-tools` documents it in `docs/tools` (auto-discovered by its `description`; the workflow is **indifferent** — it does not bind it).

## Code-editing loop policies → CODE-POLICIES.md

The loops that **edit code** (`plan-exec-loop`, `quick-loop`) additionally run the policies in [`CODE-POLICIES.md`](CODE-POLICIES.md) — **safe git** (verified branch + proposed commits) · **DB scripts-only** · **closing review gate** (proportional in quick). They order it read from their `## Inherits` **together with this chassis**; the document loops (spec-refine, plan-new, plan-refine) do **not** load it — that is why it lives in a separate doc.

## Reference resolution (global layout rule) — and what the chassis is NOT

Applies to **every** relative reference in the doctrine — never repeated per link:

1. **Normal install** (the `w/` tree): the relative path resolves as-is (`../CHASSIS.md`, `../../commands/spec-new.md`).
2. **Synthesized command skills** (hosts without a commands dir — Codex/Warp/Oz): each command installs as a **sibling** skill `w-<command>/` with its references rewritten into the bundle (`../loops/…` → `../w/loops/…`); the `w/` tree stays intact, so loop-to-loop references resolve as a normal install.
3. A reference that does not resolve = **optional deep-dive** — this engine's doctrine is self-contained.

The chassis **is not a skill** (no frontmatter; never invoked nor bound via `.workflow/skills.toml`): it enters the context only because a loop orders it read from its `## Inherits`. It does not define flow, deliverable or gap taxonomy — that belongs to each heir.
