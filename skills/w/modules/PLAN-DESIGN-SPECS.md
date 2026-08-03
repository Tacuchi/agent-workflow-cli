# PLAN-DESIGN-SPECS — per-screen design SPECs when the plan includes UI

Loaded when the plan includes UI (signal `ui`).

> **LEGACY — being retired.** The public design capability is **`design`** ([`../roles/design/ROLE.md`](../roles/design/ROLE.md)) and its only output is the **UI Design Package v1**. What this module describes is the previous path: it is composed by naming the legacy `ui-spec` skill **directly**, not by resolving a role — `ui-design` is no longer a role and `ui-spec` is bound to nothing. It stays alive only so no intermediate release leaves the plan loops without design, and is retired in the last phase of plan 012.

## Delta 4 — Design SPECs (when the plan includes UI)

The **UI without design SPEC** gap is resolved by the legacy [`ui-spec`](../roles/ui-spec/ROLE.md) skill, named directly:

- It authors **one design SPEC per screen** as a session artifact: `NNN-SPEC-<SLUG>.md` (numbering local to the session — see [`SPEC.md`](../artifacts/artifacts-design/SPEC.md)).
- It **derives** from the spec's `## UI spec` section when present (splits it per screen and raises it to executable detail); otherwise it authors from the `Requirement` (design system/theme/ambiguities via *structured-choice*, counts in the batch).
- The plan's **UI Tasks reference** their SPEC's path — that reference is the **source of truth** — and `plan-exec-loop` reads them as the design reference.
- It is **not** a composed capability: the chassis' composed-capability mode resolves a role, and this path has none.
