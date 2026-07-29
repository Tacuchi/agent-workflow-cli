# EXEC-DB-POLICY — the DB rule inside execution

Loaded when a phase touches the database (signal `db`).

## Delta 3 — DB policy: **the AI never executes DML**

Full policy in [`DB-SCRIPTS-ONLY.md`](DB-SCRIPTS-ONLY.md), the `db` module of [`../loops/CODE-POLICIES.md`](../loops/CODE-POLICIES.md). **Inline:** read-only queries → the session's `SCRIPTS.sql`, executed via MCP (`sql-mutation-guard`); DDL/DML migrations → the AI **drafts them in `SCRIPTS.sql` but NEVER executes them** — their promotion to `docs/scripts/` is done by a separate `export-*`, never this loop.
