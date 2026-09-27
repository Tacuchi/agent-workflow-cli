import type { GitPort } from "../ports/git.js";
import { isPlainBranchName } from "./branch-resolver.js";
import type { ProjectFuente } from "./parsers/project-block.js";

/**
 * How a source's declared working branch came to exist locally: it already
 * did, it was brought from its homonym in `origin`, or it was created from the
 * freshly fetched PROD remote.
 */
export type WorkingBranchOutcome = "existing" | "tracked" | "created";

export type WorkingBranchResolution =
  | { ok: true; outcome: WorkingBranchOutcome; branch: string; start_point?: string }
  | { ok: false; branch: string; reason: string };

/**
 * Why a branch with no upstream would still pull something, or null.
 *
 * A clone made with `--single-branch` (or `--depth`) fetches through a refspec
 * with no wildcard, and a bare `git pull` on a branch without upstream merges
 * that refspec — PROD, in the usual case. "No upstream" only protects a clone
 * that fetches every branch, so any other refuses instead of creating.
 */
async function narrowFetch(git: GitPort, repo: string): Promise<string | null> {
  const refspecs = await git.originFetchRefspecs(repo);
  if (refspecs.some((spec) => spec.includes("*"))) return null;
  const shown = refspecs.length > 0 ? refspecs.join(", ") : "ninguno";
  return `el clon no trae todas las ramas de origin (remote.origin.fetch: ${shown}): una rama sin upstream mezclaría esa rama con un git pull sin argumentos; agregá +refs/heads/*:refs/remotes/origin/* a remote.origin.fetch y reintentá`;
}

/**
 * Resolve `branch` in the source's repo before anybody registers it.
 *
 * A missing branch is created from `origin/<PROD>` just fetched — the team's
 * recipe (RC-14) — and with NO upstream: a branch created tracking PROD is one a
 * bare `git push` publishes to PROD and a bare `git pull` merges PROD into. A
 * branch that exists only in `origin` tracks its homonym, which touches no PROD.
 */
export async function ensureWorkingBranch(
  git: GitPort,
  source: ProjectFuente,
  branch: string,
  prod: string,
): Promise<WorkingBranchResolution> {
  if (!isPlainBranchName(branch)) {
    return { ok: false, branch, reason: `${branch} no es un nombre de rama simple` };
  }
  const repo = source.path;
  if (repo === null)
    return {
      ok: false,
      branch,
      reason: `la ruta de la fuente ${source.alias} no existe en este host; declárala con aw add-source ${source.alias}:<ruta>`,
    };
  try {
    const local = await git.localBranches(repo);
    if (local.includes(branch)) return { ok: true, outcome: "existing", branch };
    // On a case-insensitive filesystem `Feature/X` and `feature/x` are one ref
    // file: answering `existing` would register a name that is not the branch,
    // and creating the other would leave twins that overwrite each other.
    const twin = local.find((name) => name.toLowerCase() === branch.toLowerCase());
    if (twin !== undefined) {
      return {
        ok: false,
        branch,
        reason: `ya existe ${twin}, que difiere de ${branch} sólo en mayúsculas`,
      };
    }
    const narrow = await narrowFetch(git, repo);
    if (narrow !== null) return { ok: false, branch, reason: narrow };
    if (await git.remoteHasBranch(repo, branch)) {
      await git.fetchBranch(repo, branch);
      await git.createBranch(repo, branch, `refs/remotes/origin/${branch}`, { track: true });
      return { ok: true, outcome: "tracked", branch, start_point: `origin/${branch}` };
    }
    if (!(await git.remoteHasBranch(repo, prod))) {
      return {
        ok: false,
        branch,
        reason: `origin no tiene la rama de PROD ${prod}: no hay desde dónde crear ${branch}`,
      };
    }
    await git.fetchBranch(repo, prod);
    await git.createBranch(repo, branch, `refs/remotes/origin/${prod}`, { track: false });
    return { ok: true, outcome: "created", branch, start_point: `origin/${prod}` };
  } catch (err) {
    return { ok: false, branch, reason: err instanceof Error ? err.message : String(err) };
  }
}
