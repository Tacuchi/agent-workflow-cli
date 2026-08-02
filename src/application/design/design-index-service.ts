import { join } from "node:path";
import {
  type CurrentBaseline,
  DESIGNS_DIR,
  DESIGN_MANIFEST_FILE,
  type DesignFailure,
  type DesignManifest,
  validateDesignManifest,
} from "../../domain/design/manifest.js";
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
  title: string | null;
  /** Workspace-relative directory the package lives in RIGHT NOW. */
  path: string;
  manifest_path: string;
  current_baseline: CurrentBaseline | null;
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

  for (const entry of await fs.list(rootAbs)) {
    // `dir` only, and `list` does not follow links: a symlink under
    // `docs/designs/` reads as `other`, so it can never pull a manifest — and an
    // identity — in from outside the workspace.
    if (entry.type !== "dir") continue;
    index.packages.push(await readPackage(fs, rootAbs, entry.name));
  }

  index.packages.sort((a, b) => (a.id ?? a.path).localeCompare(b.id ?? b.path));
  index.failures = findDuplicateIds(index.packages);
  return index;
}

/** Resolve by identity. The caller never passes a path — that is the point. */
export function resolveDesignPackage(index: DesignIndex, id: string): DesignPackageEntry | null {
  return index.packages.find((p) => p.id === id) ?? null;
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
    title: null,
    path,
    manifest_path: manifestPath,
    current_baseline: null,
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readText(manifestAbs));
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

  const validation = validateDesignManifest(parsed, manifestPath);
  if (!validation.ok || validation.value === null) {
    return { ...base, failures: validation.failures };
  }
  return { ...base, ...project(validation.value), ok: true };
}

function project(
  manifest: DesignManifest,
): Pick<DesignPackageEntry, "id" | "title" | "current_baseline"> {
  return {
    id: manifest.id,
    title: manifest.title,
    current_baseline: manifest.current_baseline,
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
