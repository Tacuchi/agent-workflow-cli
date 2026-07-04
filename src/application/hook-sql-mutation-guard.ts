// Patterns and display name are read from the runtime config (Phase 3 agnostic CLI).
import type { EnvPort } from "../ports/env.js";
import type { ResolvedRuntime } from "../runtime/types.js";

const MUTATION_KEYWORDS = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "MERGE",
  "CREATE",
  "ALTER",
  "DROP",
  "GRANT",
  "REVOKE",
  "COPY",
];

const MUTATION_PATTERN = new RegExp(`\\b(${MUTATION_KEYWORDS.join("|")})\\b`, "i");
const COMMENT_LINE_RE = /--[^\n]*/g;
const COMMENT_BLOCK_RE = /\/\*[\s\S]*?\*\//g;

export interface SqlGuardResult {
  exitCode: 0 | 2;
  stderr?: string;
}

export interface SqlGuardInput {
  stdin: string;
  env: EnvPort;
  runtime: ResolvedRuntime;
}

export function runSqlMutationGuard(input: SqlGuardInput): SqlGuardResult {
  const patterns = input.runtime.mcpGuards?.sqlMutation;
  if (!patterns) {
    // No config → guard disabled. Allow tool through.
    return { exitCode: 0 };
  }
  if ((input.env.get("AW_SQL_GUARD") ?? "").toLowerCase() === "off") {
    return { exitCode: 0 };
  }
  const payload = parsePayload(input.stdin);
  if (!payload) return { exitCode: 0 };

  const compiled = compilePatterns(patterns);
  if (!compiled) return { exitCode: 0 };

  const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";
  if (!compiled.tool.test(toolName)) return { exitCode: 0 };

  const serverMatch = toolName.match(compiled.server);
  const serverFull = serverMatch?.[0] ?? "?";
  const serverSuffix = serverMatch?.[1] ?? serverFull;

  if (isAllowedServer(input.env, serverSuffix)) return { exitCode: 0 };

  const sql = extractSql(payload.tool_input);
  if (!sql) return { exitCode: 0 };
  const keyword = findMutation(sql);
  if (keyword === null) return { exitCode: 0 };

  const display = input.runtime.displayName ?? "agent-workflow";
  const msg = formatBlockMessage(toolName, serverFull, keyword, display);
  return { exitCode: 2, stderr: msg };
}

function parsePayload(stdin: string): Record<string, unknown> | null {
  const raw = stdin.trim();
  if (raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function compilePatterns(patterns: {
  toolPattern: string;
  serverPattern: string;
}): { tool: RegExp; server: RegExp } | null {
  try {
    return {
      tool: new RegExp(patterns.toolPattern),
      server: new RegExp(patterns.serverPattern),
    };
  } catch {
    return null;
  }
}

function isAllowedServer(env: EnvPort, serverSuffix: string): boolean {
  const allowEnv = (env.get("AW_SQL_GUARD_ALLOW") ?? "").toLowerCase();
  if (allowEnv.length === 0) return false;
  const allowed = new Set(allowEnv.split(",").map((s) => s.trim()));
  return allowed.has(serverSuffix);
}

function extractSql(toolInput: unknown): string {
  if (typeof toolInput !== "object" || toolInput === null) return "";
  const obj = toolInput as Record<string, unknown>;
  for (const key of ["sql", "query", "statement", "command"]) {
    const value = obj[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return "";
}

function findMutation(sql: string): string | null {
  const cleaned = stripComments(sql);
  const m = cleaned.match(MUTATION_PATTERN);
  return m?.[1] ? m[1].toUpperCase() : null;
}

function stripComments(sql: string): string {
  return sql.replace(COMMENT_BLOCK_RE, " ").replace(COMMENT_LINE_RE, " ");
}

function formatBlockMessage(
  toolName: string,
  server: string,
  keyword: string,
  display: string,
): string {
  return `${[
    `[${display} sql-mutation-guard] Bloqueado por shared-contract §30 (política BD universal).`,
    `  Tool      : ${toolName}`,
    `  Servidor  : ${server}`,
    `  Keyword   : ${keyword}`,
    "",
    "Las mutaciones a BD (DML/DDL) NO se ejecutan desde una sesión.",
    "Materializá el cambio como script SQL en docs/scripts/ del workspace",
    "de la fuente y pedile al usuario que lo aplique manualmente.",
    "",
    "Para excepciones puntuales delegadas por el usuario, usar:",
    "  AW_SQL_GUARD=off               # desactiva el hook por completo",
    "  AW_SQL_GUARD_ALLOW=cert        # permite sólo cert (no prod)",
    "",
  ].join("\n")}\n`;
}
