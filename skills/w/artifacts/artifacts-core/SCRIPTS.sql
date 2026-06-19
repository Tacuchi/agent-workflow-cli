-- SCRIPTS.sql — session artifact (common)
--
-- What it is: the SQL produced by a session. TWO types, distinguished by whether they are EXECUTED:
--   A) READ-ONLY queries (diagnosis/validation): the AI writes them here and then
--      executes them read-only via MCP.
--   B) DDL/DML migrations (schema/data changes): the AI DRAFTS them as a
--      deliverable but NEVER executes them; they are exported to docs/scripts/ (forward +
--      rollback) for a human/DBA to apply.
--
-- Golden rule: the AI only EXECUTES type A (read-only). The sql-mutation-guard BLOCKS
-- execution of DML/DDL — that is why type B is DELIVERED, not run.
--
-- Rules:
--   1) One entry per script, numbered, with purpose, DB/MCP target and type (A or B).
--   2) Only type A is executed (read-only, via the declared MCP).
--   3) Lives in the session (.workflow/sessions/NNN-.../SCRIPTS.sql).
--   4) Type B is exported to docs/scripts/ as a deliverable (not executed by the AI).

-- ============================================================
-- [Q1] <purpose of the query>   |   Type: A (read-only)
-- DB/MCP: <which>   |   Origin: <gap / task that motivates it>
-- ------------------------------------------------------------
SELECT ...;

-- ============================================================
-- [Q2] <purpose>   |   Type: A (read-only)
-- DB/MCP: <which>   |   Origin: <...>
-- ------------------------------------------------------------
SELECT ...;

-- ============================================================
-- [M1] <migration>   |   Type: B  —  DO NOT EXECUTE (deliverable; applied by a DBA;
--                        exported to docs/scripts/ via export-*)
-- DB/MCP: <which>   |   Origin: <plan task>
-- ------------------------------------------------------------
-- forward:
ALTER TABLE ... ;
-- rollback:
-- ALTER TABLE ... ;
