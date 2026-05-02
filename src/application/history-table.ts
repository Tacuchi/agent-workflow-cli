// Mirror de qtc_core/history.py:history_path, history_ensure, history_has_flow_column,
// _history_row_regex, history_upsert.
import { join } from "node:path";
import type { FileSystemPort } from "../ports/file-system.js";

const HISTORY_TEMPLATE =
  "# QTC Session History\n\n" +
  "| # | Flujo | Sesión | Fecha | Estado | Resumen | Refs |\n" +
  "|---|-------|--------|-------|--------|---------|------|\n";

export type UpsertAction = "added" | "updated" | "unchanged";

export function historyPath(cwd: string): string {
  return join(cwd, ".qtc", "HISTORY.md");
}

export async function ensureHistoryFile(fs: FileSystemPort, path: string): Promise<void> {
  if (await fs.exists(path)) return;
  await fs.mkdirp(join(path, ".."));
  await fs.writeText(path, HISTORY_TEMPLATE);
}

export function hasFlowColumn(text: string): boolean {
  const m = text.match(/^\|\s*#\s*\|([^\n]+)/m);
  return !!m && m[1] !== undefined && m[1].toLowerCase().includes("flujo");
}

export function buildRow(params: {
  code: string;
  flow?: string | null;
  sesionName: string;
  date: string;
  state: string;
  summary: string;
  refs: string;
  hasFlow: boolean;
}): string {
  const flowCell = params.hasFlow ? params.flow || "—" : null;
  if (flowCell !== null) {
    return `| ${params.code} | ${flowCell} | ${params.sesionName} | ${params.date} | ${params.state} | ${params.summary} | ${params.refs} |`;
  }
  return `| ${params.code} | ${params.sesionName} | ${params.date} | ${params.state} | ${params.summary} | ${params.refs} |`;
}

export async function upsertRow(
  fs: FileSystemPort,
  cwd: string,
  code: string,
  buildNewRow: (hasFlow: boolean) => string,
): Promise<UpsertAction> {
  const path = historyPath(cwd);
  await ensureHistoryFile(fs, path);
  const text = await fs.readText(path);
  const hasFlow = hasFlowColumn(text);
  const newRow = buildNewRow(hasFlow);

  const rowRegex = new RegExp(`^\\|\\s*${escapeRegex(code)}\\s*\\|.*$`, "m");
  const existing = text.match(rowRegex);
  if (existing) {
    if (existing[0] === newRow) {
      return "unchanged";
    }
    const updated = text.replace(rowRegex, newRow);
    await fs.writeText(path, updated);
    return "updated";
  }

  let appended = text;
  if (!appended.endsWith("\n")) appended += "\n";
  appended += `${newRow}\n`;
  await fs.writeText(path, appended);
  return "added";
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
