# PLAN-REFINE-DESIGN-SPECS — design SPECs for the screens a refine touches

Loaded when the refine touches UI (signal `ui`).

## Delta 4 — Design SPECs (when the refine touches UI)

Same mechanism as [`plan-new-loop`](../loops/plan-new-loop/LOOP.md) (§ *Delta 4*: the **`ui-design`** capability → per-screen `NNN-SPEC-<SLUG>.md`, see [`SPEC.md`](../artifacts/artifacts-design/SPEC.md)), **scoped to the delta**: only the screens **new or changed** by the refine get a design SPEC. The updated SPEC is written in **plan-refine's own session** (each loop manages ITS session's artifacts — it never edits plan-new's) and the plan **re-points** the UI Task reference to the current SPEC. Untouched screens keep their original SPEC.
