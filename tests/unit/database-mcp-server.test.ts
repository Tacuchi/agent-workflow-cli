import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseMcpServer } from "../../src/application/database-mcp-server.js";
import { DatabaseToolCatalog } from "../../src/application/database-tool-catalog.js";
import { upsertMcpConnection } from "../../src/application/mcp-connections-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import { toolCommand } from "../../src/cli/commands/tool.js";
import { DATABASE_TOOL_DESCRIPTORS, type ToolResponse } from "../../src/domain/database-tools.js";
import type {
  PostgresQueryOptions,
  PostgresQueryResult,
  PostgresReadonlyPort,
  PostgresRoleInspection,
} from "../../src/ports/postgres-tools.js";
import { PostgresToolError } from "../../src/ports/postgres-tools.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

const DSN = "postgres://readonly:secret@db.example.test:5432/app";

interface JsonRpcReply {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

class FakePostgres implements PostgresReadonlyPort {
  async execute(_sql: string, _dsn: string): Promise<PostgresQueryResult> {
    return { rows: [{ ok: 1 }], truncated: false };
  }

  async query(
    _sql: string,
    _values: readonly unknown[],
    _dsn: string,
  ): Promise<PostgresQueryResult> {
    return { rows: [{ name: "users" }], truncated: false };
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

class BlockingPostgres extends FakePostgres {
  signal: AbortSignal | undefined;

  override async execute(
    _sql: string,
    _dsn: string,
    options: PostgresQueryOptions = {},
  ): Promise<PostgresQueryResult> {
    this.signal = options.signal;
    return await new Promise<PostgresQueryResult>((_resolve, reject) => {
      options.signal?.addEventListener(
        "abort",
        () => reject(new PostgresToolError("QUERY_CANCELLED", "La consulta fue cancelada.")),
        { once: true },
      );
    });
  }
}

function toolContent(message: JsonRpcReply): { text: string; mimeType: string; isError?: boolean } {
  const result = message.result as
    | { content?: Array<{ text?: string; mimeType?: string }>; isError?: boolean }
    | undefined;
  const content = result?.content?.[0];
  if (content?.text === undefined || content.mimeType === undefined) {
    throw new Error("La respuesta MCP no contiene el texto de la tool.");
  }
  return {
    text: content.text,
    mimeType: content.mimeType,
    ...(result?.isError === true ? { isError: true } : {}),
  };
}

function replyById(sent: JsonRpcReply[], id: number): JsonRpcReply {
  const reply = sent.find((message) => message.id === id);
  if (reply === undefined) throw new Error(`Falta la respuesta JSON-RPC ${id}.`);
  return reply;
}

function renderDirectCli(response: ToolResponse, exitCode: 0 | 1 | 2): string {
  const render = toolCommand.renderRawJson;
  if (render === undefined) throw new Error("tool debe declarar su renderer JSON directo.");
  return render({
    ok: response.success,
    data: response,
    ...(response.success ? {} : { error: { code: response.code, message: response.error } }),
    exitCode,
  });
}

describe("servidor MCP de base de datos", () => {
  let root: string;
  let catalog: DatabaseToolCatalog;
  let sent: JsonRpcReply[];
  let hostLoadObserved: number;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "database-mcp-server-"));
    const paths = new PathsService(normalizeNamespace("workflow"), root, root);
    upsertMcpConnection(paths, { name: "alpha", dsnVar: "ALPHA_DATABASE_URL" });
    catalog = new DatabaseToolCatalog({
      paths,
      env: new FakeEnv(root, root, { ALPHA_DATABASE_URL: DSN }),
      postgres: new FakePostgres(),
    });
    sent = [];
    hostLoadObserved = 0;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("publica el catálogo compartido sólo después de initialized y observa la carga del host", async () => {
    const server = createDatabaseMcpServer({
      catalog,
      connection: "alpha",
      send: (message) => sent.push(message as JsonRpcReply),
      onHostLoadObserved: () => {
        hostLoadObserved += 1;
      },
    });

    await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize" });
    await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(replyById(sent, 2).error).toMatchObject({ code: -32002 });

    await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
    await server.handle({ jsonrpc: "2.0", id: 3, method: "tools/list" });

    expect(hostLoadObserved).toBe(1);
    expect(replyById(sent, 1).result).toMatchObject({
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
    });
    expect((replyById(sent, 3).result as { tools: unknown[] }).tools).toEqual(
      DATABASE_TOOL_DESCRIPTORS,
    );
  });

  it("descarta envelopes JSON-RPC inválidos sin escribir una respuesta inválida", async () => {
    const server = createDatabaseMcpServer({
      catalog,
      connection: "alpha",
      send: (message) => sent.push(message as JsonRpcReply),
    });

    await server.handle({ id: 1, method: "initialize" });
    await server.handle({ jsonrpc: "2.0", id: { invalid: true }, method: "initialize" });

    expect(sent).toEqual([]);
    await server.handle({ jsonrpc: "2.0", id: 2, method: "initialize" });
    expect(replyById(sent, 2).result).toMatchObject({ protocolVersion: "2025-06-18" });
  });

  it("emite exactamente el mismo JSON que el renderer directo del CLI en un éxito", async () => {
    const server = createDatabaseMcpServer({
      catalog,
      connection: "alpha",
      send: (message) => sent.push(message as JsonRpcReply),
    });
    await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize" });
    await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" });

    const direct = await catalog.call({
      tool: "execute_sql",
      connection: "alpha",
      input: { sql: "SELECT 1 AS ok" },
    });
    await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "execute_sql", arguments: { sql: "SELECT 1 AS ok" } },
    });

    const content = toolContent(replyById(sent, 2));
    expect(content.mimeType).toBe("application/json");
    expect(content.isError).toBeUndefined();
    expect(content.text).toBe(renderDirectCli(direct.response, direct.exitCode));
    expect(JSON.parse(content.text)).toEqual(direct.response);
  });

  it("usa el mismo JSON de error, mime type e isError que el CLI", async () => {
    const server = createDatabaseMcpServer({
      catalog,
      connection: "alpha",
      send: (message) => sent.push(message as JsonRpcReply),
    });
    await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize" });
    await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" });

    const direct = await catalog.call({
      tool: "execute_sql",
      connection: "alpha",
      input: { sql: "DELETE FROM users" },
    });
    await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "execute_sql", arguments: { sql: "DELETE FROM users" } },
    });

    const content = toolContent(replyById(sent, 2));
    expect(content).toMatchObject({ mimeType: "application/json", isError: true });
    expect(content.text).toBe(renderDirectCli(direct.response, direct.exitCode));
    expect(JSON.parse(content.text)).toMatchObject({
      success: false,
      code: "READ_ONLY_POLICY",
    });
  });

  it("emite exactamente el mismo JSON para search_objects exitoso", async () => {
    const server = createDatabaseMcpServer({
      catalog,
      connection: "alpha",
      send: (message) => sent.push(message as JsonRpcReply),
    });
    await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize" });
    await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" });

    const input = { object_type: "table" };
    const direct = await catalog.call({
      tool: "search_objects",
      connection: "alpha",
      input,
    });
    await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "search_objects", arguments: input },
    });

    const content = toolContent(replyById(sent, 2));
    expect(content).toMatchObject({ mimeType: "application/json" });
    expect(content.isError).toBeUndefined();
    expect(content.text).toBe(renderDirectCli(direct.response, direct.exitCode));
    expect(JSON.parse(content.text)).toEqual(direct.response);
  });

  it("usa el mismo JSON de error para search_objects inválido", async () => {
    const server = createDatabaseMcpServer({
      catalog,
      connection: "alpha",
      send: (message) => sent.push(message as JsonRpcReply),
    });
    await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize" });
    await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" });

    const input = { object_type: "table", table: "users" };
    const direct = await catalog.call({
      tool: "search_objects",
      connection: "alpha",
      input,
    });
    await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "search_objects", arguments: input },
    });

    const content = toolContent(replyById(sent, 2));
    expect(content).toMatchObject({ mimeType: "application/json", isError: true });
    expect(content.text).toBe(renderDirectCli(direct.response, direct.exitCode));
    expect(JSON.parse(content.text)).toMatchObject({
      success: false,
      code: "INVALID_INPUT",
    });
  });

  it("propaga notifications/cancelled a una llamada activa sin tocar otra conexión", async () => {
    const postgres = new BlockingPostgres();
    const paths = new PathsService(normalizeNamespace("workflow"), root, root);
    catalog = new DatabaseToolCatalog({
      paths,
      env: new FakeEnv(root, root, { ALPHA_DATABASE_URL: DSN }),
      postgres,
    });
    const server = createDatabaseMcpServer({
      catalog,
      connection: "alpha",
      send: (message) => sent.push(message as JsonRpcReply),
    });
    await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize" });
    await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" });

    const pending = server.handle({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "execute_sql", arguments: { sql: "SELECT pg_sleep(30)" } },
    });
    await Promise.resolve();
    await server.handle({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 9 },
    });
    await pending;

    expect(postgres.signal?.aborted).toBe(true);
    expect(JSON.parse(toolContent(replyById(sent, 9)).text)).toMatchObject({
      success: false,
      code: "QUERY_CANCELLED",
    });
  });
});
