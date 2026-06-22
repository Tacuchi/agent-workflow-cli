# CHECKPOINT.md — session resume state (common)

> What it is: the live resume state of a session — lets the loop resume exactly where it left off.
> **Live log (artifact-first):** `Pending`/`Next` = the intent (what is about to be done, seeded BEFORE executing); `Completed` = the result (AFTER). Updated at every gap/phase boundary, not only on `Compactar`/`Cerrar`.
> Owned by: `refine` sessions (and `exec` / `quick` sessions that carry a checkpoint).

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
