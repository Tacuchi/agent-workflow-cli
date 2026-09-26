import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runSqlMutationGuard } from "../../src/application/hook-sql-mutation-guard.js";
import { PathsService } from "../../src/application/paths-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
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

// qtc-cert is registered in `aw self mcp`, so it is PostgreSQL; qtc-prod is not.
const POSTGRES_TOOL = "mcp__qtc-cert__execute_sql";
const UNKNOWN_TOOL = "mcp__qtc-prod__execute_sql";

let homes: string;
let registeredHome: string;

function writeRegistry(home: string, content: string): void {
  const file = new PathsService(
    normalizeNamespace("workflow"),
    home,
    home,
  ).userMcpConnectionsFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

beforeAll(() => {
  homes = mkdtempSync(join(tmpdir(), "aw-sql-guard-"));
  registeredHome = join(homes, "registered");
  writeRegistry(
    registeredHome,
    JSON.stringify({
      version: 2,
      connections: [{ name: "qtc-cert", dsnVar: "DB_CERT_DSN", provider: "postgres" }],
    }),
  );
});

afterAll(() => rmSync(homes, { recursive: true, force: true }));

function guard(
  sql: string,
  vars: Record<string, string> = {},
  toolName = UNKNOWN_TOOL,
  home = registeredHome,
) {
  return runSqlMutationGuard({
    stdin: JSON.stringify({ tool_name: toolName, tool_input: { sql } }),
    env: new FakeEnv(home, home, vars),
    runtime,
    paths: new PathsService(normalizeNamespace("workflow"), home, home),
  });
}

function guardPostgres(sql: string) {
  return guard(sql, {}, POSTGRES_TOOL);
}

describe("runSqlMutationGuard", () => {
  it.each([
    // S051/AC-07: mutation words inside a literal, a quoted identifier or a comment.
    "SELECT has_database_privilege(current_user, 'esq', 'CREATE')",
    "SELECT position('INSERT INTO x' in prosrc) FROM pg_proc",
    'SELECT "update" FROM esq.tb_x',
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
    // MySQL reads `$$` as identifier characters, so the `;` inside splits there.
    ["SELECT $$; DELETE FROM t; $$", "que sólo PostgreSQL lee como literal"],
    ["SELECT $$DELETE FROM esq.tb_x$$ AS texto", "que sólo PostgreSQL lee como literal"],
  ])("bloquea %s en un servidor que no está registrado", (sql, reason) => {
    const result = guard(sql);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(reason);
  });

  it.each([
    "SELECT data #> '{a,b}' FROM esq.tb_x",
    "SELECT data #>> '{a}' FROM esq.tb_x",
    "SELECT data #- '{a}' FROM esq.tb_x",
    "SELECT 5 # 3",
    String.raw`SELECT replace(ruta, '\', '/') FROM esq.tb_x`,
    String.raw`SELECT 1 FROM esq.tb_x WHERE a LIKE 'x\_%' ESCAPE '\'`,
    "SELECT `id` FROM t",
    "SELECT 1 /*! DELETE FROM t */",
    "SELECT $$DELETE FROM esq.tb_x$$ AS texto",
  ])("lee como PostgreSQL al servidor registrado: deja pasar %s", (sql) => {
    expect(guardPostgres(sql)).toEqual({ exitCode: 0 });
  });

  it.each([
    ["SELECT data #> '{a}' FROM t; DELETE FROM t", "DELETE no es una lectura"],
    [String.raw`SELECT 'a\'; DELETE FROM t`, "DELETE no es una lectura"],
    ["DO $$ BEGIN PERFORM esq.fn_x(); END $$", "DO no es una lectura"],
    ["DO $$ BEGIN DELETE FROM esq.tb_x; END $$", "DO no es una lectura"],
  ])("en el servidor registrado sigue bloqueando %s", (sql, reason) => {
    const result = guardPostgres(sql);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(reason);
  });

  it("lee un registro ilegible como un servidor que no está registrado", () => {
    const home = join(homes, "corrupt");
    writeRegistry(home, '{"version": 2, "connections": [{"name": "qtc-cert"');
    const result = guard("SELECT data #> '{a}' FROM t", {}, POSTGRES_TOOL, home);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("un # fuera de un literal");
  });

  it.each([
    "SELECT query_to_xml('SELECT * FROM esq.tb_x', true, false, '')",
    "SELECT query_to_xml($$SELECT 'a' AS x$$, true, false, '')",
    "SELECT * FROM dblink('dbname=otra', 'SELECT id FROM esq.tb_x') AS t(id int)",
    "SELECT dblink_exec('dbname=otra', 'SELECT 1', false)",
  ])("deja pasar una función que ejecuta SQL de lectura: %s", (sql) => {
    expect(guardPostgres(sql)).toEqual({ exitCode: 0 });
  });

  it.each([
    [
      "SELECT dblink_exec('dbname=otra', 'DELETE FROM esq.tb_x')",
      "dblink_exec ejecuta un SQL que no lee: DELETE no es una lectura",
    ],
    ["SELECT dblink_exec('DELETE FROM esq.tb_x', true)", "DELETE no es una lectura"],
    ["SELECT public.dblink_exec('DELETE FROM esq.tb_x')", "DELETE no es una lectura"],
    [
      "SELECT * FROM dblink('c', 'UPDATE esq.tb_x SET a = 1 RETURNING id') AS t(id int)",
      "dblink ejecuta un SQL que no lee: UPDATE no es una lectura",
    ],
    [
      "SELECT query_to_xml('DELETE FROM esq.tb_x RETURNING *', true, false, '')",
      "query_to_xml ejecuta un SQL que no lee: DELETE no es una lectura",
    ],
    [
      "SELECT query_to_xml('SELECT 1; DELETE FROM esq.tb_x', true, false, '')",
      "DELETE no es una lectura",
    ],
    [
      "SELECT query_to_xml('SELECT query_to_xml(''DELETE FROM esq.tb_x RETURNING *'', true, false, '''')', true, false, '')",
      "DELETE no es una lectura",
    ],
    ["SELECT \"dblink_exec\"('dbname=otra', 'DELETE FROM esq.tb_x')", "DELETE no es una lectura"],
    [
      "SELECT dblink_exec('dbname=otra', 'DEL' || 'ETE FROM esq.tb_x')",
      "dblink_exec ejecuta un SQL que no es un único literal",
    ],
    [
      "SELECT query_to_xml(E'DELETE FROM esq.tb_x', true, false, '')",
      "query_to_xml ejecuta un SQL que no es un único literal",
    ],
    [
      String.raw`SELECT U&"d\0062link_exec"('dbname=otra', 'DELETE FROM esq.tb_x')`,
      "nombre lleva escapes U&",
    ],
    [
      `SELECT U&"d!0062link_exec" UESCAPE '!'('dbname=otra', 'DELETE FROM esq.tb_x')`,
      "nombre lleva escapes U&",
    ],
  ])("bloquea una función que ejecuta SQL que no lee: %s", (sql, reason) => {
    const result = guardPostgres(sql);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(reason);
  });

  // The host blocks only on exit 2: a nesting that exhausts the stack must not
  // turn into the CLI's generic failure, which lets the call through.
  it.each([
    [
      "funciones que ejecutan SQL",
      Array.from({ length: 6000 }).reduce<string>(
        (inner, _, depth) => `SELECT dblink_exec($t${depth}$${inner}$t${depth}$)`,
        "SELECT 1",
      ),
    ],
    ["EXPLAIN", `${"EXPLAIN ".repeat(20000)}SELECT 1`],
  ])("bloquea lo que anida %s más de lo que la guarda puede recorrer", (_, sql) => {
    const result = guardPostgres(sql);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("no se pudo clasificar");
  });

  it("dice qué motor leyó en cada servidor", () => {
    expect(guardPostgres("DELETE FROM esq.tb_x").stderr).toContain(
      "Motor     : PostgreSQL, registrado en aw self mcp",
    );
    expect(guard("DELETE FROM esq.tb_x").stderr).toContain("Motor     : sin declarar");
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
