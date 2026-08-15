import { join } from "node:path";
import type { DesignRouteMode } from "../../domain/design/expansion.js";
import {
  type CurrentBaseline,
  DESIGNS_DIR,
  DESIGN_MANIFEST_FILE,
  type DesignFailure,
  type DesignManifest,
  validateDesignManifest,
} from "../../domain/design/manifest.js";
import { isRecord } from "../../domain/design/validation.js";
import type { ProposalBase } from "../../domain/proposal.js";
import { baseDigest } from "../../domain/proposal.js";
import type { FileSystemPort } from "../../ports/file-system.js";

/**
 * Discovery of the UI Design Packages in a workspace.
 *
 * Resolution goes through the manifest's `id`, never through the folder: a
 * package renamed from `001-design-alta` to `007-design-altas-y-bajas`, or moved
 * anywhere under `docs/designs/`, keeps resolving. The path this service reports
 * is the CURRENT location — a hint for humans and for repairing stale
 * references, never the identity.
 */

export interface DesignPackageEntry {
  /** Null when the manifest could not be read or failed validation. */
  id: string | null;
  /**
   * Which shape this package is, so every consumer discriminates on ONE field
   * instead of inferring it from an empty catalog. Null while the manifest does
   * not validate: an unreadable package has no mode to report, and answering
   * `package` there would be a guess wearing a default.
   */
  mode: DesignRouteMode | null;
  /**
   * The `id` the manifest CLAIMS, even when it did not validate. Lets a broken
   * package be named in a diagnostic instead of reading as "no existe": those
   * are very different problems for whoever has to fix one.
   */
  declared_id: string | null;
  title: string | null;
  /** Workspace-relative directory the package lives in RIGHT NOW. */
  path: string;
  manifest_path: string;
  /**
   * The compare-and-swap base of the exact manifest bytes parsed into
   * {@link manifest}.  A publication must carry this snapshot forward instead
   * of re-reading the manifest after it has derived candidate bytes from it.
   */
  manifest_base: ProposalBase | null;
  current_baseline: CurrentBaseline | null;
  /**
   * The validated manifest, for whoever needs to resolve inside the package
   * (the reference resolver). Null when the manifest did not validate. The
   * listing surface projects it away — a catalog is not a listing.
   */
  manifest: DesignManifest | null;
  ok: boolean;
  failures: DesignFailure[];
}

export interface DesignIndex {
  root: string;
  packages: DesignPackageEntry[];
  /** Index-level problems (a duplicated identity spans two packages). */
  failures: DesignFailure[];
}

export async function readDesignIndex(fs: FileSystemPort, workspace: string): Promise<DesignIndex> {
  const rootAbs = join(workspace, DESIGNS_DIR);
  const index: DesignIndex = { root: DESIGNS_DIR, packages: [], failures: [] };
  if (!(await fs.exists(rootAbs))) return index;

  // "Moving the dossier WITHIN docs/designs/" includes moving it into a
  // subfolder, so discovery descends. A directory that is itself a package
  // stops the descent: a package never contains another one.
  await collect(fs, rootAbs, "", index.packages);

  index.packages.sort((a, b) => (a.id ?? a.path).localeCompare(b.id ?? b.path));
  index.failures = findDuplicateIds(index.packages);
  return index;
}

/** Resolve by identity. The caller never passes a path — that is the point. */
export function resolveDesignPackage(index: DesignIndex, id: string): DesignPackageEntry | null {
  return index.packages.find((p) => p.id === id) ?? null;
}

/** Depth-first walk under `docs/designs/`, stopping at each package. */
async function collect(
  fs: FileSystemPort,
  rootAbs: string,
  relative: string,
  out: DesignPackageEntry[],
): Promise<void> {
  const here = relative.length === 0 ? rootAbs : join(rootAbs, relative);
  for (const entry of await fs.list(here)) {
    // `dir` only, and `list` does not follow links: a symlink under
    // `docs/designs/` reads as `other`, so it can never pull a manifest — and an
    // identity — in from outside the workspace.
    if (entry.type !== "dir") continue;
    const folder = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
    if (await fs.exists(join(rootAbs, folder, DESIGN_MANIFEST_FILE))) {
      out.push(await readPackage(fs, rootAbs, folder));
      continue;
    }
    // A folder that holds packages is a legitimate grouping. A LEAF with no
    // manifest is not: it sits in the design taxonomy and is nothing.
    const before = out.length;
    await collect(fs, rootAbs, folder, out);
    if (out.length === before && !(await hasSubdirectory(fs, join(rootAbs, folder)))) {
      out.push(await readPackage(fs, rootAbs, folder));
    }
  }
}

async function hasSubdirectory(fs: FileSystemPort, dir: string): Promise<boolean> {
  return (await fs.list(dir)).some((e) => e.type === "dir");
}

async function readPackage(
  fs: FileSystemPort,
  rootAbs: string,
  folder: string,
): Promise<DesignPackageEntry> {
  const path = `${DESIGNS_DIR}/${folder}`;
  const manifestPath = `${path}/${DESIGN_MANIFEST_FILE}`;
  const base: DesignPackageEntry = {
    id: null,
    mode: null,
    title: null,
    path,
    manifest_path: manifestPath,
    manifest_base: null,
    declared_id: null,
    current_baseline: null,
    manifest: null,
    ok: false,
    failures: [],
  };

  const manifestAbs = join(rootAbs, folder, DESIGN_MANIFEST_FILE);
  if (!(await fs.exists(manifestAbs))) {
    return {
      ...base,
      failures: [
        {
          code: "DESIGN_MANIFEST_MISSING",
          artifact: manifestPath,
          message: `'${path}' está bajo ${DESIGNS_DIR}/ y no tiene ${DESIGN_MANIFEST_FILE}`,
          action: `creá su manifest, o movéla fuera de ${DESIGNS_DIR}/ si no es un package`,
        },
      ],
    };
  }

  let content: string;
  let parsed: unknown;
  try {
    content = await fs.readText(manifestAbs);
    parsed = JSON.parse(content);
  } catch (err) {
    return {
      ...base,
      failures: [
        {
          code: "DESIGN_MANIFEST_UNREADABLE",
          artifact: manifestPath,
          message: `no se pudo leer el manifest: ${err instanceof Error ? err.message : String(err)}`,
          action: "reparalo como un único objeto JSON válido",
        },
      ],
    };
  }

  // This is deliberately derived from the SAME read whose bytes are parsed
  // below.  Re-reading here would turn a concurrent M1 -> M2 update into a
  // proposal calculated from M1 but protected by M2, which is no CAS at all.
  const manifestBase: ProposalBase = { path: manifestPath, digest: baseDigest(content) };

  const declared = isRecord(parsed) && typeof parsed.id === "string" ? parsed.id : null;
  const validation = validateDesignManifest(parsed, manifestPath);
  if (!validation.ok || validation.value === null) {
    return {
      ...base,
      manifest_base: manifestBase,
      declared_id: declared,
      failures: validation.failures,
    };
  }
  return {
    ...base,
    manifest_base: manifestBase,
    declared_id: declared,
    ...project(validation.value),
    ok: true,
  };
}

function project(
  manifest: DesignManifest,
): Pick<DesignPackageEntry, "id" | "mode" | "title" | "current_baseline" | "manifest"> {
  return {
    id: manifest.id,
    mode: manifest.mode,
    title: manifest.title,
    current_baseline: manifest.current_baseline,
    manifest,
  };
}

/**
 * Two packages claiming one identity break every reference to it, so the index
 * reports it once per identity naming both locations — not once per package,
 * which would read as two unrelated problems.
 */
function findDuplicateIds(packages: DesignPackageEntry[]): DesignFailure[] {
  const byId = new Map<string, string[]>();
  for (const pkg of packages) {
    if (pkg.id === null) continue;
    byId.set(pkg.id, [...(byId.get(pkg.id) ?? []), pkg.path]);
  }
  const failures: DesignFailure[] = [];
  for (const [id, paths] of byId) {
    if (paths.length < 2) continue;
    failures.push({
      code: "DESIGN_ID_DUPLICATE",
      artifact: paths.join(", "),
      message: `${id} está declarado por ${paths.length} packages`,
      action: "una identidad pertenece a un solo package: cambiá el id de los demás",
    });
  }
  return failures;
}
