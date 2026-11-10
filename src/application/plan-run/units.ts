import { join } from "node:path";
import type { FileSystemPort } from "../../ports/file-system.js";
import type { GitPort } from "../../ports/git.js";

/** Where one batch of one plan edits one source (spec 066, T4.4): named by plan and batch. */
export interface PlanUnit {
  alias: string;
  plan: string;
  batch: string;
  branch: string;
  path: string;
}

/**
 * The identity of an isolation unit without a session: the branch and the
 * worktree folder carry the hub key, the plan number and the batch, so two
 * instances on two plans never meet, and one instance can find its own unit
 * again after a crash by asking git alone.
 */
export function planUnit(input: {
  worktreesRoot: string;
  hubKey: string;
  alias: string;
  plan: string;
  batch: string;
}): PlanUnit {
  const name = `plan-${input.plan}-${input.batch.toLowerCase()}`;
  return {
    alias: input.alias,
    plan: input.plan,
    batch: input.batch,
    branch: `aw/${input.hubKey}/${name}`,
    path: join(input.worktreesRoot, input.hubKey, input.alias, name),
  };
}

/** Creates the unit's worktree from `base` when it is not there yet; reuses it otherwise. */
export async function ensurePlanUnit(
  fs: FileSystemPort,
  git: GitPort,
  repo: string,
  unit: PlanUnit,
  base: string | null,
): Promise<{ created: boolean; unit: PlanUnit }> {
  const listed = await git.worktreeList(repo);
  if (
    listed.some(
      (tree) => tree.branch === unit.branch || tree.branch === `refs/heads/${unit.branch}`,
    )
  ) {
    return { created: false, unit };
  }
  await fs.mkdirp(join(unit.path, ".."));
  await git.worktreeAdd(repo, unit.path, unit.branch, base);
  return { created: true, unit };
}

/** The units git knows for one plan, read back from the branch names alone. */
export async function unitsOfPlan(
  git: GitPort,
  repo: string,
  hubKey: string,
  plan: string,
): Promise<{ branch: string; path: string; batch: string }[]> {
  const prefix = `aw/${hubKey}/plan-${plan}-`;
  const out: { branch: string; path: string; batch: string }[] = [];
  for (const tree of await git.worktreeList(repo)) {
    const branch = (tree.branch ?? "").replace(/^refs\/heads\//, "");
    if (!branch.startsWith(prefix)) continue;
    out.push({ branch, path: tree.path, batch: branch.slice(prefix.length).toUpperCase() });
  }
  return out;
}
