# PLAN-REFINE-KEYS — the compact / resume keys of a plan refinement

Loaded when the run resumes or re-runs a refinement of this plan (signal `resume`).

## Compact / resume — PLAN-refine keys

Full mechanism (3 cases, `Compactar`, re-run with `--reopen`) in the chassis (§ *Compact / resume*). PLAN-refine keys: prior-work mark = `## Refinement decisions` **in the plan** (legacy plans may also carry `## Q&A traceability`); re-refine on demand is **first-class** as many times as needed while the flow stays in PLAN.

> **Inter-turn continuity** (chassis, row 2): a flow command opens a "new work line" (new session) — **except re-running the same flow over the same input** (same plan), which does `create_or_resume` (resumes/reopens instead of duplicating).
