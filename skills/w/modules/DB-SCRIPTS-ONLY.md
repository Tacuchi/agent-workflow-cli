# DB-SCRIPTS-ONLY — mutating SQL is drafted, never executed

Loaded when a code-editing run touches the database (signal `db`).

## DB scripts-only — the AI never executes DML/DDL

Classify SQL by **purpose**, not file extension:

- **Read-only remote query** → research context: record query, digest and `RemoteContextSnapshot` before approval.
- **Fixture/ephemeral DB test** → checkout proof; may validate a phase locally.
- **DDL/DML migration** → draft as a file in `docs/scripts/`; **NEVER execute** by shell, MCP, driver or any other channel.

> Migration application is a non-blocking handoff, never a task, validation or exit condition. The plan closes on its local contract/tests; the script file in `docs/scripts/` is the evidence, not narration.
