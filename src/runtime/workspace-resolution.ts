import { access, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  declaringHubs,
  gitCommonDirectory,
  legacyDeclaringHubs,
  registerHub,
} from "../application/hub-registry.js";
import { legacyBlockFiles } from "../application/parsers/project-block.js";
import { PathsService } from "../application/paths-service.js";
import { hubUnitPaths } from "../application/unit-membership.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { WorklineDirectory } from "./namespace-resolver.js";
import { isWorklineRoot } from "./workline-marker.js";

export class WorkspaceResolutionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly roots: string[] = [],
    /** The exact command that unblocks it, when no retry over `roots` does. */
    public readonly action?: string,
  ) {
    super(message);
  }
}

export const HUB_MIGRATE_ACTION = "aw hub-migrate --apply";

/** The refusal a hub whose block still wears pre-29 markers earns. */
export function hubMigrationRequired(
  root: string,
  files: readonly string[],
): WorkspaceResolutionError {
  return new WorkspaceResolutionError(
    "HUB_MIGRATION_REQUIRED",
    `El hub ${root} tiene el bloque con marcadores anteriores a 29.0.0 (${files.join(", ")}); ejecutá ${HUB_MIGRATE_ACTION} en el hub`,
    [],
    HUB_MIGRATE_ACTION,
  );
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

/** Real repository boundary, not the common git directory shared with its units. */
export async function repositoryRoot(from: string): Promise<string | null> {
  let dir = resolve(from);
  while (true) {
    try {
      await stat(join(dir, ".git"));
      return dir;
    } catch {
      /* ancestor search */
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export async function resolveWorkspaceDirectory(
  fs: FileSystemPort,
  directory: WorklineDirectory,
  cwd: string,
  home: string,
  explicit?: string,
): Promise<WorklineDirectory> {
  const repo = await repositoryRoot(cwd);
  if (explicit !== undefined)
    return resolveExplicitWorkspace(fs, directory, cwd, home, explicit, repo);

  // A marker above the git boundary (particularly ~/.workflow) is not the
  // source's own workspace. A marker within the repository wins over claims.
  if (
    directory.materialized &&
    directory.root !== home &&
    (repo === null || contains(repo, directory.root))
  )
    return { ...directory, root: await realpath(directory.root) };
  if (repo !== null && (await gitCommonDirectory(repo)) !== null) {
    const resolved = await resolveDeclaredWorkspace(fs, directory, home, repo);
    if (resolved !== null) return resolved;
  }
  if (cwd === home)
    throw new WorkspaceResolutionError("HUB_INVALID", "$HOME no es un hub; indica --hub <ruta>.");
  if (directory.root === home) {
    if (repo !== null)
      throw new WorkspaceResolutionError(
        "HUB_UNRESOLVED",
        `No hay hub registrado para ${repo}; indica --hub o ejecuta aw en el hub.`,
      );
    return { ...directory, root: cwd, materialized: false };
  }
  return { ...directory, root: directory.materialized ? directory.root : cwd };
}

export async function registerResolvedWorkspace(
  fs: FileSystemPort,
  home: string,
  directory: WorklineDirectory,
): Promise<string | null> {
  if (directory.root === home || !(await isWorklineRoot(fs, directory.root, directory.namespace)))
    return null;
  try {
    await access(directory.root);
    await registerHub(
      fs,
      new PathsService(directory.namespace, home, directory.root),
      directory.root,
    );
    return null;
  } catch (error) {
    return `No se pudo registrar el hub ${directory.root}: ${String(error)}`;
  }
}

async function resolveExplicitWorkspace(
  fs: FileSystemPort,
  directory: WorklineDirectory,
  cwd: string,
  home: string,
  explicit: string,
  repo: string | null,
): Promise<WorklineDirectory> {
  const namespace = directory.namespace;
  const root = resolve(cwd, explicit);
  try {
    if (!(await stat(root)).isDirectory()) throw new Error("no es directorio");
  } catch {
    throw new WorkspaceResolutionError("HUB_INVALID", `El hub ${root} no existe.`);
  }
  const marked = await isWorklineRoot(fs, root, namespace);
  if (
    root === home ||
    contains(join(home, `.${namespace}`, "worktrees"), root) ||
    (repo !== null && contains(repo, root) && root !== repo && !marked)
  ) {
    throw new WorkspaceResolutionError(
      "HUB_INVALID",
      `La carpeta ${root} no es una raíz de hub válida.`,
    );
  }
  const hubs =
    marked || (await repositoryRoot(root)) === null
      ? []
      : await declaringHubs(fs, home, namespace, root);
  const otherHubs = [...new Set(hubs.map((hub) => hub.root).filter((hub) => hub !== root))];
  if (otherHubs.length > 0) {
    throw new WorkspaceResolutionError(
      "HUB_INVALID",
      `${root} es una fuente declarada; indica la raíz del hub, no la fuente.`,
      otherHubs,
    );
  }
  let parent = dirname(root);
  while (parent !== dirname(parent)) {
    if (parent !== home && (await isWorklineRoot(fs, parent, namespace))) {
      throw new WorkspaceResolutionError(
        "HUB_INVALID",
        `${root} está dentro del hub ${parent}; --hub nombra la raíz exacta.`,
        [parent],
      );
    }
    parent = dirname(parent);
  }
  return { ...directory, root: await realpath(root), materialized: marked };
}

async function resolveDeclaredWorkspace(
  fs: FileSystemPort,
  directory: WorklineDirectory,
  home: string,
  repo: string,
): Promise<WorklineDirectory | null> {
  const namespace = directory.namespace;
  const hubs = await declaringHubs(fs, home, namespace, repo);
  const first = hubs[0];
  if (hubs.length === 1 && first) return { ...directory, root: first.root, materialized: true };
  if (hubs.length > 1) {
    const roots = [...new Set(hubs.map((hub) => hub.root))];
    if (roots.length === 1 && roots[0]) return { ...directory, root: roots[0], materialized: true };
    const owner = await resolveUnitOwner(fs, directory, home, repo, roots);
    if (owner !== null) return owner;
    throw new WorkspaceResolutionError(
      "HUB_AMBIGUOUS",
      `El checkout es fuente de ${roots.join(", ")}; indica --hub <ruta>.`,
      roots,
    );
  }
  const legacy = await legacyDeclaringHubs(fs, home, namespace, repo);
  if (legacy[0] !== undefined)
    throw hubMigrationRequired(legacy[0], await legacyBlockFiles(fs, legacy[0]));
  if (directory.root === home || (await isWorklineRoot(fs, home, namespace)))
    throw new WorkspaceResolutionError(
      "HUB_UNRESOLVED",
      `No hay hub registrado para ${repo}; indica --hub o ejecuta aw en el hub.`,
    );
  return null;
}

async function resolveUnitOwner(
  fs: FileSystemPort,
  directory: WorklineDirectory,
  home: string,
  repo: string,
  roots: string[],
): Promise<WorklineDirectory | null> {
  const namespace = directory.namespace;
  const units = join(home, `.${namespace}`, "worktrees");
  const unitsRoot = await realpath(units).catch(() => units);
  const unitRepo = await realpath(repo).catch(() => repo);
  if (contains(unitsRoot, unitRepo)) {
    const owners: string[] = [];
    for (const root of roots) {
      const owns = await hubUnitPaths(fs, new PathsService(namespace, home, root), unitsRoot);
      if (owns(unitRepo)) owners.push(root);
    }
    if (owners.length === 1 && owners[0])
      return { ...directory, root: owners[0], materialized: true };
  }
  return null;
}
