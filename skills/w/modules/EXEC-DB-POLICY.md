# EXEC-DB-POLICY — the DB rule inside execution

Loaded when a phase touches the database (signal `db`).

## Delta 3 — DB policy: **checkout proof, never deployed closure**

See [`DB-SCRIPTS-ONLY.md`](DB-SCRIPTS-ONLY.md) and [`../loops/CODE-POLICIES.md`](../loops/CODE-POLICIES.md). Fixture/ephemeral-DB checks in the acquired checkout may close a phase. Do not open remote reads here: they are captured research context. Draft DDL/DML in `SCRIPTS.sql`; applying it is handoff and never blocks `validada` or plan closure.
