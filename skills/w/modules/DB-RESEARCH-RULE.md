# DB-RESEARCH-RULE — the single exception to research autonomy

Loaded when the run reads or writes a database (signal `db`).

Research is autonomous except for DB choice. A remote read is context, never plan-execution proof.

1. With >1 candidate MCP and no default, ask which one through the content structured-choice (inside the ≤3 + `flow` limit) before querying; otherwise do not ask.
2. Write queries first in a `.sql` file of `docs/scripts/` or the conversation.
3. Run them read-only through the host's MCP (never DML/DDL), then record `RemoteContextSnapshot` in `SCRIPTS.sql` plus conclusion/digest in `CONCLUSIONS.md` before plan approval.
4. Estimate read cost before running: a primary-key lookup or up to 1,000 rows can run directly; 1,001–10,000 rows or a small-table scan merits a cost notice; larger reads require explicit confirmation. Never turn an unavailable remote read into checkout validation evidence.

> Snapshots have no automatic TTL; refreshing during execution means `/w:plan-refine`. The AI **never executes DML/DDL**. Draft migrations as files in `docs/scripts/`; `/w:export-scripts` consolidates them separately as handoff.
