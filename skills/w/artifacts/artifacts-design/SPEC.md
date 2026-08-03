# NNN-SPEC-<SLUG>.md — design SPEC (UI)

> **LEGACY — being retired.** The public design capability is **`design`** ([`roles/design/ROLE.md`](../../roles/design/ROLE.md)), whose only output is the **UI Design Package v1** under `docs/designs/`. This per-screen artifact is **not** that format and **not** produced by that capability: it is the previous path, kept breathing only so no intermediate release leaves the loops without design. It is composed by naming the legacy [`ui-spec`](../../roles/ui-spec/ROLE.md) skill **directly** — `ui-spec` is not bound to `design`, and `ui-design` is no longer a role. Both this artifact and that skill are **retired** in the last phase of plan 012, with no alias, dual-read, importer or migration.

> What it is: the **design specification of ONE screen** (modal, dashboard, form, …), produced when the **plan includes UI**. It is a **session artifact** of the PLAN loops (`plan-new-loop` · `plan-refine-loop`) — process-facing, internal — and `plan-exec-loop` reads it as the **design reference** when implementing the UI tasks.
>
> **It is NOT the spec.** The requirement-spec (`docs/specs/NNN-spec-<slug>.md`) and the plan remain **documents** (invariant 3). The design SPEC is a different thing: the per-screen UI design detail, ephemeral and process-facing, living inside the session. Spelling disambiguates: `SPEC` (UPPERCASE, artifact) vs `spec` (lowercase, document).

## Naming

`NNN-SPEC-<SLUG>.md`, all UPPERCASE (session-artifact convention):

- `NNN` — sequence **local to the session** (001, 002, … in creation order). Numbered by **the loop**; the CLI is not involved (do not confuse with the global session `NNN` from `aw session-create`, nor with `aw next-number` for `docs/`).
- `SLUG` — short screen name in UPPER-KEBAB (`[A-Z0-9-]`, ≤ ~4 words).
- **One screen per file.** Several screens = several SPECs.

Examples: `001-SPEC-MODAL-EXPORT.md` · `002-SPEC-ADMIN-DASHBOARD.md`.

## Schema

Trace header (blockquote) + the [`ui-spec`](../../roles/ui-spec/ROLE.md) Markdown render (same structure, vocabulary and exact render rules; **a single screen**):

```markdown
> Design SPEC · legacy render, generated via the ui-spec skill
> Origin: docs/plans/PPP-plan-<slug>.md (· docs/specs/NNN-spec-<slug>.md § UI spec, if present)
> Design options: material3 · light · es
> Tasks: T3.2 · T3.3

# Modal Export
**Tipo**: modal | **Plataforma**: web

## Componentes
- **Formato** (select)
- **Rango de fechas** (datePicker)
- **Exportar** (button)
- **Cancelar** (link)
```

## Rules

1. Authored by the legacy **`ui-spec`** skill, named directly — **not** resolved through a role, and **not** rebindable: the only rebindable design slot is `design`, which does not produce this format.
2. The **plan-doc references** the path of the governing SPEC (in its UI Tasks / `Solution`): that reference is the **source of truth** for which SPEC governs each screen. A re-refine that changes a screen produces the updated SPEC **in its own session** (each loop manages the artifacts of ITS session) and re-points the plan reference.
3. **Derives** from the spec's `## UI spec` section when present: splits it per screen and elevates it to executable detail; a SPEC↔`## UI spec` contradiction is a **gap** (plan↔spec drift). If the spec has no `## UI spec`, it is authored from the `Requirement` via structured-choice (design system, theme, screen ambiguities).
4. Ephemeral and internal like every artifact: promotion to `docs/` happens **only** via `export-*` (never automatically by the loop).
