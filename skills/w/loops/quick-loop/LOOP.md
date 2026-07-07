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

- **No phases, no plan-doc**: the prompt **is** the task (a single unit). No roadmap.
- **Proportional verification-first** (minimal ceremony): even here the check is **seeded before**, sized to the task. Code: one test (bug repro → fix) or "existing build/lint/tests stay green" (chore). **Analysis/design**: a **short falsifiable rubric**, *ratified by the user* before pursuing it. It is the run's `SESSION.Success criteria` (see [chassis § *Verification-first*](../CHASSIS.md)).
- **Git and DB inline** (full policies in [`../CODE-POLICIES.md`](../CODE-POLICIES.md)): before editing, verify each source's expected branch (`aw check-branch`); **proposed** commit (approve first) — never `push`/`--amend`/`--no-verify`. The AI **never executes DML/DDL**: migrations are drafted into the session's `SCRIPTS.sql` (read-only queries do run, via MCP).
- **One session. One commit** proposed at the end (only if there were code changes), **after the proportional closing review gate** ([`../CODE-POLICIES.md`](../CODE-POLICIES.md) § *Closing review gate*): diff re-read + ambient conventions; fix or defer; nothing reaches the commit unreviewed.
- **Entry SIZE GATE** (before creating the session): on receiving the objective, evaluate whether it **exceeds a quick**. It fires **only on clear signals** (≥2 of: needs architecture · ≥2 sources · multiple deliverables · large feature/refactor · ambiguous requirements needing elicitation); signals already resolved by *adopted context* do **not** fire (e.g. a host pre-analysis in this conversation that removed the ambiguity — chassis § *Adopted context*); borderline → **continue in quick without asking** (if it later grows, mid-loop escalation covers it). A **resume** of an existing quick does **not** re-fire the gate. If it fires → **structured-choice** (1 content question, recommendation first + `flow` control; `Cerrar` here = abort, nothing created yet):
  - **`Cambiar a SPEC`** (recommended) → **no quick session is created**: run the *Live transition to SPEC* (next bullet).
  - **`Seguir en quick`** → continue normally (`create_or_resume` + loop).
  - **`Recortar alcance`** → the AI proposes the **sub-task that DOES fit** a quick; the loop continues with it (`SESSION.Objective` = the sub-task; the original prompt goes into the session's `## Origin`) and the rest is deferred to `BACKLOG` ("trimmed at the gate — may warrant its own spec, `/w:spec-new`").
  - **Anti-duplicate** (the `create_or_resume` spirit): if a spec whose `## Origin` references this same objective already exists (or an equivalent `*-spec-refine` session), the recommended option becomes **resuming that spec** (`/w:spec-refine` semantics) — never a second draft.
- **Live transition to SPEC** (shared by the gate and mid-loop escalation). On acceptance, the work line **moves to the SPEC flow**: the explicit consent in the structured-choice **equals invoking the destination command** (*consented exception* — rule 3 of the *Continuity rule*, [`../../SKILL.md`](../../SKILL.md) § *Operating context*). On the SPEC side:
  1. **Materialize the draft** via the [`../../commands/spec-new.md`](../../commands/spec-new.md) procedure: `aw next-number docs/specs`, slug, schema, single-pass **NO RESEARCH**. `## Origin` = "escalated from `/w:quick`" + the original prompt (+ the origin quick session if it exists).
  2. **Load and execute** [`../spec-refine-loop/LOOP.md`](../spec-refine-loop/LOOP.md) — over that spec (trampoline pattern).
  3. The run's session is that loop's **normal** `NNN-<slug>-spec-refine` (the CLI numbers it; its `## Origin` records the escalation). **Invariant 2 intact**: quick, while it is quick, never writes `docs/` — the draft is written by the SPEC flow, post-consent.
- **Mid-loop escalation + handoff**: if the task grows (same gate signals) → propose moving up to **SPEC/PLAN** (structured-choice, recommendation first). If the user accepts:
  1. The **already-edited code stays** in the working tree (never reverted) and is **recorded** in `CHECKPOINT` + `BACKLOG`: "uncommitted changes in `<source>` — decide commit/discard on resume" (the "rejected commit" pattern, [`../CODE-POLICIES.md`](../CODE-POLICIES.md) § *Safe git*).
  2. The quick session goes to `finalize` with the **pointer** in `BACKLOG`: to **PLAN** → "escalated to `docs/plans/PPP` — resume there" (**deferred** as today: seed + pointer, no live entry); to **SPEC** → "escalated to `docs/specs/NNN` — **continued live** (session `NNN-<slug>-spec-refine`)".
  3. The artifacts (`DECISION`, `SCRIPTS.sql`) **stay in the quick session** as referenceable context for the new session (never migrated).
  4. **SPEC enters live**: after `finalize`, run the *Live transition to SPEC* (draft **only if no spec exists** for this objective; then the loop). **Asymmetry** intact: PLAN can **absorb** the progress (plan-exec picks up the existing working tree); SPEC **restarts** the design cycle and treats the half-done code as context/reference, never as ingested work.

## Continuity across prompts (operating context)

`quick` is where the **continuity rule** ([`../../SKILL.md`](../../SKILL.md) § *Operating context*) shows most clearly. Inside a workspace:

1. `/w:quick "first prompt"` (**command**) → creates session `NNN-<slug>-quick`, starts the loop. Scripts go to **its** `SCRIPTS.sql`.
2. `"second prompt"` (**no command**, related work) → does **not** create another session: **continues/reopens the most recent one** (from step 1) and appends the new scripts to **that same** `SCRIPTS.sql`.
3. `/w:quick "third prompt"` (**command** again) → **new** session, new loop.

> The **command** signals "new work line"; a **bare prompt** means "same line" → by default continue/reopen the most recent session (the *last started*). Clearly unrelated → offer choosing (`continuar NNN` | `trabajo nuevo`) or fall to the **no-flow** branch (write into `docs/` by convention + numbering). No workspace → **vanilla** behavior.

## Sequence

```
quick-loop(prompt):
  # SIZE GATE — BEFORE creating a session; new work lines only (a resume does not re-fire it)
  if the objective exceeds a quick (≥2 clear signals — see delta):
    if a spec / spec-refine session for this objective already exists → recommend RESUMING it (/w:spec-refine)  # anti-duplicate
    structured_choice(content: [Cambiar a SPEC (recommended), Seguir en quick, Recortar alcance],
                      flow: [Compactar, Cerrar])           # Cerrar here = abort (nothing created yet)
    Cambiar a SPEC   → live transition (see delta): draft (spec-new procedure) +
                       load and execute ../spec-refine-loop/LOOP.md → END (no quick session)
    Recortar alcance → objective = the proposed sub-task; the rest → BACKLOG when the session is created
    Seguir en quick  → continue
  s = create_or_resume("<slug>-quick")      # CLI prepends global NNN; always a light session
  seed SESSION.Objective = the prompt
  if the conversation already established analysis/conclusions →                 # adopted context (chassis)
    adopt them (SESSION.Origin = "adopted from host conversation"; reference in CONCLUSIONS) — never re-derive/re-ask
  seed SESSION.Success criteria = the deliverable's check   # verification-first, BEFORE: test(s) if code · short RATIFIED rubric if analysis/design
  seed CHECKPOINT.Pending/Next = the task (s)               # BEFORE: seed the intent (artifact-first)
  work the task (minimal loop):
    if it edits code → verify each source's expected branch (`aw check-branch`); mismatch → pause + resolve
    produce the deliverable: edit code (minimal change) OR author the analysis/design
    if read-only DB query → SCRIPTS.sql + execute read-only
    if DB change (DDL/DML) → SCRIPTS.sql (session artifact, DO NOT execute)
    if non-obvious decision → DECISION
    if doubt/gap → inline research OR structured-choice      # chassis
    if the task GROWS → propose escalating to SPEC/PLAN      # structured-choice, recommendation first
        accepts PLAN → handoff (progress stays; BACKLOG→seeded plan — resume there, deferred) → goto finalize
        accepts SPEC → handoff (progress stays; BACKLOG→"continued live") → finalize →
                       live transition (see delta): draft if missing + spec-refine-loop
  convergence gate: Success criteria green                   # tests green if code · rubric satisfied if analysis/design
  if there were code changes:
    closing review gate (proportional):                      # diff re-read + installed ambient conventions
        findings → fix (re-validate) OR defer justified (BACKLOG)
    propose commit (approve first)                           # never push/amend/--no-verify; only after the gate
  structured_choice(content: [Cerrar tarea, Preguntar algo más], flow: [Compactar, Cerrar])
finalize: CHECKPOINT (AFTER: Pending→Completed) + BACKLOG (only if something is deferred) + close session + report
```

## Convergence / exit

- **Success criteria green** (proportional) + closing review gate passed and commit proposed if there was code (or skipping it approved) → `Cerrar`.
- `Cerrar`/`Compactar` (`flow` control) → persists `CHECKPOINT` + `BACKLOG` (resumable).
- **No export**: nothing goes to `docs/`. Anything worth preserving → promoted separately via `export-*`, or escalated (to SPEC **live** — the line continues in spec-refine already as SPEC flow; to PLAN **deferred**, seed + pointer).

> QUICK's *convergence gate* is **proportional verification-first**: a **short** `Success criteria` seeded at start (not the *absence* of a checklist — its minimal version) — for code, "the change does what the prompt asked + tests/build green"; for analysis/design, a short ratified rubric. Minimal ceremony by design, but **always with the check declared first**.
