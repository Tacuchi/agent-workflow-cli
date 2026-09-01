import { type ToolResponse, encodeToolResponse, toolFailure } from "../domain/database-tools.js";
import type { DatabaseToolCatalog, DatabaseToolOutcome } from "./database-tool-catalog.js";

const PROTOCOL_VERSION = "2025-06-18";

export interface DatabaseMcpServerDeps {
  send: (message: unknown) => void;
  catalog: DatabaseToolCatalog;
  connection: string;
  onHostLoadObserved?: () => void | Promise<void>;
}

export interface DatabaseMcpServer {
  handle(message: unknown): Promise<boolean>;
}

interface JsonRpcEnvelope extends Record<string, unknown> {
  jsonrpc: "2.0";
  method: string;
  id?: string | number | null;
}

/** JSON-RPC adapter over the shared catalog. It owns no tool rules. */
export function createDatabaseMcpServer(deps: DatabaseMcpServerDeps): DatabaseMcpServer {
  let lifecycle: "new" | "awaiting-initialized" | "ready" = "new";
  const activeCalls = new Map<string, AbortController>();
  const cancelledBeforeStart = new Set<string>();

  function reply(id: unknown, result: unknown): void {
    if (!isJsonRpcResponseId(id)) return;
    deps.send({ jsonrpc: "2.0", id, result });
  }

  function replyError(id: unknown, code: number, message: string): void {
    if (!isJsonRpcResponseId(id)) return;
    deps.send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  function toolResult(response: ToolResponse): Record<string, unknown> {
    return {
      content: [{ type: "text", text: encodeToolResponse(response), mimeType: "application/json" }],
      ...(response.success ? {} : { isError: true }),
    };
  }

  async function dispatchToolCall(message: Record<string, unknown>): Promise<boolean> {
    const params = isRecord(message.params) ? message.params : {};
    const name = typeof params.name === "string" ? params.name : "";
    const requestKey = requestIdKey(message.id);
    // tools/call is a request, not a notification. Rejecting an id-less call
    // prevents an untracked database operation that the client cannot cancel.
    if (requestKey === undefined) {
      replyError(message.id, -32600, "tools/call requiere un id de solicitud válido");
      return true;
    }
    if (cancelledBeforeStart.delete(requestKey)) {
      reply(message.id, toolResult(toolFailure("QUERY_CANCELLED", "La consulta fue cancelada.")));
      return true;
    }
    const controller = new AbortController();
    activeCalls.set(requestKey, controller);
    try {
      const outcome: DatabaseToolOutcome = await deps.catalog.call({
        tool: name,
        connection: deps.connection,
        input: params.arguments,
        signal: controller.signal,
      });
      reply(message.id, toolResult(outcome.response));
    } catch {
      reply(
        message.id,
        toolResult(toolFailure("TOOL_EXECUTION_FAILED", "La tool no pudo completar la solicitud.")),
      );
    } finally {
      if (activeCalls.get(requestKey) === controller) {
        activeCalls.delete(requestKey);
      }
    }
    return true;
  }

  async function cancelToolCall(message: Record<string, unknown>): Promise<boolean> {
    const params = isRecord(message.params) ? message.params : {};
    const key = requestIdKey(params.requestId);
    if (key === undefined) return true;
    const active = activeCalls.get(key);
    if (active !== undefined) {
      active.abort();
      return true;
    }
    // A stdio transport may receive cancellation while an earlier call keeps a
    // later request queued. Retain bounded intent so that later call never
    // reaches PostgreSQL once it starts.
    cancelledBeforeStart.add(key);
    if (cancelledBeforeStart.size > 1_000) {
      const oldest = cancelledBeforeStart.values().next().value;
      if (oldest !== undefined) cancelledBeforeStart.delete(oldest);
    }
    return true;
  }

  async function initialize(message: Record<string, unknown>): Promise<boolean> {
    if (lifecycle !== "new") {
      replyError(message.id, -32600, "initialize sólo puede llamarse una vez por sesión");
      return true;
    }
    lifecycle = "awaiting-initialized";
    reply(message.id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "agent-workflow-db", version: "1" },
    });
    return true;
  }

  async function initialized(): Promise<boolean> {
    if (lifecycle === "awaiting-initialized") {
      lifecycle = "ready";
      await deps.onHostLoadObserved?.();
    }
    return true;
  }

  function readyOrReply(message: Record<string, unknown>): boolean {
    if (lifecycle === "ready") return true;
    replyError(message.id, -32002, "Server not initialized");
    return false;
  }

  async function listTools(message: Record<string, unknown>): Promise<boolean> {
    if (!readyOrReply(message)) return true;
    try {
      const list = deps.catalog.list(deps.connection);
      reply(message.id, "tools" in list.payload ? list.payload : toolResult(list.payload));
    } catch {
      reply(
        message.id,
        toolResult(
          toolFailure("MCP_CONNECTION_INVALID", "No se pudo resolver la conexión solicitada."),
        ),
      );
    }
    return true;
  }

  async function callTool(message: Record<string, unknown>): Promise<boolean> {
    if (!readyOrReply(message)) return true;
    return await dispatchToolCall(message);
  }

  const handlers: Record<string, (message: Record<string, unknown>) => Promise<boolean>> = {
    initialize,
    "notifications/initialized": async () => await initialized(),
    "notifications/cancelled": async (message) => await cancelToolCall(message),
    "tools/list": listTools,
    "tools/call": callTool,
  };

  return {
    async handle(message: unknown): Promise<boolean> {
      if (!isJsonRpcEnvelope(message)) return false;
      const handler = handlers[message.method];
      if (handler !== undefined) return await handler(message);
      replyError(message.id, -32601, "Method not found");
      return true;
    },
  };
}

/** Accept only envelopes for which every response remains valid JSON-RPC. */
function isJsonRpcEnvelope(value: unknown): value is JsonRpcEnvelope {
  return (
    isRecord(value) &&
    value.jsonrpc === "2.0" &&
    typeof value.method === "string" &&
    isJsonRpcId(value.id)
  );
}

function isJsonRpcId(value: unknown): value is string | number | null | undefined {
  return value === undefined || isJsonRpcResponseId(value);
}

function isJsonRpcResponseId(value: unknown): value is string | number | null {
  return value === null || typeof value === "string" || isFiniteId(value);
}

function isFiniteId(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function requestIdKey(value: unknown): string | undefined {
  if (typeof value === "string") return `string:${value}`;
  if (typeof value === "number" && Number.isFinite(value)) return `number:${value}`;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
