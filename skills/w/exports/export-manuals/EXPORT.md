---
name: export-manuals
description: "Operations / onboarding manuals (operator/support audience). Synthesizes the workspace's technical manuals into `docs/manuals/` consolidating N sessions (`exec`/`quick`) + `docs/`. Reads each session's `DECISION` and the plan-doc (`Solution` — including its Final behavior block —, `Validations`) + the touched code in the sources (how what was built operates/works). Two modes: `complement` (default, overwrites `INDEX.md` pointing at the detected manuals) and `regenerate` (produces a `NNN-export-manuals-YYYY-MM-DD/` dossier with 1 manual per topic). Audience: operators / support / onboarding. Read-only/report: it never commits nor mutates sessions. The prose follows the ambient writing conventions (the host auto-applies an installed writing skill when present). Use for 'operations manual', 'how what we shipped works', 'technical onboarding pack', 'manuals index'. User-invoked via `/w:export-manuals`."
---

# export-manuals — technical manuals from sessions + `docs/`

Generates or refreshes **operations / how-it-works / onboarding** manuals in `docs/manuals/`, consolidating what N sessions delivered + the `docs/` corpus. **Read-only / report** — it never commits, never mutates sessions or code.

> `export-*` family (the only artifact→`docs/` path). Design: `docs/referencias/workflow-exports/export-manuals.md`.

## Category

`docs/manuals` — the **only** `docs/` folder this export writes.

## Writing (ambient convention, not a role)

The manual's prose follows the **ambient** writing conventions: the host auto-applies an installed writing skill (when present) by its `description` — short sentences, lists over prose, no filler, technical lexicon for the operator/support audience. This export does **not** compose or bind a `writing` role; it is **indifferent** to which writing skill exists. A useful family lives in the `dev-conventions` marketplace plugin, but the export does **not depend** on it. Manuals are user-facing deliverables → write them in the user's language.

## When to use

- "Operations manual", "how what we delivered works", "step-by-step guide".
- "Manuals index" / refresh the `INDEX.md` after new sessions.
- **Technical onboarding** pack for new team members.
- Documentation-coverage audit.

## What it does

1. Reads the session corpus (`exec`/`quick`): per session, `DECISION` + the plan-doc (`Solution` — including its Final behavior block; legacy plans: a separate `## Final behavior` section —, `Validations`).
2. Inspects the touched code in the sources (how what was built operates/works) — read-only.
3. Detects topics (declared in `SESSION` — its `## Objective` —, or inferred by operational keywords).
4. Resolves the mode (`complement` or `regenerate`).
5. Synthesizes the content applying the ambient writing conventions (host).
6. Writes: `complement` → overwrites `docs/manuals/INDEX.md`; `regenerate` → a `docs/manuals/NNN-export-manuals-YYYY-MM-DD/` dossier with 1 manual per topic.

## What it does NOT do

- Run commits, merges, push, SQL or send emails.
- Mutate sessions, the plan-doc, or the sources' code (read-only).
- Write any `docs/` folder other than `docs/manuals/` (invariant: one category).
- Overwrite a previous `regenerate` dossier (always next-number).
- Invent manuals: with no detectable topic → in `regenerate` it aborts with a clear message; in `complement` it produces an empty `INDEX.md` with an inline note.
- Visually render diagrams (visual architecture belongs to `export-diagrams`; embedded Mermaid only when it adds value).

## Read-only sandbox

In plan mode it **describes**, never writes: the resolved mode, the detected topics (with origin sessions), the manuals already present in `docs/manuals/`, and — per mode — the `INDEX.md` structure it would overwrite or the count of manuals the dossier would generate. It does **not** run `Write`; numbering queries use `aw next-number --dry-run` (pure).

## Inputs

**`agent-workflow` CLI (alias `aw`)** — never read hardcoded paths:

- `aw release-data [--since sessionNNN] [--source <alias>]` — enumerates the corpus (ALL sessions, closed + active). `aw sessions` alone lists only ACTIVE sessions — never use it as the corpus.
- `aw session-artifacts --code <NNN> --dump objetivo,decisiones` — returns `{path, content, size}` per artifact (`SESSION` with its `## Objective`, `DECISION`); the plan-doc is read by its path.
- `aw next-number docs/manuals` — deterministic numbering (`regenerate` mode only).

**Filesystem**:

- `docs/manuals/*.md` — manuals already present (to complement).
- `docs/manuals/INDEX.md` — re-generable (overwritable) in `complement` mode.
- The declared sources' code — read to describe behavior.

**Args** (no lifecycle *structured-choice*; harness capability — see [`../../harness/HARNESS.md`](../../harness/HARNESS.md)):

```
/w:export-manuals [--sessions NNN[,NNN]] [--since sessionNNN] [--source <alias>]
                  [--mode complement|regenerate] [--topics slug1,slug2] [--dry-run]
```

| Flag | Behavior |
|---|---|
| `--sessions NNN[,NNN]` | Discrete filter by code (takes precedence over `--since`) |
| `--since sessionNNN` | Only sessions after NNN (exclusive: NNN itself is out; use `--sessions` to include it) |
| `--source <alias>` | Limits to one source (multi-source workspace) |
| `--mode complement\|regenerate` | Default `complement` |
| `--topics slug1,slug2` | Limits to the declared topics |
| `--dry-run` | Propositional report, no files written |

No args: `--mode complement` over the whole corpus.

### `--mode` resolution

| Mode | Output | When to use |
|---|---|---|
| `complement` (default) | `docs/manuals/INDEX.md` (overwrites) | Refresh the index after new sessions/manuals |
| `regenerate` | `docs/manuals/NNN-export-manuals-YYYY-MM-DD/` (next-number) | Consolidated manual pack (e.g. onboarding) |

## Flow

### Step 1 — Resolve context and corpus

`aw release-data` applying `--sessions`/`--since`/`--source`. The CLI handles destination-folder resolution.

### Step 2 — Inspect the present manuals

List `docs/manuals/*.md` (excluding `INDEX.md` and `NNN-export-manuals-*/` subdirectories). Per manual: slug (from the filename), title (first `#`), brief summary (first paragraph), path.

### Step 3 — Detect topics

For every filtered corpus session (`aw session-artifacts --code <NNN> --dump objetivo,decisiones`): take the dump's `DECISION` + the plan-doc (`Solution` with its Final behavior block/`Validations`) + the touched code. **Primary** topic: the topic in `SESSION` (its `## Objective`). **Secondary**: inference by operational keywords ("configure", "install", "step by step", "how to …" — in the user's language). Filter by `--topics` when present. List (slug, confidence, origin sessions).

### Step 4 — Synthesize (prose: ambient conventions)

**`complement` mode** — one `INDEX.md`: header + manual count + table (Topic · Slug · Manual present/`[pending]` · Origin sessions) + "Next steps" when there are pending topics.

**`regenerate` mode** — 1 `.md` per topic in the dossier, each with: Purpose · Prerequisites · Numbered steps (how to operate) · Final behavior (from the plan-doc's `Solution`) · Post-use validation · Relevant decisions (`DECISION`) · Troubleshooting · References. Every manual must let the operator complete the task **without** calling the development team. Plus a dossier `README.md` with the index. The prose follows the ambient writing conventions (host).

### Step 5 — Write or report

With `--dry-run`: print the report; write nothing. Otherwise: `complement` → `Write` over `docs/manuals/INDEX.md`; `regenerate` → `aw next-number docs/manuals` + create the dossier. **NEVER commit**. Summary to the user: mode + written paths + counts; if there are detectable topics without a manual, suggest covering them.

## Output location

- `complement`: `docs/manuals/INDEX.md` (overwrites).
- `regenerate`: `docs/manuals/NNN-export-manuals-YYYY-MM-DD/` with `README.md` + 1 `.md` per topic.

## Re-run

- `complement`: idempotent — two invocations over the same corpus produce the same `INDEX.md`.
- `regenerate`: each invocation takes the next `NNN`; it never overwrites previous dossiers.

## Resources

- Design: `docs/referencias/workflow-exports/export-manuals.md` · family: [`../README.md`](../README.md).
- Writing: **ambient** convention (not a role) — the host auto-applies an installed writing skill when present.
- Source artifacts: `DECISION` + plan-doc (see `docs/referencias/workflow-artifacts/artifacts-exec/` and `docs/specs`/`docs/plans`).
- Siblings: [`../export-scripts/EXPORT.md`](../export-scripts/EXPORT.md) · [`../export-diagrams/EXPORT.md`](../export-diagrams/EXPORT.md) · [`../export-reports/EXPORT.md`](../export-reports/EXPORT.md).
