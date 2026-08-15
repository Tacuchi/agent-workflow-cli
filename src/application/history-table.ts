// The history file path itself is resolved by callers via
// `PathsService.cwdHistoryFile()` and passed in.
import { join } from "node:path";
import type { FileSystemPort } from "../ports/file-system.js";
import { localDateIso } from "./dates.js";

// Slim 4-column table: `Sesión` (row key — the `NNN-<slug>-<flow>` folder
// identity), `Fecha`, `Estado`, `Refs`. The legacy `#`/`Flujo`/`Resumen`
// columns were derivable or dead ("#" = the Sesión prefix, "Flujo" always "—",
// "Resumen" = the slug re-spaced) and are dropped; legacy tables are migrated
// in place on the first upsert.
const HISTORY_TEMPLATE =
  "# Session History\n\n" +
  "| Sesión | Fecha | Estado | Refs |\n" +
  "|--------|-------|--------|------|\n";

/** How many data cells a row of the current shape has. */
const SLIM_COLUMNS = 4;

/**
 * Where a rewrite parks the bytes it cannot carry into the current shape.
 *
 * The slim table has no column for `Flujo` or `Resumen`, and the render of
 * `HISTORY.md` is a frozen contract — so a legacy row whose dropped columns
 * carried real prose has nowhere to go INSIDE the record. Copying the file
 * verbatim beside it is the only preservation that changes not one emitted
 * byte, and the name is its own explanation to whoever finds it.
 */
const LEGACY_SNAPSHOT = "HISTORY.legacy.md";

export type UpsertAction = "added" | "updated" | "unchanged";

/**
 * What a caller ASSERTS about a row. Every optional field means "I am not
 * naming this cell", never "blank it": the upsert keeps whatever the table
 * already holds there. `state` is not optional because every caller has one —
 * a row is written precisely to record it.
 *
 * `refs` arrives already rendered (see `render/history-row.ts`), so an explicit
 * `--refs ''` still reaches here as the rendered "—" and clears the cell.
 */
export interface HistoryRowInput {
  /** Identity used to FIND the row, and half of the key of a new one. */
  code: string;
  sesionName?: string;
  date?: string;
  state: string;
  refs?: string;
}

export async function ensureHistoryFile(fs: FileSystemPort, path: string): Promise<void> {
  if (await fs.exists(path)) return;
  await fs.mkdirp(join(path, ".."));
  await fs.writeText(path, HISTORY_TEMPLATE);
}

/** First cell of the slim row: the session's folder identity, always keyed by code. */
function rowKey(code: string, sesionName: string | undefined): string {
  if (!sesionName || sesionName === code) return code;
  return sesionName.startsWith(`${code}-`) ? sesionName : `${code}-${sesionName}`;
}

export function buildRow(params: {
  code: string;
  sesionName: string;
  date: string;
  state: string;
  refs: string;
}): string {
  const key = rowKey(params.code, params.sesionName);
  return `| ${key} | ${params.date} | ${params.state} | ${params.refs} |`;
}

/** Header row cells, lowercased. Empty when the file has no table header. */
function headerCells(text: string): string[] {
  const m = text.match(/^\|([^\n]+)\|\s*$/m);
  if (!m?.[1]) return [];
  return m[1].split("|").map((c) => c.trim().toLowerCase());
}

function isLegacyHeader(cells: string[]): boolean {
  return cells.includes("#") || cells.includes("flujo") || cells.includes("resumen");
}

/** The data cells of a markdown row, with the outer pipes removed. */
function dataCells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return inner.split("|").map((c) => c.trim());
}

/** A cell nobody wrote anything into: the migration may drop it without loss. */
function isEmptyCell(value: string): boolean {
  return value === "" || value === "—" || value === "-";
}

interface MigratedTable {
  text: string;
  /** A column with content had no destination in the slim shape. */
  lossy: boolean;
}

/**
 * Rewrite a legacy table (7-col `# | Flujo | Sesión | …` or 6-col without
 * Flujo) into the slim 4-col shape, mapping every data row by header index:
 * drop `#`/`Flujo`/`Resumen`, and prefix the Sesión cell with its `#` when it
 * does not already carry it (the code is the durable row key — losing it would
 * orphan the row for future upserts).
 *
 * Scoped to the history table ONLY: rewriting stops at the first blank/non-pipe
 * line after the header, so a second markdown table further down the file is
 * left untouched. Returns `null` when the table cannot be safely mapped (no
 * separator row, or the Sesión column is missing) — the caller then leaves the
 * file as-is and falls back to append-only. HISTORY.md is the workspace's
 * durable git-tracked record: never rewrite what we cannot parse.
 *
 * `lossy` is the second half of that promise: the dropped columns are reported
 * when they carried content, so the caller can preserve the previous bytes
 * before the rewrite lands.
 */
function migrateLegacyTable(text: string, cells: string[]): MigratedTable | null {
  const columns = legacyColumns(cells);
  if (columns === null) return null; // no row key → unmappable

  const out: string[] = [];
  let headerDone = false;
  let tableClosed = false;
  let lossy = false;
  for (const line of text.split("\n")) {
    const isPipeLine = line.trim().startsWith("|");
    if (headerDone && !tableClosed && !isPipeLine) {
      tableClosed = true; // the history table ended — everything below is verbatim
    }
    if (tableClosed || !isPipeLine) {
      out.push(line);
      continue;
    }
    if (!headerDone) {
      // Header + separator collapse into the slim template's pair.
      if (isSeparator(line)) {
        headerDone = true;
        out.push("| Sesión | Fecha | Estado | Refs |");
        out.push("|--------|-------|--------|------|");
      }
      continue;
    }
    const mapped = migrateLegacyRow(line, columns);
    if (mapped.lossy) lossy = true;
    out.push(mapped.row);
  }
  if (!headerDone) return null; // separator never matched → do not touch the file
  return { text: out.join("\n"), lossy };
}

interface LegacyColumns {
  code: number;
  sesion: number;
  fecha: number;
  estado: number;
  refs: number;
  flujo: number;
  resumen: number;
}

/** Where each legacy column sits, or `null` when the table carries no row key. */
function legacyColumns(cells: string[]): LegacyColumns | null {
  const idx = (name: string) => cells.indexOf(name);
  const code = idx("#");
  const sesion = idx("sesión") !== -1 ? idx("sesión") : idx("sesion");
  if (sesion === -1 && code === -1) return null;
  return {
    code,
    sesion,
    fecha: idx("fecha"),
    estado: idx("estado"),
    refs: idx("refs"),
    flujo: idx("flujo"),
    resumen: idx("resumen"),
  };
}

function isSeparator(line: string): boolean {
  return /^\|[\s|:-]+\|?$/.test(line.trim());
}

/** One legacy row in the current shape, and whether mapping it dropped content. */
function migrateLegacyRow(line: string, columns: LegacyColumns): { row: string; lossy: boolean } {
  const parts = line.split("|").map((c) => c.trim());
  // `| a | b |` splits into ["", "a", "b", ""] — data cells start at 1.
  const cell = (i: number) => (i >= 0 ? (parts[i + 1] ?? "") : "");
  const code = cell(columns.code);
  const sesion = cell(columns.sesion);
  return {
    row: buildRow({
      code: code || sesion,
      sesionName: sesion || code,
      date: cell(columns.fecha),
      state: cell(columns.estado),
      refs: cell(columns.refs) || "—",
    }),
    lossy: !isEmptyCell(cell(columns.flujo)) || !isEmptyCell(cell(columns.resumen)),
  };
}

/**
 * Highest session number the table has ever mentioned, or 0 when it mentions
 * none.
 *
 * The live sessions folder cannot answer this on its own any more: a retired
 * session's folder is GONE, and a counter that only reads folders would hand its
 * number to the next session created. Two different runs would then share an
 * identity — the same row key, the same unit branch, the same `--code` — and the
 * second one would inherit the first one's history. `HISTORY.md` is append-only,
 * so it remembers what the filesystem no longer does.
 *
 * A file that cannot be read yields 0 rather than throwing: numbering must still
 * work in a workspace whose history was never created, and the folder scan is
 * the other half of the maximum.
 */
export async function maxHistoryNumber(fs: FileSystemPort, historyFile: string): Promise<number> {
  let text: string;
  try {
    if (!(await fs.exists(historyFile))) return 0;
    text = await fs.readText(historyFile);
  } catch {
    return 0;
  }
  let max = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const first = trimmed.split("|")[1]?.trim() ?? "";
    const m = first.match(/^(?:session)?(\d{3,})(?:-|$)/);
    if (m?.[1]) max = Math.max(max, Number.parseInt(m[1], 10));
  }
  return max;
}

/** One row of the durable record, as the table holds it. */
export interface HistoryRow {
  /** The row key: `047-algo-quick`, `session047-algo`, or a bare `047`. */
  key: string;
  date: string;
  state: string;
  refs: string;
}

/**
 * Every session the record remembers, whichever table shape holds it.
 *
 * Reading all the rows is not the same question as finding ONE of them, so it
 * is not `findRow` — but it is the same table, so it goes through the same
 * header mapping the migration uses: a legacy 7-column table answers here
 * exactly as the slim one does, and no caller has to know which shape it got.
 *
 * Scoped to the FIRST table in the file, and for the same reason the rewrite is:
 * a second markdown table further down is not the history.
 */
export function readHistoryRows(text: string): HistoryRow[] {
  const columns = legacyColumns(headerCells(text));
  if (columns === null) return [];
  const rows: HistoryRow[] = [];
  let headerSeen = false;
  for (const line of text.split("\n")) {
    if (!line.trim().startsWith("|")) {
      if (headerSeen) break;
      continue;
    }
    if (isSeparator(line)) continue;
    if (!headerSeen) {
      headerSeen = true; // the header row itself carries no session
      continue;
    }
    rows.push(rowFrom(line, columns));
  }
  return rows;
}

function rowFrom(line: string, columns: LegacyColumns): HistoryRow {
  const parts = line.split("|").map((c) => c.trim());
  // `| a | b |` splits into ["", "a", "b", ""] — data cells start at 1.
  const cell = (i: number) => (i >= 0 ? (parts[i + 1] ?? "") : "");
  const code = cell(columns.code);
  const sesion = cell(columns.sesion);
  return {
    key: rowKey(code || sesion, sesion || code),
    date: cell(columns.fecha),
    state: cell(columns.estado),
    refs: cell(columns.refs),
  };
}

/** The numeric identity a row key or a `--code` carries; `null` when it has none. */
function identityNumber(value: string): number | null {
  const m = value.match(/^(?:session)?(\d+)(?:-|$)/);
  return m?.[1] === undefined ? null : Number.parseInt(m[1], 10);
}

/**
 * Whether a row belongs to the session a caller named.
 *
 * Numeric identity first, and that is the whole point: one number is one
 * session, so `047` names the same row as `047-algo-quick` AND as the legacy
 * `session047-algo` — which is how closing a legacy folder used to APPEND a
 * second row keyed differently instead of updating the one already there.
 * Comparing as numbers rather than as strings keeps `100` off `1000-…`.
 */
function rowMatches(firstCell: string, code: string): boolean {
  if (firstCell === code) return true;
  const wanted = identityNumber(code);
  if (wanted !== null) {
    const found = identityNumber(firstCell);
    return found !== null && found === wanted;
  }
  return firstCell.startsWith(`${code}-`);
}

interface ExistingRow {
  index: number;
  line: string;
  cells: string[];
}

function findRow(lines: readonly string[], code: string): ExistingRow | null {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.trim().startsWith("|")) continue;
    const cells = dataCells(line);
    if (!rowMatches(cells[0] ?? "", code)) continue;
    return { index, line, cells };
  }
  return null;
}

/**
 * The row to write: what the caller named, over what the table already says.
 *
 * The merge is the point. `session-close` without `--refs` names no references,
 * and a row rebuilt from the caller alone wrote "—" over the ones a human had
 * put there — an update of the state silently deleting a cell nobody mentioned.
 * A cell is only ever rewritten by somebody who named it.
 *
 * Defaults apply to a row being BORN, never to one being updated: a session with
 * no declared date gets today (the day its record was written) once, and every
 * later upsert preserves it instead of re-dating it.
 */
function mergeRow(row: HistoryRowInput, existing: ExistingRow | null): string {
  const previous =
    existing !== null && existing.cells.length === SLIM_COLUMNS ? existing.cells : [];
  const key =
    row.sesionName !== undefined
      ? rowKey(row.code, row.sesionName)
      : (previous[0] ?? rowKey(row.code, undefined));
  return `| ${key} | ${row.date ?? previous[1] ?? localDateIso(new Date())} | ${row.state} | ${row.refs ?? previous[3] ?? "—"} |`;
}

/**
 * Put a new row INSIDE the table, right after its last row.
 *
 * Appending at the end of the FILE looked equivalent while HISTORY.md held
 * nothing but its table; with any prose under it, every new session landed
 * below that prose — orphan rows that still matched the row lookup, so the
 * table stayed split in two forever. Falls back to the end of the file only
 * when there is no table to insert into.
 */
function insertIntoTable(lines: readonly string[], newRow: string): string {
  const out = [...lines];
  const separator = out.findIndex((line) => /^\|[\s|:-]+\|?$/.test(line.trim()));
  if (separator === -1) {
    const tail = out[out.length - 1] === "" ? out.length - 1 : out.length;
    out.splice(tail, 0, newRow);
    if (out[out.length - 1] !== "") out.push("");
    return out.join("\n");
  }
  let end = separator;
  while (end + 1 < out.length && (out[end + 1] ?? "").trim().startsWith("|")) end += 1;
  out.splice(end + 1, 0, newRow);
  return out.join("\n");
}

/**
 * Copy the record's previous bytes beside it, once.
 *
 * Only the FIRST snapshot holds the shape the current one no longer has room
 * for, so an existing one is never overwritten — a second lossy rewrite would
 * otherwise replace the original columns with an already-slimmed copy.
 */
async function snapshotLegacy(
  fs: FileSystemPort,
  historyFile: string,
  previous: string,
): Promise<void> {
  await fs.writeTextExclusive(join(historyFile, "..", LEGACY_SNAPSHOT), previous);
}

export async function upsertRow(
  fs: FileSystemPort,
  historyFile: string,
  row: HistoryRowInput,
): Promise<UpsertAction> {
  // An empty code would make the identity match the separator row and rewrite
  // the table's own header. Callers validate it upstream; this is the guard that
  // says so instead of producing a corrupt file.
  if (row.code.trim() === "") throw new Error("upsertRow: code must not be empty");

  await ensureHistoryFile(fs, historyFile);
  const previous = await fs.readText(historyFile);

  let text = previous;
  let migrated = false;
  let lossy = false;
  const cells = headerCells(previous);
  if (isLegacyHeader(cells)) {
    const rewritten = migrateLegacyTable(previous, cells);
    // Unmappable legacy table (hand-edited, no separator): leave it verbatim and
    // append below it — losing rows would be worse than a mixed-shape table.
    if (rewritten !== null) {
      text = rewritten.text;
      migrated = true;
      lossy = rewritten.lossy;
    }
  }

  const lines = text.split("\n");
  const existing = findRow(lines, row.code);
  const merged = mergeRow(row, existing);

  if (existing === null) {
    if (lossy) await snapshotLegacy(fs, historyFile, previous);
    await fs.writeText(historyFile, insertIntoTable(lines, merged));
    return "added";
  }
  if (existing.line === merged) {
    if (migrated) await persistMigration(fs, historyFile, previous, text, lossy);
    return "unchanged";
  }
  // A matched row of a foreign shape (a legacy table nobody could migrate) is
  // about to be replaced by a slim one: whatever its extra columns held is not
  // representable here either.
  if (lossy || existing.cells.length !== SLIM_COLUMNS) {
    await snapshotLegacy(fs, historyFile, previous);
  }
  lines[existing.index] = merged;
  await fs.writeText(historyFile, lines.join("\n"));
  return "updated";
}

/** The migration still has to hit disk when the upserted row itself did not change. */
async function persistMigration(
  fs: FileSystemPort,
  historyFile: string,
  previous: string,
  migrated: string,
  lossy: boolean,
): Promise<void> {
  if (lossy) await snapshotLegacy(fs, historyFile, previous);
  await fs.writeText(historyFile, migrated);
}
