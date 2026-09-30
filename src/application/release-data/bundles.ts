import { basename, join } from "node:path";
import {
  CORRELATIVE_SOURCE,
  compareCorrelatives,
  sameCorrelative,
} from "../../domain/correlative.js";
import { FOLDER_RESERVATION_MARKER } from "../../domain/reservation.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import type { PathsService } from "../paths-service.js";
import { collectFilesByExt, getDocsDir, sessionCorrelative } from "./common.js";
import { isRollbackSql } from "./rollback.js";

export interface GraduatedBundle {
  nnn: string;
  /** Legacy per-session bundles carry the origin session; export-scripts bundles don't. */
  session_code: string | null;
  slug: string;
  /** `export` = modern NNN-export-scripts-YYYY-MM-DD · `legacy` = old NNN-sessionNNN-slug. */
  kind: "export" | "legacy" | "named";
  path: string;
  forward_count: number;
  rollback_count: number;
  metadata?: "present" | "absent";
  supersedes?: string[];
  requires?: string[];
  superseded_by?: string[];
  origin_standalone_sql?: string[];
}

/** Modern export-scripts bundle naming (see exports/export-scripts SKILL). */
const MODERN_BUNDLE_RE = new RegExp(
  `^(${CORRELATIVE_SOURCE})-(export-scripts-\\d{4}-\\d{2}-\\d{2})$`,
);
/** Pre-redesign per-session graduation naming. */
const LEGACY_BUNDLE_RE = new RegExp(
  `^(${CORRELATIVE_SOURCE})-session(${CORRELATIVE_SOURCE})-(.+)$`,
);

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

  const targetCode = sessionCorrelative(options.sessionCode);
  const dirEntries = (await fs.list(scriptsDir))
    .filter((e) => e.type === "dir")
    .sort(compareBundleEntries);

  const bundles: GraduatedBundle[] = [];
  for (const entry of dirEntries) {
    const bundle = await readGraduatedBundle(fs, entry, targetCode);
    if (bundle !== null) bundles.push(bundle);
  }
  linkSupersededBundles(bundles);
  return bundles;
}

async function readBundleManifest(
  fs: FileSystemPort,
  path: string,
): Promise<{ supersedes: string[]; requires: string[]; standalone: string[] } | null> {
  if (!(await fs.exists(path))) return null;
  try {
    const value: unknown = JSON.parse(await fs.readText(path));
    if (typeof value !== "object" || value === null) return null;
    const candidate = value as Record<string, unknown>;
    if (
      ![candidate.supersedes, candidate.requires].every(
        (items) => Array.isArray(items) && items.every((item) => typeof item === "string"),
      )
    )
      return null;
    const origin = candidate.origin as { standalone_sql?: Array<{ path?: string }> } | undefined;
    return {
      supersedes: candidate.supersedes as string[],
      requires: candidate.requires as string[],
      standalone: Array.isArray(origin?.standalone_sql)
        ? origin.standalone_sql.flatMap((file) =>
            typeof file.path === "string" ? [file.path] : [],
          )
        : [],
    };
  } catch {
    return null;
  }
}

function compareBundleEntries(
  left: { name: string; path: string },
  right: { name: string; path: string },
): number {
  const leftNumber = parseBundleName(left.name)?.nnn;
  const rightNumber = parseBundleName(right.name)?.nnn;
  if (leftNumber !== undefined && rightNumber !== undefined) {
    return compareCorrelatives(leftNumber, rightNumber) || left.name.localeCompare(right.name);
  }
  return left.name.localeCompare(right.name);
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
  const named = name.match(new RegExp(`^(${CORRELATIVE_SOURCE})-(.+)$`));
  if (named?.[1] && named[2])
    return { nnn: named[1], session_code: null, slug: named[2], kind: "named" };
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
      is_rollback: isRollbackSql(f.path),
    });
  }
  return items;
}

function linkSupersededBundles(bundles: GraduatedBundle[]): void {
  for (const bundle of bundles) {
    for (const name of bundle.supersedes ?? []) {
      const older = bundles.find((other) => other !== bundle && basename(other.path) === name);
      older?.superseded_by?.push(basename(bundle.path));
    }
  }
}

async function readGraduatedBundle(
  fs: FileSystemPort,
  entry: { path: string; name: string },
  targetCode: string | null,
): Promise<GraduatedBundle | null> {
  if (await fs.exists(join(entry.path, FOLDER_RESERVATION_MARKER))) return null;
  const parsed = parseBundleName(entry.name);
  if (!parsed) return null;
  // The session filter only applies to legacy bundles (modern ones are cross-session).
  if (
    targetCode !== null &&
    (parsed.session_code === null || !sameCorrelative(parsed.session_code, targetCode))
  ) {
    return null;
  }
  const sqlFiles = await collectFilesByExt(fs, entry.path, ".sql");
  if (sqlFiles.length === 0) return null; // a reserved folder with just a marker is not a bundle
  const rollback = sqlFiles.filter(isRollbackSql);
  const forward = sqlFiles.filter((f) => !isRollbackSql(f));
  const manifest = await readBundleManifest(fs, join(entry.path, "bundle.json"));
  return {
    ...parsed,
    path: entry.path,
    forward_count: forward.length,
    rollback_count: rollback.length,
    metadata: manifest === null ? "absent" : "present",
    ...(manifest === null
      ? {}
      : {
          supersedes: manifest.supersedes,
          requires: manifest.requires,
          origin_standalone_sql: manifest.standalone,
        }),
    superseded_by: [],
  };
}
