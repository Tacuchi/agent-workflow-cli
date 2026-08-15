---
name: quick-loop
description: >-
  The Workline lightweight shortcut: solves a scoped task (fix, small
  tweak) straight from the prompt, with minimal ceremony and a single commit.
  Heir of the chassis (loops/CHASSIS.md + CODE-POLICIES.md). Deltas: no
  plan-doc (the prompt IS the task), single light session <slug>-quick, an
  entry size gate and LIVE escalation to SPEC (to PLAN it stays deferred)
  when the objective exceeds a quick or the task grows. Never touches docs/.
  Started by /w:quick; resumable. Invoke for small, direct changes that do
  not warrant a formal spec or plan.
---

# quick-loop

> **Heir** of the common chassis — **only** the QUICK deltas live here. The engine lives in the chassis and the *code-editing loop policies* in `CODE-POLICIES.md` — never repeated.

## Flow
QUICK

## Layer
2 — the AI runs it end to end (minimal loop).

## Started by
`/w:quick` — **resumable** (same chassis resume mechanism).

## Reads
— (the user's prompt **plus any analysis already established in this conversation** — *adopted context*, chassis § *Adopted context*: adopted, never re-derived. There is no input document).

## Writes
- **Deliverable per task:** edits code in the sources (minimal change) **or** produces a scoped **analysis/design** (non-code deliverable, lives in the session artifacts — never in `docs/`).
- Session artifacts under `.workflow/sessions/`.
- **NEVER touches `docs/`** (no doc, no auto-export). An analysis/design worth preserving is promoted separately (`export-*`) or escalated to SPEC/PLAN (SPEC: live — see *QUICK delta*).

## Internal session

- **ALWAYS** creates a light session with descriptor `<slug>-quick` → `NNN-<slug>-quick` (Type = `quick`, ≈ `exec`): `SESSION` · `DECISION` · `SCRIPTS.sql` · `CHECKPOINT` (+ `BACKLOG` only if something is deferred). A single session. Research is **inline** inside it (`ANALYSIS-FILE`/`CONCLUSIONS` + read-only `SCRIPTS.sql` in its folder). The caller passes only the descriptor; the CLI prepends the global sequential `NNN` (see chassis). **Exception:** if the entry **size gate** escalates to SPEC, the quick run never comes to exist — no quick session is created; the session is the `spec-refine-loop` one.

## Inherits

Read **[`../CHASSIS.md`](../CHASSIS.md)** — the loop's **full engine** — **and** **[`../CODE-POLICIES.md`](../CODE-POLICIES.md)** — the *code-editing loop policies* — **always before** these deltas. *(If `../` does not resolve: same names next to this file — global layout rule, chassis § Reference resolution.)*

## Composes

`git` · `sql` (DB rule) · `research` (inline). Resolved via `.workflow/skills.toml`.

> **Ambient conventions (not roles):** code/testing/writing standards and `creating-tools` are standalone skills the host auto-discovers by `description` — Workline neither binds nor depends on them. Full doctrine: [../../roles/README.md](../../roles/README.md).

## QUICK delta — minimal ceremony

> **Directed tranche:** the deterministic steps below are decided by the CLI (`aw flow advance`), not by this document — it names the boundary in force, its alternatives, and the exact invocation when something has to run outside. What stays here is the *why*, plus every step that is judgment or preference.

- **No phases, no plan-doc**: the prompt **is** the task (a single unit). No roadmap.
- **Proportional verification-first** (minimal ceremony): even here the check is **seeded before**, sized to the task. Code: one test (bug repro → fix) or "existing build/lint/tests stay green" (chore). **Analysis/design**: a **short falsifiable rubric**, *ratified by the user* before pursuing it. It is the run's `SESSION.Success criteria` (see [chassis § *Verification-first*](../CHASSIS.md)).
- **Git and DB inline** (full policies in [`../CODE-POLICIES.md`](../CODE-POLICIES.md)): before editing, verify each source's expected branch (`aw check-branch`); **proposed** commit (approve first) — never `push`/`--amend`/`--no-verify`. The AI **never executes DML/DDL**: migrations are drafted into the session's `SCRIPTS.sql`; fixture/ephemeral checks are local proof and any remote read is research context, never closure.
- **One session. One commit** proposed at the end (only if there were code changes), **after the proportional closing review gate** ([`../CODE-POLICIES.md`](../CODE-POLICIES.md) § *Closing review gate*): diff re-read + ambient conventions; fix or defer; nothing reaches the commit unreviewed.
- **Entry SIZE GATE** (before creating the session): a quick that should have been a spec costs more than the ceremony it saved, so the size of the objective is judged **before** anything exists. Your part is recognizing the signals; the threshold, the question and its options are the CLI's. A signal already resolved by *adopted context* is **not** a signal (chassis § *Adopted context*). A **resume** of an existing quick never re-fires it.
  - **`Recortar alcance`**, if chosen: propose the **sub-task that DOES fit** a quick (`SESSION.Objective` = the sub-task; the original prompt goes into `## Origin`) and defer the rest to `BACKLOG` ("trimmed at the gate — may warrant its own spec, `/w:spec-new`").
  - **`Cambiar a SPEC`**, if chosen: **no quick session is created** — run the *Live transition to SPEC* (next bullet).
- **Live transition to SPEC** (shared by the gate and mid-loop escalation). On acceptance, the work line **moves to the SPEC flow**: the explicit consent in the structured-choice **equals invoking the destination command** (*consented exception* — rule 3 of the *Continuity rule*, [`../../SKILL.md`](../../SKILL.md) § *Operating context*). On the SPEC side:
  1. **Materialize the draft** via the [`../../commands/spec-new.md`](../../commands/spec-new.md) procedure: `aw next-number docs/specs --claim spec-<slug>.md`, schema, single-pass **NO RESEARCH** — its bounded reconnaissance does **not** re-fire (this run's context arrives adopted). `## Origin` = "escalated from `/w:quick`" + the original prompt (+ the origin quick session if it exists). The draft is born `status: draft`: only the SPEC gate promotes it to `ready-for-plan`.
  2. **Load and execute** [`../spec-refine-loop/LOOP.md`](../spec-refine-loop/LOOP.md) — over that spec (trampoline pattern).
  3. The run's session is that loop's **normal** `NNN-<slug>-spec-refine` (the CLI numbers it; its `## Origin` records the escalation). **Invariant 2 intact**: quick, while it is quick, never writes `docs/` — the draft is written by the SPEC flow, post-consent.
- **Mid-loop escalation + handoff**: if the task grows, declare the signals again — the CLI applies the same threshold and, if it fires, asks. If the user accepts moving up:
  1. The **already-edited code stays** in the working tree (never reverted) and is **recorded** in `CHECKPOINT` + `BACKLOG`: "uncommitted changes in `<source>` — decide commit/discard on resume" (the "rejected commit" pattern, [`../CODE-POLICIES.md`](../CODE-POLICIES.md) § *Safe git*).
  2. The quick session goes to `finalize` with the **pointer** in `BACKLOG`: to **PLAN** → "escalated to `docs/plans/PPP` — resume there" (**deferred** as today: seed + pointer, no live entry); to **SPEC** → "escalated to `docs/specs/NNN` — **continued live** (session `NNN-<slug>-spec-refine`)".
  3. The artifacts (`DECISION`, `SCRIPTS.sql`) **stay in the quick session** as referenceable context for the new session (never migrated).
  4. **SPEC enters live**: after `finalize`, run the *Live transition to SPEC* (draft **only if no spec exists** for this objective; then the loop). **Asymmetry** intact: PLAN can **absorb** the progress (plan-exec picks up the existing working tree); SPEC **restarts** the design cycle and treats the half-done code as context/reference, never as ingested work.

## Sequence

```
quick-loop(prompt):
  # The CLI drives the entry gate, its anti-duplicate search and the session, and
  # stops at each boundary it cannot decide; it verifies the seeding afterwards.
  # `Cambiar a SPEC` → live transition (see delta): draft (spec-new procedure) +
  #                    load and execute ../spec-refine-loop/LOOP.md → END (no quick session)
  if the conversation already established analysis/conclusions →                 # adopted context (chassis)
    adopt them (SESSION.Origin = "adopted from host conversation"; reference in CONCLUSIONS) — never re-derive/re-ask
  author SESSION.Success criteria = the deliverable's check  # test(s) if code · short RATIFIED rubric if analysis/design
  work the task (minimal loop):
    if it edits code → verify each source's expected branch (`aw check-branch`); mismatch → pause + resolve
    produce the deliverable: edit code (minimal change) OR author the analysis/design
    if fixture/ephemeral DB check → run it from the checkout + capture its proof
    if DB change (DDL/DML) → SCRIPTS.sql (session artifact, DO NOT execute)
    if non-obvious decision → DECISION
    if doubt/gap → inline research, a probe OR structured-choice   # chassis § Proof of concept
    if the task GROWS → declare the signals again; if the CLI asks and the user accepts:
        PLAN → handoff (progress stays; BACKLOG→seeded plan — resume there, deferred) → goto finalize
        SPEC → handoff (progress stays; BACKLOG→"continued live") → finalize →
               live transition (see delta): draft if missing + spec-refine-loop
  convergence gate: run the Success criteria and hand back their real output
  if there were code changes:
    closing review gate (proportional):                      # diff re-read + installed ambient conventions
        findings → fix (re-validate) OR defer justified (BACKLOG)
    propose commit (approve first)                           # never push/amend/--no-verify; only after the gate
  structured_choice(content: [Cerrar tarea, Preguntar algo más], flow: [Compactar, Cerrar])
finalize: CHECKPOINT (AFTER: Pending→Completed) + BACKLOG (only if something is deferred) + close session + report
```

## Convergence / exit

- Closing review gate passed and commit proposed if there was code (or skipping it approved) → `Cerrar`.
- `Cerrar`/`Compactar` (`flow` control) → persists `CHECKPOINT` + `BACKLOG` (resumable).
- **No export**: nothing goes to `docs/`. Anything worth preserving → promoted separately via `export-*`, or escalated (to SPEC **live** — the line continues in spec-refine already as SPEC flow; to PLAN **deferred**, seed + pointer).

> QUICK's *convergence gate* is **proportional verification-first**: a **short** `Success criteria` declared at start (not the *absence* of a checklist — its minimal version). The CLI evaluates it, and it evaluates the **real output** of running those criteria — a claim that they passed is not a result.

## Conditional modules

- `resume` — continuity across prompts → `../../modules/PROMPT-CONTINUITY.md`
