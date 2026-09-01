import {
  DATABASE_TOOL_DESCRIPTORS,
  type ExecuteSqlInput,
  MAX_TOOL_RESULT_BYTES,
  type SearchObjectsInput,
  type ToolFailure,
  type ToolResponse,
  isDatabaseToolName,
  parseDatabaseToolInput,
  toolFailure,
  toolSuccess,
  validateReadOnlySql,
} from "../domain/database-tools.js";
import {
  buildPostgresObjectSearchQuery,
  normalizePostgresObjectSearchRows,
} from "../domain/postgres-object-search.js";
import type { EnvPort } from "../ports/env.js";
import {
  type PostgresReadonlyPort,
  type PostgresRoleInspection,
  PostgresToolError,
} from "../ports/postgres-tools.js";
import { readDsnFile } from "./dsn-reader-service.js";
import {
  type StoredMcpConnection,
  resolveMcpConnectionSelection,
} from "./mcp-connections-service.js";
import type { PathsService } from "./paths-service.js";

export interface DatabaseToolCatalogDeps {
  paths: PathsService;
  env: EnvPort;
  postgres: PostgresReadonlyPort;
}

export interface DatabaseToolCall {
  tool: string;
  connection: string;
  input: unknown;
  signal?: AbortSignal;
}

export interface DatabaseToolOutcome {
  response: ToolResponse;
  exitCode: 0 | 1 | 2;
}

export interface DatabaseToolListOutcome {
  payload: { tools: readonly (typeof DATABASE_TOOL_DESCRIPTORS)[number][] } | ToolFailure;
  exitCode: 0 | 2;
}

export interface DatabaseRoleOutcome {
  inspection: PostgresRoleInspection | ToolFailure;
  exitCode: 0 | 1 | 2;
}

type PreparedToolCall =
  | {
      tool: "execute_sql";
      input: ExecuteSqlInput;
      dsn: string;
      signal?: AbortSignal;
    }
  | {
      tool: "search_objects";
      input: SearchObjectsInput;
      dsn: string;
      signal?: AbortSignal;
    };

type ToolCallPreparation =
  | { ok: true; value: PreparedToolCall }
  | { ok: false; outcome: DatabaseToolOutcome };

/**
 * The deep module for database tools. Its small interface is shared by direct
 * CLI and MCP adapters; connection lookup, validation, policy, handler choice
 * and response encoding stay local instead of drifting across transports.
 */
export class DatabaseToolCatalog {
  constructor(private readonly deps: DatabaseToolCatalogDeps) {}

  list(connection: string): DatabaseToolListOutcome {
    const selected = this.selectConnection(connection);
    if (!selected.ok) return { payload: sanitizeSelectionFailure(selected.response), exitCode: 2 };
    return { payload: { tools: DATABASE_TOOL_DESCRIPTORS }, exitCode: 0 };
  }

  async call(call: DatabaseToolCall): Promise<DatabaseToolOutcome> {
    const prepared = this.prepareCall(call);
    if (!prepared.ok) return prepared.outcome;
    if (prepared.value.tool === "execute_sql") return await this.executeSql(prepared.value);
    return await this.searchObjects(prepared.value);
  }

  private prepareCall(call: DatabaseToolCall): ToolCallPreparation {
    if (!isDatabaseToolName(call.tool))
      return {
        ok: false,
        outcome: failureOutcome("TOOL_NOT_FOUND", "La tool solicitada no existe.", 2),
      };
    const selected = this.selectConnection(call.connection);
    if (!selected.ok) {
      return {
        ok: false,
        outcome: { response: sanitizeSelectionFailure(selected.response), exitCode: 2 },
      };
    }
    const dsn = this.resolveDsn(selected.connection);
    if (!dsn.ok) return { ok: false, outcome: { response: dsn.response, exitCode: 2 } };
    const parsed = parseDatabaseToolInput(call.tool, call.input);
    if (!parsed.ok) return { ok: false, outcome: failureFromResponse(parsed.response, 2) };
    if (call.tool === "execute_sql") {
      return {
        ok: true,
        value: {
          tool: call.tool,
          input: parsed.value as ExecuteSqlInput,
          dsn: dsn.value,
          ...(call.signal === undefined ? {} : { signal: call.signal }),
        },
      };
    }
    return {
      ok: true,
      value: {
        tool: call.tool,
        input: parsed.value as SearchObjectsInput,
        dsn: dsn.value,
        ...(call.signal === undefined ? {} : { signal: call.signal }),
      },
    };
  }

  private async executeSql(
    call: Extract<PreparedToolCall, { tool: "execute_sql" }>,
  ): Promise<DatabaseToolOutcome> {
    const policy = validateReadOnlySql(call.input.sql);
    if (!policy.ok) {
      return failureFromResponse(policy.response, policy.response.code === "INVALID_SQL" ? 2 : 1);
    }
    return await this.runDatabaseOperation(async () => {
      const result =
        call.signal === undefined
          ? await this.deps.postgres.execute(call.input.sql, call.dsn)
          : await this.deps.postgres.execute(call.input.sql, call.dsn, { signal: call.signal });
      return this.enforceResultLimit(
        toolSuccess({
          statements: [
            {
              sql: call.input.sql,
              rows: result.rows,
              count: result.rows.length,
              ...(result.truncated ? { truncated: true } : {}),
            },
          ],
          source_id: "default",
        }),
      );
    });
  }

  private async searchObjects(
    call: Extract<PreparedToolCall, { tool: "search_objects" }>,
  ): Promise<DatabaseToolOutcome> {
    // Ask for one extra row so `truncated` means an observed row was
    // omitted, rather than a guess based on a LIMIT boundary.
    const query = buildPostgresObjectSearchQuery({ ...call.input, limit: call.input.limit + 1 });
    return await this.runDatabaseOperation(async () => {
      const result =
        call.signal === undefined
          ? await this.deps.postgres.query(query.sql, query.values, call.dsn)
          : await this.deps.postgres.query(query.sql, query.values, call.dsn, {
              signal: call.signal,
            });
      const rows = normalizePostgresObjectSearchRows(
        call.input,
        result.rows.slice(0, call.input.limit),
      );
      return this.enforceResultLimit(
        toolSuccess({
          object_type: call.input.object_type,
          pattern: call.input.pattern,
          ...(call.input.schema === undefined ? {} : { schema: call.input.schema }),
          ...(call.input.table === undefined ? {} : { table: call.input.table }),
          detail_level: call.input.detail_level,
          count: rows.length,
          results: rows,
          truncated: result.truncated || result.rows.length > call.input.limit,
        }),
      );
    });
  }

  private async runDatabaseOperation(
    operation: () => Promise<DatabaseToolOutcome>,
  ): Promise<DatabaseToolOutcome> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof PostgresToolError) {
        return failureOutcome(error.code, error.message, databaseErrorExitCode(error.code));
      }
      return failureOutcome(
        "DATABASE_QUERY_FAILED",
        "La base de datos no pudo completar la operación.",
        1,
      );
    }
  }

  async inspectRole(connection: string): Promise<DatabaseRoleOutcome> {
    const selected = this.selectConnection(connection);
    if (!selected.ok) return { inspection: selected.response, exitCode: 2 };
    const dsn = this.resolveDsn(selected.connection);
    if (!dsn.ok) return { inspection: dsn.response, exitCode: 2 };
    try {
      return { inspection: await this.deps.postgres.inspectRole(dsn.value), exitCode: 0 };
    } catch (error) {
      if (error instanceof PostgresToolError) {
        return {
          inspection: toolFailure(error.code, error.message),
          exitCode: databaseErrorExitCode(error.code),
        };
      }
      return {
        inspection: toolFailure("DATABASE_QUERY_FAILED", "No se pudo verificar el rol PostgreSQL."),
        exitCode: 1,
      };
    }
  }

  private selectConnection(
    connection: string,
  ): { ok: true; connection: StoredMcpConnection } | { ok: false; response: ToolFailure } {
    let selection: ReturnType<typeof resolveMcpConnectionSelection>;
    try {
      selection = resolveMcpConnectionSelection(this.deps.paths, { instance: connection });
    } catch {
      return {
        ok: false,
        response: toolFailure(
          "MCP_CONNECTION_INVALID",
          "No se pudo resolver la conexión solicitada.",
        ),
      };
    }
    if (!selection.ok)
      return { ok: false, response: toolFailure(selection.code, selection.message) };
    const selected = selection.connections[0];
    if (selected === undefined) {
      return {
        ok: false,
        response: toolFailure("MCP_CONNECTION_NOT_REGISTERED", "La conexión no está registrada."),
      };
    }
    if (selected.provider !== "postgres") {
      return {
        ok: false,
        response: toolFailure(
          "TOOL_PROVIDER_UNSUPPORTED",
          "Esta tool sólo admite conexiones PostgreSQL.",
        ),
      };
    }
    return { ok: true, connection: selected };
  }

  private resolveDsn(
    connection: StoredMcpConnection,
  ): { ok: true; value: string } | { ok: false; response: ToolFailure } {
    const environment = this.deps.env.get(connection.dsnVar);
    if (environment !== undefined && environment.length > 0)
      return { ok: true, value: environment };
    try {
      const file = readDsnFile(this.deps.paths).values[connection.dsnVar];
      if (file !== undefined && file.length > 0) return { ok: true, value: file };
    } catch {
      return {
        ok: false,
        response: toolFailure(
          "DATABASE_CONNECTION_INVALID",
          "No se pudo leer la configuración de conexión.",
        ),
      };
    }
    return {
      ok: false,
      response: toolFailure(
        "DATABASE_CONNECTION_MISSING",
        `La conexión '${connection.name}' no tiene un DSN disponible.`,
      ),
    };
  }

  private enforceResultLimit(response: ToolResponse): DatabaseToolOutcome {
    try {
      const bytes = new TextEncoder().encode(JSON.stringify(response)).byteLength;
      if (bytes > MAX_TOOL_RESULT_BYTES) {
        return failureOutcome("RESULT_TOO_LARGE", "El resultado serializado supera 4 MiB.", 1);
      }
      return { response, exitCode: 0 };
    } catch {
      return failureOutcome(
        "RESULT_TOO_LARGE",
        "El resultado no se puede serializar de forma segura.",
        1,
      );
    }
  }
}

function failureOutcome(code: string, message: string, exitCode: 1 | 2): DatabaseToolOutcome {
  return { response: toolFailure(code, message), exitCode };
}

function failureFromResponse(response: ToolFailure, exitCode: 1 | 2): DatabaseToolOutcome {
  return { response, exitCode };
}

function databaseErrorExitCode(code: string): 1 | 2 {
  return code === "DATABASE_CONNECTION_FAILED" ||
    code === "DATABASE_CONNECTION_INVALID" ||
    code === "INVALID_SQL"
    ? 2
    : 1;
}

function sanitizeSelectionFailure(response: ToolFailure): ToolFailure {
  return toolFailure(response.code, "No se pudo resolver la conexión solicitada.");
}
