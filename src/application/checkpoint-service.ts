import type { FileSystemPort } from "../ports/file-system.js";
import type { PathsService } from "./paths-service.js";
import { listSessionFolders, readSessionState } from "./session-resolver.js";

export interface ActiveSession {
  folder: string;
}

/**
 * Active sessions are non-`.closed` folders under `.workflow/sessions/`.
 * Sessions are no longer registered in the hub block; state derives solely
 * from the folder-local `.closed` sentinel (type-agnostic).
 */
export async function findActiveSessions(
  fs: FileSystemPort,
  paths: PathsService,
): Promise<ActiveSession[]> {
  const folders = await listSessionFolders(fs, paths.cwdSessionsDir());
  const active: ActiveSession[] = [];
  for (const folder of folders) {
    if ((await readSessionState(fs, folder.path)) !== "active") continue;
    active.push({ folder: folder.name });
  }
  return active;
}
