import { isAbsolute, relative } from "node:path";
import type { FileSystemPort } from "../../ports/file-system.js";
import type { GitPort } from "../../ports/git.js";
import {
  type ProjectFuente,
  readWorkspaceBlock,
  requireSourcePath,
} from "../parsers/project-block.js";
import { type PathsService, resolveWorkspaceRootFrom } from "../paths-service.js";
import { semanticDigest } from "../semantic-operation/protocol.js";
import { resolveCheckoutCandidates } from "./checkout-observation.js";
import { locateRun, readRun } from "./run-state-service.js";

/** QUICK may use source checkouts without units. This is not checkout-proof eligibility. */
export async function observeQuickCheckouts(
  fs: FileSystemPort,
  paths: PathsService,
  session: string,
  git: GitPort | undefined,
): Promise<Record<string, string> | null> {
  if (git === undefined) return null;
  const run = await readRun(fs, locateRun(paths, session));
  if (!run.ok || run.state.flow !== "quick") return null;
  try {
    const first = await readQuickCheckouts(fs, paths, session, git);
    const second = await readQuickCheckouts(fs, paths, session, git);
    return first !== null && semanticDigest(first) === semanticDigest(second) ? first : null;
  } catch {
    // Missing or unstable evidence asks for the commit, never silently omits it.
    return null;
  }
}

async function readQuickCheckouts(
  fs: FileSystemPort,
  paths: PathsService,
  session: string,
  git: GitPort,
): Promise<Record<string, string> | null> {
  const root = await resolveWorkspaceRootFrom(fs, paths);
  const block = await readWorkspaceBlock(fs, root, paths.blockMarkers());
  const units = await resolveCheckoutCandidates(fs, paths, session);
  const sources: ProjectFuente[] = [
    { alias: "workspace", path: root, main_branch: null },
    ...(block?.fuentes ?? []),
  ];
  const result: Record<string, string> = {};
  for (const source of sources) {
    const sourcePath = await requireSourcePath(fs, source);
    const checkout = units.find((unit) => unit.source === source.alias)?.root ?? sourcePath;
    if (!(await git.isGitRepo(checkout))) return null;
    const runtime = relative(checkout, paths.cwdRoot());
    const exclude = runtime && !runtime.startsWith("..") && !isAbsolute(runtime) ? [runtime] : [];
    result[source.alias] = semanticDigest({
      root: checkout,
      content: await git.scopedFingerprint(checkout, exclude),
      git: await git.checkoutFingerprint(checkout, exclude),
    });
  }
  return result;
}
