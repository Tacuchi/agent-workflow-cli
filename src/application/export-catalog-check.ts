import { scanSql } from "../domain/sql-lexer.js";
import type { CatalogColumns } from "./database-tool-catalog.js";
import type { SemanticArtifact, SemanticParse } from "./semantic-operation/protocol.js";

export interface CatalogLookup {
  lookupColumns(connection: string, schemas: readonly string[]): Promise<CatalogColumns>;
}

interface Ref {
  schema: string;
  table: string;
  column?: string;
  file: string;
  localTable?: boolean;
  localColumn?: boolean;
}
const nameOf = (token: string): string =>
  token.startsWith('"') ? token.slice(1, -1).replaceAll('""', '"') : token.toLowerCase();
const keyOf = (ref: { schema: string; table: string }): string => `${ref.schema}.${ref.table}`;
const identifier = (token: string): boolean =>
  /^[A-Z_][A-Z_0-9]*$/.test(token) || /^"(?:[^"]|"")+"$/.test(token);

function qualified(
  tokens: readonly string[],
  at: number,
): { schema: string; table: string; after: number } | null {
  const schema = tokens[at];
  const table = tokens[at + 2];
  return schema !== undefined &&
    identifier(schema) &&
    tokens[at + 1] === "." &&
    table !== undefined &&
    identifier(table)
    ? { schema: nameOf(schema), table: nameOf(table), after: at + 3 }
    : null;
}

function columnList(tokens: readonly string[], open: number): string[] {
  if (tokens[open] !== "(") return [];
  const out: string[] = [];
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "(") depth++;
    else if (token === ")") {
      depth--;
      if (depth === 0) break;
    } else if (
      depth === 1 &&
      (i === open + 1 || tokens[i - 1] === ",") &&
      token !== undefined &&
      !["CONSTRAINT", "PRIMARY", "FOREIGN", "UNIQUE", "CHECK"].includes(token)
    ) {
      out.push(nameOf(token));
    }
  }
  return out;
}

/** A conservative lexical inventory: anything without a qualified identity stays unverified. */
export async function checkExportCatalog(
  artifacts: readonly SemanticArtifact[],
  unit: string,
  connection: string,
  lookup: CatalogLookup,
): Promise<SemanticParse<{ unverified: string[] }>> {
  const { refs, unverified } = analyzeForwards(artifacts, unit);
  const schemas = [...new Set(refs.map((ref) => ref.schema))];
  const result = await lookup.lookupColumns(connection, schemas.length > 0 ? schemas : ["public"]);
  if (!result.ok)
    return {
      ok: false,
      failure: {
        code: "EXPORT_CATALOG_UNAVAILABLE",
        message: `no se pudo consultar '${connection}' (${result.code}): ${result.message}`,
        action: "revisá la conexión de solo lectura y repetí validate",
      },
    };
  const missing = missingFromCatalog(refs, result.columns);
  if (missing.length > 0)
    return {
      ok: false,
      failure: {
        code: "EXPORT_CATALOG_MISMATCH",
        message: missing
          .map(
            (ref) =>
              `${ref.file}: ${ref.schema}.${ref.table}${ref.column === undefined ? "" : `.${ref.column}`}`,
          )
          .join("; "),
        action: "corregí los forwards o la base destino y repetí validate",
      },
    };
  return { ok: true, value: { unverified: [...new Set(unverified)] } };
}

interface Analysis {
  refs: Ref[];
  unverified: string[];
  created: Map<string, Set<string>>;
  added: Map<string, Set<string>>;
}

function analyzeForwards(artifacts: readonly SemanticArtifact[], unit: string): Analysis {
  const forwards = artifacts
    .filter((artifact) =>
      /^0[1-5]-[^/]+\/\d{2}-[^/]+\.sql$/.test(artifact.path.slice(unit.length + 1)),
    )
    .sort((a, b) => a.path.localeCompare(b.path));
  const analysis: Analysis = { refs: [], created: new Map(), added: new Map(), unverified: [] };
  for (const file of forwards) {
    const scan = scanSql(file.content);
    if (!scan.ok) {
      analysis.unverified.push(file.path);
      continue;
    }
    for (const statement of scan.statements) {
      if (statement.tokens.length === 0) continue;
      if (!analyzeStatement(statement.tokens, file.path, analysis)) {
        analysis.unverified.push(`${file.path}: sentencia sin referencias verificables`);
      }
    }
  }
  return analysis;
}

function analyzeStatement(tokens: readonly string[], file: string, analysis: Analysis): boolean {
  let analyzed = false;
  // The lexer can identify a qualified relation, but cannot bind projection,
  // predicate or join-condition columns to their relation without a SQL parser.
  if (tokens[0] === "SELECT" || tokens.includes("WHERE") || tokens.includes("HAVING"))
    analysis.unverified.push(`${file}: columnas de consulta/predicado sin verificar`);
  for (let i = 0; i < tokens.length; i++) {
    const word = tokens[i];
    if (!["FROM", "JOIN", "UPDATE", "INTO", "TABLE", "REFERENCES", "ON"].includes(word ?? ""))
      continue;
    if (word === "ON" && !tokens.includes("INDEX")) continue;
    const table = qualified(tokens, afterOptionalModifiers(tokens, i + 1));
    if (table === null) {
      analysis.unverified.push(`${file}: ${word} sin esquema verificable`);
      continue;
    }
    analyzed = true;
    const ref = { schema: table.schema, table: table.table, file };
    if (
      word === "TABLE" &&
      tokens[0] === "DROP" &&
      tokens.includes("IF") &&
      tokens.includes("EXISTS")
    )
      continue;
    if (word === "TABLE" && tokens.includes("CREATE") && !tokens.includes("ALTER")) {
      analysis.created.set(keyOf(ref), new Set(columnList(tokens, table.after)));
      continue;
    }
    if (
      word === "TABLE" &&
      tokens.includes("ALTER") &&
      tokens.includes("ADD") &&
      tokens.includes("COLUMN")
    ) {
      const column = tokens[tokens.indexOf("COLUMN") + 1];
      if (column !== undefined) {
        const key = keyOf(ref);
        const columns = analysis.created.get(key) ?? analysis.added.get(key) ?? new Set<string>();
        columns.add(nameOf(column));
        if (!analysis.created.has(key)) analysis.added.set(key, columns);
      }
    }
    const localTable = analysis.created.has(keyOf(ref));
    analysis.refs.push({ ...ref, localTable });
    const expressionIndex =
      word === "ON" && tokens[table.after] === "(" && tokens[table.after + 2] === "(";
    if (expressionIndex)
      analysis.unverified.push(`${file}: columnas de índice por expresión sin verificar`);
    for (const column of expressionIndex
      ? []
      : referencedColumns(tokens, word ?? "", table.after)) {
      analysis.refs.push({
        ...ref,
        column,
        localTable,
        localColumn: Boolean(
          analysis.created.get(keyOf(ref))?.has(column) ||
            analysis.added.get(keyOf(ref))?.has(column),
        ),
      });
    }
  }
  return analyzed;
}

function afterOptionalModifiers(tokens: readonly string[], initial: number): number {
  let at = initial;
  if (tokens[at] === "IF" && tokens[at + 1] === "NOT" && tokens[at + 2] === "EXISTS") at += 3;
  if (tokens[at] === "IF" && tokens[at + 1] === "EXISTS") at += 2;
  if (tokens[at] === "ONLY") at++;
  return at;
}

function referencedColumns(tokens: readonly string[], word: string, after: number): string[] {
  const columns = ["INTO", "ON", "REFERENCES"].includes(word) ? columnList(tokens, after) : [];
  if (word === "UPDATE") {
    const setAt = tokens.indexOf("SET", after);
    let depth = 0;
    for (let j = setAt + 1; setAt >= 0 && j < tokens.length; j++) {
      const token = tokens[j] ?? "";
      if (depth === 0 && ["WHERE", "FROM", "RETURNING"].includes(token)) break;
      if (depth === 0 && (j === setAt + 1 || tokens[j - 1] === ",")) columns.push(nameOf(token));
      if (token === "(") depth++;
      if (token === ")") depth--;
    }
  }
  if (
    word === "TABLE" &&
    tokens.includes("ALTER") &&
    tokens.includes("COLUMN") &&
    !tokens.includes("ADD")
  ) {
    const column = tokens[tokens.indexOf("COLUMN") + 1];
    if (column !== undefined) columns.push(nameOf(column));
  }
  return columns;
}

function missingFromCatalog(
  refs: readonly Ref[],
  rows: readonly { schema: string; table: string; column: string }[],
): Ref[] {
  const existing = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = keyOf(row);
    const columns = existing.get(key) ?? new Set<string>();
    columns.add(row.column);
    existing.set(key, columns);
  }
  return refs.filter((ref) => {
    if (ref.localTable) return ref.column !== undefined && !ref.localColumn;
    const cols = existing.get(keyOf(ref));
    return (
      cols === undefined || (ref.column !== undefined && !ref.localColumn && !cols.has(ref.column))
    );
  });
}
