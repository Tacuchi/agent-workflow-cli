import { describe, expect, it } from "vitest";
import { runSqlMutationGuard } from "../../src/application/hook-sql-mutation-guard.js";
import type { ResolvedRuntime } from "../../src/runtime/types.js";
import { FakeEnv } from "../helpers/fake-env.js";

const runtime: ResolvedRuntime = {
  packageName: "@tacuchi/agent-workflow-cli",
  binName: "agent-workflow",
  source: "user-config",
  mcpGuards: {
    sqlMutation: { toolPattern: "^mcp__.+__execute_sql$", serverPattern: "^mcp__(.+?)__" },
  },
};

function guard(
  sql: string,
  vars: Record<string, string> = {},
  toolName = "mcp__qtc-prod__execute_sql",
) {
  return runSqlMutationGuard({
    stdin: JSON.stringify({ tool_name: toolName, tool_input: { sql } }),
    env: new FakeEnv("/home/u", "/home/u", vars),
    runtime,
  });
}

describe("runSqlMutationGuard", () => {
  it.each([
    // S051/AC-07: mutation words inside a literal, a quoted identifier or a comment.
    "SELECT has_database_privilege(current_user, 'esq', 'CREATE')",
    "SELECT position('INSERT INTO x' in prosrc) FROM pg_proc",
    'SELECT "update" FROM esq.tb_x',
    "SELECT $$DELETE FROM esq.tb_x$$ AS texto",
    "SELECT 1 -- DELETE FROM esq.tb_x",
    "SELECT 1 /* a /* DELETE FROM esq.tb_x */ b */",
    String.raw`SELECT E'it\'s; DELETE FROM esq.tb_x'`,
    // The read forms the spec defines.
    "WITH RECURSIVE t(n) AS (VALUES (1) UNION ALL SELECT n + 1 FROM t WHERE n < 5) SELECT * FROM t",
    "WITH a AS MATERIALIZED (SELECT 1), b AS NOT MATERIALIZED (SELECT 2) SELECT * FROM a, b",
    "EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM esq.tb_x",
    "EXPLAIN ANALYZE VERBOSE SELECT * FROM esq.tb_x",
    "SHOW search_path",
    "VALUES (1, 'a'), (2, 'b')",
    "TABLE esq.tb_x",
    "(SELECT 1) UNION (SELECT 2)",
    "SELECT 1; SELECT 2;",
    "-- sólo un comentario",
  ])("deja pasar la lectura %s", (sql) => {
    expect(guard(sql)).toEqual({ exitCode: 0 });
  });

  it.each([
    // S051/AC-08: a real mutation behind a literal that holds `--` or `/*`.
    ["SELECT '--' AS x; DELETE FROM esq.tb_x", "DELETE no es una lectura"],
    ["SELECT '/*' AS a; UPDATE esq.tb_x SET y=1; SELECT '*/'", "UPDATE no es una lectura"],
    // S051/AC-12: statements that are not reads, with or without a mutation word.
    ["DO $$ BEGIN PERFORM esq.fn_x(); END $$", "DO no es una lectura"],
    ["DO $$ BEGIN DELETE FROM esq.tb_x; END $$", "DO no es una lectura"],
    ["CALL esq.sp_limpiar()", "CALL no es una lectura"],
    ["SELECT * INTO esq.tb_copia FROM esq.tb_x", "lleva INTO"],
    ["VACUUM esq.tb_x", "VACUUM no es una lectura"],
    ["SET search_path TO esq", "SET no es una lectura"],
    [
      "WITH d AS (DELETE FROM esq.tb_x RETURNING *) SELECT * FROM d",
      "una parte del WITH: DELETE no es una lectura",
    ],
    [
      "WITH x AS (SELECT 1) DELETE FROM esq.tb_x",
      "la sentencia principal del WITH: DELETE no es una lectura",
    ],
    ["WITH x AS (SELECT 1) SELECT * INTO t FROM x", "lleva INTO"],
    ["EXPLAIN ANALYZE DELETE FROM esq.tb_x", "EXPLAIN de otra sentencia: DELETE no es una lectura"],
    ["EXPLAIN ANALYZE SELECT * INTO t FROM esq.tb_x", "lleva INTO"],
    ["SELECT 'sin cerrar FROM esq.tb_x", "no se puede delimitar"],
    // Delimitation edges: each hides a second statement under some reading.
    ["SELECT 1 AS x$a$; DELETE FROM esq.tb_x; SELECT 2 AS y$a$", "DELETE no es una lectura"],
    [String.raw`SELECT namE'\'; DELETE FROM esq.tb_x; SELECT 1 -- '`, "antes de una comilla"],
    ["SELECT 1 -- x\r; DELETE FROM esq.tb_x", "DELETE no es una lectura"],
    [String.raw`SELECT 'a\'; SELECT '; DELETE FROM t; -- '`, "antes de una comilla"],
    [String.raw`SELECT "a\"; SELECT "; DELETE FROM t; -- "`, "antes de una comilla"],
    ["SELECT 1 # '\n; DELETE FROM t; -- '", "un # fuera de un literal"],
    ["SELECT `id` FROM t", "backtick"],
    ["/*! DELETE FROM t */", "que MySQL ejecuta como SQL"],
  ])("bloquea %s", (sql, reason) => {
    const result = guard(sql);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(reason);
  });

  it("nombra la sentencia que no lee y conserva la política y las excepciones", () => {
    const { stderr } = guard("SELECT 1;\n  DELETE   FROM esq.tb_x;\n");
    expect(stderr).toContain("Sentencia : 2 de 2 · DELETE FROM esq.tb_x");
    expect(stderr).toContain("Motivo    : DELETE no es una lectura");
    expect(stderr).toContain("Servidor  : mcp__qtc-prod__");
    expect(stderr).toContain("docs/scripts/");
    expect(stderr).toContain("AW_SQL_GUARD=off");
    expect(stderr).toContain("AW_SQL_GUARD_ALLOW=<servidor>");
  });

  it("abre la guarda con las excepciones que delega la persona", () => {
    const mutation = "DELETE FROM esq.tb_x";
    expect(guard(mutation, { AW_SQL_GUARD: "off" })).toEqual({ exitCode: 0 });
    expect(guard(mutation, { AW_SQL_GUARD_ALLOW: "qtc-cert, qtc-prod" })).toEqual({ exitCode: 0 });
    expect(guard(mutation, { AW_SQL_GUARD_ALLOW: "qtc-cert" }).exitCode).toBe(2);
  });

  it("no evalúa una herramienta que no casa con el patrón", () => {
    expect(guard("DELETE FROM esq.tb_x", {}, "mcp__qtc-prod__search_objects")).toEqual({
      exitCode: 0,
    });
  });
});
