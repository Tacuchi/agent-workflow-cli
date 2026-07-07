---
name: plan-exec-loop
description: >-
  Executes an implementation plan (docs/plans/PPP-plan-<slug>.md) as a living
  doc: reads and updates it phase by phase while editing the real code and
  managing DB and git. Heir of the chassis (loops/CHASSIS.md +
  CODE-POLICIES.md). Deltas: single resumable session, safe git (verified
  branch, per-source proposed commits, never push/--amend/--no-verify), DB
  scripts-only (never executes DML/DDL), per-phase and final validation,
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
`/w:plan-exec` — **resumable** (same chassis mechanism; here resume keys off the plan-doc checkboxes + CHECKPOINT, see Delta 1).

## Reads
`docs/plans/PPP-plan-<slug>.md` (locate via the `docs/plans/PPP-plan-*.md` glob or the exact path from the command argument). It runs **any** plan, whether or not it passed through [`plan-refine-loop`](../plan-refine-loop/LOOP.md) — plan-refine is auxiliary, not mandatory; no gate requires it. If the plan includes UI, it also reads the **design SPECs** (`NNN-SPEC-<SLUG>.md`) its Tasks reference — artifacts of the plan-new/plan-refine session, read **read-only** as the design reference while implementing (see [`SPEC.md`](../../artifacts/artifacts-design/SPEC.md)).

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

## Delta 1 — One session per run; per-phase progress in the plan-doc

- Walks the plan's `Phases` in order (respecting deps) **inside the run's single session** (no session-per-phase).
- **Per-phase progress lives in the plan-doc** (`- [x]`) and in the single `CHECKPOINT` (Completed/Pending/Next): **artifact-first** — `CHECKPOINT.Next` is set to the imminent phase **before** starting it; the plan-doc's `- [x]` checkbox is flipped **after** completing the task.
- Executes the phase's `Tasks`; **skips** the ones already `- [x]` in the plan (the plan-doc is the per-task source of truth). Marks `- [x]` + state **in the plan** (living doc; never in a separate `TASKS`).
- At **every phase boundary**: validate, run the **closing review gate** (Delta 5), update the `CHECKPOINT` (Completed += Phase N, Next = Phase N+1) and propose commits.
- Records in `DECISION` only the **non-obvious**, **as it is decided** (per-phase decisions accumulate in the SINGLE `DECISION`, tagged by phase/task — e.g. `Origin: T2 (F1)`).
- The chassis **gap-driven** engine applies here **inside a task**: facing a non-obvious decision/doubt → inline research OR structured-choice.

## Delta 2 — Git policy: **safe branch + proposed commits**

Full policy in [`../CODE-POLICIES.md`](../CODE-POLICIES.md) (§ *Safe git*: branch-check before editing, rejected commit — changes stay + get recorded —, working-tree precondition between phases). **Inline:** before editing, verify each source's expected branch (`aw check-branch --source <alias>`; on mismatch → pause and resolve with the human); at each phase close and **after the review gate** (Delta 5), **proposed commits per source** (approve first) — never `push`/`--amend`/`--no-verify`.

## Delta 3 — DB policy: **the AI never executes DML**

Full policy in [`../CODE-POLICIES.md`](../CODE-POLICIES.md) (§ *DB scripts-only*). **Inline:** read-only queries → the session's `SCRIPTS.sql`, executed via MCP (`sql-mutation-guard`); DDL/DML migrations → the AI **drafts them in `SCRIPTS.sql` but NEVER executes them** — their promotion to `docs/scripts/` is done by a separate `export-*`, never this loop.

## Delta 4 — Validation

- After executing (per phase and at the end): run tests/checks against `Validations` + `Final behavior` + the spec's acceptance/success criteria.
- A validation that **runs and fails** → back to the task (gap); no advancing.
- **Validation depending on an unapplied migration**: since the AI never executes the DML, it **cannot run it read-only** → it is **deferred** (handoff to a DBA), it does **not block progress**. Recorded in the plan's `Open questions` + `BACKLOG`, marked "verification pending until the SQL is applied". (Reuses the chassis degrade/defer pattern + `MAX` cap → avoids the "back to the task" loop.)

> The **final validation** is PLAN-exec's **convergence gate** = **`Success criteria` green** (*verification-first*; analogous to SPEC's *analyze gate* and plan-new's *coherence gate*): the plan is not marked *done* until it passes or is explicitly deferred (SQL handoff). For code these are **runnable tests** (TDD); for non-executable DB migrations, a **rubric** (SCRIPTS.sql valid + reviewed).

## Delta 5 — Closing review gate (conventions, pre-commit)

Full gate in [`../CODE-POLICIES.md`](../CODE-POLICIES.md) (§ *Closing review gate*): **independent** diff re-read + installed ambient conventions; findings → fix (re-validating the phase) or defer justified. Here only the exec wiring: it runs **between the phase validation (Delta 4) and its commits (Delta 2)**; only with the gate green are the phase's commits proposed.

## Delta 6 — Completion / close

- A phase closes **done** when its tasks are `- [x]` and its validation passed **or** was deferred (SQL handoff). Possible state: **"done — SQL pending application"**.
- All phases done → final *structured-choice* (content: `Marcar plan done` / `Preguntar algo más`; flow: `Compactar`/`Cerrar`).
- **No automatic export**: the artifacts (`SCRIPTS.sql`, `DECISION`, …) stay in the session. Promoting them to `docs/` (scripts, manuals, …) is a separate step via `export-*`.

## Sequence

```
plan-exec-loop(PPP-plan-<slug>.md):
  session = create_or_resume("<slug>-plan-exec")           # <slug> from the plan-doc; ONE session per run; CLI prepends global NNN; CHECKPOINT, resume
  plan = read(PPP-plan-<slug>.md)
  for each Phase in plan (in order, respecting deps):
    if Phase done (all its Tasks - [x] in the plan): skip  # resume via plan-doc checkboxes
    seed CHECKPOINT.Next = Phase N (Pending = its Tasks)   # BEFORE starting the phase: seed the intent (artifact-first)
    for each Task of the Phase:
      if Task - [x] in the plan: skip                      # intra-phase resume by checkbox
      verify each source's expected branch (branch-check)
        on mismatch → pause + resolve with the human
      execute Task:
        edit code in the sources (minimal change)
        if it creates a tool/utility → the ambient creating-tools skill documents it in docs/tools
        if read-only DB query → SCRIPTS.sql + execute read-only
        if DB change (DDL/DML) → draft in SCRIPTS.sql (session artifact, DO NOT execute)
        if non-obvious decision → DECISION (tagged by phase/task, in the SINGLE DECISION)
        if doubt/gap → inline research OR structured-choice    # chassis
      mark Task - [x] + state IN THE PLAN                  # AFTER completing the Task (the plan-doc is the per-task source of truth)
    phase validation:
        what runs and fails → back to the task
        what depends on an unapplied migration → defer (Open questions + BACKLOG)
    closing review gate (pre-commit):                      # Delta 5: CHECKPOINT.Next = "review phase N"
        INDEPENDENT re-read of the phase diff + installed ambient conventions
        findings → fix (and re-validate the phase) OR defer justified (Open questions + BACKLOG)
    update CHECKPOINT (Completed += Phase N, Next = Phase N+1) # AFTER: Pending→Completed + Next = next phase (see artifact-first cycle)
    propose commit(s) per source (approve first)           # never push/amend/--no-verify; only after the gate is green
        if rejected → changes stay; record "phase uncommitted"
    next-phase precondition: working tree clean or acknowledged
  final validation (whatever can run; the SQL-dependent part stays as a handoff)
  structured_choice(content: [Marcar plan done, Preguntar algo más], flow: [Compactar, Cerrar])
  mark plan done (or "done — SQL pending application")
  # NO export: artifacts stay in the session; a separate export-* promotes them
finalize: CHECKPOINT (+ BACKLOG if something is deferred) + close session + report
```

## Convergence / exit

- Plan complete + validation OK (or deferred with a handoff) + **every phase passed its closing review gate** before committing → `Marcar plan done`.
- `Cerrar` (`flow` control, at any time) → `finalize` persists `CHECKPOINT` (and `BACKLOG` only if something remained unexecuted / uncommitted / unapplied), closes the session, reports.
- Promoting artifacts to `docs/` (via `export-*`) is **always** a later, explicit step outside this loop.
