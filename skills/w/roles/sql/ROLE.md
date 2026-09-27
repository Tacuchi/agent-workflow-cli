---
name: sql
description: >-
  SQL / database capability — built-in default for the `sql` role. Authoring DB
  changes as versioned scripts (never executing them): writes statements to the
  session `SCRIPTS.sql` with `@category` + `@stmt` markers, applies project SQL
  style (canonical header, BEGIN/COMMIT, idempotency, explicit schema, CTEs over
   DO/LOOP), classifies into the 5 categories, and knows how rollbacks are derived
  on export. DB access is read-only via MCP — DML/DDL is NEVER executed (invariant 4).
  Use when a loop writes migrations / queries, when research reads schema, or when
  export-scripts consolidates the bundle.
---

# sql — SQL / database capability

## Role

`sql` — built-in default. Rebindable in `.workflow/skills.toml` (third-party skill or `off`). When `off`, the loop continues without DB authoring help and says so if the task needed it.

## Purpose

Author database changes as **versioned SQL scripts**, never executing them. Two modes:

- **Read-only** (query): read schema/data through a registered connection to understand the domain (research, planning).
- **Write-to-script** (change): every DB mutation is written to the session's `SCRIPTS.sql`; the **user applies it**, never the AI.

## Composed by

- **research** — read schema via read-only MCP to understand the domain.
- **`plan-exec-loop`** — every SQL change is appended to `SCRIPTS.sql` during execution.
- **`quick-loop`** — same, for the lightweight shortcut.
- **`export-scripts`** — consolidates N sessions' `SCRIPTS.sql` into the `docs/scripts/NNN-export-scripts-YYYY-MM-DD/` bundle and derives the rollback.

## Knowledge

### Rule zero — never execute SQL (invariant 4)

The AI **never executes DML/DDL** against any DB, through any channel (MCP, `psql`, `Bash`, an app driver). Migrations stay in `SCRIPTS.sql` and external application is a handoff. Local fixture or ephemeral-DB tests may verify the checkout contract; a deployed application is never a closing requirement.

- **Read-only remote reads**: `SELECT`, schema inspection, counts — research context only. No `INSERT/UPDATE/DELETE/CREATE/ALTER/DROP/TRUNCATE`.
- Choose only a registered connection; the registry, not environment-name conventions, supplies its exact DSN variable.
- A remote snapshot is recorded before plan approval and is never refreshed from `plan-exec`.

### Staging — separate forward and rollback artifacts per session

```
.workflow/sessions/<folder>/
├── SCRIPTS.sql           (forward migrations and type-A reads)
└── SCRIPTS.rollback.sql  (reverse migrations, never applied with the forward)
```

Every statement is **appended** with a pair of comment markers:

```sql
-- @category: 01-ddl-tablas
-- @stmt: 01-crear-tabla-usuarios
CREATE TABLE IF NOT EXISTS <schema>.<table> (
  ...
);
```

- `@category` classifies (5 canonical values, below).
- `@stmt` gives the deterministic slug `NN-verb-target`; `export-scripts` derives the filename when splitting.
- Order inside the file = chronological append order. The final category order (01→02→03→04→05) is resolved by `export-scripts`.
- A global `BEGIN;` at the top of the file, `COMMIT;` at the end. Individual statements carry **no** BEGIN/COMMIT of their own.
- Put session reverses in `SCRIPTS.rollback.sql`, never after the forwards. Export pairs each forward with its own `.rollback.sql` under `rollback/`.

### The 5 categories (`@category`)

| Marker | Detection patterns |
|---|---|
| `01-ddl-tablas` | `CREATE/DROP/ALTER TABLE`, `CREATE INDEX`, `CREATE SEQUENCE` |
| `02-ddl-funciones` | `CREATE [OR REPLACE] FUNCTION/PROCEDURE`, `DROP FUNCTION/PROCEDURE` |
| `03-migracion` | `UPDATE`, `INSERT ... SELECT`, `DELETE` over existing data, column transformations |
| `04-inserts` | `INSERT INTO ... VALUES`, catalog seeds, initial configuration data |
| `05-grants` | `GRANT`/`REVOKE`, `ALTER … OWNER TO`, `ALTER DEFAULT PRIVILEGES` |

**Mandatory execution order**: 01 → 02 → 03 → 04 → 05. `SCRIPTS.sql` may mix categories chronologically; `export-scripts` orders the final bundle.

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
- **Explicit schema when the project has one** (`<schema>.<table>`); never invent a schema name or assume `public`.
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
5. **Never** renumber or move `SCRIPTS.sql` during exec.
6. Keep the inverse in the separate `SCRIPTS.rollback.sql`.

### Rollback (session draft and export)

Write session reverses in `SCRIPTS.rollback.sql`. `export-scripts` pairs each final forward with `rollback/<categoría>/NN-<nombre>.rollback.sql` and derives `rollback/00-global/00-ROLLBACK.sql` in safe reverse order. Know the strategies to write reversible forwards:

| Forward | Rollback |
|---|---|
| `CREATE TABLE IF NOT EXISTS tb_x` | `DROP TABLE IF EXISTS tb_x;` |
| `ALTER TABLE tb_x ADD COLUMN col` | `ALTER TABLE tb_x DROP COLUMN IF EXISTS col;` |
| `CREATE INDEX idx_...` | `DROP INDEX IF EXISTS idx_...;` |
| `CREATE SEQUENCE seq_...` | `DROP SEQUENCE IF EXISTS seq_...;` |
| `CREATE OR REPLACE FUNCTION fn_x(...)` | `DROP FUNCTION IF EXISTS fn_x(<signature>);` |
| `UPDATE/DELETE` with a declared backup table | `UPDATE … FROM <backup_schema>.<backup_table>` |
| `INSERT INTO tb_x VALUES (...)` | `DELETE FROM tb_x WHERE <natural key / range>;` (never DELETE without WHERE) |

**Irreversible → manual "Fase 5" block** (outside the transaction, one line per case): `TRUNCATE`, `DROP COLUMN`/`DROP TABLE` without backup, lossy `ALTER COLUMN TYPE`, `DROP ... CASCADE`, `DELETE/UPDATE` without a declared backup. To make a destructive change reversible, write the project-appropriate backup in the same forward (`<backup_schema>.<backup_table>`).

## Output

- During loops: forwards in `SCRIPTS.sql`, reverses in `SCRIPTS.rollback.sql` (session artifacts, never `docs/`).
- Via `export-scripts`: five category folders (`01-ddl-tablas` … `05-grants`) with numbered forwards, matching reverses in `rollback/<categoría>/` and the global reverse in `rollback/00-global/00-ROLLBACK.sql`; empty categories have no folder.

It never writes `docs/` from a loop (invariant 1: only `export-*` exports). It never executes anything against a DB (invariant 4).

## Source

Self-contained rules (no dependency on external skills). Rationale and history: design (`docs/referencias/workflow-roles/`).
