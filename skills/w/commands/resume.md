---
description: Use when the user asks to resume or pick up pending work — a half-done session, a spec to refine, a plan mid-execution. Backed by `aw resume`, which derives the priority, the progress and the exact re-entry command from the Workline index. An artifact argument (spec, plan or session) skips the survey. Transversal (not a flow), read-only; never touches docs/ or .workflow/.
argument-hint: "[docs/specs/… | docs/plans/… | NNN | --code <session>]"
allowed-tools:
  [
    "Bash",
    "Read",
  ]
---

# resume — pick up pending work (transversal)

Single-pass, **read-only**: no loop, no session, writes nothing in `docs/` or `.workflow/`. **Transversal** command (belongs to no SPEC/PLAN/QUICK flow). The actionable sibling of `/w:status`: same index, but it answers *what to pick up* instead of *what exists*.

> **Not `aw session-resume` / `aw resume-summary`.** Those are internal session mechanics (reopen a session; the PostCompact payload). `aw resume` is the user-facing command.

> **Hard floor — applies even if you read nothing beyond this file:**
>
> 1. **Read-only** — never execute the proposed route, with or without an argument. The CLI hands back a command string; the user drives it.
> 2. **Never re-decide** — priority, ties, the spec→plan relation and the exact command come from the CLI. Do not re-sort by date, do not associate a session to a plan by slug, do not pick a winner the CLI left tied.
> 3. **Ask via structured-choice** when the CLI returns candidates, never otherwise.
> 4. **Language** — user-facing output in the **user's language**.

## Run

1. Run `aw resume --format human`, forwarding the argument when there is one:
   - a doc path or number → pass it as the positional (`aw resume docs/plans/009-plan-x.md`);
   - a session → `aw resume --code <NNN | folder>`;
   - nothing → no argument, and the CLI walks the pipeline.
2. **Relay the output verbatim.** It already carries the objective, the progress or checkpoint, the next pending step or blocker, and the exact command.
3. **When the CLI returns candidates**, present them as a structured-choice, one option per candidate, in the order given — the CLI declares a tie precisely because there is no correct automatic winner. Add the `flow` control. Never break the tie yourself.
4. **When it returns nothing pending**, say so and stop. Do not ask.
5. **Host context (optional).** If nothing is pending at the Workline level and the host exposes cheap host-memory ([`../harness/HARNESS.md`](../harness/HARNESS.md) § *host-memory*), you may add a short note about recent focus. Never expensive, never blocking.

## What the CLI decides (do not re-derive)

- **Priority**: spec sin refinar → spec `ready-for-plan` sin plan → plan incompleto → checkpoint no asociado. Within plans, one already started outranks an untouched one.
- **Ties**: same priority and same progress → candidates. Date and age never break a tie.
- **The spec→plan relation**: proven by the plan's `Derived from` header, an explicit spec path in its `## Origin`, or an unambiguous `Spec NNN` there — never by slug. A plan whose provenance is unproven leaves its spec visible as still unplanned.
- **The route**: `/w:spec-refine`, `/w:plan-new`, `/w:plan-exec`, or `aw session-resume --reopen`, with the path already filled in.

> A plan is not finished because its boxes are ticked. `aw resume` re-enters at the first phase that is not `validada`, reports a `bloqueada` phase with its declared reason, and, when everything is green but the plan never closed, says the final validation is what remains. A plan that declares `done` over open work comes back as inconsistent — repair before implementing.

## Plan mode

Read-only already: run `aw resume --format human` and describe the proposal (and the choice it would offer), without asking or writing.

## Resources

- CLI: `aw resume` (service `resume-service` over `workline-index-service`) · sibling `aw status`
- Session mechanics: `aw session-resume --code <NNN> [--reopen]` · `aw resume-summary`
- Continuity rule: [`../SKILL.md`](../SKILL.md) § *Operating context*
- Design reference: `docs/referencias/workflow-skills/resume.md`
