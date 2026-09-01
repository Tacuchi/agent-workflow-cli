import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresReadonlyTools } from "../../src/adapters/postgres-readonly-tools.js";
import { DatabaseToolCatalog } from "../../src/application/database-tool-catalog.js";
import { upsertMcpConnection } from "../../src/application/mcp-connections-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import { MAX_TOOL_RESULT_BYTES, type ToolResponse } from "../../src/domain/database-tools.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

/**
 * These tests intentionally require an explicit disposable PostgreSQL target.
 * They create one randomly-named schema and remove it in afterAll; no default
 * developer database is ever discovered or used. AW_TEST_POSTGRES_DSN is the
 * non-superuser runtime role; AW_TEST_POSTGRES_ADMIN_DSN may separately own
 * fixture setup and grants when the runtime role cannot create schemas.
 */
const TEST_DSN = process.env.AW_TEST_POSTGRES_DSN;
const ADMIN_DSN = process.env.AW_TEST_POSTGRES_ADMIN_DSN;
const describePostgres = TEST_DSN === undefined || TEST_DSN.length === 0 ? describe.skip : describe;
const timeoutIt = process.env.AW_TEST_POSTGRES_TIMEOUT === "1" ? it : it.skip;

interface IntegrationFixture {
  dsn: string;
  schema: string;
  procedureAvailable: boolean;
}

interface PostgreSqlRole {
  name: string;
  superuser: boolean;
}

interface SearchExpectation {
  input: Record<string, unknown>;
  name: string;
  requiredFields: readonly string[];
}

type SearchObjectType = "schema" | "table" | "view" | "column" | "procedure" | "function" | "index";
type SearchDetailLevel = "names" | "summary" | "full";

const REQUIRED_SEARCH_FIELDS: Record<
  SearchObjectType,
  Record<SearchDetailLevel, readonly string[]>
> = {
  schema: {
    names: ["name"],
    summary: ["name", "table_count"],
    full: ["name", "table_count"],
  },
  table: {
    names: ["name", "schema"],
    summary: ["name", "schema", "column_count", "row_count"],
    full: ["name", "schema", "column_count", "row_count", "columns", "indexes"],
  },
  view: {
    names: ["name", "schema"],
    summary: ["name", "schema", "column_count"],
    full: ["name", "schema", "column_count", "columns", "indexes"],
  },
  column: {
    names: ["name", "table", "schema"],
    summary: ["name", "table", "schema", "type", "nullable", "default"],
    full: ["name", "table", "schema", "type", "nullable", "default"],
  },
  procedure: {
    names: ["name"],
    summary: ["name", "type", "language"],
    full: ["name", "type", "language", "parameters"],
  },
  function: {
    names: ["name"],
    summary: ["name", "type", "language"],
    full: ["name", "type", "language", "parameters"],
  },
  index: {
    names: ["name", "table", "schema"],
    summary: ["name", "table", "schema", "columns", "unique", "primary"],
    full: ["name", "table", "schema", "columns", "unique", "primary"],
  },
};

let fixture: IntegrationFixture | undefined;
let admin: Client | undefined;
let catalog: DatabaseToolCatalog | undefined;
let readonlyTools: PostgresReadonlyTools | undefined;
let createdSchema: string | undefined;
let temporaryRoot: string | undefined;

describePostgres("PostgresReadonlyTools integration", () => {
  beforeAll(async () => {
    const dsn = testDsn();
    temporaryRoot = mkdtempSync(join(tmpdir(), "aw-postgres-tools-"));
    createdSchema = fixtureSchemaName();
    const runtimeRole = await inspectRole(dsn);
    if (runtimeRole.superuser) {
      throw new Error(
        "AW_TEST_POSTGRES_DSN debe usar un rol no superusuario; usá AW_TEST_POSTGRES_ADMIN_DSN sólo para preparar el fixture.",
      );
    }
    admin = new Client({ connectionString: adminDsn() });
    await admin.connect();

    const schema = quoteIdentifier(createdSchema);
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(
      `CREATE TABLE ${schema}.fixture_rows (
        number integer PRIMARY KEY,
        label text NOT NULL
      )`,
    );
    await admin.query(`CREATE TABLE ${schema}.fixture_write_log (id integer NOT NULL)`);
    await admin.query(
      `INSERT INTO ${schema}.fixture_rows (number, label)
       SELECT value, 'row-' || value::text
       FROM generate_series(1, 1001) AS series(value)`,
    );
    await admin.query(
      `CREATE VIEW ${schema}.fixture_view AS SELECT number FROM ${schema}.fixture_rows`,
    );
    await admin.query(`CREATE INDEX fixture_rows_label_idx ON ${schema}.fixture_rows (label)`);
    await admin.query(
      `CREATE FUNCTION ${schema}.fixture_function(value integer)
       RETURNS integer
       LANGUAGE sql
       IMMUTABLE
       AS $$ SELECT value $$`,
    );
    await admin.query(
      `CREATE FUNCTION ${schema}.fixture_write_function()
       RETURNS void
       LANGUAGE plpgsql
       VOLATILE
       AS $$ BEGIN INSERT INTO ${schema}.fixture_write_log (id) VALUES (1); END $$`,
    );

    const version = await admin.query<{ server_version_num: string }>("SHOW server_version_num");
    const procedureAvailable =
      Number.parseInt(version.rows[0]?.server_version_num ?? "0", 10) >= 110_000;
    if (procedureAvailable) {
      await admin.query(
        `CREATE PROCEDURE ${schema}.fixture_procedure()
         LANGUAGE sql
         AS $$ SELECT 1 $$`,
      );
    }
    await grantFixtureRead(admin, createdSchema, runtimeRole.name);

    const paths = new PathsService(normalizeNamespace("workflow"), temporaryRoot, temporaryRoot);
    upsertMcpConnection(paths, {
      name: "integration",
      dsnVar: "AW_TEST_POSTGRES_DSN",
    });
    readonlyTools = new PostgresReadonlyTools();
    catalog = new DatabaseToolCatalog({
      paths,
      env: new FakeEnv(temporaryRoot, temporaryRoot, { AW_TEST_POSTGRES_DSN: dsn }),
      postgres: readonlyTools,
    });
    fixture = { dsn, schema: createdSchema, procedureAvailable };
  }, 15_000);

  afterAll(async () => {
    const client = admin;
    const schema = createdSchema;
    const root = temporaryRoot;
    try {
      if (client !== undefined && schema !== undefined) {
        await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      }
    } finally {
      if (client !== undefined) await client.end().catch(() => undefined);
      if (root !== undefined) rmSync(root, { recursive: true, force: true });
      admin = undefined;
      fixture = undefined;
      catalog = undefined;
      readonlyTools = undefined;
      createdSchema = undefined;
      temporaryRoot = undefined;
    }
  }, 15_000);

  it("lee una consulta a través del catálogo con el payload canónico", async () => {
    const outcome = await currentCatalog().call({
      tool: "execute_sql",
      connection: "integration",
      input: { sql: `SELECT number, label FROM ${fixtureTable()} WHERE number = 1` },
    });

    expect(outcome.exitCode).toBe(0);
    expect(statementRows(outcome.response)).toEqual([{ number: 1, label: "row-1" }]);
  });

  it("ejecuta cada nivel de detalle para los objetos PostgreSQL publicados", async () => {
    for (const expectation of searchExpectations()) {
      const outcome = await currentCatalog().call({
        tool: "search_objects",
        connection: "integration",
        input: expectation.input,
      });

      expect(outcome.exitCode).toBe(0);
      const object = objectRows(outcome.response).find((item) => item.name === expectation.name);
      expect(object).toMatchObject({ name: expectation.name });
      for (const field of expectation.requiredFields) expect(object).toHaveProperty(field);
      expect(searchEnvelope(outcome.response)).toMatchObject({
        object_type: expectation.input.object_type,
        detail_level: expectation.input.detail_level,
        results: expect.any(Array),
      });
    }
  });

  it("conserva los límites 999, 1000 y 1001 en el payload del catálogo", async () => {
    for (const expected of [
      { limit: 999, count: 999, truncated: false },
      { limit: 1000, count: 1000, truncated: false },
      { limit: 1001, count: 1000, truncated: true },
    ]) {
      const outcome = await currentCatalog().call({
        tool: "execute_sql",
        connection: "integration",
        input: {
          sql: `SELECT number FROM ${fixtureTable()} ORDER BY number ASC LIMIT ${expected.limit}`,
        },
      });
      const statement = firstStatement(outcome.response);

      expect(outcome.exitCode).toBe(0);
      expect(statement.count).toBe(expected.count);
      expect(statementRows(outcome.response)).toHaveLength(expected.count);
      expect(statement.truncated).toBe(expected.truncated ? true : undefined);
    }
  });

  it("acota el cursor del adaptador a 1000 filas y señala truncamiento observado", async () => {
    const result = await currentReadonlyTools().execute(
      `SELECT number FROM ${fixtureTable()} ORDER BY number ASC`,
      currentFixture().dsn,
    );

    expect(result.rows).toHaveLength(1000);
    expect(result.rows[0]).toEqual({ number: 1 });
    expect(result.rows[999]).toEqual({ number: 1000 });
    expect(result.truncated).toBe(true);
  });

  it("cierra el cursor localmente rechazado por 4 MiB y permite reconectar", async () => {
    const oversized = await currentCatalog().call({
      tool: "execute_sql",
      connection: "integration",
      input: { sql: `SELECT repeat('x', ${MAX_TOOL_RESULT_BYTES}) AS payload` },
    });
    const recovered = await currentCatalog().call({
      tool: "execute_sql",
      connection: "integration",
      input: { sql: "SELECT 1 AS ok" },
    });

    expect(oversized).toMatchObject({
      exitCode: 1,
      response: { success: false, code: "RESULT_TOO_LARGE" },
    });
    expect(statementRows(recovered.response)).toEqual([{ ok: 1 }]);
  }, 10_000);

  it("preserva bigint como un valor JSON seguro", async () => {
    const outcome = await currentCatalog().call({
      tool: "execute_sql",
      connection: "integration",
      input: { sql: "SELECT 9223372036854775807::bigint AS value" },
    });
    const row = statementRows(outcome.response)[0];

    expect(outcome.exitCode).toBe(0);
    expect(row).toEqual({ value: "9223372036854775807" });
  });

  it("bloquea DML, DDL, CTE modificadores, COPY, CALL, DO, SELECT INTO y varias sentencias sin cambios", async () => {
    const before = await fixtureRowCount();
    const schema = quoteIdentifier(currentFixture().schema);
    const queries = [
      {
        sql: `INSERT INTO ${fixtureTable()} (number, label) VALUES (1002, 'not-written')`,
        code: "READ_ONLY_POLICY",
      },
      {
        sql: `CREATE TABLE ${schema}.must_not_exist (id integer)`,
        code: "READ_ONLY_POLICY",
      },
      {
        sql: `WITH changed AS (DELETE FROM ${fixtureTable()} WHERE number = 1 RETURNING number) SELECT * FROM changed`,
        code: "READ_ONLY_POLICY",
      },
      {
        sql: `SELECT number INTO ${schema}.must_not_exist FROM ${fixtureTable()}`,
        code: "READ_ONLY_POLICY",
      },
      { sql: `COPY ${fixtureTable()} TO STDOUT`, code: "READ_ONLY_POLICY" },
      { sql: `CALL ${schema}.fixture_procedure()`, code: "READ_ONLY_POLICY" },
      { sql: "DO $$ BEGIN PERFORM 1; END $$", code: "READ_ONLY_POLICY" },
      { sql: "SELECT 1; SELECT 2", code: "MULTI_STATEMENT_UNSUPPORTED" },
    ];

    for (const query of queries) {
      const outcome = await currentCatalog().call({
        tool: "execute_sql",
        connection: "integration",
        input: { sql: query.sql },
      });

      expect(outcome.exitCode).toBe(1);
      expect(outcome.response).toMatchObject({ success: false, code: query.code });
    }

    expect(await fixtureRowCount()).toBe(before);
    expect(await relationExists("must_not_exist")).toBe(false);
  });

  it("impide que una función con escritura deje cambios dentro de READ ONLY", async () => {
    const schema = quoteIdentifier(currentFixture().schema);
    const outcome = await currentCatalog().call({
      tool: "execute_sql",
      connection: "integration",
      input: { sql: `SELECT ${schema}.fixture_write_function()` },
    });

    expect(outcome).toMatchObject({
      exitCode: 1,
      response: { success: false, code: "READ_ONLY_POLICY" },
    });
    expect(await writeLogCount()).toBe(0);
  });

  it("normaliza un error de sintaxis y abre una conexión nueva para la siguiente lectura", async () => {
    const invalid = await currentCatalog().call({
      tool: "execute_sql",
      connection: "integration",
      input: { sql: `SELECT * FRO ${fixtureTable()}` },
    });
    const recovered = await currentCatalog().call({
      tool: "execute_sql",
      connection: "integration",
      input: { sql: "SELECT 1 AS ok" },
    });

    expect(invalid).toMatchObject({
      exitCode: 2,
      response: { success: false, code: "INVALID_SQL" },
    });
    expect(recovered.exitCode).toBe(0);
    expect(statementRows(recovered.response)).toEqual([{ ok: 1 }]);
  });

  timeoutIt(
    "aplica statement_timeout de 30 segundos cuando AW_TEST_POSTGRES_TIMEOUT=1",
    async () => {
      const outcome = await currentCatalog().call({
        tool: "execute_sql",
        connection: "integration",
        input: { sql: "SELECT pg_sleep(31) AS slept" },
      });

      expect(outcome).toMatchObject({
        exitCode: 1,
        response: { success: false, code: "QUERY_TIMEOUT" },
      });
    },
    40_000,
  );
});

function testDsn(): string {
  if (TEST_DSN === undefined || TEST_DSN.length === 0) {
    throw new Error("AW_TEST_POSTGRES_DSN es obligatorio para la integración PostgreSQL.");
  }
  return TEST_DSN;
}

function adminDsn(): string {
  return ADMIN_DSN === undefined || ADMIN_DSN.length === 0 ? testDsn() : ADMIN_DSN;
}

async function inspectRole(dsn: string): Promise<PostgreSqlRole> {
  const client = new Client({ connectionString: dsn });
  try {
    await client.connect();
    const result = await client.query<PostgreSqlRole>(
      "SELECT current_user AS name, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user",
    );
    const role = result.rows[0];
    if (role === undefined)
      throw new Error("No se pudo inspeccionar el rol de AW_TEST_POSTGRES_DSN.");
    return role;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function grantFixtureRead(client: Client, schema: string, role: string): Promise<void> {
  const target = quoteIdentifier(schema);
  const grantee = quoteIdentifier(role);
  await client.query(`GRANT USAGE ON SCHEMA ${target} TO ${grantee}`);
  await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${target} TO ${grantee}`);
  await client.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${target} TO ${grantee}`);
}

function currentFixture(): IntegrationFixture {
  if (fixture === undefined) throw new Error("El fixture PostgreSQL no está disponible.");
  return fixture;
}

function currentCatalog(): DatabaseToolCatalog {
  if (catalog === undefined) throw new Error("El catálogo PostgreSQL no está disponible.");
  return catalog;
}

function currentReadonlyTools(): PostgresReadonlyTools {
  if (readonlyTools === undefined) throw new Error("El adaptador PostgreSQL no está disponible.");
  return readonlyTools;
}

function currentAdmin(): Client {
  if (admin === undefined) throw new Error("El cliente de fixture PostgreSQL no está disponible.");
  return admin;
}

function fixtureSchemaName(): string {
  return `aw_tools_it_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function fixtureTable(): string {
  return `${quoteIdentifier(currentFixture().schema)}.fixture_rows`;
}

function searchExpectations(): readonly SearchExpectation[] {
  const active = currentFixture();
  const common = { pattern: "fixture_%", schema: active.schema };
  const detailLevels = ["names", "summary", "full"] as const;
  const expectations: SearchExpectation[] = detailLevels.flatMap((detail_level) => [
    {
      input: { object_type: "schema", pattern: active.schema, detail_level },
      name: active.schema,
      requiredFields: requiredSearchFields("schema", detail_level),
    },
    {
      input: { ...common, object_type: "table", detail_level },
      name: "fixture_rows",
      requiredFields: requiredSearchFields("table", detail_level),
    },
    {
      input: { ...common, object_type: "view", detail_level },
      name: "fixture_view",
      requiredFields: requiredSearchFields("view", detail_level),
    },
    {
      input: {
        object_type: "column",
        pattern: "number",
        detail_level,
        schema: active.schema,
        table: "fixture_rows",
      },
      name: "number",
      requiredFields: requiredSearchFields("column", detail_level),
    },
    {
      input: { ...common, object_type: "function", detail_level },
      name: "fixture_function",
      requiredFields: requiredSearchFields("function", detail_level),
    },
    {
      input: {
        ...common,
        object_type: "index",
        detail_level,
        table: "fixture_rows",
      },
      name: "fixture_rows_label_idx",
      requiredFields: requiredSearchFields("index", detail_level),
    },
  ]);
  if (active.procedureAvailable) {
    expectations.push(
      ...detailLevels.map((detail_level) => ({
        input: { ...common, object_type: "procedure", detail_level },
        name: "fixture_procedure",
        requiredFields: requiredSearchFields("procedure", detail_level),
      })),
    );
  }
  return expectations;
}

function requiredSearchFields(
  type: SearchObjectType,
  detail: SearchDetailLevel,
): readonly string[] {
  return REQUIRED_SEARCH_FIELDS[type][detail];
}

function firstStatement(response: ToolResponse): Record<string, unknown> {
  if (!response.success) throw new Error(`Se esperaba éxito, se obtuvo ${response.code}.`);
  const statements = response.data.statements;
  if (!Array.isArray(statements)) throw new Error("El payload no contiene statements.");
  const statement = statements[0];
  if (!isRecord(statement)) throw new Error("El payload no contiene una sentencia válida.");
  return statement;
}

function statementRows(response: ToolResponse): readonly Record<string, unknown>[] {
  const rows = firstStatement(response).rows;
  if (!Array.isArray(rows) || rows.some((row) => !isRecord(row))) {
    throw new Error("El payload no contiene filas válidas.");
  }
  return rows;
}

function objectRows(response: ToolResponse): readonly Record<string, unknown>[] {
  if (!response.success) throw new Error(`Se esperaba éxito, se obtuvo ${response.code}.`);
  const results = response.data.results;
  if (!Array.isArray(results) || results.some((object) => !isRecord(object))) {
    throw new Error("El payload no contiene objetos válidos.");
  }
  return results;
}

function searchEnvelope(response: ToolResponse): Record<string, unknown> {
  if (!response.success) throw new Error(`Se esperaba éxito, se obtuvo ${response.code}.`);
  return response.data;
}

async function fixtureRowCount(): Promise<number> {
  const result = await currentAdmin().query<{ count: number }>(
    `SELECT count(*)::integer AS count FROM ${fixtureTable()}`,
  );
  const count = result.rows[0]?.count;
  if (typeof count !== "number") throw new Error("El fixture no devolvió un conteo válido.");
  return count;
}

async function writeLogCount(): Promise<number> {
  const schema = quoteIdentifier(currentFixture().schema);
  const result = await currentAdmin().query<{ count: number }>(
    `SELECT count(*)::integer AS count FROM ${schema}.fixture_write_log`,
  );
  const count = result.rows[0]?.count;
  if (typeof count !== "number") throw new Error("El fixture no devolvió un conteo válido.");
  return count;
}

async function relationExists(name: string): Promise<boolean> {
  const result = await currentAdmin().query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2
     ) AS exists`,
    [currentFixture().schema, name],
  );
  return result.rows[0]?.exists === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
