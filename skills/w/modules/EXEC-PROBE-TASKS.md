# EXEC-PROBE-TASKS — probe (PoC) tasks inside execution

Loaded when the run hits a probe task or a runnable doubt (signal `probe`).

## Delta 7 — Probe (PoC) tasks

Chassis § *Proof of concept (probe)*, instantiated for execution — for a plan's explicit probe task or a runnable doubt inside a task:

- Seed the question + pass/fail check → run **throwaway code in the session folder** (never the source tree, never committed; DB probe = read-only) → verdict in `CONCLUSIONS`, consequences in `DECISION` (tagged by task) → mark the task with its verdict.
- A **failed probe does not fail the phase** — it de-risked it: surface it (structured-choice); reshaping the plan goes to `Open questions` + `BACKLOG` (or `/w:plan-refine`).
- **Promotion**: probe code reaches the sources only as a normal task edit (branch-check + review gate) — never by committing the probe.
