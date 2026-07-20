import type {
  DefaultBranches,
  ParsedProjectBlock,
  ProjectFuente,
} from "./parsers/project-block.js";

/** Floor applied when the workspace declares no default for a role. */
export const BRANCH_ROLE_FALLBACKS: Required<DefaultBranches> = {
  principal: "main",
  desarrollo: "development",
  qa: "qa",
};

/** Branch roles of one source, fully resolved (never null). */
export interface SourceBranchRoles {
  /** Base/PROD branch: Fuentes cell → default `principal`. */
  prod: string;
  /** Working branch: Status `Ramas de trabajo` → default `desarrollo`. */
  work: string;
  /** QA branch: Status `Ramas QA` → default `qa`. */
  qa: string;
  /** Development branch: workspace default `desarrollo` (no per-source value). */
  dev: string;
}

/** Workspace defaults with the fallback floor applied. */
export function resolveDefaultBranches(
  defaults: DefaultBranches | undefined,
): Required<DefaultBranches> {
  return {
    principal: defaults?.principal || BRANCH_ROLE_FALLBACKS.principal,
    desarrollo: defaults?.desarrollo || BRANCH_ROLE_FALLBACKS.desarrollo,
    qa: defaults?.qa || BRANCH_ROLE_FALLBACKS.qa,
  };
}

/**
 * Resolve every branch role for a source: per-source value → workspace default
 * → hardcoded fallback. Single chain shared by git-flow and the Project tab, so
 * what the TUI shows is what the flows act on.
 */
export function resolveSourceBranches(
  source: ProjectFuente,
  block: Pick<ParsedProjectBlock, "default_branches" | "working_branches" | "qa_branches"> | null,
): SourceBranchRoles {
  const defaults = resolveDefaultBranches(block?.default_branches);
  return {
    prod: source.main_branch || defaults.principal,
    work: block?.working_branches[source.alias] || defaults.desarrollo,
    qa: block?.qa_branches[source.alias] || defaults.qa,
    dev: defaults.desarrollo,
  };
}

/**
 * Single shared resolver for the expected WORKING branch of a source.
 *
 * The expected work branch is sourced from the WORKSPACE block's
 * `working_branches` (per owning Fuentes source). It is DECOUPLED from sessions
 * and flow. "Rama principal" (the Fuentes table) is the BASE
 * branch, NOT the expected work branch, so it is never used here.
 *
 * Returns the declared working branch for the source, or `null` when the source
 * declares none (callers treat null as "no expectation → allow / no-op").
 */
export function expectedWorkBranch(
  source: ProjectFuente,
  workingBranches: Record<string, string>,
): string | null {
  const branch = workingBranches[source.alias];
  return branch && branch.length > 0 ? branch : null;
}

/** Find the Fuentes source that owns `filePath` (path-prefix match). */
export function findOwningSource(
  sources: readonly ProjectFuente[],
  filePath: string,
): ProjectFuente | null {
  for (const s of sources) {
    if (filePath.startsWith(s.path)) return s;
  }
  return null;
}
