# PLAN-PROBE-TASKS — probes that de-risk a plan early

Loaded when the plan rests on a runnable assumption (signal `probe`).

## Delta 5 — Probe (PoC) tasks — de-risk early

Chassis § *Proof of concept (probe)*, instantiated for planning. Two placements:

- **Plan-shaping unknown** (the `Solution` itself depends on the answer) → run the probe **inline now**; the verdict (`CONCLUSIONS`) feeds `Solution` / `Risks / impact`.
- **Execution-time risk** (a task will build on a risky, runnable assumption) → encode an explicit **probe task**, placed **early** — before the tasks that depend on its verdict; the matching `Risks / impact` entry references it.
