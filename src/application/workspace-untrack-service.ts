import type { ProcessPort } from "../ports/process.js";
import type { PathsService } from "./paths-service.js";
import {
  VISIBILITY_GITIGNORE,
  runtimeGitignoreEntries,
} from "./workspace-materialization-service.js";

export interface WorkspaceUntrack {
  paths: string[];
  applied: boolean;
}

/** Only Workline-owned ignored paths; user-authored ignore rules never authorize index edits. */
export async function workspaceUntrack(
  process: ProcessPort,
  paths: PathsService,
  apply: boolean,
): Promise<WorkspaceUntrack> {
  const cwd = paths.workspaceDir();
  const repository = await process.run("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
  if (repository.code !== 0 || repository.stdout.trim() !== "true")
    return { paths: [], applied: apply };
  const listed = await process.run("git", ["ls-files", "-z", "--cached", "--", "."], { cwd });
  if (listed.code !== 0) throw new Error(`no se pudo listar el índice: ${listed.stderr}`);
  const entries = [...runtimeGitignoreEntries(paths.namespace), ...VISIBILITY_GITIGNORE];
  const match = (file: string, pattern: string) =>
    pattern.endsWith("/")
      ? file.startsWith(pattern)
      : pattern.endsWith("*")
        ? file.startsWith(pattern.slice(0, -1))
        : file === pattern;
  const ignored = listed.stdout
    .split("\0")
    .filter((file) => file.length > 0 && entries.some((pattern) => match(file, pattern)))
    .sort();
  if (apply && ignored.length > 0) {
    const removed = await process.run("git", ["rm", "--cached", "--", ...ignored], { cwd });
    if (removed.code !== 0) throw new Error(`no se pudo sacar del índice: ${removed.stderr}`);
  }
  return { paths: ignored, applied: apply };
}
