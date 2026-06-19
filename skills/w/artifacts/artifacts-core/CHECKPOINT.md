# CHECKPOINT.md — session resume state (common)

> What it is: the resume state of a session. Written by the loop when the user triggers `Compactar` or `Cerrar`. Allows the loop to resume exactly where it left off.
> Owned by: `refine/control` sessions (and `exec` / `quick` sessions that carry a checkpoint).

## Activity (text):
Summary of the activity done so far.

## Critical context (text):
Critical context / key decisions / references to other artifacts or documents needed to continue.

## Completed (list):
List of completed phases (ref: plan-doc `docs/plans/PPP-plan.md`; or `TASKS.md` if the session created its own breakdown).

## Excluded (list):
List of excluded phases/tasks (ref: plan-doc `docs/plans/PPP-plan.md`; or `TASKS.md`) with reason.

## Pending (list):
List of pending phases (ref: plan-doc `docs/plans/PPP-plan.md`; or `TASKS.md`) still to do.

## Next (text):
Next phase/task (ref: plan-doc `docs/plans/PPP-plan.md`; or `TASKS.md`) to continue from on resume.
