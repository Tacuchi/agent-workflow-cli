# NNN-SPEC-<SLUG>.md — design SPEC (UI)

> What it is: the **design specification of ONE screen** (modal, dashboard, form, …), produced by composing the **`ui-design`** capability (built-in default [`ui-spec`](../../roles/ui-spec/SKILL.md)) when the **plan includes UI**. It is a **session artifact** of the PLAN loops (`plan-new-loop` · `plan-refine-loop`) — process-facing, internal — and `plan-exec-loop` reads it as the **design reference** when implementing the UI tasks.
>
> **It is NOT the spec.** The requirement-spec (`docs/specs/NNN-spec-<slug>.md`) and the plan remain **documents** (invariant 3). The design SPEC is a different thing: the per-screen UI design detail, ephemeral and process-facing, living inside the session. Spelling disambiguates: `SPEC` (UPPERCASE, artifact) vs `spec` (lowercase, document).

## Naming

`NNN-SPEC-<SLUG>.md`, all UPPERCASE (session-artifact convention):

- `NNN` — sequence **local to the session** (001, 002, … in creation order). Numbered by **the loop**; the CLI is not involved (do not confuse with the global session `NNN` from `aw session-create`, nor with `aw next-number` for `docs/`).
- `SLUG` — short screen name in UPPER-KEBAB (`[A-Z0-9-]`, ≤ ~4 words).
- **One screen per file.** Several screens = several SPECs.

Examples: `001-SPEC-MODAL-EXPORT.md` · `002-SPEC-ADMIN-DASHBOARD.md`.

## Schema

Trace header (blockquote) + the [`ui-spec`](../../roles/ui-spec/SKILL.md) Markdown render (same structure, vocabulary and exact render rules; **a single screen**):

```markdown
> Design SPEC · generated via the ui-design capability
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

1. Authored by the **`ui-design`** capability (rebindable via `.workflow/skills.toml`; `off` → the UI gap degrades to human / `Open questions`, like any disabled capability).
2. The **plan-doc references** the path of the governing SPEC (in its UI Tasks / `Solution`): that reference is the **source of truth** for which SPEC governs each screen. A re-refine that changes a screen produces the updated SPEC **in its own session** (each loop manages the artifacts of ITS session) and re-points the plan reference.
3. **Derives** from the spec's `## UI spec` section when present: splits it per screen and elevates it to executable detail; a SPEC↔`## UI spec` contradiction is a **gap** (plan↔spec drift). If the spec has no `## UI spec`, it is authored from the `Requirement` via structured-choice (design system, theme, screen ambiguities).
4. Ephemeral and internal like every artifact: promotion to `docs/` happens **only** via `export-*` (never automatically by the loop).
