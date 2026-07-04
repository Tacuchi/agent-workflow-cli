---
name: export-reports
description: "Executive/functional report (management/committee audience) consolidating N workspace sessions under `docs/reports/NNN-<slug>-YYYY-MM-DD.md`. Reads the corpus: the spec (`docs/specs`), `CONCLUSIONS` (research), `DECISION`, the plan-doc state + the rest of `docs/` for context. Synthesizes: what was done, key decisions, results/conclusions, pending/roadmap — with cross-session recommendation dedup. Audience adjustable via `--audience` (gerencia ≈ short; tecnica ≈ detailed). Read-only/report: it never commits nor mutates sessions. The prose follows the ambient writing conventions (the host auto-applies an installed writing skill when present). Use for 'executive report', 'what got done this quarter for management', 'brief with consolidated recommendations'. User-invoked via `/w:export-reports`."
---

# export-reports — executive/functional report from the session corpus + `docs/`

Generates a single `.md` consolidating N workspace sessions into an **executive/functional** report: what was done, key decisions, results/conclusions and pending/roadmap. **Read-only / report** — it never commits, never mutates sessions or the corpus.

> `export-*` family (the only artifact→`docs/` path). It **merges** two legacy exports into one `docs/reports` output: the executive report and the cross-session recommendation dedup. Design: `docs/referencias/workflow-exports/export-reports.md`.

## Category

`docs/reports` — the **only** `docs/` folder this export writes.

## Writing (ambient convention, not a role)

The report's prose follows the **ambient** writing conventions: the host auto-applies an installed writing skill (when present) by its `description` — technical→executive translation, per-audience length cap, short sentences, lists over prose, no filler. This export does **not** compose or bind a `writing` role. Reports are user-facing deliverables → write them in the user's language.

## When to use

- "Executive report", "functional document", "what got done this quarter for management".
- A brief with the **consolidated** (deduplicated) recommendations of the last N sessions.
- Re-generate after a new period (month / quarter); before a follow-up committee.

## What it does

1. Reads the filtered session corpus: the spec (`docs/specs`), `CONCLUSIONS` (research), `DECISION`, the plan-doc state.
2. Reads the rest of `docs/` (specs, plans, previous reports) for context.
3. Resolves the audience/length (`--audience`).
4. Synthesizes: Executive summary · What was done (grouped by business capability, not by session) · Key decisions · Results/conclusions · Pending/Roadmap.
5. **Deduplicates** the recommendations (R-items) cross-session by slug, annotating the origins.
6. Writes `docs/reports/NNN-<slug>-YYYY-MM-DD.md`.

## What it does NOT do

- Run commits, merges, push, SQL, emails or PR creation.
- Mutate sessions, the corpus or the plan-doc (read-only).
- Write any `docs/` folder other than `docs/reports/` (invariant: one category).
- Invent achievements, metrics or recommendations: conditional sections (e.g. "Improvement opportunities"/Roadmap) appear **only** when the corpus has detectable open items.
- Generate advanced technical diagrams (extensive C4/erDiagram) — those live in `export-diagrams`; here, at most a simple executive-synthesis `flowchart LR`.
- Overwrite previous reports (always next-number).

## Read-only sandbox

In plan mode it **describes**, never writes: the resolved audience/length, the corpus sessions that would enter after the filters, the sections that would appear, the R-items that would consolidate (and detected conflicts), and the estimated length. It does **not** run `Write`; numbering queries use `aw next-number --dry-run` (pure).

## Inputs

**`agent-workflow` CLI (alias `aw`)** — never read hardcoded paths:

- `aw release-data [--since sessionNNN] [--source <alias>]` — enumerates + filters the corpus (ALL sessions, closed + active, with `release_eligible`). `aw sessions` alone lists only ACTIVE sessions — never use it as the corpus.
- `aw session-artifacts --code <NNN> --dump objetivo,conclusiones,decisiones` — returns `{path, content, size}` for `SESSION` (referenced spec), `CONCLUSIONS` and `DECISION`; the plan-doc state is read by its path.
- `aw next-number docs/reports` — deterministic numbering (the CLI handles destination-folder resolution).

**Filesystem**:

- `docs/specs`, `docs/plans`, `docs/reports/*` — context + collision avoidance.

**Args** (no lifecycle *structured-choice*; harness capability — see [`../../harness/SKILL.md`](../../harness/SKILL.md)):

```
/w:export-reports [--sessions NNN[,NNN]] [--since sessionNNN] [--source <alias>]
                  [--audience gerencia|tecnica] [--slug <kebab>] [--dry-run]
```

| Flag | Behavior |
|---|---|
| `--sessions NNN[,NNN]` | Discrete filter by code (takes precedence over `--since`) |
| `--since sessionNNN` | Only sessions after NNN (exclusive: NNN itself is out; use `--sessions` to include it) |
| `--source <alias>` | Limits to one source (multi-source workspace) |
| `--audience gerencia\|tecnica` | Modulates length/lexicon: `gerencia` ≈ short/executive; `tecnica` ≈ detailed |
| `--slug <kebab>` | Filename slug override (default: `export-reports`) |
| `--dry-run` | Propositional report, no writing |

No args: the whole corpus, executive audience by default.

## Flow

### Step 1 — Resolve context and filter the corpus

`aw release-data` applying `--sessions`/`--since`/`--source`. If the resulting set is empty → **abort** with an explicit message (no sessions in the declared range). The CLI handles destination-folder resolution.

### Step 2 — Collect per-session inputs

Per filtered session (`aw session-artifacts --code <NNN> --dump objetivo,conclusiones,decisiones`): the referenced spec (what was posed), `CONCLUSIONS` (technical close / R-items), `DECISION` (what was decided), the plan-doc state (what shipped / what remains). Also collect the impacted components (touched sources) for the synthesis table.

### Step 3 — Recommendation dedup (cross-session)

Extract the R-items from `CONCLUSIONS`/`DECISION` (pending, deferred, "next steps"). Group by slug; merge duplicates annotating `origins[]`; if two same-slug R-items contradict each other, mark them as a conflict for explicit resolution. Do **not** dedup the C-items (they are analysis-specific: preserved with traceability).

### Step 4 — Synthesize (prose: ambient conventions)

Render applying the ambient writing conventions (host): Executive summary · What was done (grouped by business capability, **not** by session) · Impacted components (table) · Key decisions · Results/conclusions · Pending/Roadmap (only with R-items). Technical→executive translation and length cap per `--audience`. Optional: a simple synthesis `flowchart LR` (inline; a `mermaid.ink` link is OPTIONAL — it encodes the diagram source into a public-service URL, omit it for private corpora); the detailed technical diagram belongs to `export-diagrams`.

### Step 5 — Write or report

`aw next-number docs/reports` → `docs/reports/NNN-<slug>-YYYY-MM-DD.md`. With `--dry-run`: print; write nothing. **NEVER commit**. Summary to the user: path, audience/length, covered sessions (count + range), consolidated R-items, and a note if a conditional section was omitted.

## Output location

`docs/reports/NNN-<slug>-YYYY-MM-DD.md` (default slug `export-reports`).

## Re-run

Functionally idempotent: each invocation takes the next `NNN`; it never overwrites previous reports. To regenerate the latest: delete the file and re-invoke.

## Resources

- Design: `docs/referencias/workflow-exports/export-reports.md` · family: [`../README.md`](../README.md).
- Writing: **ambient** convention (not a role) — the host auto-applies an installed writing skill when present.
- Inputs: spec (`docs/specs`), `CONCLUSIONS`/`DECISION` (see `docs/referencias/workflow-artifacts/`), plan-doc (`docs/plans`).
- Siblings: [`../export-scripts/SKILL.md`](../export-scripts/SKILL.md) · [`../export-manuals/SKILL.md`](../export-manuals/SKILL.md) · [`../export-diagrams/SKILL.md`](../export-diagrams/SKILL.md).
