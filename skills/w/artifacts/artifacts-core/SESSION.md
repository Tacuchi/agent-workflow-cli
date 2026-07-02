# SESSION.md — internal session descriptor (common)

> What it is: the brief descriptor of an **internal session** (Layer 3). Created by a **loop**, not by the user.
> The `Type` is set by the owning loop. Authoritative type catalog: `../README.md` (table "Sessions & their artifacts").

## Objective
What this session resolves: the gap, the question, or the concrete block of work.

## Origin
Who created it and from where:
- Parent loop (e.g. `spec-refine-loop`)
- Source document (e.g. `docs/specs/003-spec.md`)
- Trigger (e.g. gap "Context incomplete")

## Type
Session type, **set by the parent loop** (not the user). Authoritative catalog: `../README.md`.
- `refine` — owns a spec-refine / plan-new / plan-refine loop run (SESSION + CHECKPOINT; + BACKLOG on close; + `NNN-SPEC-<SLUG>.md` in PLAN sessions with UI — see [`../artifacts-design/`](../artifacts-design/))
- `exec` — execute work; a single per-run session (PLAN), not one per phase
- `quick` — lightweight execution (≈ `exec`: single session, single commit) (QUICK)

> `research` is **not** a session type the loops create. Research is an **inline** activity: ANALYSIS-FILE / CONCLUSIONS are written into whatever session is active (`refine`/`exec`/`quick`) when it does investigation.

## Success criteria
The run's **done-condition**, seeded when the session is created (**verification-first** — generalized TDD; see [`../../loops/spec-refine-loop/SKILL.md`](../../loops/spec-refine-loop/SKILL.md) § Verification-first): a checklist `[ ]` of **falsifiable** items (that *can* fail) defining "done". The loop **persists until they are all green** (it is the *persistent-objective* condition); `CHECKPOINT.Pending/Completed` tracks the **red→green** progress. Two forms:

- **Executable** (code/script/fix): **runnable** tests/checks (unit, build, lint, bug repro) — literal TDD. May **reference** the repo's tests rather than copy them.
- **Rubric** (analysis/design and other non-executable deliverables): items checked by **inspection** (e.g. "identifies every affected site with `file:line`"; "each decision: rationale + ≥1 alternative"). For **subjective** deliverables the AI **proposes** the rubric and the **human ratifies** it before pursuing it.

> **Spec/plan** may **reference** the document's acceptance criteria instead of duplicating them. **Research** is the original particular case: its checklist marks the research concluded.
> **If an item cannot be met** (no evidence, DB unavailable, irresolvable): it closes as `inconcluso` with a reason and the loop **degrades** (asks the human or defers to `Open questions`/`BACKLOG`) — never spinning in place.
