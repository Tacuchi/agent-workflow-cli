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
- `refine` — owns a spec-refine / plan-new loop run (SESSION + CHECKPOINT; + BACKLOG on close)
- `exec` — execute work; a single per-run session (PLAN), not one per phase
- `quick` — lightweight execution (≈ `exec`: single session, single commit) (QUICK)

> `research` is **not** a session type the loops create. Research is an **inline** activity: ANALYSIS-FILE / CONCLUSIONS are written into whatever session is active (`refine`/`exec`/`quick`) when it does investigation.

## Success criteria
Present **only for research** activity (investigate/conclude). It is a checklist `[ ]` that, when met, marks the research as concluded.
If NOT met (e.g. research without evidence, DB unavailable): the research closes as `inconcluso` and reports the reason; the parent loop degrades the gap (asks the human or defers to `Open questions`).
For `exec` / `quick` / `refine` sessions the closing criteria live in the **plan/spec**, not here — omit this section.
