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
The run's **done-condition**, seeded at session creation: a checklist `[ ]` of **falsifiable** items. Executable deliverable → runnable tests/checks; non-executable → inspection rubric (the human ratifies it if subjective). Spec/plan sessions may **reference** the doc's acceptance criteria instead of duplicating them. The convergence gate **flips** each criterion to `- [x]` as it turns green — on close the checklist reflects the real final state. Full doctrine: [`../../loops/CHASSIS.md`](../../loops/CHASSIS.md) § *Verification-first*.
