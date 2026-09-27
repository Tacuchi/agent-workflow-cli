-- SCRIPTS.sql — session artifact (common)
--
-- What it is: SQL and remote-read context produced by a session. TWO roles are distinguished:
--   A) READ-ONLY remote queries: research context captured before plan approval, never
--      execution validation or a closing proof.
--   B) DDL/DML migrations: the AI DRAFTS the forwards here, NEVER executes them;
--      their reverses live in SCRIPTS.rollback.sql. A human/DBA applies the export.
--
-- Golden rule: the AI only EXECUTES type A (read-only). The sql-mutation-guard BLOCKS
-- execution of DML/DDL — that is why type B is DELIVERED, not run.
--
-- Rules:
--   1) One entry per script, numbered, with purpose, DB/MCP target and type (A or B).
--   2) A type A entry records `{kind: remote-read, connection, readonly: true, query_artifact,
--      captured_at, result_digest}` and has a matching note in CONCLUSIONS.md.
--   3) Lives in the session (.workflow/sessions/NNN-.../SCRIPTS.sql).
--   4) Type B is exported to docs/scripts/ as a deliverable (not executed by the AI).

-- ============================================================
-- [Q1] <purpose of the query>   |   Type: A (remote-read research context)
-- Snapshot: {kind: remote-read, connection: <which>, readonly: true,
--            query_artifact: SCRIPTS.sql#Q1, captured_at: <ISO-8601>, result_digest: <digest>}
-- Origin: <research gap only; never a plan task/validation/exit condition>
-- ------------------------------------------------------------
SELECT ...;

-- ============================================================
-- [Q2] <purpose>   |   Type: A (remote-read research context)
-- Snapshot: {kind: remote-read, connection: <which>, readonly: true,
--            query_artifact: SCRIPTS.sql#Q2, captured_at: <ISO-8601>, result_digest: <digest>}
-- Origin: <research gap only>
-- ------------------------------------------------------------
SELECT ...;

-- ============================================================
-- [M1] <migration>   |   Type: B  —  DO NOT EXECUTE (external application is handoff)
-- DB/MCP: <which>   |   Origin: <plan task>
-- ------------------------------------------------------------
ALTER TABLE ... ;
-- Reverse: SCRIPTS.rollback.sql#M1 (separate artifact; never inline).
