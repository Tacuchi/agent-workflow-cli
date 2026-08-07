import { createHash } from "node:crypto";
import { join } from "node:path";

/**
 * The isolation unit of a flow: one git worktree of a source, on a branch of its
 * own, addressed by a CONVENTION rather than by a registry file.
 *
 * The path itself encodes the three facts anybody needs — which workspace, which
 * source, which session — and `git worktree list` of the source is the live,
 * authoritative view of which units exist. So there is no registry to write, and
 * therefore none that can drift from the trees that actually exist. Occupancy is
 * inherited too: git refuses to check the same branch out in two worktrees, so a
 * second flow asking for a taken unit is stopped by git, not by a check of ours
 * that could be forgotten.
 */

/** Every isolation-unit branch lives under this prefix, and nothing else does. */
export const UNIT_BRANCH_PREFIX = "aw/";

/** Directory under the user root that holds every workspace's units. */
export const UNITS_DIR = "worktrees";

export interface UnitIdentity {
  /** Workspace the unit belongs to, as encoded in its path. */
  workspaceKey: string;
  /** Source alias, as declared in the workspace's Fuentes table. */
  alias: string;
  /** Session folder name (`103-<slug>-plan-exec`). */
  session: string;
}

/**
 * Filesystem-safe, collision-resistant name for a workspace.
 *
 * The folder name alone would collide across two checkouts of the same project,
 * and the absolute path alone is not a directory name — so it is the readable
 * half plus a short digest of the full path, which keeps the tree browsable
 * without making two workspaces share a unit.
 */
export function workspaceKey(workspaceDir: string): string {
  const normalized = workspaceDir.split("\\").join("/").replace(/\/+$/, "");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  const safe = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 8);
  return `${safe.length > 0 ? safe : "workspace"}-${digest}`;
}

/** The branch a session works on inside its units, across every source. */
export function unitBranch(session: string): string {
  return `${UNIT_BRANCH_PREFIX}${session}`;
}

/** `<userRoot>/worktrees` — the root every unit of every workspace hangs from. */
export function unitsRoot(userRoot: string): string {
  return join(userRoot, UNITS_DIR);
}

/**
 * The one path a given (workspace, source, session) triple may occupy.
 *
 * `root` is the units root, and callers pass its CANONICAL form: git reports
 * worktrees with symlinks resolved, so a root spelled `/tmp/...` would never
 * match the `/private/tmp/...` git answers with on macOS.
 */
export function unitPath(root: string, identity: UnitIdentity): string {
  return join(root, identity.workspaceKey, identity.alias, identity.session);
}

/**
 * Read a unit's identity out of a path AT or INSIDE a unit, or `null` when the
 * path belongs to no unit of ours.
 *
 * This is the inverse of {@link unitPath} and the reason no registry is needed:
 * a worktree git reports can be attributed to its workspace, source and session
 * from its location alone.
 *
 * It reads a path *inside* the unit too, because the caller that matters most is
 * the branch check, and what that one holds is the file being edited — not the
 * tree's root. Demanding the exact root made every edit inside a unit resolve to
 * "belongs to no source", which is the silence this whole reading exists to end.
 */
export function parseUnitPath(root: string, path: string): UnitIdentity | null {
  const prefix = `${normalize(root)}/`;
  const target = normalize(path);
  if (!target.startsWith(prefix)) return null;
  const parts = target
    .slice(prefix.length)
    .split("/")
    .filter((p) => p.length > 0);
  if (parts.length < 3) return null;
  const [workspaceKey, alias, session] = parts as [string, string, string];
  return { workspaceKey, alias, session };
}

function normalize(path: string): string {
  return path.split("\\").join("/").replace(/\/+$/, "");
}
