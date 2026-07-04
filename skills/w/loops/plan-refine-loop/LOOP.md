---
name: plan-refine-loop
description: >-
  Refines an existing plan (docs/plans/PPP-plan-<slug>.md) by editing it IN
  PLACE — an auxiliary, NOT mandatory step before plan-exec. Heir of the
  chassis (loops/CHASSIS.md). Deltas: reuses plan-new-loop's gap taxonomy and
  coherence gate, adds Refinement decisions / Q&A traceability (trace, no
  gating), and produces/updates design SPECs via ui-design when the refine
  touches UI. Started by /w:plan-refine; resumable and re-runnable on demand.
  Invoke when an already generated plan must be adjusted before executing it.
---

# plan-refine-loop

> **Heir** of the common chassis — **only** the PLAN-refine deltas live here. The engine is never repeated.

> **Relation to the other PLAN loops:** `plan-new-loop` **generates** the plan from the spec; `plan-refine-loop` **refines it in place** (optional); `plan-exec-loop` **executes it**. plan-refine is to plan-new what spec-refine is to spec-new.

## Flow
PLAN

## Layer
2 — the AI runs it end to end.

## Auxiliary / NOT mandatory
`plan-exec` runs **any** plan, refined or not — there is **no** gate requiring plan-refine. This loop exists to incorporate changes (new requirements, scope adjustments, deps/risks spotted on re-read) **before** executing, without regenerating the plan from scratch.

## Started by
`/w:plan-refine` — **resumable** (same chassis mechanism, keyed off CHECKPOINT) and **re-runnable on demand** (see *Compact / resume*).

## Reads
`docs/plans/PPP-plan-*.md` (glob — locates the plan by number; or the exact path from the command argument). **Always the plan itself**: this loop edits it in place; there is no separate "refined" file.

## Writes
Updates `docs/plans/PPP-plan-<slug>.md` **in place** (when the user picks `Guardar plan refinado`): completes/adjusts sections and **adds** `## Refinement decisions` + `## Q&A traceability`. Since it overwrites an existing doc, it asks the user's **confirmation**. It writes only `docs/plans` — never other `docs/` folders, no auto-export. If the refine **touches UI**, it also produces/updates **design SPECs** (`NNN-SPEC-<SLUG>.md`) as artifacts **of its own session** (see *Delta 4* — they are not `docs/`, no auto-export).

## Inherits

Read **[`../CHASSIS.md`](../CHASSIS.md)** — the loop's **full engine** — **always before** these deltas. *(If `../` does not resolve: `CHASSIS.md` next to this file — global layout rule, chassis § Reference resolution.)*

## Internal sessions — PLAN-refine instance

Full doctrine in the chassis (§ *Internal sessions* + *Numbering*). This loop's instance:

| Session | When | Artifacts | Role |
|---|---|---|---|
| **refine session** `NNN-<slug>-plan-refine/` | when the loop starts (or resumes/reopens) | `SESSION.md` · `CHECKPOINT.md` (· `BACKLOG.md` only if something is deferred) | Owns the run. Type = `refine`; descriptor `<slug>-plan-refine` (the `<slug>` comes from the input plan). |

## Delta 1 — Deliverable: the PLAN, edited in place

The plan uses the **same skeleton** [`plan-new-loop`](../plan-new-loop/LOOP.md) produces (§ *Delta 1 — RICH PLAN*: `Summary`/`Solution`/`Impacted`/`Phases`/`Tasks`/`Validations`/`Final behavior`/… with `(core)` sections always and `(opt.)` by complexity). plan-refine does **not** change the schema: it **completes/adjusts** the existing sections **in place** and **adds** two trace sections:

```markdown
## Refinement decisions   ← NEW (ADDED)
What was adjusted while refining and why (new requirements, scope changes,
deps/risks). Includes what inline research resolved (ref to the session's
CONCLUSIONS).

## Q&A traceability       ← NEW (ADDED)
Every doubt asked to the human + the chosen answer.
```

> **No gating contract** (unlike spec↔plan): the presence of `## Refinement decisions`/`## Q&A traceability` in the plan is **audit trace only** — `plan-exec` neither requires nor checks it (it runs any plan). It serves to (a) distinguish a re-refined plan from a freshly generated one on resume, and (b) record what changed and why.

> The plan **never mutates by execution** (plan-exec tracks that in the plan-doc's Tasks) — only by a (re-)refine.

## Delta 2 — Gap taxonomy (of "plan")

Reuses plan-new-loop's gap taxonomy **in full** ([`plan-new-loop`](../plan-new-loop/LOOP.md) § *Delta 2*): vague Approach/Solution, components unidentified, AS-IS wiring unknown, phase too large, task not atomic, missing deps, spec criteria uncovered, unaddressed risks, UI without design SPEC. **Focus difference:** plan-new **builds** the plan from scratch; plan-refine **detects what changed** against the written plan (or against the spec, if the spec was re-refined) and closes **those** gaps — typically fewer and more localized. One extra re-refine gap:

| Gap | Signal | Resolved by |
|---|---|---|
| Plan↔spec drift | the spec was re-refined and the plan fell out of line | **research** (re-reads the spec) / **human** |

## Delta 3 — What research investigates here

Same as plan-new (maps code/impact: FE/BE/DB components, AS-IS wiring, deps), but **scoped to the delta**: it re-verifies only what the change touches (never re-maps the whole plan). Chassis DB rule unchanged (read-only into `SCRIPTS.sql`, MCP via a question when >1 without default).

## Delta 4 — Design SPECs (when the refine touches UI)

Same mechanism as [`plan-new-loop`](../plan-new-loop/LOOP.md) (§ *Delta 4*: the **`ui-design`** capability → per-screen `NNN-SPEC-<SLUG>.md`, see [`SPEC.md`](../../artifacts/artifacts-design/SPEC.md)), **scoped to the delta**: only the screens **new or changed** by the refine get a design SPEC. The updated SPEC is written in **plan-refine's own session** (each loop manages ITS session's artifacts — it never edits plan-new's) and the plan **re-points** the UI Task reference to the current SPEC. Untouched screens keep their original SPEC.

## Compact / resume — PLAN-refine keys

Full mechanism (3 cases, `Compactar`, re-run with `--reopen`) in the chassis (§ *Compact / resume*). PLAN-refine keys: prior-work mark = `## Refinement decisions` + `## Q&A traceability` **in the plan**; re-refine on demand is **first-class** as many times as needed while the flow stays in PLAN.

> **Inter-turn continuity** (chassis, row 2): a flow command opens a "new work line" (new session) — **except re-running the same flow over the same input** (same plan), which does `create_or_resume` (resumes/reopens instead of duplicating).

## Sequence

```
plan-refine-loop(plan):
  input = glob(docs/plans/PPP-plan-*.md) | argument path       # always the plan itself (in place)
  session = create_or_resume("<slug>-plan-refine")             # reopens if it exists (see Compact / resume)
  seed SESSION.Success criteria = coherence-gate checklist     # verification-first, BEFORE
  work = read(plan) (+ the spec if realignment is needed; + checkpoint progress if resuming)
  repeat:                                                      # chassis engine
    gaps = detect_gaps(work)  (plan-new taxonomy + plan↔spec drift)  minus the exhausted ones
    if gaps == ∅: break
    batch ≤3 → seed CHECKPOINT.Pending/Next → resolve each gap:
      research (scoped to the delta — Delta 3) · human (structured-choice) ·
      ui-design (Delta 4, only new/changed screens)
    integrate + update CHECKPOINT                              # artifact-first cycle
  coherence gate (read-only) = Success criteria green:
    - plan-new checklist (criterion→task · Final behavior · XS–S/XS · deps · Impacted↔Solution · UI→current SPEC)
    - re-refine's own check: the plan is REALIGNED with what changed
    whatever fails → comes back as a gap
  structured_choice(content: [Guardar plan refinado, Preguntar algo más], flow: [Compactar, Cerrar])
  Guardar → edit in place (with confirmation) + insert/update Refinement decisions + Q&A traceability
finalize: CHECKPOINT persisted (+ BACKLOG only if something is deferred) + close session + report
```

## Convergence / exit

- **No material gaps** → **coherence gate** (the *Sequence* checklist; plan-new's gate + the re-refine's own realignment check).
- Passes → `Guardar plan refinado` (edits in place with confirmation) → `finalize`.
- `Cerrar` at any time → `finalize` (persists `CHECKPOINT`; `BACKLOG` only if something is deferred; closes the session, reports).
