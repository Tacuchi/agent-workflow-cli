import { join } from "node:path";
import type { FileSystemPort } from "../../ports/file-system.js";
import type { PathsService } from "../paths-service.js";
import { collectFilesByExt, getDocsDir, sessionCodeInt } from "./common.js";

export interface GraduatedBundle {
  nnn: string;
  /** Legacy per-session bundles carry the origin session; export-scripts bundles don't. */
  session_code: string | null;
  slug: string;
  /** `export` = modern NNN-export-scripts-YYYY-MM-DD · `legacy` = old NNN-sessionNNN-slug. */
  kind: "export" | "legacy";
  path: string;
  forward_count: number;
  rollback_count: number;
}

/** Modern export-scripts bundle naming (see exports/export-scripts SKILL). */
const MODERN_BUNDLE_RE = /^(\d{3})-(export-scripts-\d{4}-\d{2}-\d{2})$/;
/** Pre-redesign per-session graduation naming. */
const LEGACY_BUNDLE_RE = /^(\d{3})-session(\d{3})-(.+)$/;

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
    const parsed = parseBundleName(entry.name);
    if (!parsed) continue;
    // The session filter only applies to legacy bundles (modern ones are cross-session).
    if (
      targetCode !== null &&
      (parsed.session_code === null || Number.parseInt(parsed.session_code, 10) !== targetCode)
    ) {
      continue;
    }
    const sqlFiles = await collectFilesByExt(fs, entry.path, ".sql");
    // Legacy rollbacks: *.rollback.sql · modern export-scripts bundles: 00-ROLLBACK.sql.
    const isRollback = (f: string) => f.endsWith(".rollback.sql") || f.endsWith("00-ROLLBACK.sql");
    const rollback = sqlFiles.filter(isRollback);
    const forward = sqlFiles.filter((f) => !isRollback(f));
    bundles.push({
      ...parsed,
      path: entry.path,
      forward_count: forward.length,
      rollback_count: rollback.length,
    });
  }
  return bundles;
}

function parseBundleName(
  name: string,
): Pick<GraduatedBundle, "nnn" | "session_code" | "slug" | "kind"> | null {
  const modern = name.match(MODERN_BUNDLE_RE);
  if (modern?.[1] && modern[2]) {
    return { nnn: modern[1], session_code: null, slug: modern[2], kind: "export" };
  }
  const legacy = name.match(LEGACY_BUNDLE_RE);
  if (legacy?.[1] && legacy[2] && legacy[3]) {
    return { nnn: legacy[1], session_code: legacy[2], slug: legacy[3], kind: "legacy" };
  }
  return null;
}

export interface StandaloneSql {
  name: string;
  path: string;
  size: number | null;
  is_rollback: boolean;
}

/**
 * Loose SQL files at the top level of docs/scripts (outside any bundle dir) —
 * the "source B" of export-scripts, listed deterministically so the skill does
 * not have to walk the filesystem itself.
 */
export async function listStandaloneSql(
  fs: FileSystemPort,
  cwd: string,
  paths: PathsService,
  options: { sourceAlias?: string } = {},
): Promise<StandaloneSql[]> {
  let docsDir: string;
  try {
    docsDir = await getDocsDir(fs, cwd, paths, options.sourceAlias);
  } catch {
    return [];
  }
  const scriptsDir = join(docsDir, "scripts");
  if (!(await fs.exists(scriptsDir))) return [];

  const files = (await fs.list(scriptsDir))
    .filter((e) => e.type === "file" && e.name.endsWith(".sql"))
    .sort((a, b) => a.name.localeCompare(b.name));

  const items: StandaloneSql[] = [];
  for (const f of files) {
    let size: number | null = null;
    try {
      size = (await fs.stat(f.path)).size;
    } catch {
      // best-effort: unreadable size never drops the listing
    }
    items.push({
      name: f.name,
      path: f.path,
      size,
      // Case-insensitive: covers both x.rollback.sql and the house 00-ROLLBACK.sql.
      is_rollback: /rollback/i.test(f.name),
    });
  }
  return items;
}
