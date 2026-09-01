import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { runDatabaseMcpStdio } from "../../src/application/database-mcp-stdio.js";
import type { DatabaseToolCatalog } from "../../src/application/database-tool-catalog.js";
import { DATABASE_TOOL_DESCRIPTORS, toolFailure } from "../../src/domain/database-tools.js";

interface JsonRpcReply {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface TestTransport {
  input: PassThrough;
  stdout: string[];
  diagnostics: string[];
  done: Promise<void>;
}

function startTransport(catalog: DatabaseToolCatalog): TestTransport {
  const input = new PassThrough();
  const output = new PassThrough();
  const diagnostics = new PassThrough();
  const stdout: string[] = [];
  const diagnosticLines: string[] = [];
  output.on("data", (chunk: Buffer | string) => stdout.push(String(chunk)));
  diagnostics.on("data", (chunk: Buffer | string) => diagnosticLines.push(String(chunk)));
  return {
    input,
    stdout,
    diagnostics: diagnosticLines,
    done: runDatabaseMcpStdio({ input, output, diagnostics, catalog, connection: "alpha" }),
  };
}

function catalogWith(
  call: (request: { signal?: AbortSignal }) => Promise<{
    response: ReturnType<typeof toolFailure>;
    exitCode: 0 | 1 | 2;
  }>,
): DatabaseToolCatalog {
  return {
    list: () => ({ payload: { tools: DATABASE_TOOL_DESCRIPTORS }, exitCode: 0 }),
    call: async (request: { signal?: AbortSignal }) => await call(request),
  } as unknown as DatabaseToolCatalog;
}

function successfulCatalog(): DatabaseToolCatalog {
  return catalogWith(async () => ({
    response: toolFailure("TEST_UNEXPECTED_CALL", "La prueba no esperaba ejecutar una tool."),
    exitCode: 1,
  }));
}

function writeMessage(input: PassThrough, message: Record<string, unknown>): void {
  input.write(`${JSON.stringify(message)}\n`);
}

function replies(chunks: string[]): JsonRpcReply[] {
  return chunks
    .join("")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as JsonRpcReply);
}

function replyById(chunks: string[], id: number): JsonRpcReply {
  const reply = replies(chunks).find((message) => message.id === id);
  if (reply === undefined) throw new Error(`Falta la respuesta JSON-RPC ${id}.`);
  return reply;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  if (resolve === undefined) throw new Error("No se pudo crear la espera de la prueba.");
  return { promise, resolve };
}

describe("transporte stdio del MCP de base de datos", () => {
  it("descarta un frame completo demasiado grande y atiende la línea posterior", async () => {
    const transport = startTransport(successfulCatalog());
    const initialize = Buffer.from(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`,
    );
    const oversized = Buffer.alloc(7 * 1024 * 1024, "x");

    transport.input.write(Buffer.concat([oversized, Buffer.from("\n"), initialize]));
    transport.input.end();
    await transport.done;

    expect(replyById(transport.stdout, 1).result).toMatchObject({
      protocolVersion: "2025-06-18",
    });
    expect(transport.diagnostics.join("")).toContain("frame JSON-RPC demasiado grande descartado");
    expect(transport.stdout.join("")).not.toContain("frame JSON-RPC demasiado grande descartado");
  });

  it("reconstruye un JSON-RPC UTF-8 partido dentro de un carácter multibyte", async () => {
    const transport = startTransport(successfulCatalog());
    const raw = Buffer.from(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: { annotation: "señal" },
      })}\n`,
    );
    const multibyteStart = raw.indexOf(Buffer.from("ñ"));
    if (multibyteStart < 0) throw new Error("La prueba no encontró el carácter UTF-8 esperado.");

    transport.input.write(raw.subarray(0, multibyteStart + 1));
    transport.input.write(raw.subarray(multibyteStart + 1));
    transport.input.end();
    await transport.done;

    expect(replyById(transport.stdout, 2).result).toMatchObject({
      protocolVersion: "2025-06-18",
    });
    expect(transport.diagnostics.join("")).toBe("");
  });

  it("entrega cancelación fuera de la cola mientras una tool está activa", async () => {
    const started = deferred<AbortSignal>();
    const aborted = deferred<void>();
    const catalog = catalogWith(async ({ signal }) => {
      if (signal === undefined)
        throw new Error("La llamada MCP debe recibir una señal de cancelación.");
      started.resolve(signal);
      return await new Promise((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted.resolve();
            resolve({
              response: toolFailure("QUERY_CANCELLED", "La consulta fue cancelada."),
              exitCode: 1,
            });
          },
          { once: true },
        );
      });
    });
    const transport = startTransport(catalog);

    writeMessage(transport.input, { jsonrpc: "2.0", id: 1, method: "initialize" });
    writeMessage(transport.input, { jsonrpc: "2.0", method: "notifications/initialized" });
    writeMessage(transport.input, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "execute_sql", arguments: { sql: "SELECT pg_sleep(30)" } },
    });
    const signal = await started.promise;

    writeMessage(transport.input, {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 7 },
    });
    await aborted.promise;
    transport.input.end();
    await transport.done;

    expect(signal.aborted).toBe(true);
    const result = replyById(transport.stdout, 7).result as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? "{}")).toMatchObject({
      success: false,
      code: "QUERY_CANCELLED",
    });
  });
});
