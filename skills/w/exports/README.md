# exports — `export-*` family (Layer 1)

> This is the **bundle README** for the `export-*` family: the **only** path that promotes session artifacts to permanent `docs/` documents. Each export is invoked by the **user** (never by a loop) as a separate, explicit step.
> Related layers: [`../commands/`](../commands/) (Layer 1 flows) · [`../loops/`](../loops/) (Layer 2, AI-driven) · artifacts live in `.workflow/sessions/` (Layer 3). Design reference: `docs/referencias/workflow-exports/`.
>
> **Namespace:** invoked via the Skill tool by `name:` — `export-scripts`, `export-manuals`, `export-diagrams`, `export-reports`. The thin `/w:export-*` slash commands that route here are authored separately under [`../commands/`](../commands/).

---

## Principle (boundary) — hard rule

**Loops NEVER graduate/export to `docs/` automatically.** A loop produces **artifacts** under `.workflow/sessions/` and writes only the `docs/` folder owned by its own flow (SPEC→`specs`; PLAN→`plans`+`tools`). Promoting the **rest** of the artifacts into documents is done **only** by these `export-*` skills, as a **separate and explicit** step that the **user** invokes — the execution loops never trigger it.

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
| [`export-scripts`](export-scripts/SKILL.md) | `sql` | type-B `SCRIPTS.sql` (DDL/DML migrations) across N sessions + standalone `docs/scripts/*.sql` | `docs/scripts/NNN-export-scripts-<date>/` (numbered forwards + `00-ROLLBACK.sql`) |
| [`export-manuals`](export-manuals/SKILL.md) | `writing` | sessions + `DECISION` + plan-doc (`Solution`, `Final behavior`, `Validations`) + touched code | `docs/manuals/` |
| [`export-diagrams`](export-diagrams/SKILL.md) | `diagrams` | source code of the sources + plan-doc (`AS-IS` / `TO-BE`, `Impacted`) | `docs/diagrams/` (C4 / mermaid) |
| [`export-reports`](export-reports/SKILL.md) | `writing` | corpus of sessions (spec, `CONCLUSIONS`, `DECISION`) + plan-doc state + `docs/` | `docs/reports/` (executive / functional report) |

> **Composition over ownership:** an export does **not** own its authoring logic — it **composes a capability role** from [`../../`workflow-skills](../../) (resolved through `.workflow/skills.toml`): `export-scripts` composes `sql`; `export-manuals` and `export-reports` compose `writing`; `export-diagrams` composes `diagrams`. Swapping the implementation is a one-line config change; it never touches the export.

## Common properties

1. **Layer 1, explicit** — the **user** invokes them (`/w:export-<cat>`). **Never** automatic (no loop fires them).
2. **Single-pass, read-only over sessions** — they read artifacts/sessions and `docs/`, **synthesize**, and write **only** their own `docs/<category>/` folder. They do **not** mutate sessions and do **not** open/close loops.
3. **Cross-session** — they consolidate **N** sessions + the `docs/` corpus (dedup, roadmap, continuous numbering).
4. **No loop, no internal sessions** — options come from **args** (no lifecycle `AskUserQuestion`).
5. **Git-safe** — they **never** commit, merge, push, `--amend`, or `--no-verify`. The output is a written document the user reviews and commits when ready.
6. **DB scripts-only** — `export-scripts` ships migration SCRIPTS as a bundle; it **never executes** DDL/DML (a human/DBA applies them).

## Section schema of each `export-*/SKILL.md`

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
- `aw release-data [--since sessionNNN] [--source alias]` — consolidated dump of sessions (corpus enumeration).
- `aw session-artifacts --code <NNN>` — lazy read of a session's artifacts.
- `aw next-number docs/<category>` — deterministic numbering of the output.

> The destination-folder resolution (workspace root, single- vs multi-source) is handled by the CLI internally. If a specific flag is uncertain at implementation time, it is noted inline in each SKILL.

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
| `export-scripts` | [`export-scripts/SKILL.md`](export-scripts/SKILL.md) | `docs/scripts` | `sql` |
| `export-manuals` | [`export-manuals/SKILL.md`](export-manuals/SKILL.md) | `docs/manuals` | `writing` |
| `export-diagrams` | [`export-diagrams/SKILL.md`](export-diagrams/SKILL.md) | `docs/diagrams` | `diagrams` |
| `export-reports` | [`export-reports/SKILL.md`](export-reports/SKILL.md) | `docs/reports` | `writing` |
