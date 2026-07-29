# DB-SCRIPTS-ONLY — mutating SQL is drafted, never executed

Loaded when a code-editing run touches the database (signal `db`).

## DB scripts-only — the AI never executes DML/DDL

Distinguished by **execution**, not by file (see the [`SCRIPTS.sql`](../artifacts/artifacts-core/SCRIPTS.sql) schema):

- **Read-only queries** (diagnosis/validation) → `SCRIPTS.sql` (session artifact); the AI **does** execute them read-only via MCP (`sql-mutation-guard`).
- **DDL/DML migrations** (schema/data changes) → the AI **drafts them in `SCRIPTS.sql`** (session artifact) but **NEVER executes them**.

> Mutating SQL **stays in the session**; it is never moved to `docs/`. Its promotion to `docs/scripts/` (forward + rollback) is done by a separate `export-*`, never by the loop.
