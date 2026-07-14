# SESSION.md — internal session descriptor (common)

> What it is: the brief descriptor of an **internal session** (Layer 3). Created by a **loop**, not by the user.
> The session **type** is normally not rendered: a loop descriptor ends in `<slug>-<flow>`, so the type is derivable from the folder name (the loop still passes `--type` to `aw session-create`). Authoritative type catalog: `../README.md` (table "Sessions & their artifacts").

## Objective
What this session resolves: the gap, the question, or the concrete block of work.

## Origin
Who created it and from where:
- Parent loop (e.g. `spec-refine-loop`)
- Source document (e.g. `docs/specs/003-spec.md`)
- Trigger (e.g. gap "Context incomplete")

## Type
**Only when the folder name does not encode it** (a free-form descriptor with no `<slug>-<flow>` suffix). Loop sessions omit this heading — their name carries the flow.

> `research` is **not** a session type the loops create. Research is an **inline** activity: ANALYSIS-FILE / CONCLUSIONS are written into whatever session is active (`refine`/`exec`/`quick`) when it does investigation.

## Success criteria
The run's **done-condition**, seeded at session creation: a checklist `[ ]` of **falsifiable** items. Executable deliverable → runnable tests/checks; non-executable → inspection rubric (the human ratifies it if subjective). Spec/plan sessions may **reference** the doc's acceptance criteria instead of duplicating them. The convergence gate **flips** each criterion to `- [x]` as it turns green — on close the checklist reflects the real final state. Full doctrine: [`../../loops/CHASSIS.md`](../../loops/CHASSIS.md) § *Verification-first*.
