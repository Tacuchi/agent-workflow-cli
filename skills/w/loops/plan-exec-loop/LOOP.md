---
name: plan-exec-loop
description: >-
  Executes an implementation plan (docs/plans/PPP-plan-<slug>.md) as a living
  doc: runs it phase by phase — each phase a verifiable state — while editing
  the real code and managing DB and git. Heir of the chassis (loops/CHASSIS.md
  + CODE-POLICIES.md). Deltas: executability entry gate, deviation gate
  (structural to plan-refine, functional to spec-refine), single resumable
  session, safe git, DB scripts-only, phase proof plus progressive tests,
  pre-commit closing review gate, no auto-export. Composes git and sql.
  Started by /w:plan-exec. Invoke to implement an already generated plan.
---

# plan-exec-loop

> **Heir** of the common chassis — the **execution deltas** live here: the real work (code, DB, git). The engine lives in the chassis and the *code-editing loop policies* in `CODE-POLICIES.md` — never repeated.

## Flow
PLAN

## Layer
2 — the AI runs it end to end.

## Started by
`/w:plan-exec` — **resumable** (same chassis mechanism; here resume keys off the plan-doc phase states + checkboxes + CHECKPOINT, see Delta 1).

## Reads
`docs/plans/PPP-plan-<slug>.md` (locate via the `docs/plans/PPP-plan-*.md` glob or the exact path from the command argument) **and its source spec** (resolved through the plan's `## Origin`) — the entry gate reads both. It runs **any** plan, whether or not it passed through [`plan-refine-loop`](../plan-refine-loop/LOOP.md) — plan-refine is auxiliary, not mandatory; no gate requires it. What it does require is an **executable shape** (§ *Entry gate — executability*). If the plan includes UI, it also reads the **design SPECs** (`NNN-SPEC-<SLUG>.md`) its Tasks reference — artifacts of the plan-new/plan-refine session, read **read-only** as the design reference while implementing (see [`SPEC.md`](../../artifacts/artifacts-design/SPEC.md)).

## Writes
- `docs/plans/PPP-plan-<slug>.md` (**read/update**, living doc: phase/task state, `Open questions`).
- Artifacts of the plan-exec session under `.workflow/sessions/` (`SCRIPTS.sql`, `DECISION`, `ANALYSIS-FILE`/`CONCLUSIONS`, …).
- It does **NOT** write other `docs/` folders nor **graduate/export** artifacts automatically (see *Boundary*).

## Boundary — no auto-export (hard rule)

Full rule in the chassis (§ *docs/ boundary — no auto-export*). Here: the only `docs/` folder this loop writes is **`docs/plans`** (the plan, living); everything else stays in the session until an explicit, later `export-*`.

## Inherits

Read **[`../CHASSIS.md`](../CHASSIS.md)** — the loop's **full engine** — **and** **[`../CODE-POLICIES.md`](../CODE-POLICIES.md)** — the *code-editing loop policies* — **always before** these deltas. *(If `../` does not resolve: same names next to this file — global layout rule, chassis § Reference resolution.)*

## Composes

`git` (safe branch + proposed commits) · `sql` (DB rule). Both resolved via `.workflow/skills.toml`; `off` → the loop continues without the capability and, if it was needed, says so or asks.

> **Ambient conventions (not roles):** code/testing/writing standards and `creating-tools` are standalone skills the host auto-discovers by `description` — Workline neither binds nor depends on them. Full doctrine: [../../roles/README.md](../../roles/README.md).

## Internal sessions (managed)

- **plan-exec session** descriptor `<slug>-plan-exec` → `NNN-<slug>-plan-exec` (the `<slug>` comes from the input plan-doc `docs/plans/PPP-plan-<slug>.md`): **a single session per run** (Type = `exec`). Owns the run; holds `SESSION` + `CHECKPOINT` + `DECISION` + `SCRIPTS.sql` (+ `BACKLOG` only if something is deferred). Research is **inline** inside this session: it produces `ANALYSIS-FILE`/`CONCLUSIONS` (+ read-only `SCRIPTS.sql` if it queries DB) in its own folder.

> **Numbering**: the caller passes only the descriptor; the CLI prepends the global sequential `NNN` over `.workflow/sessions/` (see chassis). It never restarts per type.

> **Compat (legacy):** old workspaces may hold `plan-exec-phase-*` sessions (one per phase) and `*-research-*` ones — historical, left as-is; new runs use a single session.

## Entry gate — executability

**Before touching code**, read the plan and its spec and check the shape execution depends on:

1. every phase declares its `Resultado`, its `Condición de salida` and its `Validación de fase`;
2. if temporary behavior exists, its current boundary and retirement phase are identifiable; otherwise the simulation check is not applicable;
3. the primary proof of the first `pendiente` phase is identifiable;
4. no structural contradiction is evident (a phase that undoes an earlier one, evidence nobody can produce).

Execution **no longer accepts in silence** a plan that would force it to invent its own structure. Two outcomes:

- **Minor gap** — the plan is all but executable: an exit condition derivable from what is already written, the obvious evidence unnamed, micro-tasks to group. `plan-exec` may **normalize it with consent** — one structured-choice content question, labels `Normalizar y ejecutar` (recommended) | `Ir a plan-refine`. Normalizing edits the `### Fn` blocks in place, **adds no scope and moves no boundary**, and is recorded in `DECISION` + `CHECKPOINT`.
- **Structural gap** — phases, contracts, journey or simulation boundary are missing. It does **not** improvise: record the finding in `CHECKPOINT`, hand off to [`plan-refine-loop`](../plan-refine-loop/LOOP.md) (`/w:plan-refine`) and resume execution over the refined plan.

> The gate reads the **canonical phase contract** from [`plan-new-loop`](../plan-new-loop/LOOP.md) § *Phase contract (canonical)* — required sections, the `> Estado:` vocabulary, semantic granularity. Execution references it; it never redefines it. The marker is a **line of its own** inside the `### Fn` block (`> Estado: <value>`); written any other way it reads as `pendiente`.

## Delta 1 — One session per run; the phase cycle in the plan-doc

- Walks the plan's `### Fn` blocks under `## Tasks` in order (respecting deps) **inside the run's single session** (no session-per-phase). *(Legacy plans: a separate `## Phases` table — walk it the same way.)*
- **Phase cycle** (artifact-first, one per `### Fn`): read `Resultado` + `Condición de salida` → confirm the initial state → flip `> Estado: en ejecución` and seed `CHECKPOINT.Next` → execute its tasks → run the phase proof plus the justified focused tests (Delta 4). Then: closing review gate over the phase's whole diff (Delta 5) → confirm the `Condición de salida` → flip `> Estado: validada` → update `CHECKPOINT` and propose commits (Delta 2).
- Executes the phase's tasks; **skips** the ones already `- [x]` in the plan (the plan-doc is the per-task source of truth). **Micro steps stay internal** (canonical contract): they reach `CHECKPOINT` only when a resume needs them, never the plan.
- **Marking order (hard rule):** a task is marked `- [x]` when its local work is finished. A phase reaches `validada` **only** when its primary proof **ran and passed**, the needed focused checks passed, its `Condición de salida` is true, the review gate is green and every remaining review finding is explicitly deferred — a blocker is never deferred into `validada`. **Never** because all its checkboxes are ticked.
- **Intermediate states:** `bloqueada` = the phase is stopped on a live blocker — recorded in `CHECKPOINT` + the plan's `## Open questions`, back to `en ejecución` when it clears; it counts as **not validated**. A phase whose work is complete but whose operative check the AI **cannot run** (an unapplied migration — Delta 3) **stays `bloqueada`**: its finished tasks keep their boxes ticked, and the reason goes on its own `> Bloqueo:` line, dropped when the blocker clears. It counts as **not validated** until the check runs and passes. Never a silent `validada`.
- **Plan-doc residue (hard rule):** execution writes into the plan-doc **only** five things — checkbox flips (`- [ ]` → `- [x]`), the phase's own `> Estado:` line, its `> Bloqueo:` line while blocked, deferrals appended to its `## Open questions`, and, on close, the single plan status line (Delta 6). The declared-gap hatch is Deltas 4, 5 and 7. Per-phase results, review-gate findings and metrics go to the session's `DECISION`/`CHECKPOINT` — **never** into the plan-doc. Phase blocks are updated **in place — NEVER append a duplicate `### Fn` block** (same contract as CHECKPOINT sections). The entry gate's consented normalization is the single exception, and it lands before execution starts.
- **CHECKPOINT per phase:** on closing a phase record the **functional state reached**, the simulation boundary in force **only when the change carries one**, the tests run and their result, the non-obvious decisions, the deferrals and the next state being pursued. Enumerating every file touched is not required unless it helps a resume.
- Records in `DECISION` only the **non-obvious**, **as it is decided** (per-phase decisions accumulate in the SINGLE `DECISION`, tagged by phase/task — e.g. `Origin: T2 (F1)`). A structural deviation is **not** settled with an entry there (§ *Deviation gate*).
- The chassis **gap-driven** engine applies here **inside a task**: facing a non-obvious decision/doubt → inline research, a probe (Delta 7) OR structured-choice.

> **Legacy plans degrade safely.** `plan-exec` still runs plans with `### Fn` blocks, `- [ ]` tasks, legacy sections and **no** `> Estado:` line: a missing line reads `pendiente`, and nothing is back-filled. A plan with every box ticked is **not** validated by that fact — the session (`CHECKPOINT`, review gate) decides. What is genuinely missing is closed by the entry gate or by `plan-refine`, never assumed.

## Deviation gate

Execution resolves **detail**, never **redesign**. This gate lives **only** in this loop — the chassis does not carry it.

- **Local decision — `plan-exec` continues.** A class or method name; a local helper; internal code layout; imports; a choice between equivalent APIs already allowed; a fix needed to compile; a minor refactor that does not move the journey; one extra focused test for a risk found while implementing. Recorded in `DECISION` only when it is not obvious.
- **Structural deviation — stop and return to `plan-refine`.** Stop when the change touches: an input or output; an observable state; a relevant endpoint or public contract; the set of participating components or repositories; the phase order; the simulation boundary; the integration strategy; a material dependency; the main persistence mechanism; a phase already `validada`; the evidence needed to demonstrate the result. A decision that substantially expands or shrinks the work counts too.
- **Functional change — return to `spec-refine`.** Stop when the change touches: the expected result; the functional scope; a business rule; an acceptance criterion; the actor or consumer; or a product decision.

On either return path: `CHECKPOINT` records the state reached and the trigger, the phase keeps the state it really has (`en ejecución` or `bloqueada`, never `validada`), the working tree is left committed or acknowledged (Delta 2), and the human is told through a structured-choice which command to run. Resuming later over the corrected plan is a normal `create_or_resume`.

| Finding | `plan-exec` | `plan-refine` | `spec-refine` |
|---|---|---|---|
| Rename a helper · internal implementation · test for a local risk | continues | — | — |
| Change the public DTO | stops | yes | yes, if behavior changes |
| Add a participating repository | stops | yes | — |
| Move the simulation to another boundary | stops | yes | — |
| Change the phase order | stops | yes | — |
| Add a functional rule · change an acceptance criterion | stops | — | yes |

## Delta 2 — Git policy: **safe branch + proposed commits**

Full policy in [`../CODE-POLICIES.md`](../CODE-POLICIES.md) (§ *Safe git*: branch-check before editing, rejected commit — changes stay + get recorded —, working-tree precondition between phases). **Inline:** before editing, verify each source's expected branch (`aw check-branch --source <alias>`; on mismatch → pause and resolve with the human); at each phase close and **after the review gate** (Delta 5), **proposed commits per source** (approve first) — never `push`/`--amend`/`--no-verify`.

## Delta 3 — DB policy: **the AI never executes DML**

Full policy in [`../CODE-POLICIES.md`](../CODE-POLICIES.md) (§ *DB scripts-only*). **Inline:** read-only queries → the session's `SCRIPTS.sql`, executed via MCP (`sql-mutation-guard`); DDL/DML migrations → the AI **drafts them in `SCRIPTS.sql` but NEVER executes them** — their promotion to `docs/scripts/` is done by a separate `export-*`, never this loop.

## Delta 4 — Validation: phase proof + progressive tests

- The phase's **primary proof** is its `Validación de fase`: it demonstrates the **state reached**, not the structure written. Three levels, and the loop never descends one automatically:
  1. **phase proof** — component interaction, endpoint smoke test, vertical run down to the stub, persistence integration, or the main path end to end;
  2. **focused tests** — added when the layer carries its own rules, a relevant transformation, error handling, persistence, transactions, temporal logic or external integration;
  3. **risk tests** — security, concurrency, idempotency, retries, known regressions.
- **One vertical proof per operation while wiring** (request → controller → use case → repository → fake or stub → expected response): it demonstrates the path once instead of re-asserting the same happy path at every layer. Trivial mappers, plain DTOs and framework behavior get no dedicated test.
- Compatible with **TDD without a test per method**: the evidence may be written before, during or after the phase's code. What is mandatory is that the `Condición de salida` be demonstrated **before** the phase is flipped to `validada`.
- Each added test is re-weighed at the closing review gate ([`../CODE-POLICIES.md`](../CODE-POLICIES.md) § *Closing review gate* → *Test-value lens*, tag `overtest`): over-testing is a **finding to fix or justify**, never an automatic rejection.
- Also run the plan's `## Validations` (cross-cutting rules and constraints) + the Final behavior block of `## Solution` (legacy plans: the `## Final behavior` section) + the spec's acceptance/success criteria (its `## Scenarios`, if present, are ready-made test cases: GIVEN=arrange · WHEN=act · THEN=assert).
- A validation that **runs and fails** → back into the phase (gap): no advancing, no `validada`.
- **Validation depending on an unapplied migration**: since the AI never executes the DML, it **cannot run it read-only** → the check is **deferred** (handoff to a DBA) and the phase **stays `bloqueada`**. A phase whose implementation is finished but whose operative proof cannot run does not become `validada`: the work may be complete and its boxes ticked, but the state waits until the proof runs and passes. The reason goes on its `> Bloqueo:` line, in `CHECKPOINT`, in the plan's `## Open questions` and in `BACKLOG`, marked "verification pending until the SQL is applied". (Reuses the chassis degrade/defer pattern + `MAX` cap → avoids the "back to the task" loop.)

> The **final validation** is PLAN-exec's **convergence gate** = **`Success criteria` green** (*verification-first*; analogous to SPEC's *analyze gate* and plan-new's *coherence gate*): the plan is not marked *done* until it passes. A deferred check never counts as a passed one — it keeps its phase `bloqueada` and the plan open. For code these are **runnable tests** (TDD); for non-executable DB migrations, a **rubric** (SCRIPTS.sql valid + reviewed).

## Delta 5 — Closing review gate (conventions, pre-commit)

Full gate in [`../CODE-POLICIES.md`](../CODE-POLICIES.md) (§ *Closing review gate*): **independent** diff re-read + installed ambient conventions + the floor lenses (minimality, **test value**, **temporary simulation**, tooling); findings → fix (re-validating the phase) or defer justified. Here only the exec wiring: it runs over the phase's **whole** diff, **between the phase validation (Delta 4) and its commits (Delta 2)**; only with the gate green is the phase flipped to `validada` and its commits proposed.

## Delta 6 — Completion / close

- A phase closes when its `> Estado:` reads `validada`: work done, `Condición de salida` true, proof **run and passed**. A proof still waiting on an operative handoff leaves it `bloqueada`.
- **Every phase `validada` + the final validation passed** → final *structured-choice* (content: `Marcar plan done` / `Preguntar algo más`; flow: `Compactar`/`Cerrar`). `Marcar plan done` is offered under no other condition: one `bloqueada` phase keeps the plan open, however many of its tasks are ticked.
- **Marking done = ONE line in the plan-doc**, under the title's blockquote: `> Estado: done — YYYY-MM-DD · sesión NNN`, updated in place on a re-run. It never replaces the per-phase lines inside the `### Fn` blocks — position tells the two apart. No per-phase result tables, no ✅ suffixes — that record lives in the session (`DECISION`/`CHECKPOINT`).
- **No automatic export**: the artifacts (`SCRIPTS.sql`, `DECISION`, …) stay in the session. Promoting them to `docs/` (scripts, manuals, …) is a separate step via `export-*`.

## Delta 7 — Probe (PoC) tasks

Chassis § *Proof of concept (probe)*, instantiated for execution — for a plan's explicit probe task or a runnable doubt inside a task:

- Seed the question + pass/fail check → run **throwaway code in the session folder** (never the source tree, never committed; DB probe = read-only) → verdict in `CONCLUSIONS`, consequences in `DECISION` (tagged by task) → mark the task with its verdict.
- A **failed probe does not fail the phase** — it de-risked it: surface it (structured-choice); reshaping the plan goes to `Open questions` + `BACKLOG` (or `/w:plan-refine`).
- **Promotion**: probe code reaches the sources only as a normal task edit (branch-check + review gate) — never by committing the probe.

## Sequence

```
plan-exec-loop(PPP-plan-<slug>.md):
  session = create_or_resume("<slug>-plan-exec")           # <slug> from the plan-doc; ONE session per run; CLI prepends global NNN; CHECKPOINT, resume
  plan = read(PPP-plan-<slug>.md, its spec, checkpoint)
  entry gate (executability): result · exit condition · phase proof · simulation boundary if any · no structural contradiction
      minor gap      → structured-choice [Normalizar y ejecutar | Ir a plan-refine] → normalize in place + DECISION
      structural gap → CHECKPOINT(blocker) → hand off to /w:plan-refine → stop
  for each Phase (### Fn block in ## Tasks; legacy: ## Phases table) in plan (in order, respecting deps):
    if Estado == validada: skip                            # legacy (no line): all its Tasks - [x] AND the session shows it closed
    read Resultado + Condición de salida; confirm the initial state
    set > Estado: en ejecución
    seed CHECKPOINT.Next = Phase N (Pending = its Tasks)   # BEFORE starting the phase: seed the intent (artifact-first)
    for each Task of the Phase:
      if Task - [x] in the plan: skip                      # intra-phase resume by checkbox
      verify each source's expected branch (branch-check)
        on mismatch → pause + resolve with the human
      execute Task (micro steps internal — never plan entries):
        edit code in the sources (minimal change)
        if it creates a tool/utility → the ambient creating-tools skill documents it in docs/tools
        if read-only DB query → SCRIPTS.sql + execute read-only
        if DB change (DDL/DML) → draft in SCRIPTS.sql (session artifact, DO NOT execute)
        deviation gate:
            local decision       → resolve; DECISION only if non-obvious (tagged by phase/task)
            structural deviation → CHECKPOINT(state + trigger) → stop → /w:plan-refine
            functional change    → CHECKPOINT(state + trigger) → stop → /w:spec-refine
        if probe (PoC) task / runnable doubt → seed check → run throwaway code in the
            session folder → verdict → CONCLUSIONS/DECISION; failed → structured-choice (Delta 7)
        if doubt/gap → inline research, probe OR structured-choice   # chassis
      mark Task - [x] IN THE PLAN                          # AFTER its local work; checkbox flip ONLY — results go to DECISION/CHECKPOINT
    phase proof (Validación de fase) + the justified focused tests:   # Delta 4 levels 1→3
        what runs and fails → back into the phase (no validada)
        what cannot run (unapplied migration) → defer the CHECK, never the validation: the phase stays bloqueada
    closing review gate (pre-commit):                      # Delta 5: CHECKPOINT.Next = "review phase N"
        INDEPENDENT re-read of the WHOLE phase diff + installed ambient conventions
        + floor lenses: minimality · test value (overtest) · temporary simulation · tooling
        findings → fix (and re-validate the phase) OR defer justified (Open questions + BACKLOG)
    confirm the Condición de salida → set > Estado: validada  # ONLY with the proof run and passed; NEVER from the checkboxes alone
        blocker still live       → set > Estado: bloqueada + > Bloqueo: <reason> + CHECKPOINT + Open questions
        check not runnable (SQL) → set > Estado: bloqueada + > Bloqueo: <reason> + CHECKPOINT + Open questions + BACKLOG
    update CHECKPOINT (functional state reached · simulation boundary if any · tests + result · decisions · deferrals · next state)
    propose commit(s) per source (approve first)           # never push/amend/--no-verify; only after the gate is green
        if rejected → changes stay; record "phase uncommitted"
    next-phase precondition: working tree clean or acknowledged
  final validation (whatever can run; a deferred check keeps its phase bloqueada)
  if every phase validada AND the final validation passed:
    structured_choice(content: [Marcar plan done, Preguntar algo más], flow: [Compactar, Cerrar])
    mark plan done → ONE status line under the title blockquote (Delta 6), updated in place
  else: the plan stays open → CHECKPOINT.Next = run the pending validation of the blocked phase(s)
  # NO export: artifacts stay in the session; a separate export-* promotes them
finalize: CHECKPOINT (+ BACKLOG if something is deferred) + close session + report
```

## Convergence / exit

- **Every phase `validada`** + final validation **run and passed** + **every phase passed its closing review gate** before committing → `Marcar plan done`. A phase left `pendiente`, `en ejecución` or `bloqueada` keeps the plan open, whatever its checkboxes say — a proof waiting on an operative handoff (an unapplied migration) is exactly that case.
- A **structural deviation** or a **functional change** exits this loop without converging (§ *Deviation gate*): `CHECKPOINT` + `finalize`, and the work continues in `plan-refine` / `spec-refine`. Same exit when the entry gate finds a structural gap.
- `Cerrar` (`flow` control, at any time) → `finalize` persists `CHECKPOINT` (and `BACKLOG` only if something remained unexecuted / uncommitted / unapplied), closes the session, reports.
- Promoting artifacts to `docs/` (via `export-*`) is **always** a later, explicit step outside this loop.
