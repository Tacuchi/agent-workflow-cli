---
name: quick-loop
description: >-
  The Workline lightweight shortcut: solves a scoped task (fix, small
  tweak) straight from the prompt, with minimal ceremony and a single commit.
  Heir of the chassis (loops/CHASSIS.md + CODE-POLICIES.md). Deltas: no
  plan-doc (the prompt IS the task), git as its only record, an
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
- **Deliverable per task:** edits code in the sources (minimal change) **or** produces a scoped **analysis/design** (non-code deliverable, reported in the conversation — never in `docs/`).
- **NEVER touches `docs/`** (no doc, no auto-export). An analysis/design worth preserving is persisted separately (`/w:persist`) or escalated to SPEC/PLAN (SPEC: live — see *QUICK delta*).

## Run state — git only

QUICK creates no document and stores nothing: the working tree and the commit are its record (spec 066, D01). An interrupted quick is visible only in `git status` of its source; resuming it is reading that state. Research stays **inline** in the conversation.

## Inherits

Read **[`../CHASSIS.md`](../CHASSIS.md)** — the loop's **full engine** — **and** **[`../CODE-POLICIES.md`](../CODE-POLICIES.md)** — the *code-editing loop policies* — **always before** these deltas. *(If `../` does not resolve: same names next to this file — global layout rule, chassis § Reference resolution.)*

## Composes

Git safety, DB scripts-only and inline research are loop rules. Host-native help is optional and does not override them.

## QUICK delta — minimal ceremony

- **No phases, no plan-doc**: the prompt **is** the task (a single unit). No roadmap.
- **Proportional verification-first** (minimal ceremony): even here the check is **seeded before**, sized to the task. Code: it compiles first, then one test (bug repro → fix) or "existing build/lint/tests stay green" (chore). **Analysis/design**: a **short falsifiable rubric**, *ratified by the user* before pursuing it. It is stated in the conversation before the work (see [chassis § *Verification-first*](../CHASSIS.md)).
- **Git and DB inline** (full policies in [`../CODE-POLICIES.md`](../CODE-POLICIES.md)): before editing, verify each source's branch (`aw check-branch`); the commit is `aw flow propose-commit` then `aw flow commit` with the approved digest. To isolate the task, `aw flow unit --quick <slug> --source <alias> [--from <ref>]` creates or finds its worktree; work in a unit or an existing worktree commits with `--checkout <path>`. The AI **never executes DML/DDL**: migrations are drafted as files in `docs/scripts/` (escalating when the task needs a document); fixture/ephemeral checks are local proof and any remote read is research context, never closure.
- **Fix preview, before executing**: declare the fix you are about to make — files to touch, intent, expected shape of the diff. It is **proportional**: one line for something trivial; approach, files and risks for something complex. Above the same signal threshold that fires the entry size gate (below), a person approves it (`Ejecutar tal cual` · `Ajustar el enfoque` · `Escalar a spec` → *Mid-loop escalation*). **Below the threshold there is no human stop**: the preview stays declared in the conversation and the task executes.
- **One task. One commit** proposed at the end (only if there were code changes), **after the validation order** ([`../CODE-POLICIES.md`](../CODE-POLICIES.md) § *Validation order*): it compiles, it runs, the author's own pass over the diff; reviewer agents only when the person accepts them (at most 2, one case each).
- **Entry SIZE GATE** (before implementation): a quick that should have been a spec costs more than the ceremony it saved. Recognize the signals; the threshold, anti-duplicate search and alternatives are the CLI's. A signal resolved by *adopted context* is **not** a signal (chassis § *Adopted context*). A **resume** never re-fires the gate.
  - **`Recortar alcance`**, if chosen: propose the **sub-task that DOES fit** a quick (the sub-task becomes the task; the rest is reported as "trimmed at the gate — may warrant its own spec, `/w:spec-new`").
  - **`Cambiar a SPEC`** ends the quick, preserving its request for *Live transition to SPEC*.
- **Live transition to SPEC** (shared by the gate and mid-loop escalation). On acceptance, the work line **moves to the SPEC flow**: the explicit consent in the structured-choice **equals invoking the destination command** (*consented exception* — rule 3 of the *Continuity rule*, [`../../SKILL.md`](../../SKILL.md) § *Operating context*). On the SPEC side:
  1. **Materialize the draft** via the [`../../commands/spec-new.md`](../../commands/spec-new.md) procedure: `aw next-number docs/specs --publish spec-<slug>.md` with the finished draft on stdin (one atomic act: number assigned, document written, no reservation left), schema, single-pass **NO RESEARCH** — its bounded reconnaissance does **not** re-fire (this run's context arrives adopted). `## Origin` = "escalated from `/w:quick`" + the original prompt. The draft is born `status: draft`: only the SPEC gate promotes it to `ready-for-plan`.
  2. **Load and execute** [`../spec-refine-loop/LOOP.md`](../spec-refine-loop/LOOP.md) — over that spec (trampoline pattern).
  3. The spec's `## Origin` records the escalation. **Invariant 2 intact**: quick, while it is quick, never writes `docs/` — the draft is written by the SPEC flow, post-consent.
- **Mid-loop escalation + handoff**: if the task grows, declare the signals again — the CLI applies the same threshold and, if it fires, asks. If the user accepts moving up:
  1. **Any already-edited code stays** in the working tree (never reverted) and is **reported**: "uncommitted changes in `<source>` — decide commit/discard on resume" (the "rejected commit" pattern of *Safe git*); `git status` keeps it visible.
  2. The report names where the work continues. **SPEC** continues through `/w:spec-new` with the preserved request; **PLAN** stays deferred (seed + pointer, no live entry).
  3. **SPEC enters live**: run the *Live transition to SPEC* (draft **only if no spec exists** for this objective; then the loop). **Asymmetry** intact: PLAN can **absorb** the progress (plan-exec picks up the existing working tree); SPEC **restarts** the design cycle and treats the half-done code as context/reference, never as ingested work.

## Sequence

```
quick-loop(prompt):
  # `Cambiar a SPEC` → live transition (see delta): draft (spec-new procedure) +
  #                    load ../spec-refine-loop/LOOP.md → END
  if the conversation already established analysis/conclusions →                 # adopted context (chassis)
    adopt them — never re-derive/re-ask
  state the deliverable's check  # test(s) if code · short RATIFIED rubric if analysis/design
  work the task (minimal loop):
    if it edits code → aw check-branch per source; mismatch → fix what it names
    declare the fix preview (files · intent · expected diff), proportional to the task
      above the gate's threshold → ask for approval; below it, nothing stops
    produce the deliverable: edit code (minimal change) OR author the analysis/design
    if fixture/ephemeral DB check → run it from the checkout + keep its output
    if DB change (DDL/DML) → a file in docs/scripts/ (DO NOT execute)
    if doubt/gap → inline research, a probe OR structured-choice   # chassis § Proof of concept
    if the task GROWS → declare the signals again; if the user accepts:
        PLAN → handoff (progress stays in the working tree; a seeded plan is proposed)
        SPEC → handoff (progress stays) → live transition (see delta): draft if missing + spec-refine-loop
  convergence gate: run the check and hand back its real output
  if there were code changes:
    validation order (proportional):                         # compiles · runs · own pass over the diff
        targeted review only if the person accepts it           # ≤2 agents, one named case each
        findings → fix (recompile + re-validate) OR report them justified
    aw flow propose-commit → person approves the digest → aw flow commit
  structured_choice(content: [Cerrar tarea, Preguntar algo más], flow: [Compactar, Cerrar])
report: what changed, the check's output and the commit hash (or the uncommitted state)
```

## Convergence / exit

- Before closing, run `aw amend apply … --check` for each spec/plan line known to be outdated. Propose its returned path; never edit without approval.
- Validation order passed and commit made if there was code (or skipping it approved) → `Cerrar`.
- `Cerrar`/`Compactar` (`flow` control) → the working tree stays as it is; `git status` is the resume point.
- **No document**: nothing goes to `docs/` (§ *Writes*); escalating is the only way up.

> QUICK's *convergence gate* is that same **proportional verification-first**: a **short** check declared at start — its minimal version, never the *absence* of a check. Only the **real output** of running it counts; a claim that it passed is not a result.

## Conditional modules

- `resume` — continuity across prompts → `../../modules/PROMPT-CONTINUITY.md`
