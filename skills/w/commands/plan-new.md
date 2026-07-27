---
description: Use when a spec is ready to become an executable plan — not to refine an existing plan (plan-refine) nor execute one (plan-exec). Starts or resumes the planning loop (plan-new-loop) from a spec. Turns the "what" (spec) into the "how" (plan). Ideal input: an already refined docs/specs/NNN-spec-<slug>.md. Also adopts an externally-built plan (host plan mode, hand-written, another agent) as the plan-doc — mode 4 of its input resolution. May split into sibling plans (split gate).
argument-hint: <docs/specs/NNN-spec-<slug>.md | prompt>
allowed-tools:
  [
    "Bash",
    "Read",
    "Write",
    "Edit",
  ]
---

# plan-new — trampoline to the planning loop

SPEC → PLAN bridge. Turns the "what" (refined spec) into the "how" (plan). Delegates to `plan-new-loop` (Layer 2).

> **Hard floor — applies even if you read nothing beyond this file:**
>
> 1. **Session first** — create/resume the run's session before working: `aw session-create --type refine --name <slug>-plan-new --objetivo "<one-line objective>"`; keep its `CHECKPOINT.md` updated (`## Completed` · `## Pending / Next`; `## Open questions` only while live doubts exist).
> 2. **Ask, don't invent** — user-dependent decisions go through questions with a recommended option first (≤3 content questions + the `flow` control `Compactar`/`Cerrar`).
> 3. **Write boundary** — this flow writes only `docs/plans/…` (with confirmation if it exists); nothing else lands in `docs/`.
> 4. **Language** — everything user-facing (questions, option labels, the plan's content) goes in the **user's language**.

## Input resolution

The skill evaluates `$ARGUMENTS` (specs live in place — `docs/specs/NNN-spec-<slug>.md`; locate via the `docs/specs/NNN-spec-*.md` glob or the exact path):

1. **Ready spec** (`docs/specs/NNN-spec-<slug>.md` whose frontmatter declares `status: ready-for-plan`) → ideal. Proceed straight to `plan-new-loop`.
2. **Spec not ready** (`status: draft` / `refining`, or no mark at all) → **soft-suggest** running `/w:spec-refine` first; planning over a solid spec produces better plans. It is a suggestion, **never a block**: the user may proceed. Questions the spec left with destination `PLAN` are this flow's **input**, not a reason to send it back.
3. **prompt** (no spec referenced) → propose using the SPEC flow; **by default launch `/w:spec-new`** with that prompt to create the draft, and continue the natural flow from there.
4. **External plan content** — the argument/conversation carries an **already-built plan** (host plan mode output, hand-written, another agent's) → **adopt it**. Single pass, **NO RESEARCH**: materialize as `docs/plans/PPP-plan-<slug>.md` (`aw next-number docs/plans`), normalized to the rich-plan schema (`../loops/plan-new-loop/LOOP.md` § *Delta 1*) with only what the source provides. `## Origin` = "adopted from <source>" + attribution (host · model · date). Then offer `/w:plan-refine` (closes schema gaps) or `/w:plan-exec`. Anti-duplicate: a plan whose `## Origin` matches this objective → recommend resuming it, never a second one. Adoption **never regenerates over** an existing plan-doc.

> **Mode 3 vs 4:** a prompt that *describes a wish* → SPEC (mode 3); content that *already is a plan* → adopt (mode 4). Doctrine: `../loops/CHASSIS.md` § *Adopted context*.

> **Ready vs not** is read from the spec's frontmatter `status`, never from the filename (there is no `-refined` anymore). **Legacy compat:** a spec with no frontmatter that carries `## Refinement decisions` — or the older `## Q&A traceability` — counts as ready the same way.

## Run the loop

`plan-new-loop` is **not** a skill invocable by name — it is this command's operating manual (a sibling doc in the bundle). **Load it and execute it end to end**:

1. **Read** `../loops/plan-new-loop/LOOP.md` (inside the installed `w` skill — e.g. `~/.claude/skills/w/loops/…`).
2. **Follow** its instructions taking `$ARGUMENTS` as input (resolved per the 4 rules above): it detects state/resume, runs the gap-driven engine, creates and manages sessions, converges and reports. *(Mode 4 — adoption — is single-pass: materialize + offer the next step; no loop is started.)*

> Do not try `Skill: plan-new-loop` — it is not registered as a skill. The command **is** the entry; the loop is its body.

## Phases are functional states

The plan is born with `### Fn` phases that each leave a **verifiable state of the system** — each with its `> Estado:` line, its primary evidence and its exit condition — never a list of files, classes or layers. The blocks beyond those are **conditional**: a phase with no temporary behavior gets no `Límite de simulación`, and one with nothing excluded gets no `Diferido` — a heading is never written empty to satisfy a template. The plan itself is born `> Estado: open` under the title; only `plan-exec` closes it. Contract: `../loops/plan-new-loop/LOOP.md` § *Phase contract (canonical)*.

## Numbering notes

The plan is named `docs/plans/PPP-plan-<slug>.md`. `aw next-number docs/plans` returns JSON (field `next` = `PPP`); the loop builds the full name (slug = short kebab-case from the Requirement: `[a-z0-9-]`, ≤ ~5 words / ≤ 40 chars). It does **not inherit the spec's `NNN`**. The link to the spec is established by reference (`## Origin` / "Derived from") in the plan, never by number.

## UI → design SPECs

If the plan **includes UI**, the loop composes the `ui-design` capability and produces per-screen **design SPECs** (`NNN-SPEC-<SLUG>.md`) as artifacts of its session — the plan's UI Tasks reference them (see `../loops/plan-new-loop/LOOP.md` § *Delta 4* and `../artifacts/artifacts-design/SPEC.md`).

## Risky assumptions → probe (PoC) tasks

When the plan rests on a runnable unknown (external connection, SDK, UI behavior), the loop encodes an **early probe task** — or runs an inline probe if the solution itself depends on the answer (see `../loops/plan-new-loop/LOOP.md` § *Delta 5*; doctrine: `../loops/CHASSIS.md` § *Proof of concept*).

## Plan mode

The skill resolves the input per the 4 rules above and describes the loop actions it would run (mode 4: the plan-doc it would materialize), without starting the iteration or writing files.

## Resources

- Loop manual: `../loops/plan-new-loop/LOOP.md`
- Design reference: `docs/referencias/workflow-commands/plan-new.md`
