// Patterns and display name are read from the runtime config (Phase 3 agnostic CLI).
import {
  type SqlLexicalMark,
  type SqlLiteral,
  type SqlStatement,
  scanSql,
} from "../domain/sql-lexer.js";
import type { EnvPort } from "../ports/env.js";
import type { ResolvedRuntime } from "../runtime/types.js";
import { parseHookPayload } from "./hook-common.js";
import { resolveMcpConnectionSelection } from "./mcp-connections-service.js";
import type { PathsService } from "./paths-service.js";

// The spec's closed list of reads (S051/AC-12): anything else is blocked, even
// without a mutation keyword, because a mutation list lets through what it omits.
const READ_STATEMENTS = new Set(["SELECT", "VALUES", "TABLE", "SHOW"]);
const EXPLAIN_LEGACY_OPTIONS = new Set(["ANALYZE", "ANALYSE", "VERBOSE"]);
const STATEMENT_DISPLAY_CHARS = 120;

// Functions that run the SQL text of one of their arguments: the first one, or
// the last one that is not a fail_on_error flag. dblink's connection is not the
// caller's transaction, so not even serve-db's READ ONLY covers it.
const SQL_TEXT_FUNCTIONS: ReadonlyMap<string, "first" | "last"> = new Map([
  ["query_to_xml", "first"],
  ["query_to_xmlschema", "first"],
  ["query_to_xml_and_xmlschema", "first"],
  ["dblink", "last"],
  ["dblink_exec", "last"],
  ["dblink_send_query", "last"],
  ["dblink_open", "last"],
]);
const BOOLEAN_LITERALS = new Set(["TRUE", "FALSE"]);

const REASONS = {
  undelimited:
    "el SQL no se puede delimitar: hay un literal, un identificador o un comentario sin cerrar",
  into: "lleva INTO: SELECT … INTO crea una tabla, no la lee",
  noRead: "no empieza con una lectura",
  withShape: "el WITH no tiene la forma nombre AS (…)",
  explainShape: "las opciones de EXPLAIN no cierran su paréntesis",
  unclassifiable:
    "el SQL no se pudo clasificar hasta el final, por ejemplo porque anida más de lo que la guarda puede recorrer",
  sqlTextNotLiteral: (name: string) =>
    `${name} ejecuta un SQL que no es un único literal, y no se puede juzgar`,
  sqlTextNotRead: (name: string, reason: string) => `${name} ejecuta un SQL que no lee: ${reason}`,
  escapedFunctionName:
    "llama a una función cuyo nombre lleva escapes U&, y no se puede saber cuál es",
} as const;

// PostgreSQL reads these differently than MySQL; a server that may be either
// is read both ways, and the other reading could hide a second statement.
const MARK_REASONS: Record<SqlLexicalMark, string> = {
  hash: "tiene un # fuera de un literal, que otro motor lee como comentario",
  backtick: "tiene un backtick fuera de un literal, que otro motor lee como identificador",
  "backslash-quote":
    "tiene una \\ antes de una comilla, que otro motor lee como escape y cierra el literal en otro lugar",
  "executable-comment": "tiene un comentario /*! … */, que MySQL ejecuta como SQL",
  "dollar-quote": "tiene un literal entre $…$, que sólo PostgreSQL lee como literal",
};

/** `postgres` only when Workline knows it; any other server may also be MySQL. */
type SqlDialect = "postgres" | "unknown";

const DIALECT_DISPLAY: Record<SqlDialect, string> = {
  postgres: "PostgreSQL, registrado en aw self mcp",
  unknown:
    "sin declarar: el servidor no está registrado en aw self mcp y se lee también como MySQL",
};

export interface SqlGuardResult {
  exitCode: 0 | 2;
  stderr?: string;
}

export interface SqlGuardInput {
  stdin: string;
  env: EnvPort;
  runtime: ResolvedRuntime;
  paths: PathsService;
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
  const payload = parseHookPayload(input.stdin);
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
  const dialect = dialectOf(toolName, input.paths);
  const blocked = findNonReadOrBlock(sql, dialect);
  if (blocked === null) return { exitCode: 0 };

  const display = input.runtime.displayName ?? "agent-workflow";
  const msg = formatBlockMessage(toolName, serverFull, dialect, blocked, display);
  return { exitCode: 2, stderr: msg };
}

/**
 * Every connection in the `aw self mcp` registry is served by `aw mcp serve-db`,
 * which speaks only PostgreSQL, and the host names its tools `mcp__<name>__…`.
 */
function dialectOf(toolName: string, paths: PathsService): SqlDialect {
  try {
    const registry = resolveMcpConnectionSelection(paths, { allConnections: true });
    if (!registry.ok) return "unknown";
    const served = registry.connections.some(
      (connection) =>
        connection.provider === "postgres" && toolName.startsWith(`mcp__${connection.name}__`),
    );
    return served ? "postgres" : "unknown";
  } catch {
    // A throw would exit the hook with a code the host does not block on; an
    // unreadable registry declares nothing, so the server is read both ways.
    return "unknown";
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

interface NonReadStatement {
  statement: string;
  reason: string;
}

/**
 * The host blocks only on exit 2, and a throw leaves the hook with another code:
 * a nesting deep enough to exhaust the stack is blocked, never let through.
 */
function findNonReadOrBlock(sql: string, dialect: SqlDialect): NonReadStatement | null {
  try {
    return findNonRead(sql, dialect);
  } catch {
    return {
      statement: `entrada completa · ${displayStatement(sql)}`,
      reason: REASONS.unclassifiable,
    };
  }
}

function findNonRead(sql: string, dialect: SqlDialect): NonReadStatement | null {
  const scan = scanSql(sql);
  if (!scan.ok) {
    return {
      statement: `entrada completa · ${displayStatement(sql)}`,
      reason: REASONS.undelimited,
    };
  }
  // An empty or comment-only statement runs nothing; it is neither counted nor classified.
  const statements = scan.statements.filter(
    (s) => s.tokens.length > 0 || marksOf(s, dialect).length > 0,
  );
  for (const [position, statement] of statements.entries()) {
    const reason = classifyStatement(statement, dialect);
    if (reason === null) continue;
    const text = displayStatement(sql.slice(statement.start, statement.end));
    return { statement: `${position + 1} de ${statements.length} · ${text}`, reason };
  }
  return null;
}

/** Every mark is another engine's reading, so PostgreSQL has none to fear. */
function marksOf(statement: SqlStatement, dialect: SqlDialect): readonly SqlLexicalMark[] {
  return dialect === "postgres" ? [] : statement.marks;
}

/** Returns why the statement is not a read, or null when it reads. */
function classifyStatement(statement: SqlStatement, dialect: SqlDialect): string | null {
  const mark = marksOf(statement, dialect)[0];
  if (mark !== undefined) return MARK_REASONS[mark];
  const { tokens } = statement;
  const shape = classifyRange(tokens, 0, tokens.length);
  if (shape !== null) return shape;
  if (tokens.includes("INTO")) return REASONS.into;
  return classifySqlTextCalls(statement);
}

/** A function that runs SQL text reads only when that text is one literal that reads. */
function classifySqlTextCalls(statement: SqlStatement): string | null {
  const { tokens } = statement;
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (tokens[index + 1] !== "(") continue;
    if (isEscapedName(tokens, index)) return REASONS.escapedFunctionName;
    const call = sqlTextFunctionOf(tokens[index] ?? "");
    if (call === undefined) continue;
    const text = sqlTextArgument(statement, index + 1, call.position);
    if (text === undefined) return REASONS.sqlTextNotLiteral(call.name);
    // Only PostgreSQL has these functions, so the text they run is PostgreSQL.
    const inner = findNonRead(text, "postgres");
    if (inner !== null) return REASONS.sqlTextNotRead(call.name, inner.reason);
  }
  return null;
}

/** `U&"…"`, with or without UESCAPE, spells the name through escapes the guard does not decode. */
function isEscapedName(tokens: readonly string[], index: number): boolean {
  const token = tokens[index] ?? "";
  return token === "UESCAPE" || (token.startsWith('"') && tokens[index - 1] === "U");
}

/** A bare name folds to lower case, as PostgreSQL resolves it; a quoted one does not. */
function sqlTextFunctionOf(
  token: string,
): { name: string; position: "first" | "last" } | undefined {
  const name = token.startsWith('"') ? token.slice(1, -1) : token.toLowerCase();
  const position = SQL_TEXT_FUNCTIONS.get(name);
  return position === undefined ? undefined : { name, position };
}

/** The SQL text the call at `open` runs, or undefined when it is not one literal. */
function sqlTextArgument(
  statement: SqlStatement,
  open: number,
  position: "first" | "last",
): string | undefined {
  const { tokens } = statement;
  const close = matchingParen(tokens, open, tokens.length);
  if (close < 0) return undefined;
  const args = callArguments(tokens, open, close);
  const sqlArgs =
    position === "first"
      ? args.slice(0, 1)
      : args.filter(
          ([start, end]) => end - start !== 1 || !BOOLEAN_LITERALS.has(tokens[start] ?? ""),
        );
  const arg = sqlArgs.at(-1);
  return arg === undefined ? undefined : soleLiteral(statement.literals, arg);
}

/** Token ranges [start, end) of the call's arguments, split at its own commas. */
function callArguments(
  tokens: readonly string[],
  open: number,
  close: number,
): Array<[number, number]> {
  const args: Array<[number, number]> = [];
  let depth = 0;
  let start = open + 1;
  for (let index = open + 1; index < close; index += 1) {
    const token = tokens[index];
    if (token === "(") depth += 1;
    else if (token === ")") depth -= 1;
    else if (token === "," && depth === 0) {
      args.push([start, index]);
      start = index + 1;
    }
  }
  args.push([start, close]);
  return args;
}

/** An argument with no token of its own is its literals; only one is judged. */
function soleLiteral(
  literals: readonly SqlLiteral[],
  [start, end]: [number, number],
): string | undefined {
  if (start !== end) return undefined;
  const inside = literals.filter((literal) => literal.at === start);
  return inside.length === 1 ? inside[0]?.text : undefined;
}

function classifyRange(tokens: readonly string[], start: number, end: number): string | null {
  let index = start;
  while (index < end && tokens[index] === "(") index += 1;
  const first = index < end ? tokens[index] : undefined;
  if (first === undefined || first === ")" || first === ",") return REASONS.noRead;
  if (READ_STATEMENTS.has(first)) return null;
  if (first === "WITH") return classifyWith(tokens, index + 1, end);
  if (first === "EXPLAIN") return classifyExplain(tokens, index + 1, end);
  return `${first} no es una lectura`;
}

/**
 * Only a top-level WITH may hold data-modifying parts, so each part's body and
 * the main statement are classified; nested WITHs recurse through classifyRange.
 */
function classifyWith(tokens: readonly string[], start: number, end: number): string | null {
  let index = tokens[start] === "RECURSIVE" ? start + 1 : start;
  for (;;) {
    const part = classifyWithPart(tokens, index, end);
    if (typeof part === "string") return part;
    index = part.next;
    if (tokens[index] !== ",") break;
    index += 1;
  }
  const main = classifyRange(tokens, index, end);
  return main === null ? null : `la sentencia principal del WITH: ${main}`;
}

/** Reads `name [(columns)] AS [NOT] [MATERIALIZED] (body)`; returns why it fails or where it ends. */
function classifyWithPart(
  tokens: readonly string[],
  start: number,
  end: number,
): string | { next: number } {
  const as = indexAtDepth(tokens, "AS", start, end);
  if (as < 0) return REASONS.withShape;
  let open = as + 1;
  if (tokens[open] === "NOT") open += 1;
  if (tokens[open] === "MATERIALIZED") open += 1;
  const close = tokens[open] === "(" ? matchingParen(tokens, open, end) : -1;
  if (close < 0) return REASONS.withShape;
  const body = classifyRange(tokens, open + 1, close);
  return body === null ? { next: close + 1 } : `una parte del WITH: ${body}`;
}

/** EXPLAIN is classified by what it explains, with or without ANALYZE. */
function classifyExplain(tokens: readonly string[], start: number, end: number): string | null {
  let index = start;
  if (tokens[index] === "(") {
    const close = matchingParen(tokens, index, end);
    if (close < 0) return REASONS.explainShape;
    index = close + 1;
  } else {
    while (EXPLAIN_LEGACY_OPTIONS.has(tokens[index] ?? "")) index += 1;
  }
  const target = classifyRange(tokens, index, end);
  return target === null ? null : `EXPLAIN de otra sentencia: ${target}`;
}

function indexAtDepth(tokens: readonly string[], word: string, start: number, end: number): number {
  let depth = 0;
  for (let index = start; index < end; index += 1) {
    const token = tokens[index];
    if (token === "(") depth += 1;
    else if (token === ")") depth -= 1;
    else if (depth === 0 && token === word) return index;
    if (depth < 0) return -1;
  }
  return -1;
}

function matchingParen(tokens: readonly string[], open: number, end: number): number {
  let depth = 0;
  for (let index = open; index < end; index += 1) {
    if (tokens[index] === "(") depth += 1;
    else if (tokens[index] === ")") depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
}

function displayStatement(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > STATEMENT_DISPLAY_CHARS
    ? `${compact.slice(0, STATEMENT_DISPLAY_CHARS)}…`
    : compact;
}

function formatBlockMessage(
  toolName: string,
  server: string,
  dialect: SqlDialect,
  blocked: NonReadStatement,
  display: string,
): string {
  return `${[
    `[${display} sql-mutation-guard] Bloqueado por shared-contract §30 (política BD universal).`,
    `  Tool      : ${toolName}`,
    `  Servidor  : ${server}`,
    `  Motor     : ${DIALECT_DISPLAY[dialect]}`,
    `  Sentencia : ${blocked.statement}`,
    `  Motivo    : ${blocked.reason}`,
    "",
    "Sólo pasan lecturas: SELECT sin INTO, WITH de lecturas, EXPLAIN de una lectura, SHOW, VALUES y TABLE.",
    "Las mutaciones a BD (DML/DDL) NO se ejecutan desde una sesión.",
    "Materializá el cambio como script SQL en docs/scripts/ del hub",
    "de la fuente y pedile al usuario que lo aplique manualmente.",
    "",
    "Para excepciones puntuales delegadas por el usuario, usar:",
    "  AW_SQL_GUARD=off               # desactiva el hook por completo",
    "  AW_SQL_GUARD_ALLOW=<servidor> # permite sólo ese servidor",
    "",
  ].join("\n")}\n`;
}
