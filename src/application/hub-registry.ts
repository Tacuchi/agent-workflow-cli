import { randomUUID } from "node:crypto";
import { readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { FileSystemPort } from "../ports/file-system.js";
import { acquireLock } from "./lock-service.js";
import { type ParsedHubBlock, readHubBlock, readLegacyBlock } from "./parsers/hub-block.js";
import { PathsService } from "./paths-service.js";

export class HubRegistryError extends Error {
  readonly code = "HUB_REGISTRY_UNREADABLE";
}

export function hubsFile(home: string, namespace: string): string {
  return join(home, `.${namespace}`, "hubs.json");
}

export async function readHubs(file: string): Promise<string[]> {
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("formato inválido");
    const record = value as { version?: unknown; roots?: unknown };
    if (
      record.version !== 1 ||
      !Array.isArray(record.roots) ||
      record.roots.some((r) => typeof r !== "string" || !isAbsolute(r))
    ) {
      throw new Error("versión o raíces inválidas");
    }
    return record.roots;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new HubRegistryError(`Registro de hubs ilegible (${file}): ${String(error)}`);
  }
}

/** This is user-level state, written by the raw filesystem; it never materializes a hub. */
export async function registerHub(
  fs: FileSystemPort,
  paths: PathsService,
  root: string,
): Promise<void> {
  const file = join(paths.userRoot(), "hubs.json");
  const canonical = await realpath(root);
  const existing = await readHubs(file);
  if (existing.includes(canonical)) return;
  const lock = await acquireLock(`${file}.lock`, fs, { waitMs: 1000, removeOnRelease: true });
  try {
    const roots = await readHubs(file);
    const alive: string[] = [];
    for (const path of [...roots, canonical]) {
      try {
        const key = await realpath(path);
        if (!alive.includes(key)) alive.push(key);
      } catch {
        /* removed hubs are pruned on a write */
      }
    }
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify({ version: 1, roots: alive }, null, 2)}\n`, {
        flag: "wx",
      });
      await rename(tmp, file);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  } finally {
    await lock.release();
  }
}

/** Find the common git directory without invoking git; works for linked worktrees. */
export async function gitCommonDirectory(start: string): Promise<string | null> {
  try {
    if (!(await stat(start)).isDirectory()) return null;
  } catch {
    return null;
  }
  let dir = resolve(start);
  while (true) {
    const dotGit = join(dir, ".git");
    try {
      const info = await stat(dotGit);
      const gitDir = info.isDirectory()
        ? dotGit
        : resolve(dir, /^gitdir:\s*(.+)$/m.exec(await readFile(dotGit, "utf8"))?.[1] ?? "");
      if (gitDir === dir) return null;
      return await resolveCommonDirectory(gitDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export interface DeclaringHub {
  root: string;
  alias: string;
  workingBranch: string | null;
}

export async function declaringHubs(
  fs: FileSystemPort,
  home: string,
  namespace: string,
  repo: string,
): Promise<DeclaringHub[]> {
  return await hubsDeclaring(home, namespace, repo, (root, paths) =>
    readHubBlock(fs, root, paths.blockMarkers()),
  );
}

/**
 * The registered hubs whose pre-29 block declares `repo`.
 *
 * Read only so the walk-up can answer HUB_MIGRATION_REQUIRED instead of
 * HUB_UNRESOLVED about a hub that exists: those hubs never resolve as hubs
 * until `aw hub-migrate --apply` runs in them.
 */
export async function legacyDeclaringHubs(
  fs: FileSystemPort,
  home: string,
  namespace: string,
  repo: string,
): Promise<string[]> {
  const hubs = await hubsDeclaring(home, namespace, repo, (root) => readLegacyBlock(fs, root));
  return [...new Set(hubs.map((hub) => hub.root))];
}

async function hubsDeclaring(
  home: string,
  namespace: string,
  repo: string,
  read: (root: string, paths: PathsService) => Promise<ParsedHubBlock | null>,
): Promise<DeclaringHub[]> {
  const common = await gitCommonDirectory(repo);
  if (common === null) return [];
  const result: DeclaringHub[] = [];
  for (const root of await readHubs(hubsFile(home, namespace))) {
    if (root === home) continue;
    const paths = new PathsService(namespace as PathsService["namespace"], home, root);
    try {
      const block = await read(root, paths);
      for (const source of block?.fuentes ?? []) {
        if (source.path && (await gitCommonDirectory(source.path)) === common) {
          result.push({
            root,
            alias: source.alias,
            workingBranch: block?.working_branches[source.alias] ?? null,
          });
        }
      }
    } catch {
      /* An absent hub or a source no longer declared is not a claimant. */
    }
  }
  return result;
}

async function resolveCommonDirectory(gitDir: string): Promise<string> {
  let common = gitDir;
  try {
    common = resolve(gitDir, (await readFile(join(gitDir, "commondir"), "utf8")).trim());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return await realpath(common);
}
