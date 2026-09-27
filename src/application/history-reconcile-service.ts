import type { FileSystemPort } from "../ports/file-system.js";
import { readHistoryRows } from "./history-table.js";
import type { PathsService } from "./paths-service.js";
import { listSessionFolders, readSessionState } from "./session-resolver.js";

/** A read-only comparison of the travelling register and this machine's folders. */
export async function reconcileHistory(
  fs: FileSystemPort,
  paths: PathsService,
): Promise<{
  missing_rows: string[];
  contradictory_rows: Array<{ session: string; state: string; reason: string }>;
}> {
  const file = paths.cwdHistoryFile();
  const rows = (await fs.exists(file)) ? readHistoryRows(await fs.readText(file)) : [];
  const folders = await listSessionFolders(fs, paths.cwdSessionsDir());
  const keyOf = (name: string) => name.replace(/^session(?=\d)/, "");
  const byFolder = new Map(folders.map((folder) => [keyOf(folder.name), folder.path]));
  const byRow = new Map(rows.map((row) => [keyOf(row.key), row]));
  const missingRows = folders
    .filter((folder) => !byRow.has(keyOf(folder.name)))
    .map((folder) => folder.name);
  const contradictory: Array<{ session: string; state: string; reason: string }> = [];
  for (const row of rows) {
    const path = byFolder.get(keyOf(row.key));
    if (path === undefined) {
      if (row.state === "closed" || row.state === "abandoned")
        contradictory.push({ session: row.key, state: row.state, reason: "sin carpeta local" });
      continue;
    }
    const state = await readSessionState(fs, path);
    if (row.state === "active" && state !== "active")
      contradictory.push({
        session: row.key,
        state: row.state,
        reason: "activa con marcador de cierre",
      });
    if (row.state === "closed" && state !== "closed")
      contradictory.push({
        session: row.key,
        state: row.state,
        reason: "cerrada sin marcador de cierre",
      });
    if ((row.state === "paused" || row.state === "abandoned") && row.state !== state) {
      contradictory.push({
        session: row.key,
        state: row.state,
        reason: `registro ${row.state}, carpeta ${state}`,
      });
    }
  }
  return { missing_rows: missingRows, contradictory_rows: contradictory };
}
