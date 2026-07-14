// The history file path itself is resolved by callers via
// `PathsService.cwdHistoryFile()` and passed in.
import { join } from "node:path";
import type { FileSystemPort } from "../ports/file-system.js";

// Slim 4-column table: `Sesión` (row key — the `NNN-<slug>-<flow>` folder
// identity), `Fecha`, `Estado`, `Refs`. The legacy `#`/`Flujo`/`Resumen`
// columns were derivable or dead ("#" = the Sesión prefix, "Flujo" always "—",
// "Resumen" = the slug re-spaced) and are dropped; legacy tables are migrated
// in place on the first upsert.
const HISTORY_TEMPLATE =
  "# Session History\n\n" +
  "| Sesión | Fecha | Estado | Refs |\n" +
  "|--------|-------|--------|------|\n";

export type UpsertAction = "added" | "updated" | "unchanged";

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
 */
function migrateLegacyTable(text: string, cells: string[]): string | null {
  const idx = (name: string) => cells.indexOf(name);
  const iCode = idx("#");
  const iSesion = idx("sesión") !== -1 ? idx("sesión") : idx("sesion");
  const iFecha = idx("fecha");
  const iEstado = idx("estado");
  const iRefs = idx("refs");
  if (iSesion === -1 && iCode === -1) return null; // no row key → unmappable

  const out: string[] = [];
  let headerDone = false;
  let tableClosed = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const isPipeLine = trimmed.startsWith("|");
    if (headerDone && !tableClosed && !isPipeLine) {
      tableClosed = true; // the history table ended — everything below is verbatim
    }
    if (tableClosed || !isPipeLine) {
      out.push(line);
      continue;
    }
    if (!headerDone) {
      // Header + separator collapse into the slim template's pair.
      if (/^\|[\s|:-]+\|?$/.test(trimmed)) {
        headerDone = true;
        out.push("| Sesión | Fecha | Estado | Refs |");
        out.push("|--------|-------|--------|------|");
      }
      continue;
    }
    const parts = line.split("|").map((c) => c.trim());
    // `| a | b |` splits into ["", "a", "b", ""] — data cells start at 1.
    const cell = (i: number) => (i >= 0 ? (parts[i + 1] ?? "") : "");
    const code = cell(iCode);
    const sesion = cell(iSesion);
    out.push(
      buildRow({
        code: code || sesion,
        sesionName: sesion || code,
        date: cell(iFecha),
        state: cell(iEstado),
        refs: cell(iRefs) || "—",
      }),
    );
  }
  if (!headerDone) return null; // separator never matched → do not touch the file
  return out.join("\n");
}

export async function upsertRow(
  fs: FileSystemPort,
  historyFile: string,
  code: string,
  buildNewRow: () => string,
): Promise<UpsertAction> {
  await ensureHistoryFile(fs, historyFile);
  let text = await fs.readText(historyFile);
  const cells = headerCells(text);
  let migrated = false;
  if (isLegacyHeader(cells)) {
    const rewritten = migrateLegacyTable(text, cells);
    if (rewritten !== null) {
      text = rewritten;
      migrated = true;
    }
    // Unmappable legacy table (hand-edited, no separator): leave it verbatim and
    // append below it — losing rows would be worse than a mixed-shape table.
  }
  const newRow = buildNewRow();

  // Match by the first cell: exactly the code, or the `NNN-<slug>-<flow>` key.
  // `code` is never empty (validated upstream); an empty one would let the
  // optional `-…` branch match the separator row.
  if (code.trim() === "") throw new Error("upsertRow: code must not be empty");
  const rowRegex = new RegExp(`^\\|\\s*${escapeRegex(code)}(-[^|]*)?\\s*\\|.*$`, "m");
  const existing = text.match(rowRegex);
  if (existing) {
    if (existing[0] === newRow) {
      if (migrated) await fs.writeText(historyFile, text); // persist the migration even when the row is unchanged
      return "unchanged";
    }
    const updated = text.replace(rowRegex, newRow);
    await fs.writeText(historyFile, updated);
    return "updated";
  }

  let appended = text;
  if (!appended.endsWith("\n")) appended += "\n";
  appended += `${newRow}\n`;
  await fs.writeText(historyFile, appended);
  return "added";
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
