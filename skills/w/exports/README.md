# exports — `export-*` family (Layer 1)

> This is the **bundle README** for the `export-*` family: the **only** path that promotes session artifacts to permanent `docs/` documents. Each export is invoked by the **user** (never by a loop) as a separate, explicit step. *(Host→`docs/` ingestion is a different plane: [`/w:persist`](../commands/persist.md) persists in-conversation work — it reads the conversation, never sessions, and owns `docs/research`.)*
> Related layers: [`../commands/`](../commands/) (Layer 1 flows) · [`../loops/`](../loops/) (Layer 2, AI-driven) · artifacts live in `.workflow/sessions/` (Layer 3). Design reference: `docs/referencias/workflow-exports/`.
>
> **Namespace:** each export body is an **operating manual** (`EXPORT.md` — deliberately not a `SKILL.md`, so no host indexes it as a standalone skill). The user-invocable surface is the `/w:export-*` commands authored under [`../commands/`](../commands/), which read-and-follow the sibling `EXPORT.md` (per-host wrapper: see [`../harness/HARNESS.md`](../harness/HARNESS.md) § *Command packaging*).

---

## Principle (boundary) — hard rule

**Loops NEVER graduate/export to `docs/` automatically.** A loop produces **artifacts** under `.workflow/sessions/` and writes only the `docs/` folder owned by its own flow (SPEC→`specs`; PLAN→`plans`). Promoting the **rest** of the artifacts into documents is done **only** by these `export-*` skills, as a **separate and explicit** step that the **user** invokes — the execution loops never trigger it.

```
.workflow/sessions/<NNN-…>/           docs/  (permanent, user-facing)
  SCRIPTS.sql  ──── export-scripts ──►  scripts/
  DECISION · plan-doc ── export-manuals ──►  manuals/
  source code · plan-doc ── export-diagrams ──►  diagrams/
  spec · CONCLUSIONS · DECISION ── export-reports ──►  reports/
        (read-only, single-pass, cross-session, user-invoked)
```

## One export per derived `docs/` category (4)

| Export | Composes | Reads (artifacts / sessions + corpus) | Writes (its ONLY category) |
|---|---|---|---|
| [`export-scripts`](export-scripts/EXPORT.md) | `sql` | type-B `SCRIPTS.sql` (DDL/DML migrations) across N sessions + standalone `docs/scripts/*.sql` | `docs/scripts/NNN-export-scripts-<date>/` (numbered forwards + `00-ROLLBACK.sql`) |
| [`export-manuals`](export-manuals/EXPORT.md) | — (prose: ambient conventions) | sessions + `DECISION` + plan-doc (`Solution` incl. Final behavior block, `Validations`) + touched code | `docs/manuals/` |
| [`export-diagrams`](export-diagrams/EXPORT.md) | `diagrams` | source code of the sources + plan-doc (AS-IS → TO-BE delta in `Solution`, `Impacted`) | `docs/diagrams/` (C4 / mermaid) |
| [`export-reports`](export-reports/EXPORT.md) | — (prose: ambient conventions) | corpus of sessions (spec, `CONCLUSIONS`, `DECISION`) + plan-doc state + `docs/` | `docs/reports/` (executive / functional report) |

> **Composition over ownership:** an export that owns a derived artifact does **not** own its authoring logic — it **composes a capability role** from [`../roles/`](../roles/) (resolved through `.workflow/skills.toml`): `export-scripts` composes `sql`; `export-diagrams` composes `diagrams`. Swapping the implementation is a one-line config change; it never touches the export. `export-manuals` and `export-reports` produce **prose**, which follows **ambient writing conventions** (the host auto-applies an installed writing skill if present) — they do **not** compose or bind a `writing` role.

## Common properties

1. **Layer 1, explicit** — the **user** invokes them (`/w:export-<cat>`). **Never** automatic (no loop fires them).
2. **Single-pass, read-only over sessions** — they read artifacts/sessions and `docs/`, **synthesize**, and write **only** their own `docs/<category>/` folder. They do **not** mutate sessions and do **not** open/close loops.
3. **Cross-session** — they consolidate **N** sessions + the `docs/` corpus (dedup, roadmap, continuous numbering).
4. **No loop, no internal sessions** — options come from **args** (no lifecycle *structured-choice*; harness capability — see [`../harness/HARNESS.md`](../harness/HARNESS.md)).
5. **Git-safe** — they **never** commit, merge, push, `--amend`, or `--no-verify`. The output is a written document the user reviews and commits when ready.
6. **DB scripts-only** — `export-scripts` ships migration SCRIPTS as a bundle; it **never executes** DDL/DML (a human/DBA applies them).
7. **Spec and plan are documents** — written by the SPEC/PLAN flows directly, never exported.

## Section schema of each `export-*/EXPORT.md`

Mirrors `docs/referencias/workflow-exports/` and the old export SKILLs. Frontmatter: `name:` (kebab — exactly `export-scripts` / `export-manuals` / `export-diagrams` / `export-reports`) + rich `description:` (what + when, drives selection). Body:

| Section | Purpose |
|---|---|
| `## Category` | Destination `docs/` folder (its ONLY category) |
| `## Composes` | The capability role it loads (resolved via `skills.toml`) |
| `## When to use` | Discovery triggers + scenarios |
| `## What it does` | Step list (the synthesis) |
| `## What it does NOT do` | Hard exclusions (no commit, no execute, single category) |
| `## Read-only sandbox` | Plan-mode behavior (describe, don't write) |
| `## Inputs` | `aw` reads + filesystem reads + args |
| `## Flow` | Step-by-step (resolve context → collect → synthesize → number → write → report) |
| `## Output location` | The exact path/shape it writes |
| `## Re-run` | Idempotence (next NNN; never overwrites) |
| `## Resources` | Design references + sibling exports |

## Runtime CLI (`agent-workflow`, alias `aw`)

Exports read the corpus through the CLI — **never hard-coded paths**:

- `aw sessions` — list sessions (counts + next correlative) to enumerate the corpus.
- `aw release-data [--since sessionNNN] [--source alias] [--include-graduated] [--standalone-sql]` — consolidated dump of sessions (corpus enumeration). `--include-graduated` lists previous `docs/scripts` bundles (modern `NNN-export-scripts-YYYY-MM-DD` and legacy naming); `--standalone-sql` lists loose top-level `docs/scripts/*.sql` (export-scripts' source B).
- `aw session-artifacts --code <NNN> [--dump [kinds]]` — counts by default; `--dump` returns `{path, content, size}` per artifact (objetivo, decisiones, conclusiones, tasks, checkpoint, backlog, scripts).
- `aw next-number docs/<category>` — deterministic numbering of the output. It also **creates the category folder when missing** (workspace-init no longer scaffolds docs/ upfront) — this is what makes destination resolution a CLI guarantee. In plan/dry-run mode call it with `--dry-run` (pure query, creates nothing).

> The destination-folder resolution (workspace root, single- vs multi-source, on-demand creation) is handled by the CLI internally. If a specific flag is uncertain at implementation time, it is noted inline in each SKILL.

## 6 Hard invariants (never violate)

1. **No auto-export**: only `export-*` promotes to `docs/`, always explicit/user-invoked.
2. **Each export writes ONLY its one `docs/` category** (scripts / manuals / diagrams / reports).
3. **Spec and plan are documents** (written by SPEC/PLAN flows directly) — they are **not** exported.
4. **DB scripts-only**: `export-scripts` ships SCRIPTS.sql migrations, **never executes** them.
5. **Git-safe**: exports are read-only/report — **never** commit/push.
6. **Cross-session synthesis**: exports consolidate N sessions, not a single one.

## Index

| Export | File | Category | Composes |
|---|---|---|---|
| `export-scripts` | [`export-scripts/EXPORT.md`](export-scripts/EXPORT.md) | `docs/scripts` | `sql` |
| `export-manuals` | [`export-manuals/EXPORT.md`](export-manuals/EXPORT.md) | `docs/manuals` | — (prose: ambient conventions) |
| `export-diagrams` | [`export-diagrams/EXPORT.md`](export-diagrams/EXPORT.md) | `docs/diagrams` | `diagrams` |
| `export-reports` | [`export-reports/EXPORT.md`](export-reports/EXPORT.md) | `docs/reports` | — (prose: ambient conventions) |
