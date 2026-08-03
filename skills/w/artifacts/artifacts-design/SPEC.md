# NNN-SPEC-<SLUG>.md — design SPEC (UI)

> **RETIRED — no loop produces or reads this.** The public design capability is **`design`** ([`roles/design/ROLE.md`](../../roles/design/ROLE.md)), whose only output is the **UI Design Package v1** under `docs/designs/`. The composing loops land `## Design references` and exact roots over that package; **none of them authors a per-screen design SPEC any more**. This schema is documented only so a file written before the change can still be read by whoever finds it. The file itself, and [`ui-spec`](../../roles/ui-spec/ROLE.md), are **deleted** in the last phase of plan 012 — with no alias, dual-read, importer or migration.

> What it *was*: the **design specification of ONE screen** (modal, dashboard, form, …), produced as a **session artifact** of the PLAN loops when the plan included UI, and read by `plan-exec-loop` as the design reference. Everything below describes that historical form in the past tense.
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

1. It **was** authored by the **`ui-spec`** skill, named directly — never resolved through a role. `ui-spec` is bound to nothing and no loop invokes it.
2. The plan-doc **used to reference** the path of the governing SPEC in its UI Tasks. A plan written today pins an **exact root** instead (`DES-001@r4 / SCR-002@r2#empty`), which resolves by identity and digest rather than by a session path that dies with its session.
3. It **used to derive** from the spec's `## UI spec` section. A spec written today keeps `## Design references` and no design at all.
4. It was ephemeral and internal like every artifact. The package that replaced it is the opposite by design: durable, versioned, and living in `docs/designs/` from the moment it is published.
