import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertMcpConnection } from "../../src/application/mcp-connections-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import { mcpCommand } from "../../src/cli/commands/mcp.js";
import { toolCommand } from "../../src/cli/commands/tool.js";
import { type ParsedArgs, parseArgv } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import { DATABASE_TOOL_DESCRIPTORS } from "../../src/domain/database-tools.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

const postgres = vi.hoisted(() => ({
  execute: vi.fn(async () => ({ rows: [{ ok: 1 }], truncated: false })),
  query: vi.fn(async () => ({ rows: [], truncated: false })),
  inspectRole: vi.fn(async () => ({
    superuser: false,
    canCreateRole: false,
    canCreateDatabase: false,
    canWrite: false,
    transactionReadOnly: true,
  })),
}));

vi.mock("../../src/adapters/postgres-readonly-tools.js", () => ({
  PostgresReadonlyTools: class {
    execute = postgres.execute;
    query = postgres.query;
    inspectRole = postgres.inspectRole;
  },
}));

const DSN = "postgres://readonly:secret@db.example.test:5432/app";

function context(root: string): CliContext {
  const namespace = normalizeNamespace("workflow");
  const paths = new PathsService(namespace, root, root);
  return {
    fs: {} as never,
    env: new FakeEnv(root, root, { ALPHA_DATABASE_URL: DSN }),
    git: {} as never,
    process: {} as never,
    runtime: {
      packageName: "@tacuchi/agent-workflow-cli",
      binName: "agent-workflow",
      source: "default",
    },
    namespace: { namespace, source: "default" },
    paths,
    skills: {},
  };
}

function parsed(argv: string[]): ParsedArgs {
  return parseArgv(argv);
}

function raw(result: Parameters<NonNullable<typeof toolCommand.renderRawJson>>[0]): string {
  const render = toolCommand.renderRawJson;
  if (render === undefined) throw new Error("tool debe exponer su renderer raw.");
  return render(result);
}

async function executeWithStdin(
  args: ParsedArgs,
  ctx: CliContext,
  input: string,
): Promise<Awaited<ReturnType<typeof toolCommand.execute>>> {
  const original = Object.getOwnPropertyDescriptor(process, "stdin");
  if (original === undefined) throw new Error("No se pudo preservar process.stdin.");
  const stream = new PassThrough();
  Object.defineProperty(process, "stdin", { configurable: true, value: stream });
  stream.end(input);
  try {
    return await toolCommand.execute(args, ctx);
  } finally {
    Object.defineProperty(process, "stdin", original);
  }
}

describe("CLI tool", () => {
  let root: string;
  let ctx: CliContext;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tool-command-"));
    ctx = context(root);
    upsertMcpConnection(ctx.paths, { name: "alpha", dsnVar: "ALPHA_DATABASE_URL" });
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("lista el mismo catálogo transport-neutral como JSON crudo y sale con 0", async () => {
    const result = await toolCommand.execute(
      parsed(["tool", "list", "--connection", "alpha"]),
      ctx,
    );

    expect(result).toMatchObject({
      ok: true,
      exitCode: 0,
      data: { tools: DATABASE_TOOL_DESCRIPTORS },
    });
    expect(raw(result)).toBe(JSON.stringify({ tools: DATABASE_TOOL_DESCRIPTORS }));
  });

  it("ejecuta una llamada con el payload canónico crudo y sale con 0", async () => {
    const result = await toolCommand.execute(
      parsed([
        "tool",
        "call",
        "execute_sql",
        "--connection",
        "alpha",
        "--input-json",
        '{"sql":"SELECT 1 AS ok"}',
      ]),
      ctx,
    );

    expect(result).toMatchObject({
      ok: true,
      exitCode: 0,
      data: {
        success: true,
        data: {
          statements: [{ sql: "SELECT 1 AS ok", rows: [{ ok: 1 }], count: 1 }],
          source_id: "default",
        },
      },
    });
    expect(raw(result)).toBe(
      '{"success":true,"data":{"statements":[{"sql":"SELECT 1 AS ok","rows":[{"ok":1}],"count":1}],"source_id":"default"}}',
    );
    expect(postgres.execute).toHaveBeenCalledWith("SELECT 1 AS ok", DSN);
  });

  it("acepta el marcador --input-json - y lee el JSON desde stdin", async () => {
    const args = parsed([
      "tool",
      "call",
      "execute_sql",
      "--connection",
      "alpha",
      "--input-json",
      "-",
    ]);

    expect(args.values.get("input-json")).toBe("-");
    expect(args.flags.has("--input-json")).toBe(false);

    const result = await executeWithStdin(args, ctx, '{"sql":"SELECT 1 AS ok"}');

    expect(result).toMatchObject({ ok: true, exitCode: 0 });
    expect(raw(result)).toContain('"success":true');
    expect(postgres.execute).toHaveBeenCalledWith("SELECT 1 AS ok", DSN);
  });

  it("ejecuta search_objects desde stdin con el mismo payload canónico", async () => {
    postgres.query.mockResolvedValueOnce({
      rows: [{ name: "user_id", table: "users", schema: "public" }],
      truncated: false,
    });
    const args = parsed([
      "tool",
      "call",
      "search_objects",
      "--connection",
      "alpha",
      "--input-json",
      "-",
    ]);

    const result = await executeWithStdin(
      args,
      ctx,
      '{"object_type":"column","pattern":"user%","schema":"public","table":"users"}',
    );

    expect(result).toMatchObject({ ok: true, exitCode: 0 });
    expect(raw(result)).toBe(
      '{"success":true,"data":{"object_type":"column","pattern":"user%","schema":"public","table":"users","detail_level":"names","count":1,"results":[{"name":"user_id","table":"users","schema":"public"}],"truncated":false}}',
    );
    expect(postgres.query).toHaveBeenCalledWith(
      expect.stringContaining("column_info.column_name ILIKE $1"),
      ["user%", "public", "users", 101],
      DSN,
    );
  });

  it("devuelve JSON crudo y exit 2 para JSON de entrada inválido", async () => {
    const result = await toolCommand.execute(
      parsed(["tool", "call", "execute_sql", "--connection", "alpha", "--input-json", "{no-json}"]),
      ctx,
    );

    expect(result.exitCode).toBe(2);
    expect(raw(result)).toBe(
      '{"success":false,"error":"--input-json debe contener JSON válido.","code":"INVALID_JSON"}',
    );
    expect(postgres.execute).not.toHaveBeenCalled();
  });

  it("mantiene el error de search_objects inválido como JSON crudo", async () => {
    const result = await toolCommand.execute(
      parsed([
        "tool",
        "call",
        "search_objects",
        "--connection",
        "alpha",
        "--input-json",
        '{"object_type":"table","table":"users"}',
      ]),
      ctx,
    );

    expect(result.exitCode).toBe(2);
    expect(raw(result)).toBe(
      '{"success":false,"error":"table sólo aplica a column e index.","code":"INVALID_INPUT"}',
    );
    expect(postgres.query).not.toHaveBeenCalled();
  });

  it("rechaza opciones desconocidas antes de invocar una tool y sale con 2", async () => {
    const result = await toolCommand.execute(
      parsed(["tool", "list", "--connection", "alpha", "--unexpected"]),
      ctx,
    );

    expect(result.exitCode).toBe(2);
    expect(raw(result)).toBe(
      '{"success":false,"error":"tool recibió una opción no permitida.","code":"INVALID_INPUT"}',
    );
    expect(postgres.execute).not.toHaveBeenCalled();
  });

  it("mantiene el error de conexión desconocida como JSON crudo y exit 2", async () => {
    const result = await toolCommand.execute(
      parsed(["tool", "list", "--connection", "missing"]),
      ctx,
    );

    expect(result.exitCode).toBe(2);
    expect(raw(result)).toBe(
      '{"success":false,"error":"No se pudo resolver la conexión solicitada.","code":"MCP_CONNECTION_NOT_REGISTERED"}',
    );
  });
});

describe("bootstrap de mcp serve-db", () => {
  let stdout: ReturnType<typeof vi.spyOn>;
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stdout.mockRestore();
    stderr.mockRestore();
  });

  it("suprime el envelope de CLI en stdout cuando el arranque recibe una conexión posicional", async () => {
    const result = await mcpCommand.execute(
      parsed(["mcp", "serve-db", "legacy"]),
      {} as CliContext,
    );

    expect(result).toMatchObject({
      ok: false,
      exitCode: 2,
      suppressOutput: true,
      error: { code: "MCP_SERVER_BOOTSTRAP_FAILED" },
    });
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      "aw mcp serve-db: mcp serve-db no acepta una conexión posicional. Usá --instance <nombre>.\n",
    );
  });

  it("conserva mcp dbhub sólo como alias deprecado del servidor Workline", async () => {
    const result = await mcpCommand.execute(parsed(["mcp", "dbhub", "legacy"]), {} as CliContext);

    expect(result).toMatchObject({
      ok: false,
      exitCode: 2,
      suppressOutput: true,
      error: { code: "MCP_SERVER_BOOTSTRAP_FAILED" },
    });
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenNthCalledWith(
      1,
      "aw mcp dbhub está deprecado; usá 'aw mcp serve-db'.\n",
    );
    expect(stderr).toHaveBeenNthCalledWith(
      2,
      "aw mcp serve-db: mcp serve-db no acepta una conexión posicional. Usá --instance <nombre>.\n",
    );
  });
});
