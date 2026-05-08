import { join } from "node:path";
import type { FileSystemPort } from "../../ports/file-system.js";
import type { PathsService } from "../paths-service.js";
import { collectFilesByExt, getDocsDir, sessionCodeInt } from "./common.js";

export interface GraduatedBundle {
  nnn: string;
  session_code: string;
  slug: string;
  path: string;
  forward_count: number;
  rollback_count: number;
}

export async function listGraduatedBundles(
  fs: FileSystemPort,
  cwd: string,
  paths: PathsService,
  options: { sessionCode?: string; sourceAlias?: string } = {},
): Promise<GraduatedBundle[]> {
  let docsDir: string;
  try {
    docsDir = await getDocsDir(fs, cwd, paths, options.sourceAlias);
  } catch {
    return [];
  }
  const scriptsDir = join(docsDir, "scripts");
  if (!(await fs.exists(scriptsDir))) return [];

  const targetCode = options.sessionCode ? sessionCodeInt(options.sessionCode) : null;
  const dirEntries = (await fs.list(scriptsDir))
    .filter((e) => e.type === "dir")
    .sort((a, b) => a.name.localeCompare(b.name));

  const bundles: GraduatedBundle[] = [];
  for (const entry of dirEntries) {
    const m = entry.name.match(/^(\d{3})-session(\d{3})-(.+)$/);
    if (!m || !m[1] || !m[2] || !m[3]) continue;
    const nnn = m[1];
    const sessionNnn = m[2];
    const slug = m[3];
    if (targetCode !== null && Number.parseInt(sessionNnn, 10) !== targetCode) continue;
    const sqlFiles = await collectFilesByExt(fs, entry.path, ".sql");
    const rollback = sqlFiles.filter((f) => f.endsWith(".rollback.sql"));
    const forward = sqlFiles.filter((f) => !f.endsWith(".rollback.sql"));
    bundles.push({
      nnn,
      session_code: sessionNnn,
      slug,
      path: entry.path,
      forward_count: forward.length,
      rollback_count: rollback.length,
    });
  }
  return bundles;
}
