# DECISION.md — non-obvious decisions log (exec / quick sessions)

> What it is: a log of non-obvious decisions made during an `exec` or `quick` session. Kept per-session so the loop and the human can trace why things were done a certain way.

## Origin
Reference work unit (per the owning loop):
- in `exec` → the Task from the plan-doc (`docs/plans/PPP-plan.md`, e.g. "T2 (F1)")
- in `quick` → the prompt / work unit (no task numbering)

## Decision
Non-obvious decisions. For each: the decision taken, the reason, and the alternatives considered.

> **Local decisions only.** This log records what execution legitimately resolved on its own (naming, a local helper, internal code layout, a refactor that does not move the journey). A **structural deviation** is not settled with an entry here — a changed input or output, observable state, public contract, set of participating components, phase order, simulation boundary or integration strategy **stops execution** and returns to `plan-refine`; a functional change returns to `spec-refine`. See [`plan-exec-loop`](../../loops/plan-exec-loop/LOOP.md) § *Deviation gate*.
