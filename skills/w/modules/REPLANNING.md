# REPLANNING — re-planning a plan that is already partly executed

Loaded when the plan is already partially executed (signal `replan`).

## Replanning executed work

A partially executed plan is replanned **forward**, never rewritten backwards:

- Phases already `validada` **stay as they are**, and their result becomes the initial state of what follows. Completed tasks are not re-written as if they had never happened.
- Only pending work is re-designed. A `validada` phase that the new shape invalidates gets a **compensating correction** as a new phase — never a silent edit of the closed one.
- **Return from `plan-exec`** (structural deviation — [`plan-exec-loop`](../loops/plan-exec-loop/LOOP.md) § *Deviation gate*): the deviation enters as a **material gap** of this run. Changed input or output, observable state, public contract, participating components, phase order, simulation boundary or integration strategy — all land in `## Refinement decisions` with what execution already proved.
- **Legacy plans** (no phase state, micro-task shape) are migrated to the phase contract when this round touches them: completed tasks preserved, micro-tasks grouped by purpose, results and exit conditions derived from the spec and from the plan itself. Functional evidence that neither backs is **not invented** — it becomes an `## Open questions` entry.
