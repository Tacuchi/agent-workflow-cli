import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { NAMESPACE_REGEX } from "./namespace.js";

/**
 * What tells a Workline workspace apart from a directory that merely shares the
 * name of a subfolder.
 *
 * The canonical marker used to be `.<ns>/sessions/` alone, and that is a shape
 * the host tools imitate: `~/.claude/sessions`, `~/.codex/sessions` and
 * `~/.kimi-code/sessions` all exist on a normal machine. With three of them in
 * one home directory, every command launched from a path that was never
 * initialized read `$HOME` as three workspaces at once and died with
 * `WORKLINE_NAMESPACE_AMBIGUOUS` before any service was built.
 *
 * So the workspace gets a mark of its own, `.<ns>/workline.json`, written by the
 * minimal materialization. No host tool writes it, which is the whole point.
 */
export const WORKLINE_MARKER_FILE = "workline.json";

/**
 * Evidence that a directory was a Workline workspace BEFORE the mark existed.
 *
 * A workspace already materialized has to keep resolving without anybody running
 * a migration, and these are the runtime files only Workline puts at `.<ns>/`.
 * The first write into such a workspace adds the mark, so this reading is the
 * bridge and not a second contract: after it, the mark answers on its own.
 */
export const LEGACY_WORKLINE_FILES = [
  "HISTORY.md",
  "claims.jsonl",
  "skills.toml",
  "processes.json",
] as const;

/** The bytes the mark carries: enough to read it, never a second source of truth. */
export function worklineMarkerContent(namespace: string): string {
  return `${JSON.stringify({ workline: 1, namespace }, null, 2)}\n`;
}

/**
 * Whether `dir` holds the Workline workspace of `namespace`.
 *
 * Fails CLOSED in the direction that matters: a directory that only looks like
 * one — `sessions/` and nothing of Workline's beside it — is not adopted as a
 * workspace, so the command's own path is, which is what the person asked for.
 */
type MarkerReader = { stat(path: string): Promise<{ type: string }> };

export async function isWorklineRoot(
  fs: MarkerReader,
  dir: string,
  namespace: string,
): Promise<boolean> {
  const root = join(dir, `.${namespace}`);
  if (await isFile(fs, join(root, WORKLINE_MARKER_FILE))) return true;
  if (!(await isDir(fs, join(root, "sessions")))) return false;
  for (const legacy of LEGACY_WORKLINE_FILES) {
    if (await isFile(fs, join(root, legacy))) return true;
  }
  return false;
}

async function isFile(fs: MarkerReader, path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).type === "file";
  } catch {
    return false;
  }
}

async function isDir(fs: MarkerReader, path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).type === "dir";
  } catch {
    return false;
  }
}

/** The hook entry needs only marker reads, before any CLI services are loaded. */
export async function hasWorklineMarker(start: string): Promise<boolean> {
  const fs = {
    stat: async (path: string) => {
      const info = await stat(path);
      return { type: info.isFile() ? "file" : info.isDirectory() ? "dir" : "other" };
    },
  };
  let dir = start;
  while (true) {
    // Reuse the resolver's exact marker/legacy rule for every candidate namespace.
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // An unreadable ancestor must not suppress a hook that might need to run.
      return true;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(".")) continue;
      const namespace = entry.name.slice(1);
      if (NAMESPACE_REGEX.test(namespace) && (await isWorklineRoot(fs, dir, namespace)))
        return true;
    }
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}
