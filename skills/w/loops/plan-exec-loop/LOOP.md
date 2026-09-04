---
name: plan-exec-loop
description: >-
  Executes an implementation plan (docs/plans/PPP-plan-<slug>.md) as a living
  doc: re-infers isolated or continuous phase batches, edits real code, then
  validates/reviews/commits each effective batch. Heir of CHASSIS.md and
  CODE-POLICIES.md. Keeps the executability and deviation gates, one resumable
  session, safe git, DB scripts-only and no auto-export. Composes git and sql.
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
`docs/plans/PPP-plan-<slug>.md` (the `docs/plans/PPP-plan-*.md` glob, or the given path) **and its source spec** (from its `> Derived from`, else one in `## Origin`; none if `> Standalone:`) — the entry gate reads both. It runs any plan whose source contract is executable: `> Límite de ejecución: checkout`, explicit phase/task sources and aliases from `AGENTS.md > Fuentes`. A legacy or v21 plan that lacks it fails closed to [`plan-refine-loop`](../plan-refine-loop/LOOP.md); plan-refine remains auxiliary only after that contract exists. If the plan pins design, it also reads the **UI Design Package** revisions its `## Design references` and its tasks name — **read-only**, at the exact revision each one fixed (§ *Design precondition gate*).

## Writes
- `docs/plans/PPP-plan-<slug>.md` (**read/update**, living doc: phase/task state, `Open questions`).
- Artifacts of the plan-exec session under `.workflow/sessions/` (`SCRIPTS.sql`, `DECISION`, `ANALYSIS-FILE`/`CONCLUSIONS`, …).
- It does **NOT** write other `docs/` folders nor **graduate/export** artifacts automatically (see *Boundary*).

## Boundary — no auto-export (hard rule)

Full rule in the chassis (§ *docs/ boundary — no auto-export*). Here: the only `docs/` folder this loop writes is **`docs/plans`** (the plan, living); everything else stays in the session until an explicit, later `export-*`.

## Inherits

Read **[`../CHASSIS.md`](../CHASSIS.md)** — the loop's **full engine** — **and** **[`../CODE-POLICIES.md`](../CODE-POLICIES.md)** — the *code-editing loop policies* — **always before** these deltas. *(If `../` does not resolve: same names next to this file — global layout rule, chassis § Reference resolution.)*

Read the shared execution-unit contract in
[`PLAN-EXECUTION-BATCHES`](../../modules/PLAN-EXECUTION-BATCHES.md); it owns batch syntax,
inference, the deferred-validation cycle and conditional Git authorization.

## Composes

`git` (safe branch + proposed commits). `plan-exec` does **not** load `external-data`: its proof comes from the acquired checkout only. SQL fixture/ephemeral tests are ordinary local commands; remote MCP reads belong to earlier research, never this loop.

> **Ambient conventions (not roles):** code/testing/writing standards and `creating-tools` are standalone skills the host auto-discovers by `description` — Workline neither binds nor depends on them. Full doctrine: [../../roles/README.md](../../roles/README.md).

## Internal sessions (managed)

- **plan-exec session** descriptor `<slug>-plan-exec` → `NNN-<slug>-plan-exec` (the `<slug>` comes from the input plan-doc `docs/plans/PPP-plan-<slug>.md`): **a single session per run** (Type = `exec`). Owns the run; holds `SESSION` + `CHECKPOINT` + `DECISION` + `SCRIPTS.sql` (+ `BACKLOG` only if something is deferred). Research is **inline** inside this session: it produces `ANALYSIS-FILE`/`CONCLUSIONS` (+ read-only `SCRIPTS.sql` if it queries DB) in its own folder.

> **Numbering**: the caller passes only the descriptor; the CLI prepends the global sequential `NNN` over `.workflow/sessions/` (see chassis). It never restarts per type.

> **Compat (legacy):** old workspaces may hold `plan-exec-phase-*` sessions (one per phase) and `*-research-*` ones — historical, left as-is; new runs use a single session.

## Entry gate — executability

**Before touching code**, read the plan and its spec and check the shape execution depends on:
this is § *Entry gate — executability*. Once that shape exists, plan-refine is auxiliary, not mandatory.

1. the plan declares `> Límite de ejecución: checkout`; every phase has `> Fuentes:` and every task has `_(fuentes: …)_`; aliases resolve through `AGENTS.md > Fuentes` (except reserved `workspace`) and task sources are a subset of their phase;
2. every phase declares its `Resultado`, its `Condición de salida` and its `Validación de fase`;
3. if temporary behavior exists, its current boundary and retirement phase are identifiable; otherwise the simulation check is not applicable;
4. the primary proof of the first `pendiente` phase is identifiable and is a checkout command or inspection;
5. no structural contradiction is evident (a phase that undoes an earlier one, evidence nobody can produce).
6. reading the phase prose shows that no deployed product, installed host, MCP connection or remote URL is a validation or exit condition; those observations belong to research or `Handoff operativo`, never the closure path.

Execution **no longer accepts in silence** a plan that would force it to invent its own structure. Two outcomes:

- **Minor gap** — the plan is all but executable: an exit condition derivable from what is already written, the obvious evidence unnamed, micro-tasks to group. Normalizing edits the `### Fn` blocks in place, **adds no scope and moves no boundary**, and is recorded in `DECISION` + `CHECKPOINT`.
- **Structural gap** — phases, contracts or journey are missing, or a change that **does** carry temporary behavior leaves its boundary undeclared. It does **not** improvise: record the finding in `CHECKPOINT`, hand off to [`plan-refine-loop`](../plan-refine-loop/LOOP.md) (`/w:plan-refine`) and resume execution over the refined plan.

> **Which outcome a declared gap produces, and whether anybody is asked to consent, is not this document's call:** the deterministic steps below are decided by the CLI (`aw flow advance`), not by this document. Normalization is offered on a minor gap and on nothing else — a structural one is not something to consent to.

> **A missing `Límite de simulación` is a gap only when there is something to simulate.** No task and no phase introduces temporary behavior → the block is legitimately absent and the gate passes; demanding it anyway pushes execution to invent a stub so the plan matches a template. The same holds for `Diferido` and every other conditional block.

> The gate reads the **canonical phase contract** from [`plan-new-loop`](../plan-new-loop/LOOP.md) § *Phase contract (canonical)* — required sections, the `> Estado:` vocabulary, semantic granularity. Execution references it; it never redefines it. The marker is a **line of its own** inside the `### Fn` block (`> Estado: <value>`); written any other way it reads as `pendiente`.

After this gate and before editing, infer the effective batches over pending phases. The live
checkout may merge or split the plan's declaration without consent; record the result and drift in
`CHECKPOINT`. A missing `## Execution batches` is legacy compatibility, not an entry gap.

## Design precondition gate (fail-closed, per task)

Applies **only** to a task that pins design (`DES-001@r4 / SCR-002@r2#empty`). Run
`aw designs --plan <plan-doc>` before implementing the batch; it answers per task
and the verdict is the command's, not the implementer's.

**Four causes block, and each names the artifact and the corrective action:** the
reference does not resolve · its digest no longer matches the bytes · the revision
is **revoked** · the applicable **closure** does not reach `handoff`. A blocked
task is not implemented, its phase stays `en ejecución` or `bloqueada`, and the
correction goes to `/w:plan-refine` — or to `/w:spec-refine` when it changes
behavior or acceptance.

**One cause only warns:** a revision **superseded** by a newer one but intact
stays executable. Publishing `@r5` never invalidates the `@r4` a task pinned on
purpose; only an explicit, audited revocation does. A **stale path hint** warns
the same way — identity resolved, the recorded path moved.

> **`plan-exec` never redesigns.** Completing an `outline` artifact, inventing a
> missing state or promoting a revision to `handoff` are design decisions and
> belong to the refine that owns them. Full contract in
> [`DESIGN-REFERENCES.md`](../../modules/DESIGN-REFERENCES.md) (signal `ui`).

**Publishing a document together with a package revision is one transition.** A
spec or plan whose reference moves is written in the **same** all-or-nothing batch
as the revision it points at, so no reader ever sees a document citing a baseline
that is not there, or a revision no document reached. An effect the batch cannot
cover — anything outside the workspace files — is recorded as **pending
reconciliation** in `CHECKPOINT`, never reported as published.

## Delta 1 — One session per run; execution-unit cycle in the plan-doc

- Walk the plan's `### Fn` blocks under `## Tasks` in dependency order inside one session. Infer
  effective `continuous`/`isolated` batches first; legacy `## Phases` tables degrade the same way.
- **Execution-unit cycle:** seed one batch intent; implement all its phases in order; validate and
  review at unit close; then update states/`CHECKPOINT` and enter Git. An isolated unit contains
  one phase. A continuous unit follows `PLAN-EXECUTION-BATCHES`: no proof, runner, build, lint,
  review or commit between its phases.
- Executes the phase's tasks; **skips** the ones already `- [x]` in the plan (the plan-doc is the per-task source of truth). **Micro steps stay internal** (canonical contract): they reach `CHECKPOINT` only when a resume needs them, never the plan.
- **Marking order (hard rule):** a phase reaches `validada` only with its proof run and passed, its
  exit condition true and the combined review green; a blocker is never deferred into `validada`.
  **Never** because all its checkboxes are ticked.
- **Intermediate states:** `bloqueada` = the phase is stopped on a live checkout blocker — recorded in `CHECKPOINT` + the plan's `## Open questions`, back to `en ejecución` when it clears; it counts as **not validated**. A proof that cannot run **stays `bloqueada`**. A deferred check never counts as a passed one. A script awaiting real-world application is a **handoff**, not a blocker: local fixture/ephemeral validation can still establish the promised behavior and the phase may become `validada`.
- **A blocker without a reason is not a blocker (hard rule).** Writing `> Estado: bloqueada` **always** writes its `> Bloqueo:` line in the same edit: a state that says "stopped" without saying on what is a dead end for whoever reads `aw status` next. The runtime tolerates a legacy block that states none (`blocker: null`) — this loop never produces one. `CHECKPOINT.Next` names **the action that unblocks it** in the checkout, never an operator's deployed run.
- **Plan-doc residue (hard rule):** execution writes into the plan-doc **only** five things — checkbox flips (`- [ ]` → `- [x]`), the phase's own `> Estado:` line, its `> Bloqueo:` line while blocked, deferrals appended to its `## Open questions`, and the plan's own status mark (its `> Estado:` line and, on close, its `> Cierre:` line — Delta 6). The declared-gap hatch is Deltas 4, 5 and 7. Per-phase results, review-gate findings and metrics go to the session's `DECISION`/`CHECKPOINT` — **never** into the plan-doc. Phase blocks are updated **in place — NEVER append a duplicate `### Fn` block** (same contract as CHECKPOINT sections). The entry gate's consented normalization is the single exception, and it lands before execution starts.
- **CHECKPOINT per execution unit:** record its effective grouping, functional states, simulation
  boundary when applicable, checks/results, decisions, deferrals and next intent. The task boxes
  and `en ejecución` marks preserve an intra-batch resume.
- Records in `DECISION` only the **non-obvious**, **as it is decided** (per-phase decisions accumulate in the SINGLE `DECISION`, tagged by phase/task — e.g. `Origin: T2 (F1)`). A structural deviation is **not** settled with an entry there (§ *Deviation gate*).
- The chassis **gap-driven** engine applies here **inside a task**: facing a non-obvious decision/doubt → inline research, a probe (Delta 7) OR structured-choice.

> **Legacy plans degrade safely:** a missing line reads `pendiente`; missing execution batches are
> inferred into `CHECKPOINT`; neither is back-filled. Checked boxes alone prove nothing.

## Deviation gate

Execution resolves **detail**, never **redesign** — and between those two there is a third thing: a
divergence that keeps the functional lineage and can be reconciled **forward**.
This gate lives **only** in this loop — the chassis does not carry it. It has **four** exits, and the
run stops at it: declaring a deviation no longer carries on to the commit by itself.

- **Local decision — `plan-exec` continues.** A class or method name; a local helper; internal code layout; imports; a choice between equivalent APIs already allowed; a fix needed to compile; a minor refactor that does not move the journey; one extra focused test for a risk found while implementing. Declares **no signal** — the gate is not raised — and is recorded in `DECISION` only when it is not obvious.
- **Composable decision — a note is registered and execution continues.** The change amends how the promise is met without changing who promised it. It is the only exit that writes a **decision note**, and it is available **only** when all four closures hold (below). The spec and the plan stay byte-exact. A **standalone** plan has no chain to add a note to: its decision stays in the run's trace and you write it into the session's `DECISION.md`.
- **Structural deviation — stop and return to `plan-refine`.** Stop when the change touches: an input or output; an observable state; a relevant endpoint or public contract; the set of participating components or repositories; the phase order; the simulation boundary; the integration strategy; a material dependency; the main persistence mechanism; a phase already `validada`; the evidence needed to demonstrate the result. A decision that substantially expands or shrinks the work counts too.
- **Functional change — return to `spec-refine`.** Stop when the **promise of the product** moves: the expected result; the functional scope; a business rule; the outcome an acceptance criterion states; the actor or consumer; a product decision. A technical divergence that leaves the promise intact never comes back here — its first exit is `Registrar la decisión y seguir`.

> **How an affirmation is addressed:** a decision note names the criteria it amends as `S{NNN}/AC-nn` — `NNN` from the spec file's number, `AC-nn` the label the criterion carries in the spec's checklist. The CLI **derives** that id from the label plus the file number, so the readable form the spec template writes is already addressable (a criterion that spells the full id is read the same way, never counted twice). A note amending a criterion the spec does not state **at all** is refused with `CONTRACT_ASSERTION_ABSENT`, and the exit is the spec stating it (`spec-refine`), never a second spelling of the id here.

### Obligations — the two classes, and how each one is settled

A note may leave work behind, and it declares **which of two classes** each piece is. A
**compensation** is work this lineage owes: it holds the plan's closure shut until it is settled. A
**handoff** is work somebody outside the run took on: it stays listed, it stays visible after the plan
closes, and it blocks nothing — a run that cannot discharge it could never close. Nothing historical
moves: the boxes and the phase states record what happened, and the obligation is new work of the
effective contract.

The class is the agent's to state while drafting the note, and the person sees it in the sealed
preview before registering it; a new note leaving work without saying which class is refused. A note
published before the class existed is read tolerantly — an undeclared obligation is a **compensation**
unless the plan itself enumerates that exact work as a handoff — and every surface marks that as a
reading somebody supplied, never as the note's own word. The class is revocable: the
settlement boundary may declare a live compensation a handoff after all. So **when in doubt,
compensation** — the only error a later boundary still catches.

Settling one is publishing a note that **supersedes** the one carrying it without carrying it forward;
there is no second ledger of discharged obligations: one recorded outside the chain
could disagree with it. The closure does this by itself: between the last `batch-close` and
the final validation the run declares, per compensation, whether it is done and with what evidence,
and the CLI derives and publishes the settlement note. A compensation still pending leaves that
boundary open with an executable action and costs the run no attempt. With **no** open run — a plan
blocked today whose run closed long ago — the exit is `aw settle`: it lists what is owed, previews the
note, and publishes it against an approval.

**The split between scaffolding and content**, in three lines. A gap with a **single** reading is
repaired by the run itself, and the repair is recorded. A gap with **more than one** reading is asked
**once for all of them**, with the run's own reading offered as the recommendation. Everything else
is **content**, and content is the person's.

**Eligibility is closure, never size.** The composable exit opens only when the four close: the
divergence stays in the **same functional lineage**; its **intent is settled**, so nothing further has
to be elicited; its **transitive impact can be enumerated**, every consumer nameable; and its
**result can be sealed and recovered**, so an identical retry gives the same outcome and a failure
leaves nothing half-written. Counts — of criteria, phases or repositories — are reported and decide
nothing: a divergence touching one criterion that closes three of the four is not composable, and one
touching nine that closes all four is.

> **Which exit the run takes is the person's, and which are offered is not this document's call:** the deterministic steps below are decided by the CLI (`aw flow advance`), not by this document. Recognizing the divergence and closing its eligibility are judgment; counting the closures and raising the choice are a rule.

On any exit that leaves the phase: `CHECKPOINT` records the state reached and the trigger, the phase
keeps the state it really has (`en ejecución` or `bloqueada`, never `validada`), and the working tree
is left committed or acknowledged (Delta 2). On the two return paths and on an escalation, the
**escalation package** travels with it — diagnosis, decisions already taken, evidence gathered and the
return point — and the destination **declares that it consumed it**, so returning never costs redoing
the analysis execution had already done. Resuming later over the corrected plan is a normal
`create_or_resume`.

**More than one divergence may appear in a run, and every one is kept.** A later recognition never
erases an earlier one.

| Finding | `plan-exec` | note | `plan-refine` | `spec-refine` |
|---|---|---|---|---|
| Rename a helper · internal implementation · test for a local risk | continues | — | — | — |
| Same promise, different route, four closures held | continues | yes | — | — |
| Change the public DTO | stops | — | yes | yes, if behavior changes |
| Add a participating repository | stops | — | yes | — |
| Move the simulation to another boundary | stops | — | yes | — |
| Change the phase order | stops | — | yes | — |
| Add a functional rule · move the outcome a criterion promises | stops | — | — | yes |
| Does not compose against this lineage at all | stops | — | — | a spec of its own |

## Delta 2 — Git policy: **safe branch + proposed commits**

Full policy in [`../CODE-POLICIES.md`](../CODE-POLICIES.md), and its gating is the CLI's: this loop
adds nothing of its own beyond running on a verified branch and never
`push`/`--amend`/`--no-verify`.

## Delta 4 — Validation: phase proof + progressive tests

- The phase's **primary proof** is its `Validación de fase`: it demonstrates the **state reached**, not the structure written. Three levels, and the loop never descends one automatically:
  1. **phase proof** — component interaction, endpoint smoke test, vertical run down to the stub, persistence integration, or the main path end to end;
  2. **focused tests** — added when the layer carries its own rules, a relevant transformation, error handling, persistence, transactions, temporal logic or external integration;
  3. **risk tests** — security, concurrency, idempotency, retries, known regressions.
- **One vertical proof per operation while wiring** (request → controller → use case → repository → fake or stub → expected response): it demonstrates the path once instead of re-asserting the same happy path at every layer. Trivial mappers, plain DTOs and framework behavior get no dedicated test.
- `isolated` remains compatible with literal TDD. A continuous batch may author evidence before
  code, but first runs it at batch close. No phase becomes `validada` before its exit is demonstrated.
- **Continuous means all checks at batch close.** Do not run its phase proofs, focused/risk tests,
  build, typecheck, lint or review while implementing internal phases. At close run proofs in phase
  order, then the justified checks and cross-cutting validations. `isolated` runs the same stack for
  its single phase.
- Each added test is re-weighed at the closing review gate ([`../CODE-POLICIES.md`](../CODE-POLICIES.md) § *Closing review gate* → *Test-value lens*, tag `overtest`): over-testing is a **finding to fix or justify**, never an automatic rejection.
- Also run the plan's `## Validations` (cross-cutting rules and constraints) + the Final behavior block of `## Solution` (legacy plans: the `## Final behavior` section). **What execution runs is the PLAN's evidence, never the spec's prose:** `plan-new` already derived those validations from the spec's acceptance criteria and its `## Scenarios`, so the spec is confirmed functionally **through** them. A criterion no validation covers is a gap of the plan, not a test to improvise here.
- A validation that **runs and fails** → back into the phase (gap): no advancing, no `validada`.

- **SQL delivery**: validate the migration's behavior against a fixture or ephemeral database in the acquired checkout. The forward/rollback script is delivered through `SCRIPTS.sql` and `export-scripts`; a real application is an optional handoff and never keeps a phase or the plan open.

> The **final validation** is PLAN-exec's **convergence gate** = **`Success criteria` green** (*verification-first*; analogous to SPEC's *analyze gate* and plan-new's *coherence gate*): the plan is not marked *done* until local proof passes. For code and persistence these are checkout commands/tests; a script's real-world application is never a closing criterion.

## Delta 5 — Closing review gate (conventions, pre-commit)

Full gate in [`../CODE-POLICIES.md`](../CODE-POLICIES.md): independent re-read, ambient
conventions and the floor lenses. It covers the execution unit's **whole** diff after every phase
proof/check and before states or Git advance. Findings are fixed and the affected checks rerun, or
deferred with justification when they are not blockers.

## Delta 6 — Completion / close

- A phase closes when its `> Estado:` reads `validada`: work done, exit condition true and proof
  passed. In a continuous batch every phase waits for the batch review; an operative handoff leaves
  the affected phase `bloqueada` and the unit uncommitted.
- **The plan's own state is the third axis, and it stays `open` during the whole run.** Every phase `validada` is **not** the plan closed: the final validation still has to run. Keep `> Estado: open` under the title while executing — stamping it on the first write if the plan carries none — and never write `done` from the counters — a legacy plan with every box ticked is not closed by that fact (§ *Legacy plans degrade safely*).
- **Every phase `validada` + final validation passed** unlocks completion, and the mark is written
  **after Git**: commit each unit, integrate it, and only then seal `done`. A run that isolates its
  writing holds commits that live on `aw/<session>` and nowhere else, so a `done` stamped before the
  merge would be true of no branch anybody reads.
- **Integrating is part of closing, not a chore after it.** `aw worktree integrate --code <NNN>`
  merges every unit of the session into its source's working branch, in alias order, one at a time
  over the live branch — never a rebase, a force, a push or a silent branch switch. A **conflict is a
  live state, not a failure**: the unit, its commits and the merge are kept, the receipt names the
  plan, the source and the files, and `aw fix-git --path <source>` (`prepare` → `apply` →
  `commit --confirm`) resolves it; then integrate again to confirm and give the unit back. The plan
  is not `done` and the session does not close while a unit is still alive.
- **Marking done = ONE status line in the plan-doc**, under the title's blockquote: `> Estado: done`, updated in place on a re-run. The machine value **stands alone** — the date and session go on their own `> Cierre: YYYY-MM-DD · sesión NNN` line right under it, for the same reason a blocker never rides on a phase's state line. It never replaces the per-phase lines inside the `### Fn` blocks — position tells the two apart. No per-phase result tables, no ✅ suffixes — that record lives in the session (`DECISION`/`CHECKPOINT`).
- **Legacy status line, migrated on write.** A plan carrying the old single-line form (`> Estado: done — YYYY-MM-DD · sesión NNN`) is still **read** as closed; the first time this loop legitimately writes that document, it is rewritten to the two-line form. Compatibility is for reading old plans — every new write uses the normalized contract.
- **No automatic export**: the artifacts (`SCRIPTS.sql`, `DECISION`, …) stay in the session. Promoting them to `docs/` (scripts, manuals, …) is a separate step via `export-*`.

## Sequence

```
plan-exec-loop(PPP-plan-<slug>.md):
  session = create_or_resume("<slug>-plan-exec")           # <slug> from the plan-doc; ONE session per run; CLI prepends global NNN; CHECKPOINT, resume
  plan = read(PPP-plan-<slug>.md, its spec, checkpoint)
  entry gate (executability): result · exit condition · phase proof · simulation boundary if any · no structural contradiction
      minor gap      → structured-choice [Normalizar y ejecutar | Ir a plan-refine] → normalize in place + DECISION
      structural gap → CHECKPOINT(blocker) → hand off to /w:plan-refine → stop
  batches = infer_effective_batches(pending phases, plan + live checkout)
      may merge/split declared rows without asking; legacy absence is allowed
      record batches + declaration drift in CHECKPOINT
  commit_authorization = explicit conditional pre-authorization from the user, if any
      record it before editing; otherwise approval is deferred to each green batch close
  for each Batch in batches:
    verify every affected source's branch; mismatch → stop + human
    seed CHECKPOINT.Next = Batch Bn (mode + phases + tasks)
    for each Phase in Batch:
      if Estado == validada: skip
      read Resultado + Condición de salida; set > Estado: en ejecución
      for each pending Task:
        execute minimal work; keep DB/tool policies; apply deviation gate
          local decision → resolve; DECISION only if non-obvious
          structural/functional deviation → CHECKPOINT + stop → refine destination
          probe whose verdict shapes later work → batch was ineligible; stop/re-infer
        mark Task - [x] after its local work
      # continuous: advance directly to the next phase; run NO validation/review/commit here
    at Batch close, in phase order:
      run every Validación de fase, then justified focused/risk checks
      run applicable plan Validations; last Batch also runs final validation before Git
      failures → fix + rerun affected checks
      unrun operative check → phase bloqueada + > Bloqueo: + CHECKPOINT + Open questions
    closing review gate over the WHOLE BATCH diff
      findings → fix + rerun affected checks OR defer justified if non-blocking
    if any proof/check/review/exit condition is not green:
      preserve actual states + combined uncommitted diff; record unblocking action; stop
    set every Batch phase > Estado: validada; update CHECKPOINT
    prepare exactly one commit per affected source, in its own isolation unit
      pre-authorized → commit without another question
      else → one consolidated approval for all source commits
      rejected → changes stay; record "batch uncommitted"
    if last Batch + final validation green:
      integrate: aw worktree integrate --code NNN            # every unit, alias order, live branch
        conflict → keep unit + merge; report plan/source/files; aw fix-git --path <source>
                   (prepare → apply → commit --confirm) → integrate again → release
        refused (dirty checkout / off branch / uncommitted unit) → fix what it names; retry
      then mark plan done: > Estado: done + > Cierre: YYYY-MM-DD · sesión NNN under the title (Delta 6)
    next-batch precondition: working trees clean or acknowledged
  if no Batch ran and phases are already validada:
    run final validation now; if green → same integrate-then-mark-done branch
  if plan is not done:
    the plan-level > Estado: stays open → CHECKPOINT.Next = the action that unblocks the phase(s)
  # NO export: artifacts stay in the session; a separate export-* promotes them
finalize: CHECKPOINT (+ BACKLOG if something is deferred) + close session + report
  a session holding a live unit does NOT close: integrate it, or record why it stays
```

## Convergence / exit

- **Every phase `validada`** + final validation passed + every effective batch reviewed before its
  commits + every unit integrated → `Marcar plan done`. Any pending/running/blocked phase keeps the
  plan open, and so does any unit still holding commits.
- A **structural deviation** or a **functional change** exits this loop without converging (§ *Deviation gate*): `CHECKPOINT` + `finalize`, and the work continues in `plan-refine` / `spec-refine`. Same exit when the entry gate finds a structural gap.
- `Cerrar` (`flow` control, at any time) → `finalize` persists `CHECKPOINT` (and `BACKLOG` only if something remained unexecuted / uncommitted / unapplied), closes the session, reports.
- Promoting artifacts to `docs/` (via `export-*`) is **always** a later, explicit step outside this loop.

## Conditional modules

- `probe` — probe (PoC) tasks → `../../modules/EXEC-PROBE-TASKS.md`
- `db` — the DB policy → `../../modules/EXEC-DB-POLICY.md`
