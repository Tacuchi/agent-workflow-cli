// Mirror de developer-workflow-plugin/scripts/sql-mutation-guard.py.
import type { EnvPort } from "../ports/env.js";

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

const TOOL_NAME_PATTERN = /^mcp__plugin.*qtc-(cert|prod).*__execute_sql$/;
const SERVER_PATTERN = /qtc-(cert|prod)/;
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
}

export function runSqlMutationGuard(input: SqlGuardInput): SqlGuardResult {
  if ((input.env.get("QTC_SQL_GUARD") ?? "").toLowerCase() === "off") {
    return { exitCode: 0 };
  }
  const raw = input.stdin.trim();
  if (raw.length === 0) return { exitCode: 0 };

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { exitCode: 0 };
  }

  const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";
  if (!TOOL_NAME_PATTERN.test(toolName)) return { exitCode: 0 };

  const serverMatch = toolName.match(SERVER_PATTERN);
  const server = serverMatch?.[1] ?? "?";

  const allowEnv = (input.env.get("QTC_SQL_GUARD_ALLOW") ?? "").toLowerCase();
  if (allowEnv.length > 0) {
    const allowed = new Set(allowEnv.split(",").map((s) => s.trim()));
    if (allowed.has(server)) return { exitCode: 0 };
  }

  const sql = extractSql(payload.tool_input);
  if (!sql) return { exitCode: 0 };

  const keyword = findMutation(sql);
  if (keyword === null) return { exitCode: 0 };

  const msg = formatBlockMessage(toolName, server, keyword);
  return { exitCode: 2, stderr: msg };
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

function formatBlockMessage(toolName: string, server: string, keyword: string): string {
  // Mirror Python `print(msg, file=sys.stderr)` — print appends a trailing `\n`.
  return `${[
    "[qtc-dev sql-mutation-guard] Bloqueado por shared-contract §30 (política BD universal de la familia qtc-*).",
    `  Tool      : ${toolName}`,
    `  Servidor  : qtc-${server}`,
    `  Keyword   : ${keyword}`,
    "",
    "Las mutaciones a BD (DML/DDL) NO se ejecutan desde una sesión qtc-*.",
    "Materializá el cambio como script SQL en docs/scripts/ del workspace",
    "de la fuente y pedile al usuario que lo aplique manualmente.",
    "",
    "Para excepciones puntuales delegadas por el usuario, usar:",
    "  QTC_SQL_GUARD=off              # desactiva el hook por completo",
    "  QTC_SQL_GUARD_ALLOW=cert       # permite sólo cert (no prod)",
    "",
  ].join("\n")}\n`;
}
