# DB-RESEARCH-RULE — the single exception to research autonomy

Loaded when the run reads or writes a database (signal `db`).

Investigation is otherwise autonomous: the AI investigates inline and reports without asking permission. A database is the one place where it asks first.

1. **MCP choice**: if the gap needs DB and there is **>1 candidate MCP with no configured default**, the AI asks which one to use. That question goes through the **same structured-choice** as a **content question** (counts inside the ≤3 + `flow` limit), **before** running queries. A single MCP or a default → no question.
2. Write the queries **first** into the session's `SCRIPTS.sql`.
3. Execute them **read-only** via MCP (respect `sql-mutation-guard`: never DML/DDL).

> The AI **never executes DML/DDL**. A migration is drafted in the session's `SCRIPTS.sql` and handed off; promoting it to `docs/scripts/` is a separate `export-*`, never a loop.
