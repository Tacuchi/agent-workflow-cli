---
name: ui-spec
description: >-
  UI spec authoring — built-in default for the `ui-design` capability. Given a UI
  requirement, author a structured, framework-agnostic screen specification as
  **Markdown** (single output format). Knows the conceptual screen structure, the
  kind/region vocabulary, the authoring rules, design-system / theme / variant
  handling, and the exact Markdown render format. Two landing zones, same render:
  in SPEC (`spec-refine-loop`) it authors the `## UI spec` section of the spec doc;
  in PLAN (`plan-new-loop`/`plan-refine-loop`) it authors per-screen **design
  SPECs** (`NNN-SPEC-<SLUG>.md`) as session artifacts. Use when a loop is refining
  a spec or building/refining a plan that involves screens, forms, dashboards,
  modals or any UI surface.
---

# ui-spec — UI spec authoring

## Role

`ui-design` — this is its **built-in default implementation**. Rebindable in `.workflow/skills.toml` to a third-party skill (installed via skills.sh) or `off`. Resolution: built-in default → `~/.workflow/skills.toml` (global) → `.workflow/skills.toml` (workspace).

## Purpose

Given a UI requirement, author a **structured Markdown description** of the screens and their components — descriptive (what exists and what for) and structured (regions → components, consistent vocabulary), framework-agnostic. The AI authors it **natively**, guided by this skill; there is no endpoint to call. **Single output format: Markdown** (no parallel JSON representation).

## Composed by

Two levels, same capability:

- **`spec-refine-loop`** (see `../../loops/spec-refine-loop/SKILL.md`) — resolving the **UI unspecified** gap (when the requirement involves UI): authors the spec's `## UI spec` section (the UI's *what*, coarse-grain screens).
- **`plan-new-loop` · `plan-refine-loop`** (see `../../loops/plan-new-loop/SKILL.md` § *Delta 4*) — resolving the **UI without design SPEC** gap (when the **plan includes UI**): authors per-screen **design SPECs** (`NNN-SPEC-<SLUG>.md`) as **PLAN session artifacts** (see `../../artifacts/artifacts-design/SPEC.md`); they derive from `## UI spec` when it exists.

In both, the composing loop contributes:

- **Asking the human** (design system, theme, screen ambiguities) via *structured-choice* (canonical rule: `../../loops/CHASSIS.md` § *Structured-choice*; per-harness binding: `../../harness/SKILL.md`).
- **Gap-driven iteration** until convergence.
- Offering **variants** and **curating** the result.

Any loop could compose it; the primary cases are SPEC and PLAN. In SPEC the description lands as a section of the spec document (`docs/specs/NNN-spec-<slug>.md`) — the spec remains a document (invariant 3). In PLAN it lands as **design SPECs** (session artifacts) — which are **not** the requirement-spec: they are the per-screen design detail, process-facing.

## Knowledge

### Conceptual structure (universal, recursive)

A **screen** has: `name`, `type` (semantic purpose: auth, dashboard, form, list, detail, error, …), `platform` (web by default, mobile, …), optional `description`, and **either regions** (complex screen) **or** direct **components** (simple screen) — **never both**.

- A **region** groups components and has a `type`.
- A **component** has a `kind`, and optionally `role`, `label` and `children` (nestable, recursive).

It is a conceptual model to guide authoring; **it is never serialized to JSON** — the only output is the Markdown render (see Output).

- `type` (region) ∈ `header · main · footer · sidebar · filters · summary`
- `kind` (component) by category:
  - **Containers**: `card · panel · modal`
  - **Data**: `table · list · grid`
  - **Visualization**: `chart · metric · badge · image`
  - **Input**: `textInput · select · checkbox · datePicker · toggle`
  - **Actions**: `button · link · actionGroup`
  - **Navigation**: `navBar · tabs · breadcrumb`
  - **Feedback**: `alert · progress`

### Rules

1. **Concise** — only the essential. No filler, no speculative components.
2. Simple screen (login, password recovery, error) → direct `components`, **no** `regions`.
3. Complex screen (dashboard, CRUD maintenance) → `regions` to organize.
4. `role` is **optional** — only when it adds clarity (`role:"logo"`, `role:"primary"`).
5. Limits: **≤100 components**, **≤5 nesting levels**.
6. One screen per `#` block; a multi-screen requirement lists them one after another (each with its own `#`).

### Design options (the loop asks the human)

These options **guide content/labels**; the screen structure is design-system **agnostic** and does NOT carry them in the model. They are **annotated in the spec** (section header):

- **Design system**: `material3 · bootstrap5 · tailwind3 · antDesign · chakraUI · custom`.
- **Theme**: `light · dark · auto`.
- **Language**: `es · en · …` (affects the `label`s — user-facing content follows the user's language).
- **Density** (optional): `compact · comfortable · spacious`.
- **maxWidth** (optional): pixels, 320–3840 (layout annotation).

### Variants

When the requirement admits more than one reasonable layout (e.g. table vs. card grid; tabs vs. accordion), offer **2-3 variants** as alternative Markdown screens and ask the human to pick. The chosen variant is curated and stays; discarded ones are not persisted.

### Disambiguation

Before authoring, resolve ambiguities via *structured-choice* (the loop triggers it):

- Simple or complex screen (does it need `regions`?).
- Which primary/secondary actions exist.
- What data it shows (table, metrics, both).
- Whether there are states (loading, empty, error) the spec must enumerate.

If the human does not answer, assume the simplest case coherent with the description and note the assumption.

### Examples (few-shot; labels in the user's language)

**Simple (no regions)** — `Recuperar Contraseña` (auth, web):

```markdown
# Recuperar Contraseña
**Tipo**: auth | **Plataforma**: web

## Componentes
- **logo** (image)
- **Correo electrónico** (textInput)
- **Enviar enlace** (button)
- **Volver al login** (link)
```

**Complex (with regions)** — "Dashboard" (web):

```markdown
# Dashboard
**Tipo**: dashboard | **Plataforma**: web

## Summary
- **Total** (metric)
- **Pendientes** (metric)

## Main
- **Registros** (table)
```

## Output — two landing zones, one format (Markdown)

**Single output format: Markdown.** The loop writes it (never this skill on its own). The **render is identical** at both levels; what changes is where it lands, per the composing loop:

| Composing loop | Lands in | Grain |
|---|---|---|
| `spec-refine-loop` | the spec's `## UI spec` section (`docs/specs/NNN-spec-<slug>.md`) — document, in place | all the requirement's screens, coarse grain |
| `plan-new-loop` · `plan-refine-loop` | **design SPECs** `NNN-SPEC-<SLUG>.md` — artifacts in the **PLAN session** (one **per screen**, with a trace header; see `../../artifacts/artifacts-design/SPEC.md`) | one screen per file, executable detail |

Head the section (or the SPEC's trace header) with the chosen design options (design system, theme, language) in one line. Then the Markdown render, with these exact rules:

- `# {name}`
- `**Tipo**: {type} | **Plataforma**: {platform}`
- `description` as a separate paragraph (only if present).
- With regions: one `## {Capitalized type}` per region (capitalize the `type`'s first letter).
- Without regions: a single `## Componentes`.
- Each component: `- **{label || role || kind}**`, followed by ` ({kind})` **only if** there was a `label` or `role`.
- `children` indented **2 spaces per level**.
- Multiple screens are listed one after another (each with its own `#`).

## Source

Rationale and history: design (`docs/referencias/workflow-roles/ui-spec.md`).
