-- SCRIPTS.rollback.sql — reverse of the type-B migrations in SCRIPTS.sql.
-- NEVER run with a forward; a human/DBA applies the exported rollback if needed.
-- Each marker corresponds to a forward in SCRIPTS.sql. Type-A reads have no reverse.

-- [M1] <migration> — inverse of SCRIPTS.sql#M1
-- @category: 01-ddl-tablas
-- @stmt: 01-revertir-tabla
ALTER TABLE ... ;
