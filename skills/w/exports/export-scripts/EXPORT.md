---
name: export-scripts
description: "Consolidates pending SQL into a numbered `docs/scripts/` bundle: five forward categories and paired rollbacks. Publishes the net final state; never executes SQL. After publication the CLI offers a commit of explicit paths, only with approval. Composes `sql`. User-invoked via `/w:export-scripts`."
---

# export-scripts — consolidated SQL bundle, simple and direct

Consolidates pending SQL into `docs/scripts/NNN-export-scripts-YYYY-MM-DD/`, with category folders and rollback files under `rollback/`. The AI **never executes** SQL; application is a handoff.

**The material is declared, not assumed:** a base brings it, `--exclude` subtracts pieces and `--environment` what the book records as applied. With no flag: the session corpus, bundles out.

> `export-*` family (the only artifact→`docs/` path). Design: `docs/referencias/workflow-exports/export-scripts.md`.

## Category

`docs/scripts` — the **only** `docs/` folder this export writes.

## Composes

The **`sql`** capability (built-in default `sql`), resolved via `.workflow/skills.toml`. It contributes the DDL/DML category vocabulary, the application order and the rollback derivation. This export does **not** own that logic: it composes it. Rebindable or `off` by config.

## What it does NOT do

- **Execute SQL** (DB scripts-only). The bundle is a deliverable; a human/DBA applies it.
- Commit, merge or push; touch `.workflow/sessions/` or the loose `*.sql` (read-only).
- Write any `docs/` folder other than `docs/scripts/` (invariant: one category).
- Rewrite, renumber or delete a previous bundle: one in the origin is **read**, its directory left as it was.
- Include read-only type-A (diagnostic queries) or invent SQL.
- Put email templates, production checklists, commit listings or executive summaries in the README.

## Read-only sandbox

In plan mode do **not** call `prepare` (it reserves a folder): describe the origin, categories and tentative `NNN` from `aw next-number --dry-run docs/scripts`. No mutations.

## Inputs

**`agent-workflow` CLI (alias `aw`)** — never read hardcoded paths:

- `aw release-data [--since sessionNNN] [--source <alias>]` — the session corpus (ALL sessions, closed + active, with `release_eligible`). `aw sessions` lists only ACTIVE ones: never use it as the corpus.
- `aw session-artifacts --code <NNN> --dump scripts` — session SQL including root `SCRIPTS.sql` and `SCRIPTS.rollback.sql`, with relative names, path and size. No SQL → not material.
- `aw release-data --standalone-sql [--include-graduated]` — the loose `docs/scripts/*.sql` and the previous bundles. `prepare` already reads both through its base; these are for looking by hand.
- `aw release-pass list` — `--environment` reads linked/applied bundles. `--catalog <connection>` optionally inspects the target catalog through Workline's read-only PostgreSQL connection; unreachable or missing objects block publication. Without it, no database connection opens.
- `aw next-number docs/scripts` — deterministic numbering; it also creates `docs/scripts` when missing, which is what makes destination resolution a CLI guarantee. In plan mode, `--dry-run`.

**Args** (no lifecycle *structured-choice*; harness capability — see [`../../harness/HARNESS.md`](../../harness/HARNESS.md)):

```
/w:export-scripts [--from sessions|bundles|workspace] [--exclude <nombre>]… [--environment <ambiente>]
                  [--sessions NNN[,NNN]] [--since sessionNNN] [--source <alias>] [--code <sesión>] [--catalog <conexión>]
```

| Flag | Behavior |
|---|---|
| `--from <base>` | The base: `sessions` (default) · `bundles` · `workspace` (all three) |
| `--exclude <nombre>` | Subtracts one piece by the name the inventory prints. **Repeatable** |
| `--environment <ambiente>` | Subtracts bundles the book records as applied there; no record is reported as such |
| `--sessions NNN[,NNN]` | Discrete filter by code (takes precedence over `--since`) |
| `--since sessionNNN` | Only sessions after NNN (exclusive: NNN itself is out; use `--sessions` to include it) |
| `--source <alias>` | Limits to one source (multi-source workspace) |
| `--catalog <connection>` | Optional read-only target catalog check, repeated on validate and apply |
| `--code <sesión>` | Owns the folder reservation; without it, the sealed operation owns it |

No args: every corpus session, bundles and loose SQL out — the behavior that always was. The three composition flags are this export's alone.

## Flow

### Step 1 — Collect SQL sources

`prepare` already resolved WHICH pieces are in: its inventory lists them per origin with every exclusion and its reason. Read only that.

**Sessions**: read every `.sql` named by `aw session-artifacts --code <NNN> --dump scripts`, including root `SCRIPTS.sql` and `SCRIPTS.rollback.sql`. Take only type-B migrations; skip type-A research. Markers: `-- @category: <01-05>` and `-- @stmt: NNN-verb-target` (from the `sql` capability).

**Loose SQL**: per file, honor `@category` markers when present; otherwise infer it from content (`CREATE/ALTER TABLE`, `CREATE INDEX` → `01`; `CREATE OR REPLACE FUNCTION`/`PROCEDURE` → `02`; `UPDATE`/`DELETE` → `03`; `INSERT INTO … VALUES` → `04`). If the filename contains `rollback` → skip (it never enters a forward).

**Published bundles**: read forwards in category and filename order. Both `rollback/` and legacy flat rollbacks are **never** forwards.

An empty origin → **abort**: `prepare` already refused, saying whether nothing matched or everything was already applied.

### Step 2 — Bundle numbering

`aw next-number docs/scripts` → `docs/scripts/NNN-export-scripts-YYYY-MM-DD/`.

### Step 3 — Net final state, classification and internal order

Reconcile every candidate the origin brought against the code and the declared final state. Omit
objects born and retired within the sequence; write migrated objects directly in their final form;
omit explicitly retired objects even when their deletion is absent from the input.

| History in the corpus | Publish |
|---|---|
| Created, then dropped | Nothing: neither forward nor rollback |
| Created, then changed (type/rename) | One statement in final form |
| Created, untouched | The original statement |
| Retired by session context without an explicit `DROP` | Omit it |

**Synthesize, never invent:** folding `CREATE` + `ALTER` into a final `CREATE` is required;
adding a migration no session performed is forbidden. Session context outranks script chronology:
a retired object stays out even when no file dropped it. Check actual state **read-only** before
deciding what remains; reconcile code (including entity mappings and native queries) with it.
Do not promote one-off QA data repairs into release migrations.

**Corpus ≠ live source environment.** Hand edits may never appear in a script. As an
operational handoff after application, compare source and target object by object through
read-only inspections; before application the planned delta hides omissions. Portable
guards assert existence, not a source-specific row count. Compare routine definitions
from the live catalog, not the file that once created them: omit a replacement when live
bodies already agree. User-visible labels matter too; an older label can leave an object
present but unfindable. None of these remote observations is a local closure criterion.

**A previous bundle in the origin is MATERIAL A RECONCILIAR, not untouchable history.** Two that
contradict — one creating an object, a later one retiring it — publish the resulting net final state,
never their chronological sum: the new bundle does not create it, and its global rollback does not
reverse a creation it never published. The bundles on disk are never modified.

Group the remaining statements: `01-ddl-tablas` · `02-ddl-funciones` · `03-migracion` · `04-inserts` · `05-grants`. Origin traces changes, never determines their order.

### Step 4 — Continuous numbering (no gaps)

Keep the five fixed category numbers. Omit empty folders; within each populated folder, number files `01-<nombre>.sql`, `02-<nombre>.sql`, … with no gaps.

### Step 5 — Write the forwards

Write each forward in its category folder with a concise header and useful origin. Reconcile to the net final state; keep idempotency, intent and transaction boundaries. Never invent verification SELECTs.

### Step 6 — Derive `00-ROLLBACK.sql` (at the end)

For every forward `<categoría>/NN-<nombre>.sql`, write `rollback/<categoría>/NN-<nombre>.rollback.sql`. Derive `rollback/00-global/00-ROLLBACK.sql` from the consolidated final state, **in dependency-safe order**: drop referencing rows/tables before their FK targets; never reverse the session chronology or file order literally. Verify the real state only through read-only inspection; application is the user's handoff.

### Step 7 — Write the `README.md` (3 sections)

`## Archivos` (every file present) · `## Aplicar` (`psql -f` for each forward, category then filename order; `*/*.sql` or `0*/*.sql` reaches only forwards; `**/*.sql`, `find` and PowerShell `-Recurse` also reach rollbacks and MUST NOT be used to apply) · `## Revertir` (`rollback/00-global/00-ROLLBACK.sql`). Write it in the user's language.

### Step 8 — Write or report

Publish through the three stages (`prepare` → `validate` → `apply --approval`); in plan mode, describe instead. Once published, the CLI proposes `aw workspace-commit prepare --export <ruta>` and executes `apply --approval <digest>` only with explicit approval, with exact paths and no push. Summary: one line per file + the bundle path, naming the origin and what stayed out.

## Output location

```
docs/scripts/NNN-export-scripts-YYYY-MM-DD/
├── README.md
├── 01-ddl-tablas/01-<nombre>.sql
├── 02-ddl-funciones/ · 03-migracion/ · 04-inserts/ · 05-grants/
└── rollback/
    ├── 00-global/00-ROLLBACK.sql
    └── <categoría>/NN-<nombre>.rollback.sql  # one per forward
```

## Re-run

Each invocation publishes a new `NNN`: never delete or overwrite a published bundle. Corrections supersede the earlier bundle.

## Resources

- Design: `docs/referencias/workflow-exports/export-scripts.md` · family: [`../README.md`](../README.md).
- Composed capability: `sql` (built-in default; see `docs/referencias/workflow-roles/`).
- Source artifact: `SCRIPTS.sql` (see `docs/referencias/workflow-artifacts/artifacts-core/`).
- Siblings: [`../export-manuals/EXPORT.md`](../export-manuals/EXPORT.md) · [`../export-diagrams/EXPORT.md`](../export-diagrams/EXPORT.md) · [`../export-reports/EXPORT.md`](../export-reports/EXPORT.md).
