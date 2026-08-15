# DB-SCRIPTS-ONLY — mutating SQL is drafted, never executed

Loaded when a code-editing run touches the database (signal `db`).

## DB scripts-only — the AI never executes DML/DDL

Classify by **role**, not file (see [`SCRIPTS.sql`](../artifacts/artifacts-core/SCRIPTS.sql)):

- **Read-only remote query** → research context: record query, digest and `RemoteContextSnapshot` before approval.
- **Fixture/ephemeral DB test** → checkout proof; may validate a phase locally.
- **DDL/DML migration** → draft in session `SCRIPTS.sql`; **NEVER execute**.

> Migration application is a non-blocking handoff, never a task, validation or exit condition. The plan closes on its local contract/tests; the deterministic steps below are decided by the CLI (`aw flow advance`), not by this document and it verifies the session script, not narration.
