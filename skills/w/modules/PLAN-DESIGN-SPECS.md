# PLAN-DESIGN-SPECS — per-screen design SPECs when the plan includes UI

Loaded when the plan includes UI (signal `ui`).

## Delta 4 — Design SPECs (when the plan includes UI)

The **UI without design SPEC** gap is resolved by **composing** the **`ui-design`** capability (built-in default [`ui-spec`](../roles/ui-spec/ROLE.md); rebindable via `.workflow/skills.toml`; `off` → degrades to human / `Open questions`):

- It authors **one design SPEC per screen** as a session artifact: `NNN-SPEC-<SLUG>.md` (numbering local to the session — see [`SPEC.md`](../artifacts/artifacts-design/SPEC.md)).
- It **derives** from the spec's `## UI spec` section when present (splits it per screen and raises it to executable detail); otherwise it authors from the `Requirement` (design system/theme/ambiguities via *structured-choice*, counts in the batch).
- The plan's **UI Tasks reference** their SPEC's path — that reference is the **source of truth** — and `plan-exec-loop` reads them as the design reference.
- It is the chassis' composed-capability resolution mode (next to *research*, *probe* and *human*).
