import { join } from "node:path";
import type { FileSystemPort } from "../../ports/file-system.js";
import type { GitPort } from "../../ports/git.js";

/** A worktree on its own branch where one piece of work edits one source. */
export interface IsolationUnit {
  alias: string;
  branch: string;
  path: string;
}

/** Where one batch of one plan edits one source (spec 066, T4.4): named by plan and batch. */
export interface PlanUnit extends IsolationUnit {
  plan: string;
  batch: string;
}

/** Where one QUICK edits one source without a plan (spec 067, ID05): named by its slug. */
export interface QuickUnit extends IsolationUnit {
  quick: string;
}

/** The unit as git has it, and the base it was created from (`null` when it already existed). */
export interface EnsuredUnit {
  created: boolean;
  base: string | null;
  unit: IsolationUnit;
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

/** The QUICK counterpart of {@link planUnit}: `aw/<hub>/quick-<slug>`, never a fictitious plan. */
export function quickUnit(input: {
  worktreesRoot: string;
  hubKey: string;
  alias: string;
  slug: string;
}): QuickUnit {
  const name = `quick-${input.slug}`;
  return {
    alias: input.alias,
    quick: input.slug,
    branch: `aw/${input.hubKey}/${name}`,
    path: join(input.worktreesRoot, input.hubKey, input.alias, name),
  };
}

/**
 * Creates the unit's worktree from `base` when it is not there yet; reuses it
 * otherwise, reporting the folder git has for it and leaving its base alone.
 */
export async function ensureUnit<T extends IsolationUnit>(
  fs: FileSystemPort,
  git: GitPort,
  repo: string,
  unit: T,
  base: string | null,
): Promise<{ created: boolean; base: string | null; unit: T }> {
  const listed = (await git.worktreeList(repo)).find(
    (tree) => tree.branch === unit.branch || tree.branch === `refs/heads/${unit.branch}`,
  );
  if (listed !== undefined)
    return { created: false, base: null, unit: { ...unit, path: listed.path } };
  await fs.mkdirp(join(unit.path, ".."));
  await git.worktreeAdd(repo, unit.path, unit.branch, base);
  return { created: true, base, unit };
}
