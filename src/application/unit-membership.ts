import { parseUnitPath, workspaceKey } from "../domain/isolation-unit.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { PathsService } from "./paths-service.js";
import { readCustody } from "./session-custody-service.js";
import { listSessionFolders } from "./session-resolver.js";

/** Every known historical key and every sealed unit of this hub. */
export async function hubUnitPaths(
  fs: FileSystemPort,
  paths: PathsService,
  root: string,
): Promise<(path: string) => boolean> {
  const keys = new Set([workspaceKey(paths.workspaceDir())]);
  try {
    const local: unknown = JSON.parse(await fs.readText(paths.cwdLocalConfigFile()));
    if (
      local &&
      typeof local === "object" &&
      "previous_keys" in local &&
      Array.isArray(local.previous_keys)
    ) {
      for (const key of local.previous_keys) if (typeof key === "string") keys.add(key);
    }
  } catch {
    /* legacy hub */
  }
  const owned = new Set<string>();
  for (const session of await listSessionFolders(fs, paths.cwdSessionsDir())) {
    const custody = await readCustody(fs, session.path);
    if (custody.status !== "present") continue;
    for (const source of custody.custody.sources) if (source.unit_path) owned.add(source.unit_path);
  }
  return (path) => {
    const unit = parseUnitPath(root, path);
    if (unit === null) return false;
    return owned.has(path) || keys.has(unit.workspaceKey);
  };
}
