# CHASSIS — the loop engine

The **common engine** of Workline loops: heirs read it before their deltas and only reference it.

> **How:** `aw flow read` says where the document stands, `aw flow save` writes it against that read, and the execution verbs close batches and commit by digest. Their contracts live in `aw flow --help`, never guessed.

## Host execution rules

- Write JSON payloads with the file tool, never heredoc or shell-built JSON; redirect the file to stdin.
- `aw flow` keeps nothing between calls: every call derives its position from the document and git, and quotes back the digest it read.
- On Windows set `PYTHONUTF8=1` for Python consumers.

## Heirs (canonical list)

The **5 loops** run this engine; each adds only its deltas:

- [`spec-refine-loop`](spec-refine-loop/LOOP.md) — refines the **spec** in place.
- [`plan-new-loop`](plan-new-loop/LOOP.md) — generates the **plan** from the spec.
- [`plan-refine-loop`](plan-refine-loop/LOOP.md) — refines the **plan** in place (auxiliary).
- [`plan-exec-loop`](plan-exec-loop/LOOP.md) — **executes** the plan: code, DB and git.
- [`quick-loop`](quick-loop/LOOP.md) — **minimal ceremony** (the prompt *is* the objective).

The two that edit code also apply [`CODE-POLICIES.md`](CODE-POLICIES.md).

## Persistent objective

A loop fulfills its document's objective — the spec's requirement, the plan's phases, the quick's prompt — until its convergence gate confirms it. Gaps are the method; the document is the record.

> **Continuity from the document.** The next prompt, a compaction or a crash resumes from what the document and git already say: the spec's `status`, the plan's state field, its boxes and its next step, and the uncommitted changes of its sources (`aw resume`). Nothing else is kept between turns.

## Verification-first

The persistent objective needs a **checkable done-condition** — otherwise the loop cannot know when it is done (or chases a target it invented). That condition is **seeded BEFORE executing**, never improvised at the end: it is **generalized TDD**.

**Where it lives:** in the document itself — the spec's acceptance criteria, the plan's `Validación de fase` and `## Validations`, the quick's stated check — **falsifiable** criteria (that *can* fail); the boxes and the evidence lines track the **red→green** progress. Two forms, by deliverable:

| Deliverable | Criterion = | Cycle |
|---|---|---|
| code / script / fix / feature | **runnable tests** (unit, build, lint, bug repro) | literal TDD: red → green → refactor |
| DB migration (not executable; invariant 4) | **rubric**: the script in `docs/scripts/` valid + reviewed (never executed) | rubric |
| spec / plan | **rubric** = the document's acceptance criteria (referenced, not duplicated) | rubric |
| analysis / design | **rubric falsifiable by inspection** (e.g. "every affected site with `file:line`"; "each decision: rationale + ≥1 alternative") | rubric |

- **Form and weight scale**: a chore = "existing tests/build stay green" (one line); a feature = real acceptance tests. The rule is "**always declare the check before**", not "always write new tests".
- **Subjective deliverable** (analysis/design): the AI **proposes** the rubric and the **human ratifies** it before pursuing it.
- **Unresolvable criterion** (no evidence, DB unavailable): closes as `inconclusive` and the loop **degrades** — **never iterates against a fake target**.
- **Source-bounded**: a closing criterion is demonstrated by a command or inspection tied to the acquired checkout. A deployed product, host runtime or remote connection is research context or an operational handoff, never a done-condition.

**Gate integrity (anti-gaming + independent verification).** The gate only counts if it is not gamed to pass. The loop does **not**: modify the check or loosen a `Success criterion` to force green; weaken, delete or skip tests/validations; use trivial or tautological asserts that always pass (the expected value comes from an independent source, never from the output itself); patch the test instead of fixing the cause (prefer fixing production code).

Facing a real blocker it **stops and reports it** (→ the document's `Open questions`) instead of gaming the metric. The verdict counts **only the check's output, never the implementer's self-declaration** — *only command output counts*.

**Checks before reviewers.** First what runs: code compiles and then runs (`CODE-POLICIES.md` § *Validation order*); a document passes the CLI's checks (`aw plan lint`, its gate). Reviewers come last, on request: the host names the cases, asks the person, and runs at most **2** agents, each on **one** named case. Declined or not offered, the run closes on its checks.

**Minimality (anti-over-engineering).** Passing the criteria is **necessary, not sufficient**: the gate also rejects a deliverable **heavier than its `Success criteria` require** — YAGNI at the deliverable's altitude. A spec can be coherent yet over-specified; a plan sound yet over-engineered; a diff green yet padded with reinvented stdlib, speculative abstractions or dead flexibility. At its own altitude the gate asks the laziest-that-works questions:

- **does each part need to exist at all?** — speculative → cut it (the strongest lever, cheapest at spec/plan altitude);
- **is it already there?** — in the codebase, the stdlib or the platform → reuse it, never reinvent;
- **could it be smaller?** — same behavior, fewer moving parts → shrink it.

A **built-in floor** owed by every gate with **no external skill**; the code-editing loops *raise* it with the installed ambient conventions (`CODE-POLICIES.md` § *Validation order*), never lower it. Bounded by *Gate integrity*: minimality cuts over-building, never correctness — never trim validation at trust boundaries, error handling, security, accessibility or anything the spec requires. Each heir's lens: **spec** = over-specified scope · **plan** = over-engineered solution / needless phase-task · **code** = the `delete`/`stdlib`/`native`/`yagni`/`shrink` diff lens.

## The document as the live record

The spec or plan is the run's only durable record, written **as the work happens**, not only at the end:

1. **BEFORE** — the plan says what comes next: its state is `in-progress` and its next step is named.
2. **EXECUTE** — resolve the gap, run the phase, edit the code.
3. **AFTER** — the boxes, the phase states, at most five evidence lines per batch and the next step are rewritten at the batch close (`aw flow close-batch`).

Long evidence, logs and reasoning stay in the conversation; only their bounded summary reaches the plan.

> **Fixed form (hard rule):** a document keeps its `##` headings and is updated **in place** — appending a duplicate heading is a contract violation.

## Gap-driven convergent engine

The common cycle — each heir instantiates it in its `## Sequence` with its own gap taxonomy: detect the gaps, record the next one in the document, resolve each with its resolver, integrate, repeat until none is left and the convergence gate can run. One open question at a time, never more than three. Why gap-driven at all: a plan fixed up front cannot notice what it did not know.

## No run state — the document and git

There is no run file, saved boundary or attempt counter. `aw flow read` returns where the document stands and the `read_digest` this instance read; every write of a spec or plan quotes it back and is refused with `DOC_CHANGED_SINCE_READ` if another instance wrote first. Human approvals (saving a document, a commit) travel in the conversation as digests the CLI returned. QUICK leaves its trace in git alone.

## Ask-vs-research rule (the discriminator)

Which resolver a gap gets is the kind of thing it is. Already **established in this conversation** → adopt it (`adopted` module), never re-ask a settled conclusion · answerable by **reading** the repo/data → research, autonomously · answerable only by **RUNNING a small experiment** → a probe (`probe` module) · dependent on **what the user wants** → ask the human. Why: asking a person what a file already says wastes the one resource the loop cannot regenerate, and guessing what only they decide is worse.

## Research: autonomy, scope & failure

Investigation runs **inside the current run** and its conclusions stay in the conversation; a finding worth keeping reaches `docs/` only through the flow's document or `/w:persist`.

- **Autonomous**: the AI investigates and reports **without asking permission**. The human keeps control via the `flow` control.
- **Scope**: the current conversation (settled conclusions are reused, never re-derived) + hub + associated repos + DB MCPs.
- **DB rule** — the single exception to autonomy: it lives in the `db` module and is loaded **before** any query runs.
- **Inconclusive research** (DB unavailable, insufficient evidence, unresolvable factual gap): the investigation closes **`inconclusive`** with its reason. The loop **degrades** the gap — to a human question, or failing that to the flow doc's `## Open questions` (the final report when the flow has no doc) — instead of re-firing it, because a gap dropped without a destination is this engine's promised convergence, faked.

**Subagents — admitted per stage.** Only three cases inside a run: parallel research in `spec-refine`, `plan-new` and `plan-refine`; implementing independent units in `plan-exec` and `quick`; the targeted review the person accepted (*Checks before reviewers*).
Research and implementation fan out only with **three or more independent** parts, at most **3** at a time. Independent means none uses another's result or writes what another writes; dependent units run in sequence.
Everything else stays in the main thread: drafting, deciding, asking, shaping phases, persisting, updating state, resuming, integrating, committing and a document loop's closing verification. Capture (`spec-new`) launches none unless the person asks.
A default, not a cage: the host may depart from it saying so, but never launches reviewers the person did not accept, whatever its mode or skills order; a host without subagents runs the same cases inline.

## Structured-choice (design & batching)

**Canonical form:** *structured-choice* = **≤3 content questions + 1 `flow` control**, always. Each option is a **short semantic label + one functional sentence** (outcome/trade-off or simple example), never a positional code. The CLI builds it and refuses a question that does not hold this form. Present it with the richest current binding in [`HARNESS.md`](../harness/HARNESS.md); otherwise labeled markdown.

- **Flow:** `Compactar` | `Cerrar`, appended to every boundary with alternatives — never the question's to omit, because one nobody can pause or leave is not a question. An unanswered control means continue (`Continuar` when the UI requires it). Under context pressure the loop **raises the choice itself**, recommending `Compactar`.
- **Content/batching:** human gaps, pre-query MCP choice and the convergence action | `Preguntar algo más`; at most 3 per call. Honor a smaller native ceiling by reserving one question slot for `flow`; carry overflow, prioritizing blockers.
- **Options/encoding:** prefer 2–3 alternatives. Map label/sentence to separate fields or `Label — functional sentence`. If it cannot fit, use labeled markdown; never truncate or merge candidates or duplicate a host-provided free-text option.
- **Recommendation:** exactly one option is *recommended*, it comes first, and it comes from research; the human ratifies or corrects it, never starts cold.
- **Text fallback:** answer by label; `Aceptar recomendaciones` accepts all first options. Never require composite coordinates such as `1A, 2A, 3A`.

> Canonical labels (`Continuar`, `Compactar`, `Cerrar`, `Aprobar y guardar`, `Refinar`, …) stay verbatim; other user-facing text follows [`SKILL.md`](../SKILL.md) § *Language policy*.

## Compact / resume

Resume **keys off the document**: the flow's command re-run over the same input reads it again and continues from its state — spec `status`, the plan's state field, its `- [x]` boxes and next step — plus `git status` of its sources. Re-running is always supported and never needs anything but the document.

> **`Compactar`** (the `flow` control) → make sure the plan's next step is current (it is rewritten at every batch close) → let the host compact → resume with `aw resume`.

## Convergence / exit

- **No material gaps** → read-only **convergence gate**: failed criteria return as gaps. Each heir owns its gate.
- Finish sources → approve the commit by its digest (`aw flow propose-commit`, then `aw flow commit`) or skip it; the plan closes with `aw flow finish`. `Cerrar` leaves the document and the working trees as they are.
- **Report** (QUICK/PLAN close, block, compact, resume): proven state with evidence; block and cause if any; one next human action only if pending. Unrun validation is no proof or 100% closure. No preamble, redundant recap or farewell.

## docs/ boundary (hard rule)

A loop writes into `docs/` its own flow's document and, when the work produces them, the deliverables of `docs/diagrams`, `docs/manuals`, `docs/reports` and `docs/scripts`, each with its category's shape; the hub commit refuses anything else (`aw flow propose-commit --source hub`). SQL is consolidated later with `/w:export-scripts`. Reusable tooling follows the `docs/tools` contract.

## Conditional modules

The engine above is what every run needs. The branches below apply only under their signal, and `aw context-plan` returns them exactly then — never just in case:

- `adopted` → [`../modules/ADOPTED-CONTEXT.md`](../modules/ADOPTED-CONTEXT.md) · `probe` → [`../modules/PROBE.md`](../modules/PROBE.md) · `db` → [`../modules/DB-RESEARCH-RULE.md`](../modules/DB-RESEARCH-RULE.md)

## Reference resolution (global layout rule) — and what the chassis is NOT

Applies to **every** relative reference in the doctrine — never repeated per link:

1. **Normal install** (the `w/` tree): the relative path resolves as-is.
2. **Synthesized command skills** (hosts without a commands dir): each command installs as a sibling skill `w-<command>/` with its references rewritten into the bundle (`../loops/…` → `../w/loops/…`).
3. A reference that does not resolve = **optional deep-dive** — this engine is self-contained.

> `aw context-plan` hands back **absolute** paths, so a run that asks the CLI for its read-set resolves no relative reference at all. This rule is the fallback for one that does not ask.

The chassis **is not a skill** (no frontmatter; never invoked nor bound): it enters the context only because a loop orders it read from its `## Inherits`. It does not define flow, deliverable or gap taxonomy — that belongs to each heir.
