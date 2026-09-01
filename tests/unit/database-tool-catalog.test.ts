import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseToolCatalog } from "../../src/application/database-tool-catalog.js";
import { upsertMcpConnection } from "../../src/application/mcp-connections-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import {
  type ToolResponse,
  encodeToolResponse,
  parseDatabaseToolInput,
  validateReadOnlySql,
} from "../../src/domain/database-tools.js";
import type {
  PostgresQueryResult,
  PostgresReadonlyPort,
  PostgresRoleInspection,
} from "../../src/ports/postgres-tools.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

const DSN = "postgres://readonly:secret@db.example.test:5432/app";

interface RecordedQuery {
  sql: string;
  values: readonly unknown[];
  dsn: string;
}

class FakePostgres implements PostgresReadonlyPort {
  readonly executeCalls: Array<{ sql: string; dsn: string }> = [];
  readonly queryCalls: RecordedQuery[] = [];
  executeResult: PostgresQueryResult = { rows: [{ "?column?": 1 }], truncated: false };
  queryResult: PostgresQueryResult = { rows: [{ name: "users" }], truncated: false };

  async execute(sql: string, dsn: string): Promise<PostgresQueryResult> {
    this.executeCalls.push({ sql, dsn });
    return this.executeResult;
  }

  async query(sql: string, values: readonly unknown[], dsn: string): Promise<PostgresQueryResult> {
    this.queryCalls.push({ sql, values, dsn });
    return this.queryResult;
  }

  async inspectRole(_dsn: string): Promise<PostgresRoleInspection> {
    return {
      superuser: false,
      canCreateRole: false,
      canCreateDatabase: false,
      canWrite: false,
      transactionReadOnly: true,
    };
  }
}

describe("DatabaseToolCatalog", () => {
  let root: string;
  let paths: PathsService;
  let postgres: FakePostgres;
  let catalog: DatabaseToolCatalog;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "database-tool-catalog-"));
    paths = new PathsService(normalizeNamespace("workflow"), root, root);
    postgres = new FakePostgres();
    upsertMcpConnection(paths, { name: "alpha", dsnVar: "ALPHA_DATABASE_URL" });
    catalog = new DatabaseToolCatalog({
      paths,
      env: new FakeEnv(root, root, { ALPHA_DATABASE_URL: DSN }),
      postgres,
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("normaliza los defaults de search_objects y rechaza sus combinaciones inválidas", () => {
    const executeWithForeignField = parseDatabaseToolInput("execute_sql", {
      sql: "SELECT 1",
      timeout: 10,
    });
    expect(executeWithForeignField).toMatchObject({
      ok: false,
      response: { code: "INVALID_INPUT" },
    });

    expect(parseDatabaseToolInput("search_objects", { object_type: "column" })).toEqual({
      ok: true,
      value: {
        object_type: "column",
        pattern: "%",
        detail_level: "names",
        limit: 100,
      },
    });

    const tableWithoutSchema = parseDatabaseToolInput("search_objects", {
      object_type: "column",
      table: "users",
    });
    expect(tableWithoutSchema).toMatchObject({ ok: false, response: { code: "INVALID_INPUT" } });

    const foreignField = parseDatabaseToolInput("search_objects", {
      object_type: "table",
      unexpected: true,
    });
    expect(foreignField).toMatchObject({ ok: false, response: { code: "INVALID_INPUT" } });
  });

  it("ejecuta execute_sql con el payload canónico y sin exponer el DSN", async () => {
    const outcome = await catalog.call({
      tool: "execute_sql",
      connection: "alpha",
      input: { sql: "SELECT 1" },
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.response).toEqual({
      success: true,
      data: {
        statements: [{ sql: "SELECT 1", rows: [{ "?column?": 1 }], count: 1 }],
        source_id: "default",
      },
    });
    expect(postgres.executeCalls).toEqual([{ sql: "SELECT 1", dsn: DSN }]);
    expect(encodeToolResponse(outcome.response)).not.toContain(DSN);
  });

  it("bloquea SQL de escritura antes de abrir la conexión", async () => {
    const outcome = await catalog.call({
      tool: "execute_sql",
      connection: "alpha",
      input: { sql: "WITH changed AS (DELETE FROM users RETURNING id) SELECT * FROM changed" },
    });

    expect(outcome).toMatchObject({
      exitCode: 1,
      response: { success: false, code: "READ_ONLY_POLICY" },
    });
    expect(postgres.executeCalls).toEqual([]);
  });

  it("rechaza múltiples sentencias sin abrir la conexión", async () => {
    const outcome = await catalog.call({
      tool: "execute_sql",
      connection: "alpha",
      input: { sql: "SELECT 1; SELECT 2" },
    });

    expect(outcome).toMatchObject({
      exitCode: 1,
      response: { success: false, code: "MULTI_STATEMENT_UNSUPPORTED" },
    });
    expect(postgres.executeCalls).toEqual([]);
  });

  it("no deja que una comilla ordinaria, una identificada o un comentario CR oculten otra sentencia", async () => {
    const inputs = [
      String.raw`SELECT 'x\'; DELETE FROM users; --'`,
      String.raw`SELECT "x\"; DELETE FROM users; --"`,
      "SELECT 1; -- comentario\rDELETE FROM users",
      "SELECT 1 AS x$tag$; DELETE FROM users; -- $tag$",
    ];

    for (const sql of inputs) {
      const outcome = await catalog.call({
        tool: "execute_sql",
        connection: "alpha",
        input: { sql },
      });
      expect(outcome).toMatchObject({
        exitCode: 1,
        response: { success: false, code: "MULTI_STATEMENT_UNSUPPORTED" },
      });
    }
    expect(postgres.executeCalls).toEqual([]);
  });

  it("admite escapes sólo en E strings y rechaza un dollar quote sin cierre", () => {
    expect(validateReadOnlySql(String.raw`SELECT E'it\'s safe'`)).toEqual({ ok: true });
    expect(validateReadOnlySql("SELECT $$unterminated")).toMatchObject({
      ok: false,
      response: { code: "INVALID_SQL" },
    });
  });

  it("bloquea SELECT INTO aunque tenga modificadores antes de INTO", async () => {
    const outcome = await catalog.call({
      tool: "execute_sql",
      connection: "alpha",
      input: { sql: "SELECT DISTINCT id INTO snapshot FROM users" },
    });

    expect(outcome).toMatchObject({
      exitCode: 1,
      response: { success: false, code: "READ_ONLY_POLICY" },
    });
    expect(postgres.executeCalls).toEqual([]);
  });

  it("bloquea set_config aunque esté envuelto en un SELECT", async () => {
    const outcome = await catalog.call({
      tool: "execute_sql",
      connection: "alpha",
      input: { sql: "SELECT pg_catalog.set_config('statement_timeout', '0', false)" },
    });

    expect(outcome).toMatchObject({
      exitCode: 1,
      response: { success: false, code: "READ_ONLY_POLICY" },
    });
    expect(postgres.executeCalls).toEqual([]);
  });

  it("envía la búsqueda de objetos como SQL parametrizado y conserva sus defaults resueltos", async () => {
    const outcome = await catalog.call({
      tool: "search_objects",
      connection: "alpha",
      input: {
        object_type: "column",
        pattern: "user%",
        detail_level: "summary",
        limit: 7,
        schema: "public",
        table: "users",
      },
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.response).toEqual({
      success: true,
      data: {
        object_type: "column",
        pattern: "user%",
        schema: "public",
        table: "users",
        detail_level: "summary",
        count: 1,
        results: [{ name: "users" }],
        truncated: false,
      },
    });
    expect(postgres.queryCalls).toHaveLength(1);
    expect(postgres.queryCalls[0]).toMatchObject({
      values: ["user%", "public", "users", 8],
      dsn: DSN,
    });
    expect(postgres.queryCalls[0]?.sql).toContain("ILIKE $1");
    expect(postgres.queryCalls[0]?.sql).not.toContain("user%");
  });

  it("marca truncamiento sólo cuando observa una fila adicional y conserva el envelope DBHub", async () => {
    postgres.queryResult = {
      rows: [
        { name: "accounts", schema: "public" },
        { name: "audit_log", schema: "public" },
      ],
      truncated: false,
    };

    const outcome = await catalog.call({
      tool: "search_objects",
      connection: "alpha",
      input: { object_type: "table", limit: 1 },
    });

    expect(outcome).toEqual({
      exitCode: 0,
      response: {
        success: true,
        data: {
          object_type: "table",
          pattern: "%",
          detail_level: "names",
          count: 1,
          results: [{ name: "accounts", schema: "public" }],
          truncated: true,
        },
      },
    });
    expect(postgres.queryCalls[0]?.values).toEqual(["%", 2]);
  });

  it("devuelve un error transport-neutral para una tool inexistente", async () => {
    const outcome = await catalog.call({
      tool: "drop_database",
      connection: "alpha",
      input: {},
    });

    expect(outcome).toEqual({
      exitCode: 2,
      response: {
        success: false,
        code: "TOOL_NOT_FOUND",
        error: "La tool solicitada no existe.",
      },
    });
  });
});

describe("el encoder transport-neutral", () => {
  it("preserva byte por byte el payload de éxito", () => {
    const response: ToolResponse = {
      success: true,
      data: { statements: [{ sql: "SELECT 1", rows: [{ ok: 1 }], count: 1 }] },
    };

    expect(encodeToolResponse(response)).toBe(
      '{"success":true,"data":{"statements":[{"sql":"SELECT 1","rows":[{"ok":1}],"count":1}]}}',
    );
  });
});
