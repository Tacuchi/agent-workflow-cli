import { join, relative, win32 } from "node:path";
import type { FileSystemPort } from "../../ports/file-system.js";
import { collectFilesByExt } from "./common.js";
import { isRollbackSql } from "./rollback.js";

const SCRIPTS_SUBDIR = "scripts";

export async function readScriptsArtifacts(
  fs: FileSystemPort,
  sessionPath: string,
): Promise<{ name: string; path: string; size: number | null; is_rollback: boolean }[]> {
  const scriptsDir = join(sessionPath, SCRIPTS_SUBDIR);
  const files = (await fs.exists(scriptsDir))
    ? await collectFilesByExt(fs, scriptsDir, ".sql")
    : [];
  for (const name of ["SCRIPTS.sql", "SCRIPTS.rollback.sql"]) {
    const path = join(sessionPath, name);
    if (await fs.exists(path)) files.push(path);
  }
  files.sort((a, b) => a.localeCompare(b));
  const items: { name: string; path: string; size: number | null; is_rollback: boolean }[] = [];
  for (const f of files) {
    let size: number | null = null;
    try {
      size = (await fs.stat(f)).size;
    } catch {
      // ignore
    }
    items.push({
      name: (f.includes("\\")
        ? win32.relative(sessionPath, f)
        : relative(sessionPath, f)
      ).replaceAll("\\", "/"),
      path: f,
      size,
      is_rollback: isRollbackSql(f),
    });
  }
  return items;
}
