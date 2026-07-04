---
name: export-diagrams
description: "Generates the workspace's architecture and flow diagrams in `docs/diagrams/` consolidating the sources' code + the plan-doc (`Current state (AS-IS)` / `Target state (TO-BE)`, `Impacted`) of N sessions. Produces context, containers, components, integrations and data model (when read-only MCP is available). Default `mermaid` (renders on GitHub, `mermaid.ink` link for preview); `c4`/structurizr opt-in via `--engine`. Output in `docs/diagrams/NNN-export-diagrams-YYYY-MM-DD/` (or `.md`). Read-only/report: emits only the diagram source (the reader renders it); never commits nor mutates anything; MCP reads only. Composes the `diagrams` capability. Use for 'system diagram', 'workspace C4', 'architecture/flow map'. User-invoked via `/w:export-diagrams`."
---

# export-diagrams — architecture and flow diagrams from code + plan-doc

Generates a diagram dossier (**architecture and flows**) of the workspace, aggregating the sources' structure and the sessions' delta. **Read-only / report** — it emits only the diagram **source** (Mermaid / DSL); the reader renders it. It never commits, never mutates anything; MCP reads only.

> `export-*` family (the only artifact→`docs/` path). Design: `docs/referencias/workflow-exports/export-diagrams.md`.

## Category

`docs/diagrams` — the **only** `docs/` folder this export writes.

## Composes

The **`diagrams`** capability (built-in default `diagrams`), resolved via `.workflow/skills.toml`. It contributes the render engine (native Mermaid C4 / Structurizr DSL), the C1–C4 levels and the preview-link convention. This export does **not** own that logic: it composes it. Rebindable or `off` by config.

## When to use

- "System diagram", "workspace C4", "architecture map".
- "Flow diagram" across touched components / integrations.
- Technical onboarding; before structural changes (validate the current architecture); technical audit.

## What it does

1. Inspects the workspace sources' code (structure, wiring, integrations, technologies).
2. Reads the plan-doc from the sessions: `Current state (AS-IS)` / `Target state (TO-BE)` and `Impacted` (what changed and where).
3. (Optional) With read-only MCP available and a data-model request: queries DB schemas (reads only).
4. Resolves the engine (`--engine`) and consolidates the architecture/flows touched by the N sessions.
5. Renders the diagrams (composes `diagrams`): context, containers, components, integrations, data model (when it applies).
6. Writes the dossier to `docs/diagrams/NNN-export-diagrams-YYYY-MM-DD/` with a `README.md` (index + how to read).

## What it does NOT do

- Run commits, merges, push, or SQL.
- Mutate sessions, the plan-doc or the code (read-only). MCP **reads only** (never DML/DDL).
- Write any `docs/` folder other than `docs/diagrams/` (invariant: one category).
- **Visually render** the diagram: it emits only the source (Mermaid / DSL); the reader renders with their tools (or the `mermaid.ink` link).
- Validate that the integrations work (that is doctor work) or invent absent components.
- Overwrite previous dossiers (always next-number).

## Read-only sandbox

In plan mode it **describes**, never writes: the resolved engine, the levels/sections that would appear (resolved by args), the sources to inspect + detected integrations, and — with a data-model request — the proposed MCP queries with their estimated cost. It does **not** run `Write` or MCP mutations; numbering queries use `aw next-number --dry-run` (pure).

## Inputs

**`agent-workflow` CLI (alias `aw`)** — never read hardcoded paths:

- `aw sessions` / `aw release-data [--since sessionNNN] [--source <alias>]` — enumerates the corpus (input for the AS-IS/TO-BE delta).
- `aw session-artifacts --code <NNN> --dump objetivo` — locates the session and its plan-doc reference; `AS-IS`/`TO-BE`/`Impacted` are read from the plan-doc by its path.
- `aw next-number docs/diagrams` — deterministic numbering (the CLI handles destination-folder resolution).

**Filesystem / code**:

- The declared sources' code (structure, wiring, technology manifests).
- Existing `docs/diagrams/` (to complement / avoid collisions).

**Read-only MCP** (optional, only with a data-model request and configuration): `\d <table>`, `SELECT count(*)`, FK relations for the `erDiagram`. With the cost guard.

**Args** (no lifecycle *structured-choice*; harness capability — see [`../../harness/SKILL.md`](../../harness/SKILL.md)):

```
/w:export-diagrams [--sessions NNN[,NNN]] [--since sessionNNN] [--source <alias>]
                   [--engine mermaid|c4] [--scope c4|integrations|data|todo] [--dry-run]
```

| Flag | Behavior |
|---|---|
| `--sessions NNN[,NNN]` | Discrete filter by code (takes precedence over `--since`); affects the AS-IS/TO-BE delta |
| `--since sessionNNN` | Only sessions after NNN (exclusive: NNN itself is out; use `--sessions` to include it) |
| `--source <alias>` | Limits to one source (multi-source workspace) |
| `--engine mermaid\|c4` | Default `mermaid` (renders on GitHub); `c4` = opt-in Structurizr DSL |
| `--scope` | Which sections appear: `c4` (context/containers/components), `integrations`, `data` (only with MCP), `todo` (default: all) |
| `--dry-run` | Propositional report, no files written |

No args: `--engine mermaid --scope todo`. The system **snapshot** is always the last known state; `--since`/`--sessions` modulate the delta emphasis (what was touched), not the base snapshot.

## Flow

### Step 1 — Resolve context and corpus

`aw sessions` / `release-data` applying `--sessions`/`--since`/`--source`. The CLI handles destination-folder resolution.

### Step 2 — Inspect the sources

Per source: basic structure, internal components (modules, services, commands, hooks, configured MCP), technologies per manifest (`package.json`, `pom.xml`, …), external integrations.

### Step 3 — Read the corpus delta

Per filtered session (`aw session-artifacts --code <NNN> --dump objetivo`): follow the plan-doc reference and read `Current state (AS-IS)` / `Target state (TO-BE)` and `Impacted`. Used to highlight what changed over the current snapshot.

### Step 4 — Inspect MCP (optional)

If `--scope` includes `data` and read-only MCP exists: `\d <table>`, `count(*)`, FK relations (with the cost guard). Not available → omit the "Data model" section with an inline note.

### Step 5 — Render (composes `diagrams`)

Per `--engine`: `mermaid` → native Mermaid C4 blocks (`C4Context`/`C4Container`/`C4Component`) and `flowchart` for flows; `c4` → a separate Structurizr `workspace.dsl` + auxiliary embedded Mermaid for offline reading. For every ```` ```mermaid ```` block, add immediately after the closing fence a blockquote with the preview link: `> Ver diagrama renderizado: <https://mermaid.ink/img/BASE64>` (URL-safe base64 of the plain code). Not applicable to `workspace.dsl`.

### Step 6 — Write or report

With `--dry-run`: print the report; write nothing. Otherwise: `aw next-number docs/diagrams` + write the dossier. **NEVER commit**. Summary to the user: engine, present/omitted sections (e.g. Data omitted without MCP) and the path.

## Output location

```
docs/diagrams/NNN-export-diagrams-YYYY-MM-DD/
├── README.md          # index + how to read + counts
├── diagrams.md        # main document with embedded Mermaid (+ mermaid.ink links)
└── workspace.dsl      # only with --engine c4 (Structurizr)
```

## Re-run

Functionally idempotent: each invocation takes the next `NNN`; it never overwrites previous dossiers. To regenerate: delete the directory and re-invoke.

## Resources

- Design: `docs/referencias/workflow-exports/export-diagrams.md` · family: [`../README.md`](../README.md).
- Composed capability: `diagrams` (built-in default; see `docs/referencias/workflow-roles/`).
- Input: plan-doc `AS-IS`/`TO-BE`/`Impacted` (see `docs/plans`).
- Siblings: [`../export-scripts/SKILL.md`](../export-scripts/SKILL.md) · [`../export-manuals/SKILL.md`](../export-manuals/SKILL.md) · [`../export-reports/SKILL.md`](../export-reports/SKILL.md).
