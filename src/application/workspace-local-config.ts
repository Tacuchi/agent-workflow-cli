import { execFile } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import { promisify } from "node:util";
import type { FileSystemPort } from "../ports/file-system.js";
import { acquireLock } from "./lock-service.js";
import type { PathsService } from "./paths-service.js";

const runGit = promisify(execFile);

export interface WorkspaceLocalConfig {
  version: 1;
  sources: Record<string, string>;
  [key: string]: unknown;
}

export type LocalConfigRead =
  | { config: WorkspaceLocalConfig; error: null }
  | { config: null; error: string };

export function absoluteOnAnyHost(path: string): boolean {
  return isAbsolute(path) || win32.isAbsolute(path);
}

export function localSourcePath(
  config: WorkspaceLocalConfig | null,
  alias: string,
): string | undefined {
  return config !== null && Object.hasOwn(config.sources, alias)
    ? config.sources[alias]
    : undefined;
}

export async function readWorkspaceLocalConfig(
  fs: FileSystemPort,
  file: string,
): Promise<LocalConfigRead> {
  if (!(await fs.exists(file))) return { config: { version: 1, sources: {} }, error: null };
  try {
    const value: unknown = JSON.parse(await fs.readText(file));
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      (value as Record<string, unknown>).version !== 1 ||
      typeof (value as Record<string, unknown>).sources !== "object" ||
      (value as Record<string, unknown>).sources === null ||
      Array.isArray((value as Record<string, unknown>).sources) ||
      Object.values((value as WorkspaceLocalConfig).sources).some((p) => typeof p !== "string")
    )
      throw new Error("formato o versión no reconocidos");
    return { config: value as WorkspaceLocalConfig, error: null };
  } catch (error) {
    return { config: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Call only while holding the workspace lock; an unreadable file is never replaced. */
export async function writeWorkspaceLocalConfigUnlocked(
  fs: FileSystemPort,
  paths: PathsService,
  changes: Record<string, string | null>,
): Promise<void> {
  const file = paths.cwdLocalConfigFile();
  const existing = await readWorkspaceLocalConfig(fs, file);
  if (existing.config === null) throw new Error(`local.json ilegible: ${existing.error}`);
  const sources: Record<string, string> = Object.assign(
    Object.create(null),
    existing.config.sources,
  );
  for (const [alias, path] of Object.entries(changes)) {
    if (path === null) delete sources[alias];
    else sources[alias] = absoluteOnAnyHost(path) ? path : resolve(paths.workspaceDir(), path);
  }
  await fs.mkdirp(join(paths.workspaceDir(), `.${paths.namespace}`));
  await ensureLocalConfigIgnored(fs, paths);
  await fs.writeText(file, `${JSON.stringify({ ...existing.config, sources }, null, 2)}\n`);
}

/** Use the containing repository's private exclude file, never the tracked .gitignore. */
async function ensureLocalConfigIgnored(fs: FileSystemPort, paths: PathsService): Promise<void> {
  const cwd = paths.workspaceDir();
  const file = paths.cwdLocalConfigFile();
  let root: string;
  try {
    root = (await runGit("git", ["-C", cwd, "rev-parse", "--show-toplevel"])).stdout.trim();
    await runGit("git", ["-C", cwd, "check-ignore", "-q", "--", file]);
    return;
  } catch {
    // A non-repository hub has nothing to exclude; check whether git can see it.
    try {
      root = (await runGit("git", ["-C", cwd, "rev-parse", "--show-toplevel"])).stdout.trim();
    } catch {
      return;
    }
  }
  const gitPath = (
    await runGit("git", ["-C", cwd, "rev-parse", "--git-path", "info/exclude"])
  ).stdout.trim();
  const exclude = resolve(cwd, gitPath);
  // A leading slash anchors the entry at the repository root, including nested hubs.
  const canonicalFile = join(await fs.realPath(cwd), `.${paths.namespace}`, "local.json");
  const relativeEntry = `/${relative(root, canonicalFile).replaceAll("\\", "/")}`;
  const current = (await fs.exists(exclude)) ? await fs.readText(exclude) : "";
  if (current.split(/\r?\n/).includes(relativeEntry)) return;
  await fs.mkdirp(dirname(exclude));
  await fs.writeText(
    exclude,
    `${current}${current.length > 0 && !current.endsWith("\n") ? "\n" : ""}${relativeEntry}\n`,
  );
}

export async function writeWorkspaceLocalConfig(
  fs: FileSystemPort,
  paths: PathsService,
  changes: Record<string, string | null>,
): Promise<void> {
  const lock = await acquireLock(paths.cwdLockFile(), fs, { removeOnRelease: true });
  try {
    await writeWorkspaceLocalConfigUnlocked(fs, paths, changes);
  } finally {
    await lock.release();
  }
}
