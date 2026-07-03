---
name: export-scripts
description: "Consolidates the workspace's pending SQL into a single `docs/scripts/NNN-export-scripts-YYYY-MM-DD/` bundle with continuous numbering after `00-ROLLBACK.sql`. Reads type-B migrations (DDL/DML) from two sources: `.workflow/sessions/<folder>/SCRIPTS.sql` across N sessions AND standalone `docs/scripts/*.sql` (excluding previous bundles). Ignores read-only type-A (diagnostic queries, not deliverables). Minimal SQL headers + a simple README (3 sections: Files / Apply / Revert). The rollback is derived from the forwards. Read-only/report: it NEVER executes SQL nor commits — the bundle is for a human/DBA to apply. Composes the `sql` capability. Use for 'release SQL bundle', 'prepare the prod push', 'consolidate pending SQLs'. User-invoked via `/w:export-scripts`."
---

# export-scripts — consolidated SQL bundle, simple and direct

Consolidates the pending SQL migrations of N sessions + standalone files into a single bundle under `docs/scripts/NNN-export-scripts-YYYY-MM-DD/`, with continuous numbering after `00-ROLLBACK.sql`. **Read-only / report** — the AI **never executes** the SQL; the user/DBA applies the bundle manually.

> `export-*` family (the only artifact→`docs/` path). Design: `docs/referencias/workflow-exports/export-scripts.md`.

## Category

`docs/scripts` — the **only** `docs/` folder this export writes.

## Composes

The **`sql`** capability (built-in default `sql`), resolved via `.workflow/skills.toml`. It contributes the DDL/DML category vocabulary, the application order and the rollback derivation. This export does **not** own that logic: it composes it. Rebindable or `off` by config.

## When to use

- "Release SQL bundle", "prepare the prod push", "consolidate pending SQLs".
- Before promoting a branch to certification / `main`.
- After several `exec`/`quick` sessions left `SCRIPTS.sql` files with migrations.

## What it does

1. Collects the workspace's SQL from **two sources**: each corpus session's type-B `SCRIPTS.sql` + standalone `docs/scripts/*.sql` (excluding previous bundles).
2. Classifies the statements by canonical category (DDL-TABLES / DDL-FUNCTIONS / DML / INSERTS).
3. Consolidates cross-source per category with **continuous numbering** after `00-ROLLBACK.sql`.
4. Writes the consolidated forwards (each statement with its origin, 1 line).
5. Derives `00-ROLLBACK.sql` **at the end**, reading the already-written forwards.
6. Writes a minimal `README.md` (Files / Apply / Revert).

## What it does NOT do

- **Execute SQL** (DB scripts-only invariant). The bundle is a deliverable; a human/DBA applies it.
- Commit, merge, push.
- Touch `.workflow/sessions/` or the standalone `docs/scripts/*.sql` (read-only).
- Write any `docs/` folder other than `docs/scripts/` (invariant: one category).
- Migrate previous bundles (`docs/scripts/NNN-export-scripts-*/` stay as history).
- Include read-only type-A (diagnostic queries) or invent SQL.
- Generate email templates, production checklists, commit/session listings, or executive summaries in the README.

## Read-only sandbox

In plan mode it **describes**, never writes: the resolved `NNN`, the detected sources (sessions + standalone), the categories with content, the files that would appear at the bundle root and the approximate README content. It does **not** run `Write`, effectful `aw next-number`, or mutations.

## Inputs

**`agent-workflow` CLI (alias `aw`)** — never read hardcoded paths:

- `aw sessions` / `aw release-data [--since sessionNNN] [--source <alias>]` — enumerates the session corpus.
- `aw session-artifacts --code <NNN> --dump scripts` — lists the session's `.sql` files with path and size (content is read by path). No scripts → empty list, silent skip.
- `aw next-number docs/scripts` — deterministic numbering of the bundle directory (the CLI handles destination-folder resolution).

**Filesystem**:

- Standalone `docs/scripts/*.sql` (top-level only), **excluding** any `docs/scripts/NNN-export-scripts-*/` (previous outputs of this export).

**Args** (no lifecycle *structured-choice*; harness capability — see [`../../harness/SKILL.md`](../../harness/SKILL.md)):

```
/w:export-scripts [--sessions NNN[,NNN]] [--since sessionNNN] [--source <alias>]
                  [--skip-standalone] [--dry-run]
```

| Flag | Behavior |
|---|---|
| `--sessions NNN[,NNN]` | Discrete filter by code (takes precedence over `--since`) |
| `--since sessionNNN` | Only sessions after NNN (exclusive: NNN itself is out; use `--sessions` to include it) |
| `--source <alias>` | Limits to one source (multi-source workspace) |
| `--skip-standalone` | Skips reading the standalone `docs/scripts/*.sql` |
| `--dry-run` | Propositional report, no files written |

No args: every corpus session + every standalone `.sql` (excluding previous bundles).

## Flow

### Step 1 — Collect SQL sources

**Source A — sessions**: for every corpus session (`aw sessions` / `release-data` + `session-artifacts --code <NNN> --dump scripts`), read the `.sql` files the dump lists (per-script path). Take **only** type-B statements (deliverable DDL/DML migrations); ignore read-only type-A (diagnostic queries). Expected per-statement markers: `-- @category: <01-04>` + `-- @stmt: NNN-verb-target` (format defined by the `sql` capability).

**Source B — standalone** (unless `--skip-standalone`): list top-level `docs/scripts/*.sql`, **excluding** `docs/scripts/NNN-export-scripts-*/`. Per file: honor `@category` markers when present; otherwise infer the category from content (`CREATE/ALTER TABLE`, `CREATE INDEX` → `01`; `CREATE OR REPLACE FUNCTION`/`PROCEDURE` → `02`; `UPDATE`/`DELETE` → `03`; `INSERT INTO … VALUES` → `04`). If the filename contains `rollback` → skip (it never enters a forward).

If the A + B union is empty → **abort**: there is no pending SQL in the workspace.

### Step 2 — Bundle numbering

`aw next-number docs/scripts` → `docs/scripts/NNN-export-scripts-YYYY-MM-DD/`.

### Step 3 — Classification and internal order

Group by canonical category: `01 DDL-TABLES` · `02 DDL-FUNCTIONS` · `03 DML` · `04 INSERTS`. Internal order chronological by origin (ascending session → ascending stmt; standalone interleaved by lexical filename order).

### Step 4 — Continuous numbering (no gaps)

Assign sequential numbers **only to categories with content**, in canonical order. The first forward is always `01-…`. E.g.: DML only → `00-ROLLBACK.sql`, `01-DML.sql`; all 4 categories → `00-ROLLBACK.sql`, `01-DDL-TABLES.sql`, `02-DDL-FUNCTIONS.sql`, `03-DML.sql`, `04-INSERTS.sql`.

### Step 5 — Write the forwards

Per category with content, one file with a 1-2 line header (`-- 0N-<CATEGORY>.sql — bundle NNN-export-scripts-YYYY-MM-DD`) and, per statement, **a one-line origin comment** (`-- sessionXXX / stmt-id` or `-- docs/scripts/001-filename.sql`) followed by the SQL exactly as the developer wrote it (wrapped in `BEGIN; … COMMIT;` where it applies). Do not replicate motivation/impact/idempotency already present at the origin; no statement index, no invented verification SELECTs.

### Step 6 — Derive `00-ROLLBACK.sql` (at the end)

Via the `sql` capability, **reading the already-written forwards** (not the original `SCRIPTS.sql`): inverse statements in reverse order (last→first), a single transactional block, and an "irreversible cleanup" block at the end outside the transaction only if there are operations without an automatic reverse.

### Step 7 — Write the `README.md` (3 sections)

`## Archivos` (table: 1 row per file present) · `## Aplicar` (one `psql -f` per file in ascending order; the export executes nothing) · `## Revertir` (`psql -f 00-ROLLBACK.sql` + a note if there is an irreversible block). The README is a user-facing deliverable → write it in the user's language. **Vetoed**: executive summary, session table, email templates, commit listing, production checklist.

### Step 8 — Write or report

With `--dry-run`: print the report; write nothing. Otherwise: `Write` the bundle. **NEVER commit**. Summary to the user: one line per written file + the bundle path (without replicating the README).

## Output location

```
docs/scripts/NNN-export-scripts-YYYY-MM-DD/
├── 00-ROLLBACK.sql       # reverse derived from the forwards
├── 01-<CATEGORY>.sql     # first forward (continuous numbering)
├── 02-<CATEGORY>.sql     # …per category with content
└── README.md             # Archivos · Aplicar · Revertir
```

## Re-run

Functionally idempotent: each invocation takes the next `NNN` and **never overwrites** previous bundles. To regenerate: delete the directory manually and re-invoke.

## Resources

- Design: `docs/referencias/workflow-exports/export-scripts.md` · family: [`../README.md`](../README.md).
- Composed capability: `sql` (built-in default; see `docs/referencias/workflow-roles/`).
- Source artifact: `SCRIPTS.sql` (see `docs/referencias/workflow-artifacts/artifacts-core/`).
- Siblings: [`../export-manuals/SKILL.md`](../export-manuals/SKILL.md) · [`../export-diagrams/SKILL.md`](../export-diagrams/SKILL.md) · [`../export-reports/SKILL.md`](../export-reports/SKILL.md).
