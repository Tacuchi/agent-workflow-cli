---
description: Use when a spec draft needs disambiguating before planning — closes the blocking functional gaps and marks it status ready-for-plan. Not the first draft (that is spec-new). Starts or resumes spec-refine-loop over docs/specs/NNN-spec-<slug>.md, in place.
argument-hint: <docs/specs/NNN-spec-<slug>.md>
allowed-tools:
  [
    "Bash",
    "Read",
    "Write",
    "Edit",
  ]
---

# spec-refine — trampoline to the refinement loop

Delegates to `spec-refine-loop` (Layer 2), which iterates, closes the blocking gaps and leaves the spec ready for planning.

> **Minimum context — a guide; only Git/DB is fixed. Read even if nothing else is:**
>
> 1. **Session first** — open or resume the run before working: `aw flow start --flow spec-refine --name <slug> --objetivo "<one-line objective>" --root "${CLAUDE_PLUGIN_ROOT}/skills/w"`; keep its `CHECKPOINT.md` updated (`## Completed` · `## Pending / Next`; `## Open questions` only while live doubts exist).
> 2. **Ask, don't invent** — user-dependent decisions go through questions with a recommended option first (≤3 content questions + the `flow` control `Compactar`/`Cerrar`).
> 3. **Write boundary** — this flow edits only `docs/specs/…` (in place, with confirmation), stamping `status: ready-for-plan` on save; nothing else lands in `docs/`.
> 4. **Language** — everything user-facing (questions, option labels, the doc's content) goes in the **user's language**.
> 5. **Converge, do not close everything** — the target is `ready-for-plan`, not a spec without unknowns: close what can change **what** gets built; hand architecture and implementation questions to `PLAN`, recorded in `## Open questions` with their destination.
> 6. **Shape before gaps** — if the spec must be **split** or **replaced**, ask and resolve that **before** the gap questions, in its own question, and record the answer in `CHECKPOINT`. Never mix it into the gap batch.

## Run the loop

1. Read, in order, the `read_set` entries it returned that are not `loaded`.
2. Follow the loop manual end to end, taking `$ARGUMENTS` as input: it detects state/resume, runs the gap-driven engine, manages sessions, converges and reports.

> `spec-refine-loop` is **not** a skill invocable by name — it is this command's operating manual. The command **is** the entry; the loop is its body.

## More context

`aw context-plan --command spec-refine --signal <s> --root "${CLAUDE_PLUGIN_ROOT}/skills/w"` returns the extra documents a case needs; read exactly what it lists:

- `shape` — the loop's change-shape gate fired and you must tell `split` from `replace` → [`../modules/SPEC-CHANGE-SHAPE.md`](../modules/SPEC-CHANGE-SHAPE.md)
- `resume` — a prior refinement of this spec may exist → [`../modules/SPEC-REFINE-KEYS.md`](../modules/SPEC-REFINE-KEYS.md)
- `web` — the solution space looks unexplored and the loop opens its ideation step → [`../modules/IDEATION-GATE.md`](../modules/IDEATION-GATE.md)
