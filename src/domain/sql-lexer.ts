/** PostgreSQL lexical scan shared by the serve-db read-only policy and the sql-mutation-guard hook. */

/**
 * Lexical facts another engine reads differently than PostgreSQL. The scan
 * only reports them; each caller decides what they mean for its own policy.
 */
export type SqlLexicalMark = "hash" | "backtick" | "backslash-quote" | "executable-comment";

export interface SqlStatement {
  /** Offsets of the statement's text in the scanned input, without its `;`. */
  start: number;
  end: number;
  /** Upper-cased words plus the marks `(`, `)` and `,`, outside literals and comments. */
  tokens: string[];
  marks: SqlLexicalMark[];
}

export interface SqlScanSuccess {
  ok: true;
  /** Upper-cased words outside literals and comments, across every statement. */
  tokens: string[];
  semicolons: number;
  contentAfterSemicolon: boolean;
  statements: SqlStatement[];
}

export interface SqlScanFailure {
  ok: false;
}

export function scanSql(sql: string): SqlScanSuccess | SqlScanFailure {
  const state = createSqlScanState();
  while (state.index < sql.length) {
    if (!scanSqlCharacter(sql, state)) return { ok: false };
  }
  flushSqlToken(state);
  closeStatement(state, sql.length);
  return state.blockCommentDepth === 0
    ? {
        ok: true,
        tokens: state.tokens,
        semicolons: state.semicolons,
        contentAfterSemicolon: state.contentAfterSemicolon,
        statements: state.statements,
      }
    : { ok: false };
}

interface SqlScanState {
  tokens: string[];
  index: number;
  semicolons: number;
  contentAfterSemicolon: boolean;
  token: string;
  blockCommentDepth: number;
  statements: SqlStatement[];
  statement: SqlStatement;
}

function createSqlScanState(): SqlScanState {
  return {
    tokens: [],
    index: 0,
    semicolons: 0,
    contentAfterSemicolon: false,
    token: "",
    blockCommentDepth: 0,
    statements: [],
    statement: openStatement(0),
  };
}

function openStatement(start: number): SqlStatement {
  return { start, end: start, tokens: [], marks: [] };
}

function closeStatement(state: SqlScanState, end: number): void {
  state.statement.end = end;
  state.statements.push(state.statement);
  state.statement = openStatement(end + 1);
}

function mark(state: SqlScanState, value: SqlLexicalMark): void {
  if (!state.statement.marks.includes(value)) state.statement.marks.push(value);
}

function scanSqlCharacter(sql: string, state: SqlScanState): boolean {
  if (state.blockCommentDepth > 0) {
    consumeBlockComment(sql, state);
    return true;
  }
  const char = sql[state.index] ?? "";
  const next = sql[state.index + 1] ?? "";
  if (consumeSqlComment(sql, state, char, next)) return true;
  markContentAfterSemicolon(state, char, next);
  const literal = consumeSqlLiteral(sql, state, char);
  if (literal !== undefined) return literal;
  consumePlainSqlCharacter(state, char);
  state.index += 1;
  return true;
}

function consumeSqlComment(sql: string, state: SqlScanState, char: string, next: string): boolean {
  if (char === "-" && next === "-") {
    consumeLineComment(sql, state);
    return true;
  }
  if (char !== "/" || next !== "*") return false;
  flushSqlToken(state);
  openBlockComment(sql, state);
  return true;
}

/** MySQL runs the body of a `/*! … *\/` comment as SQL. */
function openBlockComment(sql: string, state: SqlScanState): void {
  if (sql[state.index + 2] === "!") mark(state, "executable-comment");
  state.blockCommentDepth += 1;
  state.index += 2;
}

/** Returns undefined when the current byte remains regular SQL punctuation. */
function consumeSqlLiteral(sql: string, state: SqlScanState, char: string): boolean | undefined {
  if (char === "'" || char === '"') return consumeQuotedSql(sql, state, char);
  if (char !== "$" || !canOpenDollarQuoted(sql, state)) return undefined;
  const dollarQuoted = consumeDollarQuotedSql(sql, state);
  if (dollarQuoted === "consumed") return true;
  return dollarQuoted === "unterminated" ? false : undefined;
}

function consumePlainSqlCharacter(state: SqlScanState, char: string): void {
  if (/[A-Za-z0-9_]/.test(char)) {
    state.token += char;
    return;
  }
  flushSqlToken(state);
  if (char === ";") {
    state.semicolons += 1;
    closeStatement(state, state.index);
  } else if (char === "(" || char === ")" || char === ",") {
    state.statement.tokens.push(char);
  } else if (char === "#") {
    mark(state, "hash");
  } else if (char === "`") {
    mark(state, "backtick");
  }
}

function consumeBlockComment(sql: string, state: SqlScanState): void {
  const char = sql[state.index] ?? "";
  const next = sql[state.index + 1] ?? "";
  if (char === "/" && next === "*") {
    openBlockComment(sql, state);
    return;
  }
  if (char === "*" && next === "/") {
    state.blockCommentDepth -= 1;
    state.index += 2;
    return;
  }
  state.index += 1;
}

function consumeLineComment(sql: string, state: SqlScanState): void {
  flushSqlToken(state);
  state.index += 2;
  while (state.index < sql.length && sql[state.index] !== "\n" && sql[state.index] !== "\r") {
    state.index += 1;
  }
}

function markContentAfterSemicolon(state: SqlScanState, char: string, next: string): void {
  if (state.semicolons === 0 || /\s/.test(char) || char === ";") return;
  if ((char === "-" && next === "-") || (char === "/" && next === "*")) return;
  state.contentAfterSemicolon = true;
}

function consumeQuotedSql(sql: string, state: SqlScanState, quote: "'" | '"'): boolean {
  // PostgreSQL's ordinary string literals and quoted identifiers escape a
  // quote by doubling it. Backslashes escape only E'...' strings under the
  // default standard_conforming_strings setting, so treating every backslash
  // as an escape could hide a closing quote and a second statement.
  const allowsBackslashEscapes = quote === "'" && state.token.toUpperCase() === "E";
  flushSqlToken(state);
  const next = skipQuoted(sql, state.index, quote, allowsBackslashEscapes);
  if (next < 0) return false;
  // MySQL, and PostgreSQL with standard_conforming_strings off, read `\'` as
  // an escaped quote: the literal would end somewhere else.
  if (!allowsBackslashEscapes && sql.slice(state.index, next).includes(`\\${quote}`)) {
    mark(state, "backslash-quote");
  }
  state.index = next;
  return true;
}

type DollarQuotedConsumption = "consumed" | "not-dollar-quoted" | "unterminated";

function consumeDollarQuotedSql(sql: string, state: SqlScanState): DollarQuotedConsumption {
  const opener = readDollarTag(sql, state.index);
  if (opener === undefined) return "not-dollar-quoted";
  flushSqlToken(state);
  // An opener without its own closer is invalid PostgreSQL. Refuse it at the
  // first one rather than resuming at each subsequent `$tag$`; otherwise many
  // distinct unterminated tags make repeated suffix scans quadratic below the
  // 1 MiB input cap.
  const close = sql.indexOf(opener.tag, opener.afterOpen);
  if (close < 0) return "unterminated";
  state.index = close + opener.tag.length;
  return "consumed";
}

/** PostgreSQL requires a delimiter after an identifier to be whitespace-separated. */
function canOpenDollarQuoted(sql: string, state: SqlScanState): boolean {
  if (state.token.length > 0) return false;
  const previous = state.index === 0 ? undefined : sql[state.index - 1];
  // A quoted identifier is also an identifier even though it was intentionally
  // omitted from `tokens`; without this fence `"name$tag$` could hide the
  // remainder from the single-statement scan.
  return previous === undefined || (previous !== '"' && !isIdentifierContinuation(previous));
}

function isIdentifierContinuation(char: string): boolean {
  return /[A-Za-z0-9_$]/.test(char) || char.charCodeAt(0) >= 0x80;
}

function flushSqlToken(state: SqlScanState): void {
  if (state.token.length === 0) return;
  const word = state.token.toUpperCase();
  state.tokens.push(word);
  state.statement.tokens.push(word);
  state.token = "";
}

function skipQuoted(
  sql: string,
  start: number,
  quote: "'" | '"',
  allowsBackslashEscapes: boolean,
): number {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] === quote) {
      if (sql[index + 1] === quote) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    if (allowsBackslashEscapes && sql[index] === "\\") {
      index += 2;
    } else {
      index += 1;
    }
  }
  return -1;
}

function readDollarTag(sql: string, start: number): { tag: string; afterOpen: number } | undefined {
  if (sql[start] !== "$") return undefined;
  const next = sql[start + 1];
  if (next === "$") return { tag: "$$", afterOpen: start + 2 };
  if (next === undefined || !/[A-Za-z_]/.test(next)) return undefined;
  let end = start + 2;
  while (end < sql.length && /[A-Za-z0-9_]/.test(sql[end] ?? "")) end += 1;
  if (sql[end] !== "$") return undefined;
  const tag = sql.slice(start, end + 1);
  return { tag, afterOpen: end + 1 };
}
