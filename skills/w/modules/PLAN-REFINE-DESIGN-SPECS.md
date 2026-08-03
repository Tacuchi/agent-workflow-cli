# PLAN-REFINE-DESIGN-SPECS — design SPECs for the screens a refine touches

Loaded when the refine touches UI (signal `ui`).

> **LEGACY — being retired.** See the banner in [`PLAN-DESIGN-SPECS.md`](PLAN-DESIGN-SPECS.md): the public capability is `design` and its output is the UI Design Package v1; this path names the legacy `ui-spec` skill directly and dies in the last phase of plan 012.

## Delta 4 — Design SPECs (when the refine touches UI)

Same mechanism as [`plan-new-loop`](../loops/plan-new-loop/LOOP.md) (§ *Delta 4*: the legacy `ui-spec` skill → per-screen `NNN-SPEC-<SLUG>.md`, see [`SPEC.md`](../artifacts/artifacts-design/SPEC.md)), **scoped to the delta**: only the screens **new or changed** by the refine get a design SPEC. The updated SPEC is written in **plan-refine's own session** (each loop manages ITS session's artifacts — it never edits plan-new's) and the plan **re-points** the UI Task reference to the current SPEC. Untouched screens keep their original SPEC.
