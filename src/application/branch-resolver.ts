import type { ProjectFuente } from "./parsers/project-block.js";

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
