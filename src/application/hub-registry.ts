import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { FileSystemPort } from "../ports/file-system.js";
import { isWorklineRoot } from "../runtime/workline-marker.js";
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
  if ((await readHubs(file)).includes(canonical)) return;
  await rewriteHubs(fs, file, async (roots) => {
    const alive: string[] = [];
    for (const path of [...roots, canonical]) {
      try {
        const key = await realpath(path);
        if (!alive.includes(key)) alive.push(key);
      } catch {
        /* removed hubs are pruned on a write */
      }
    }
    return alive;
  });
}

/**
 * The registry's only write: under its lock, over a fresh reading, by an
 * atomic rename. Every writer goes through here, so a concurrent `aw` can
 * neither lose a root another one just added nor read a half-written file.
 */
async function rewriteHubs(
  fs: FileSystemPort,
  file: string,
  next: (roots: string[]) => Promise<string[]>,
): Promise<void> {
  const lock = await acquireLock(`${file}.lock`, fs, { waitMs: 1000, removeOnRelease: true });
  try {
    const roots = await next(await readHubs(file));
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(tmp, `${JSON.stringify({ version: 1, roots }, null, 2)}\n`, { flag: "wx" });
      await rename(tmp, file);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  } finally {
    await lock.release();
  }
}

export type HubState = "ok" | "missing" | "not-a-hub" | "ephemeral";

export interface RegisteredHub {
  name: string;
  root: string;
  state: HubState;
}

/**
 * Where agent scratchpads and test fixtures live. A hub copied there is a
 * throwaway, so the implicit registration of each invocation skips it.
 */
export async function systemTempRoots(): Promise<string[]> {
  const roots: string[] = [];
  for (const candidate of [tmpdir(), "/tmp", "/private/tmp"]) {
    try {
      const key = await realpath(candidate);
      if (!roots.includes(key)) roots.push(key);
    } catch {
      /* a platform without this folder has nothing under it */
    }
  }
  return roots;
}

export function isEphemeralRoot(root: string, tempRoots: readonly string[]): boolean {
  return tempRoots.some((temp) => {
    const inside = relative(temp, root);
    return inside === "" || (!inside.startsWith("..") && !isAbsolute(inside));
  });
}

export async function hubState(
  fs: FileSystemPort,
  root: string,
  namespace: string,
  tempRoots: readonly string[],
): Promise<HubState> {
  if (!(await fs.exists(root))) return "missing";
  if (!(await isWorklineRoot(fs, root, namespace))) return "not-a-hub";
  return isEphemeralRoot(root, tempRoots) ? "ephemeral" : "ok";
}

/**
 * A hub is named after its folder. Two registered hubs sharing one get their
 * parent too, so neither name points at the other.
 */
export function hubNames(roots: readonly string[]): Map<string, string> {
  const count = new Map<string, number>();
  for (const root of roots) count.set(basename(root), (count.get(basename(root)) ?? 0) + 1);
  return new Map(
    roots.map((root) => [
      root,
      (count.get(basename(root)) ?? 0) > 1
        ? `${basename(dirname(root))}/${basename(root)}`
        : basename(root),
    ]),
  );
}

export async function listRegisteredHubs(
  fs: FileSystemPort,
  home: string,
  namespace: string,
  tempRoots: readonly string[],
): Promise<RegisteredHub[]> {
  const roots = await readHubs(hubsFile(home, namespace));
  const names = hubNames(roots);
  const hubs: RegisteredHub[] = [];
  for (const root of roots) {
    hubs.push({
      name: names.get(root) ?? basename(root),
      root,
      state: await hubState(fs, root, namespace, tempRoots),
    });
  }
  return hubs;
}

/** Removes every root that is not `ok` and returns them as they were judged. */
export async function pruneHubs(
  fs: FileSystemPort,
  home: string,
  namespace: string,
  tempRoots: readonly string[],
): Promise<RegisteredHub[]> {
  const file = hubsFile(home, namespace);
  let removed: RegisteredHub[] = [];
  await rewriteHubs(fs, file, async (roots) => {
    const names = hubNames(roots);
    const kept: string[] = [];
    removed = [];
    for (const root of roots) {
      const state = await hubState(fs, root, namespace, tempRoots);
      if (state === "ok") kept.push(root);
      else removed.push({ name: names.get(root) ?? basename(root), root, state });
    }
    return kept;
  });
  return removed;
}

export interface HubScan {
  found: string[];
  registered: string[];
  skipped: Array<{ path: string; reason: string }>;
}

const SCAN_DEPTH = 3;
const SCAN_SKIPPED_DIRS = new Set(["node_modules", ".git"]);

/**
 * The hubs under each folder, judged by `isWorklineRoot` and never by the mere
 * presence of `.<ns>/`: a leftover with only a HISTORY.md is reported, not adopted.
 */
export async function scanHubs(
  fs: FileSystemPort,
  home: string,
  namespace: string,
  folders: readonly string[],
): Promise<HubScan> {
  const registered = await readHubs(hubsFile(home, namespace));
  const walk: ScanWalk = {
    fs,
    namespace,
    registered,
    home: await realpath(home).catch(() => home),
    seen: new Set<string>(),
    scan: { found: [], registered: [], skipped: [] },
  };
  const starts =
    folders.length > 0 ? folders.map((folder) => resolve(folder)) : parentsOf(registered);
  for (const start of starts) await visitScanned(walk, start, 0);
  return walk.scan;
}

interface ScanWalk {
  fs: FileSystemPort;
  namespace: string;
  registered: readonly string[];
  home: string;
  seen: Set<string>;
  scan: HubScan;
}

async function visitScanned(walk: ScanWalk, dir: string, depth: number): Promise<void> {
  const key = await realpath(dir).catch(() => null);
  if (key === null || walk.seen.has(key)) return;
  walk.seen.add(key);
  await classifyScanned(walk, key);
  if (depth === SCAN_DEPTH) return;
  for (const child of await scannableChildren(key)) await visitScanned(walk, child, depth + 1);
}

async function classifyScanned(walk: ScanWalk, dir: string): Promise<void> {
  if (dir === walk.home || !(await walk.fs.exists(join(dir, `.${walk.namespace}`)))) return;
  if (!(await isWorklineRoot(walk.fs, dir, walk.namespace))) {
    walk.scan.skipped.push({
      path: dir,
      reason: "sin marcador de hub (workline.json o sessions/)",
    });
    return;
  }
  (walk.registered.includes(dir) ? walk.scan.registered : walk.scan.found).push(dir);
}

async function scannableChildren(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() && !SCAN_SKIPPED_DIRS.has(entry.name) && !entry.name.startsWith("."),
    )
    .map((entry) => join(dir, entry.name));
}

function parentsOf(roots: readonly string[]): string[] {
  return [...new Set(roots.map((root) => dirname(root)))];
}

/** Registers what a scan found, through the same write as everything else. */
export async function registerScannedHubs(
  fs: FileSystemPort,
  home: string,
  namespace: string,
  roots: readonly string[],
): Promise<void> {
  if (roots.length === 0) return;
  await rewriteHubs(fs, hubsFile(home, namespace), async (current) => [
    ...current,
    ...roots.filter((root) => !current.includes(root)),
  ]);
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
