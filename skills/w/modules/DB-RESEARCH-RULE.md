# DB-RESEARCH-RULE — the single exception to research autonomy

Loaded when the run reads or writes a database (signal `db`).

Research is autonomous except for DB choice. A remote read is context, never plan-execution proof.

1. With >1 candidate MCP and no default, ask which one through the content structured-choice (inside the ≤3 + `flow` limit) before querying; otherwise do not ask.
2. Write queries first in session `SCRIPTS.sql`.
3. Run them read-only via MCP (`sql-mutation-guard`: never DML/DDL), then record `RemoteContextSnapshot` in `SCRIPTS.sql` plus conclusion/digest in `CONCLUSIONS.md` before plan approval.

> Snapshots have no automatic TTL; refreshing during execution means `/w:plan-refine`. The AI **never executes DML/DDL**. Draft migrations in session `SCRIPTS.sql`; `export-*` promotes them separately as handoff.
