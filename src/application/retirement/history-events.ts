/**
 * The one durable agent-workflow trace a retirement leaves: an append-only row.
 *
 * It is a SECOND table in `HISTORY.md`, under its own heading, and never the
 * session table. The session table is an upsert keyed by session — exactly the
 * wrong shape here, because the session it would key on no longer exists and
 * because a terminal event must never be rewritten. So this ledger only ever
 * grows, and its key is the operation's own digest.
 *
 * That key is what makes the same approval, retried, recognize itself instead of
 * appending a second row for one operation. It is also the re-entry signal for a
 * retirement with no git side at all: with no ref to compare, the presence of this
 * row IS the answer to "did the commit point pass".
 */

import type { FileSystemPort } from "../../ports/file-system.js";
import { ensureHistoryFile } from "../history-table.js";
import type { PathsService } from "../paths-service.js";

const HEADING = "## Retiros";

const TABLE_HEADER =
  "| Operación | Fecha | Comando | Objetivo | Resultado |\n" +
  "|-----------|-------|---------|----------|-----------|";

/** Short enough to read, long enough to identify: the digest's first 12 chars. */
function key(digest: string): string {
  return digest.slice(0, 12);
}

export interface TerminalEvent {
  operation: string;
  date: string;
  command: string;
  target: string;
  result: string;
}

/**
 * Every terminal event the ledger holds, oldest first.
 *
 * Read for the projections, and kept strictly apart from `status.discarded`, which
 * means something else entirely: items a session DEFERRED or EXCLUDED from its
 * scope. Folding a retirement into that list would make "discarded" mean two
 * different things on the same board — one of them recoverable and one of them not.
 */
export async function readEvents(
  fs: FileSystemPort,
  paths: PathsService,
): Promise<TerminalEvent[]> {
  const path = paths.cwdHistoryFile();
  if (!(await fs.exists(path))) return [];
  let text: string;
  try {
    text = await fs.readText(path);
  } catch {
    return [];
  }
  const out: TerminalEvent[] = [];
  let inTable = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === HEADING) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (trimmed.startsWith("#")) break;
    const event = rowOf(trimmed);
    if (event !== null) out.push(event);
  }
  return out;
}

/** One data row of the ledger; `null` for the header, the separator or a non-row. */
function rowOf(line: string): TerminalEvent | null {
  if (!line.startsWith("|")) return null;
  // `| a | b | c | d | e |` splits into ["", a, b, c, d, e, ""].
  const cells = line.split("|").map((c) => c.trim());
  if (cells.length < 7) return null;
  const [, operation, date, command, target, result] = cells as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (operation === "Operación" || /^[-:]+$/.test(operation)) return null;
  return { operation, date, command, target, result };
}

/** Whether this operation's row is already there — the idempotence check. */
export async function hasEvent(
  fs: FileSystemPort,
  paths: PathsService,
  digest: string,
): Promise<boolean> {
  const path = paths.cwdHistoryFile();
  if (!(await fs.exists(path))) return false;
  try {
    return (await fs.readText(path)).includes(`| ${key(digest)} |`);
  } catch {
    return false;
  }
}

/**
 * Append the row, once.
 *
 * Idempotent by the digest, and append-only by construction: it inserts at the end
 * of its own table and rewrites nothing above it, so no previous row — of either
 * table — can be lost by a retirement.
 */
export async function appendEvent(
  fs: FileSystemPort,
  paths: PathsService,
  event: TerminalEvent,
): Promise<{ appended: boolean }> {
  const path = paths.cwdHistoryFile();
  await ensureHistoryFile(fs, path);
  const text = await fs.readText(path);
  if (text.includes(`| ${event.operation} |`)) return { appended: false };

  const row = `| ${event.operation} | ${event.date} | ${event.command} | ${event.target} | ${event.result} |`;
  if (!text.includes(HEADING)) {
    const base = text.endsWith("\n") ? text : `${text}\n`;
    await fs.writeText(path, `${base}\n${HEADING}\n\n${TABLE_HEADER}\n${row}\n`);
    return { appended: true };
  }

  // The table already exists: the row goes at the END of it, and everything else
  // in the file is copied through untouched.
  const lines = text.split("\n");
  const last = lastRowIndex(lines);
  if (last === -1) {
    const base = text.endsWith("\n") ? text : `${text}\n`;
    await fs.writeText(path, `${base}${TABLE_HEADER}\n${row}\n`);
    return { appended: true };
  }
  lines.splice(last + 1, 0, row);
  await fs.writeText(path, lines.join("\n"));
  return { appended: true };
}

/** Index of the last row of the retirements table; `-1` when it has none yet. */
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
