/** Transport-neutral contract for the PostgreSQL tools exposed by CLI and MCP. */

import { scanSql } from "./sql-lexer.js";

export const MAX_TOOL_INPUT_BYTES = 1024 * 1024;
/** JSON-RPC framing adds a small envelope around the canonical tool input. */
export const MAX_TOOL_TRANSPORT_INPUT_BYTES = MAX_TOOL_INPUT_BYTES + 64 * 1024;
export const MAX_TOOL_RESULT_BYTES = 4 * 1024 * 1024;
export const MAX_TOOL_ROWS = 1000;

export const DATABASE_TOOL_NAMES = ["execute_sql", "search_objects"] as const;
export type DatabaseToolName = (typeof DATABASE_TOOL_NAMES)[number];

export const SEARCH_OBJECT_TYPES = [
  "schema",
  "table",
  "view",
  "column",
  "procedure",
  "function",
  "index",
] as const;
export type SearchObjectType = (typeof SEARCH_OBJECT_TYPES)[number];

export const SEARCH_DETAIL_LEVELS = ["names", "summary", "full"] as const;
export type SearchDetailLevel = (typeof SEARCH_DETAIL_LEVELS)[number];

export interface ExecuteSqlInput {
  sql: string;
}

export interface SearchObjectsInput {
  object_type: SearchObjectType;
  pattern: string;
  detail_level: SearchDetailLevel;
  limit: number;
  schema?: string;
  table?: string;
}

export type DatabaseToolInput = ExecuteSqlInput | SearchObjectsInput;

export interface DatabaseToolDescriptor {
  name: DatabaseToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolSuccess {
  success: true;
  data: Record<string, unknown>;
  warnings?: readonly ToolWarning[];
}

export interface ToolWarning {
  code: string;
  message: string;
}

export interface ToolFailure {
  success: false;
  error: string;
  code: string;
  details?: Record<string, unknown>;
}

export type ToolResponse = ToolSuccess | ToolFailure;

export const DATABASE_TOOL_DESCRIPTORS: readonly DatabaseToolDescriptor[] = [
  {
    name: "execute_sql",
    description:
      "Ejecuta una única consulta PostgreSQL de lectura en una transacción de solo lectura.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["sql"],
      properties: {
        sql: { type: "string", minLength: 1, description: "Una única sentencia de lectura." },
      },
    },
  },
  {
    name: "search_objects",
    description: "Busca objetos PostgreSQL con filtros y orden determinista.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["object_type"],
      properties: {
        object_type: { enum: [...SEARCH_OBJECT_TYPES] },
        pattern: { type: "string", default: "%" },
        detail_level: { enum: [...SEARCH_DETAIL_LEVELS], default: "names" },
        limit: { type: "integer", minimum: 1, maximum: MAX_TOOL_ROWS, default: 100 },
        schema: { type: "string" },
        table: { type: "string" },
      },
    },
  },
];

export function isDatabaseToolName(value: string): value is DatabaseToolName {
  return (DATABASE_TOOL_NAMES as readonly string[]).includes(value);
}

export function toolSuccess(
  data: Record<string, unknown>,
  warnings: readonly ToolWarning[] = [],
): ToolSuccess {
  return {
    success: true,
    data,
    ...(warnings.length === 0 ? {} : { warnings }),
  };
}

export function toolFailure(
  code: string,
  error: string,
  details?: Record<string, unknown>,
): ToolFailure {
  return {
    success: false,
    error,
    code,
    ...(details === undefined ? {} : { details }),
  };
}

/** The one encoder used by both direct CLI and MCP tool responses. */
export function encodeToolResponse(response: ToolResponse): string {
  return JSON.stringify(response);
}

export type ParsedToolInput =
  | { ok: true; value: DatabaseToolInput }
  | { ok: false; response: ToolFailure };

export function parseDatabaseToolInput(name: DatabaseToolName, value: unknown): ParsedToolInput {
  if (serializedBytes(value) > MAX_TOOL_INPUT_BYTES) {
    return { ok: false, response: toolFailure("INPUT_TOO_LARGE", "La entrada supera 1 MiB.") };
  }
  if (name === "execute_sql") return parseExecuteSqlInput(value);
  return parseSearchObjectsInput(value);
}

export type SqlPolicyResult = { ok: true } | { ok: false; response: ToolFailure };

/**
 * The database transaction is the final protection. This lexical policy fails
 * closed before opening a connection for clear mutation and multi-statement
 * forms, while preserving comments and quoted strings correctly enough not to
 * mistake their contents for SQL keywords.
 */
export function validateReadOnlySql(sql: string): SqlPolicyResult {
  const scan = scanSql(sql);
  if (!scan.ok || scan.tokens.length === 0) {
    return {
      ok: false,
      response: toolFailure("INVALID_SQL", "La consulta debe contener SQL legible."),
    };
  }
  if (scan.semicolons > 1 || (scan.semicolons === 1 && scan.contentAfterSemicolon)) {
    return {
      ok: false,
      response: toolFailure(
        "MULTI_STATEMENT_UNSUPPORTED",
        "execute_sql acepta una sola sentencia.",
      ),
    };
  }

  const first = scan.tokens[0];
  if (first === undefined || !["SELECT", "WITH", "EXPLAIN", "SHOW", "VALUES"].includes(first)) {
    return {
      ok: false,
      response: toolFailure("READ_ONLY_POLICY", "execute_sql sólo permite consultas de lectura."),
    };
  }

  const forbidden = new Set([
    "INSERT",
    "UPDATE",
    "DELETE",
    "MERGE",
    "CREATE",
    "ALTER",
    "DROP",
    "TRUNCATE",
    "GRANT",
    "REVOKE",
    "INTO",
    "COPY",
    "CALL",
    "DO",
    "VACUUM",
    "ANALYZE",
    "LOCK",
    "BEGIN",
    "COMMIT",
    "ROLLBACK",
    "SET",
    "SET_CONFIG",
  ]);
  if (scan.tokens.some((token) => forbidden.has(token))) {
    return {
      ok: false,
      response: toolFailure("READ_ONLY_POLICY", "La consulta contiene una operación no permitida."),
    };
  }
  return { ok: true };
}

function parseExecuteSqlInput(value: unknown): ParsedToolInput {
  const record = objectWithOnly(value, ["sql"]);
  if (record === null || typeof record.sql !== "string" || record.sql.trim().length === 0) {
    return {
      ok: false,
      response: toolFailure("INVALID_INPUT", "execute_sql requiere un objeto con sql no vacío."),
    };
  }
  return { ok: true, value: { sql: record.sql } };
}

function parseSearchObjectsInput(value: unknown): ParsedToolInput {
  const record = objectWithOnly(value, [
    "object_type",
    "pattern",
    "detail_level",
    "limit",
    "schema",
    "table",
  ]);
  const base = parseSearchBase(record);
  if (!base.ok) return base;
  const filters = parseSearchFilters(record);
  if (!filters.ok) return filters;
  const constraint = validateSearchFilters(base.value.object_type, filters.value);
  if (constraint !== undefined) return { ok: false, response: constraint };
  return {
    ok: true,
    value: {
      ...base.value,
      ...filters.value,
    },
  };
}

type SearchBase = Pick<SearchObjectsInput, "object_type" | "pattern" | "detail_level" | "limit">;
type SearchFilters = Pick<SearchObjectsInput, "schema" | "table">;
type SearchParse<T> = { ok: true; value: T } | { ok: false; response: ToolFailure };

function parseSearchBase(record: Record<string, unknown> | null): SearchParse<SearchBase> {
  if (record === null || typeof record.object_type !== "string") {
    return failureSearchInput("search_objects requiere object_type.");
  }
  if (!(SEARCH_OBJECT_TYPES as readonly string[]).includes(record.object_type)) {
    return failureSearchInput("object_type no es uno de los valores permitidos.");
  }
  const pattern = record.pattern ?? "%";
  if (typeof pattern !== "string" || pattern.length === 0) {
    return failureSearchInput("pattern debe ser un texto no vacío.");
  }
  const detailLevel = record.detail_level ?? "names";
  if (
    typeof detailLevel !== "string" ||
    !(SEARCH_DETAIL_LEVELS as readonly string[]).includes(detailLevel)
  ) {
    return failureSearchInput("detail_level no es uno de los valores permitidos.");
  }
  const limit = record.limit ?? 100;
  if (!isSearchLimit(limit))
    return failureSearchInput(`limit debe estar entre 1 y ${MAX_TOOL_ROWS}.`);
  return {
    ok: true,
    value: {
      object_type: record.object_type as SearchObjectType,
      pattern,
      detail_level: detailLevel as SearchDetailLevel,
      limit,
    },
  };
}

function parseSearchFilters(record: Record<string, unknown> | null): SearchParse<SearchFilters> {
  if (record === null) return failureSearchInput("search_objects requiere object_type.");
  const schema = optionalNonEmptyString(record.schema);
  const table = optionalNonEmptyString(record.table);
  if (schema === false || table === false) {
    return failureSearchInput("schema y table deben ser textos no vacíos.");
  }
  return {
    ok: true,
    value: {
      ...(schema === undefined ? {} : { schema }),
      ...(table === undefined ? {} : { table }),
    },
  };
}

function validateSearchFilters(
  type: SearchObjectType,
  filters: SearchFilters,
): ToolFailure | undefined {
  if (filters.table !== undefined && type !== "column" && type !== "index") {
    return toolFailure("INVALID_INPUT", "table sólo aplica a column e index.");
  }
  if (filters.schema !== undefined && type === "schema") {
    return toolFailure("INVALID_INPUT", "schema no aplica al tipo schema; usá pattern.");
  }
  if (filters.table !== undefined && filters.schema === undefined) {
    return toolFailure("INVALID_INPUT", "table requiere el filtro schema.");
  }
  return undefined;
}

function isSearchLimit(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_TOOL_ROWS
  );
}

function failureSearchInput(message: string): SearchParse<never> {
  return { ok: false, response: toolFailure("INVALID_INPUT", message) };
}

function objectWithOnly(
  value: unknown,
  allowed: readonly string[],
): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key))) return null;
  return record;
}

function optionalNonEmptyString(value: unknown): string | undefined | false {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) return false;
  return value;
}

function serializedBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return MAX_TOOL_INPUT_BYTES + 1;
  }
}
