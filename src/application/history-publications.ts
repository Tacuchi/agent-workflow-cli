/**
 * The row a publication leaves in the workspace index, with no flow to leave it.
 *
 * `export-*` and `persist` write into `docs/` outside any directed run, and
 * until now the workspace's own record — `.<ns>/HISTORY.md` — heard nothing
 * about it: whoever wanted the document listed had to run `aw history-update` by
 * hand afterwards, which is a repair and not an index.
 *
 * It is a THIRD table in that file, under its own heading, for the same reason
 * the retirements ledger is a second one: the session table is an upsert keyed
 * by session, and a publication has no session to key on. Append-only, because
 * what it records is that something was published on a day — a fact a later
 * publication does not undo.
 */

import { basename } from "node:path";
import { leadingCorrelative } from "../domain/correlative.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { localDateIso } from "./dates.js";
import { ensureHistoryFile } from "./history-table.js";

const HEADING = "## Publicaciones";

/** Numbers already published in this destination, including deleted artifacts. */
export async function publishedCorrelatives(
  fs: FileSystemPort,
  historyFile: string,
  directory: string,
): Promise<Set<string>> {
  if (!(await fs.exists(historyFile))) return new Set();
  const text = await fs.readText(historyFile);
  const result = new Set<string>();
  const prefix = `${directory.replace(/\\/g, "/").replace(/\/$/, "")}/`;
  const section = text.split(HEADING)[1]?.split(/\n## /)[0] ?? "";
  for (const line of section.split("\n")) {
    const path = line
      .match(/^\|\s*([^|]+?)\s*\|/)?.[1]
      ?.trim()
      .replace(/\\/g, "/");
    if (!path?.startsWith(prefix)) continue;
    const name = path.slice(prefix.length).split("/")[0];
    const number = leadingCorrelative(basename(name ?? ""));
    if (number !== null) result.add(number);
  }
  return result;
}

const TABLE_HEADER =
  "| Documento | Fecha | Comando |\n" + //
  "|-----------|-------|---------|";

export interface PublicationRow {
  /** Path inside the workspace, as the publication wrote it. */
  document: string;
  date: string;
  /** The command that published it: `persist`, `export-manuals`, … */
  command: string;
}

export function publicationRows(
  written: readonly string[],
  command: string,
  now: Date = new Date(),
): PublicationRow[] {
  const date = localDateIso(now);
  return written.map((document) => ({ document, date, command }));
}

/**
 * Add the rows that are not there yet, in one write.
 *
 * Idempotent on the whole row: re-applying the same publication the same day
 * adds nothing, while publishing the same document again another day is a new
 * fact and gets its own line.
 */
export async function appendPublications(
  fs: FileSystemPort,
  historyFile: string,
  rows: readonly PublicationRow[],
): Promise<{ appended: string[] }> {
  if (rows.length === 0) return { appended: [] };
  await ensureHistoryFile(fs, historyFile);
  const text = await fs.readText(historyFile);
  const missing = rows.map(render).filter((row) => !text.includes(row));
  if (missing.length === 0) return { appended: [] };

  const appended = missing.map((row) => row.trim());
  if (!text.includes(HEADING)) {
    const base = text.endsWith("\n") ? text : `${text}\n`;
    await fs.writeText(
      historyFile,
      `${base}\n${HEADING}\n\n${TABLE_HEADER}\n${missing.join("\n")}\n`,
    );
    return { appended };
  }
  const lines = text.split("\n");
  const last = lastRowIndex(lines);
  if (last === -1) {
    const base = text.endsWith("\n") ? text : `${text}\n`;
    await fs.writeText(historyFile, `${base}${TABLE_HEADER}\n${missing.join("\n")}\n`);
    return { appended };
  }
  lines.splice(last + 1, 0, ...missing);
  await fs.writeText(historyFile, lines.join("\n"));
  return { appended };
}

function render(row: PublicationRow): string {
  return `| ${row.document} | ${row.date} | ${row.command} |`;
}

/** Index of the last row of the publications table; `-1` when it has none yet. */
function lastRowIndex(lines: readonly string[]): number {
  let last = -1;
  let inTable = false;
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (line === HEADING) inTable = true;
    else if (!inTable) continue;
    else if (line.startsWith("|")) last = i;
    else if (line.startsWith("#")) break;
  }
  return last;
}
