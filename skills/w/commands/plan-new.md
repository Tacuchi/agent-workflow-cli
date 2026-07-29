---
description: Use when a spec is ready to become an executable plan — not to refine one (plan-refine) nor execute one (plan-exec). Starts plan-new-loop from docs/specs/NNN-spec-<slug>.md, turning the "what" into the "how". Also adopts an externally-built plan. May split into sibling plans.
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

## Run the loop

1. `aw context-plan --command plan-new` — read exactly the documents it lists, in order.
2. Follow the loop manual end to end, taking `$ARGUMENTS` as input (resolved per the module below): it detects state/resume, runs the gap-driven engine, manages sessions, converges and reports.

> `plan-new-loop` is **not** a skill invocable by name — it is this command's operating manual. The command **is** the entry; the loop is its body.

## Phases are functional states

The plan is born with `### Fn` phases that each leave a **verifiable state of the system** — each with its `> Estado:` line, its primary evidence and its exit condition — never a list of files, classes or layers. The blocks beyond those are **conditional**: a phase with no temporary behavior gets no `Límite de simulación`, and one with nothing excluded gets no `Diferido` — a heading is never written empty to satisfy a template. The plan itself is born `> Estado: open`; only `plan-exec` closes it.

## More context

`aw context-plan --command plan-new --signal <s>` returns the extra documents a case needs; read exactly what it lists:

- `input` — the argument is not plainly a `ready-for-plan` spec → [`../modules/PLAN-INPUT.md`](../modules/PLAN-INPUT.md)
- `split` — the spec may need more than one plan → [`../modules/PLAN-SPLIT-GATE.md`](../modules/PLAN-SPLIT-GATE.md)
- `ui` — the plan includes UI, so it composes `ui-design` → [`../modules/PLAN-DESIGN-SPECS.md`](../modules/PLAN-DESIGN-SPECS.md)
- `probe` — the plan rests on a runnable unknown → [`../modules/PLAN-PROBE-TASKS.md`](../modules/PLAN-PROBE-TASKS.md)
