---
name: sql
description: >-
  SQL / database capability — built-in default for the `sql` role. Authoring DB
  changes as versioned scripts (never executing them): writes statements to the
  session `SCRIPTS.sql` with `@category` + `@stmt` markers, applies project SQL
  style (canonical header, BEGIN/COMMIT, idempotency, explicit schema, CTEs over
  DO/LOOP), classifies into the 4 categories, and knows how rollbacks are derived
  on export. DB access is read-only via MCP — DML/DDL is NEVER executed (invariant 4).
  Use when a loop writes migrations / queries, when research reads schema, or when
  export-scripts consolidates the bundle.
---

# sql — SQL / database capability

## Role

`sql` — built-in default. Rebindable in `.workflow/skills.toml` (third-party skill or `off`). When `off`, the loop continues without DB authoring help and says so if the task needed it.

## Purpose

Author database changes as **versioned SQL scripts**, never executing them. Two modes:

- **Read-only** (query): read schema/data via MCP to understand the domain (research, planning).
- **Write-to-script** (change): every DB mutation is written to the session's `SCRIPTS.sql`; the **user applies it**, never the AI.

## Composed by

- **research** — read schema via read-only MCP to understand the domain.
- **`plan-exec-loop`** — every SQL change is appended to `SCRIPTS.sql` during execution.
- **`quick-loop`** — same, for the lightweight shortcut.
- **`export-scripts`** — consolidates N sessions' `SCRIPTS.sql` into the `docs/scripts/NNN-export-scripts-YYYY-MM-DD/` bundle and derives the rollback.

## Knowledge

### Rule zero — never execute SQL (invariant 4)

The AI **never executes DML/DDL** against any DB, through any channel (MCP, `psql`, `Bash`, an app driver). Migrations stay in `SCRIPTS.sql` and the **user applies them**. If the temptation "verify by applying" appears, refuse and ask the user to run it.

- **Read-only reads via MCP**: `SELECT`, schema inspection, counts — OK. No `INSERT/UPDATE/DELETE/CREATE/ALTER/DROP/TRUNCATE`.
- The DB MCPs (cert/prod) are **READONLY** by contract.
- Single exception, which does NOT relax the rule: if the user explicitly asks "run it yourself against cert", still confirm per block and never assume broadened authorization.

### Staging — a single `SCRIPTS.sql` per session

```
.workflow/sessions/<folder>/
└── SCRIPTS.sql      (consolidated: ALL of the session's statements)
```

Every statement is **appended** with a pair of comment markers:

```sql
-- @category: 01-ddl-tablas
-- @stmt: 01-crear-tabla-usuarios
CREATE TABLE IF NOT EXISTS esq_credito.tb_usuarios (
  ...
);
```

- `@category` classifies (4 canonical values, below).
- `@stmt` gives the deterministic slug `NN-verb-target`; `export-scripts` derives the filename when splitting.
- Order inside the file = chronological append order. The final per-category execution order (01→02→03→04) is resolved by `export-scripts`, not here.
- A global `BEGIN;` at the top of the file, `COMMIT;` at the end. Individual statements carry **no** BEGIN/COMMIT of their own.
- **No** per-file `.rollback.sql` during exec — the rollback is generated on export.

### The 4 categories (`@category`)

| Marker | Detection patterns |
|---|---|
| `01-ddl-tablas` | `CREATE/DROP/ALTER TABLE`, `CREATE INDEX`, `CREATE SEQUENCE` |
| `02-ddl-funciones` | `CREATE [OR REPLACE] FUNCTION/PROCEDURE`, `DROP FUNCTION/PROCEDURE` |
| `03-migracion` | `UPDATE`, `INSERT ... SELECT`, `DELETE` over existing data, column transformations |
| `04-inserts` | `INSERT INTO ... VALUES`, catalog seeds, initial configuration data |

**Mandatory execution order**: 01 → 02 → 03 → 04. `SCRIPTS.sql` may mix categories chronologically; `export-scripts` orders the final bundle.

### SQL style

- **Canonical 4-line header**, between two equal-sign lines (delivered scripts are user-facing → field values in the user's language):

  ```sql
  -- ============================================================================
  -- Script:  NNN-tipo-objetivo.sql
  -- Sesion:  sNNN
  -- Objeto:  <what it does, 1-2 lines>
  -- Alcance: <filters and boundaries of the change, 1 line>
  -- ============================================================================
  ```

  Only 4 fields. Author/Date/long notes do NOT go in the header (a free block below, if needed). If the engine is not Postgres, state it in `Objeto:`.
- **Idempotency**: `CREATE TABLE IF NOT EXISTS`, `DROP ... IF EXISTS`, `CREATE OR REPLACE`, `ON CONFLICT`.
- **Explicit schema** always (`esq_credito.tb_x`, never `public.`).
- **CTEs over DO/LOOP**: one transformation = chained `WITH ... AS` + one final `INSERT/UPDATE/DELETE`. Avoid `DO $$ ... LOOP ... END $$` when the result is achievable declaratively (easier to audit and revert). Exception: dynamic object discovery (FKs/columns/constraints) — document the reason in `Objeto:`.
- **Parametrized queries** always (never string concatenation) — in any SQL that ends up in app code.
- Never create `fn_*`/`sp_*` to reuse logic exclusive to one script; use a CTE or inline.
- **Section separators** (only with 2+ sections):

  ```sql
  -- ----------------------------------------------------------------------------
  -- N. Short description of what this block does.
  -- ----------------------------------------------------------------------------
  ```

  Double boxes (`====`) only for the header.

### `SCRIPTS.sql` maintenance process

1. **Detect the category** of the change (markers table).
2. **Verify idempotency** of the statement.
3. **Append** with the marker pair (`@category` + `@stmt`).
4. **Style check** — canonical header, CTEs over DO/LOOP, explicit schema.
5. **Never** renumber or move (there is a single `SCRIPTS.sql`).
6. **Never** generate `.rollback.sql` during exec.

### Rollback (generated by `export-scripts`, not here)

`export-scripts` reads the consolidated forwards and generates **a single** `00-ROLLBACK.sql` at the bundle root, in reverse order. Know the strategies to write reversible forwards:

| Forward | Rollback |
|---|---|
| `CREATE TABLE IF NOT EXISTS tb_x` | `DROP TABLE IF EXISTS tb_x;` |
| `ALTER TABLE tb_x ADD COLUMN col` | `ALTER TABLE tb_x DROP COLUMN IF EXISTS col;` |
| `CREATE INDEX idx_...` | `DROP INDEX IF EXISTS idx_...;` |
| `CREATE SEQUENCE seq_...` | `DROP SEQUENCE IF EXISTS seq_...;` |
| `CREATE OR REPLACE FUNCTION fn_x(...)` | `DROP FUNCTION IF EXISTS fn_x(<signature>);` |
| `UPDATE/DELETE` with a backup in `esq_audit.tb_bkp_*` | `UPDATE … FROM esq_audit.tb_bkp_…` |
| `INSERT INTO tb_x VALUES (...)` | `DELETE FROM tb_x WHERE <natural key / range>;` (never DELETE without WHERE) |

**Irreversible → manual "Fase 5" block** (outside the transaction, one line per case): `TRUNCATE`, `DROP COLUMN`/`DROP TABLE` without backup, lossy `ALTER COLUMN TYPE`, `DROP ... CASCADE`, `DELETE/UPDATE` without a backup in `esq_audit`. To make a destructive change reversible, write the backup in the same forward (`esq_audit.tb_bkp_<table>_sNNN`).

## Output

- During loops: statements appended to `.workflow/sessions/<folder>/SCRIPTS.sql` (session artifact, never `docs/`).
- Via `export-scripts`: the `docs/scripts/NNN-export-scripts-YYYY-MM-DD/` bundle — `00-ROLLBACK.sql` + `01-<CATEGORY>.sql` … (continuous numbering, no gaps for empty categories) + `README.md`. Canonical category order: `DDL-TABLES → DDL-FUNCTIONS → DML → INSERTS`.

It never writes `docs/` from a loop (invariant 1: only `export-*` exports). It never executes anything against a DB (invariant 4).

## Source

Self-contained rules (no dependency on external skills). Rationale and history: design (`docs/referencias/workflow-roles/`).
