# SESSION.md — internal session descriptor (common)

> What it is: the brief descriptor of an **internal session** (Layer 3). Created by a **loop**, not by the user.
> The `Type` is set by the owning loop. Authoritative type catalog: `../README.md` (table "Sessions & their artifacts").

## Objective (text):
What this session resolves: the gap, the question, or the concrete block of work.

## Origin (list):
Who created it and from where:
- Parent loop (e.g. `spec-refine-loop`)
- Source document (e.g. `docs/specs/003-spec.md`)
- Trigger (e.g. gap "Context incomplete")

## Type (text):
Session type, **set by the parent loop** (not the user). Authoritative catalog: `../README.md`.
- `research` — investigate/conclude (read-only); on-demand, **not resumable** (run-and-close)
- `exec` — execute work, one per phase (PLAN)
- `quick` — lightweight execution (≈ `exec`: single session, single commit) (QUICK)
- `refine` / `control` — owns a loop run (SESSION + CHECKPOINT; + BACKLOG on close)

## Components (list):
Projects / systems / sources / databases involved.

## Success criteria (list):
Checklist `[ ]` that, when met, **closes the session and triggers the report** back to the loop.
If NOT met (e.g. research without evidence, DB unavailable): the session **closes anyway with state `inconcluso`** and reports the reason; the parent loop degrades the gap (asks the human or defers to `Open questions`).
