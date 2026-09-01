import { PostgresReadonlyTools } from "../../adapters/postgres-readonly-tools.js";
import { DatabaseToolCatalog } from "../../application/database-tool-catalog.js";
import {
  type DatabaseToolDescriptor,
  MAX_TOOL_INPUT_BYTES,
  type ToolFailure,
  type ToolResponse,
  encodeToolResponse,
  toolFailure,
} from "../../domain/database-tools.js";
import type { CommandResult, ExitCode } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand } from "../registry.js";
import type { CliContext } from "../types.js";

type ToolCliPayload = { tools: readonly DatabaseToolDescriptor[] } | ToolResponse;

/** Direct, transport-free access to the same catalog served over MCP. */
export const toolCommand: CliCommand<ToolCliPayload> = {
  name: "tool",
  describe:
    "Invoca una tool PostgreSQL de Workline sin crear un servidor MCP. Uso: tool list --connection <nombre> | tool call <tool> --connection <nombre> --input-json <json|->.",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult<ToolCliPayload>> {
    const argumentsError = validateToolArguments(args);
    if (argumentsError !== undefined) return toolCommandFailure("INVALID_INPUT", argumentsError, 2);
    const subcommand = args.rest[0];
    const connection = args.values.get("connection");
    if (connection === undefined || connection.length === 0) {
      return toolCommandFailure("CONNECTION_REQUIRED", "tool requiere --connection <nombre>.", 2);
    }
    const catalog = new DatabaseToolCatalog({
      paths: ctx.paths,
      env: ctx.env,
      postgres: new PostgresReadonlyTools(),
    });
    if (subcommand === "list") return runToolList(args, catalog, connection);
    return await runToolCall(args, catalog, connection);
  },
  renderRawJson(result: CommandResult<ToolCliPayload>): string {
    if (isToolResponse(result.data)) return encodeToolResponse(result.data);
    if (result.ok && isToolList(result.data)) return JSON.stringify(result.data);
    return encodeToolResponse(
      toolFailure(result.error?.code ?? "TOOL_FAILED", "La tool no pudo completar la solicitud."),
    );
  },
};

function runToolList(
  args: ParsedArgs,
  catalog: DatabaseToolCatalog,
  connection: string,
): CommandResult<ToolCliPayload> {
  if (args.rest.length !== 1) return invalidToolUsage();
  if (args.values.has("input-json") || args.flags.has("--input-json")) {
    return toolCommandFailure("INVALID_INPUT", "tool list no acepta --input-json.", 2);
  }
  const outcome = catalog.list(connection);
  if ("tools" in outcome.payload) {
    return { ok: true, data: outcome.payload, exitCode: outcome.exitCode };
  }
  return toolResponseFailure(outcome.payload, outcome.exitCode);
}

async function runToolCall(
  args: ParsedArgs,
  catalog: DatabaseToolCatalog,
  connection: string,
): Promise<CommandResult<ToolCliPayload>> {
  if (args.rest[0] !== "call" || args.rest.length !== 2) return invalidToolUsage();
  const tool = args.rest[1];
  if (tool === undefined)
    return toolCommandFailure("INVALID_INPUT", "Falta el nombre de la tool.", 2);
  const rawInput = args.values.get("input-json");
  if (rawInput === undefined) {
    return toolCommandFailure(
      "INPUT_JSON_REQUIRED",
      "tool call requiere --input-json <json|->.",
      2,
    );
  }
  const parsed = await parseInputJson(rawInput);
  if (!parsed.ok) return toolResponseFailure(parsed.response, 2);
  const outcome = await catalog.call({ tool, connection, input: parsed.value });
  return outcome.response.success
    ? { ok: true, data: outcome.response, exitCode: outcome.exitCode }
    : toolResponseFailure(outcome.response, outcome.exitCode);
}

function invalidToolUsage(): CommandResult<ToolCliPayload> {
  return toolCommandFailure(
    "INVALID_INPUT",
    "Usá 'tool list --connection <nombre>' o 'tool call <tool> --connection <nombre> --input-json <json|->'.",
    2,
  );
}

function toolCommandFailure(
  code: string,
  message: string,
  exitCode: ExitCode,
): CommandResult<ToolCliPayload> {
  return toolResponseFailure(toolFailure(code, message), exitCode);
}

function validateToolArguments(args: ParsedArgs): string | undefined {
  const allowedValues = new Set(["connection", "input-json", "namespace", "format"]);
  const allowedFlags = new Set([
    "--connection",
    "--input-json",
    "--namespace",
    "--format",
    "--json",
    "--detail",
  ]);
  if ([...args.values.keys()].some((key) => !allowedValues.has(key))) {
    return "tool recibió una opción no permitida.";
  }
  if ([...args.flags].some((flag) => !allowedFlags.has(flag))) {
    return "tool recibió una opción no permitida.";
  }
  return undefined;
}

function toolResponseFailure(
  response: ToolFailure,
  exitCode: ExitCode,
): CommandResult<ToolCliPayload> {
  return {
    ok: false,
    data: response,
    error: { code: response.code, message: response.error },
    exitCode,
  };
}

type ParsedInput = { ok: true; value: unknown } | { ok: false; response: ToolFailure };

async function parseInputJson(raw: string): Promise<ParsedInput> {
  let text = raw;
  if (raw === "-") {
    const stdin = await readBoundedStdin(process.stdin, MAX_TOOL_INPUT_BYTES);
    if (!stdin.ok) return stdin;
    text = stdin.value;
  }
  if (new TextEncoder().encode(text).byteLength > MAX_TOOL_INPUT_BYTES) {
    return { ok: false, response: toolFailure("INPUT_TOO_LARGE", "La entrada supera 1 MiB.") };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return {
      ok: false,
      response: toolFailure("INVALID_JSON", "--input-json debe contener JSON válido."),
    };
  }
}

async function readBoundedStdin(
  stream: NodeJS.ReadableStream,
  maxBytes: number,
): Promise<{ ok: true; value: string } | { ok: false; response: ToolFailure }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) {
      return { ok: false, response: toolFailure("INPUT_TOO_LARGE", "La entrada supera 1 MiB.") };
    }
    chunks.push(bytes);
  }
  return { ok: true, value: Buffer.concat(chunks).toString("utf-8") };
}

function isToolResponse(value: unknown): value is ToolResponse {
  return (
    value !== null &&
    typeof value === "object" &&
    "success" in value &&
    typeof (value as { success?: unknown }).success === "boolean"
  );
}

function isToolList(value: unknown): value is { tools: readonly DatabaseToolDescriptor[] } {
  if (value === null || typeof value !== "object" || !("tools" in value)) return false;
  return Array.isArray((value as { tools?: unknown }).tools);
}
