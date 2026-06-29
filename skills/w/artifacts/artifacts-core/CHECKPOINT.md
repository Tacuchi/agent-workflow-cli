# CHECKPOINT.md — session resume state (common)

> What it is: the live resume state of a session — lets the loop resume exactly where it left off.
> **Live log (artifact-first):** `Pending`/`Next` = the intent (what is about to be done, seeded BEFORE executing); `Completed` = the result (AFTER). Updated at every gap/phase boundary, not only on `Compactar`/`Cerrar`.
> Owned by: **every session** (`refine` · `exec` · `quick`). Persisted **always** on close/compact (the resume key — invariant #6), unlike `BACKLOG` which is written only when something is deferred.

## Activity
Summary of the activity done so far.

## Critical context
Key decisions / references to other artifacts or documents needed to continue.

## Completed
Completed phases/tasks (ref: plan-doc `docs/plans/PPP-plan.md`; or `TASKS.md` if the session created its own breakdown).

## Excluded
Excluded phases/tasks (ref: plan-doc; or `TASKS.md`) with reason.

## Pending
Pending phases/tasks (ref: plan-doc; or `TASKS.md`) still to do.

## Next
Next phase/task (ref: plan-doc; or `TASKS.md`) to continue from on resume.
