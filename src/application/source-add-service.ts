import { resolve } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { GitPort } from "../ports/git.js";
import { readWorkspaceBlock } from "./parsers/project-block.js";
import type { PathsService } from "./paths-service.js";
import { ensureWorkingBranch } from "./working-branch-service.js";
import { runWorkspaceInit } from "./workspace-init-service.js";
import { writeWorkspaceLocalConfig } from "./workspace-local-config.js";

export async function addSource(
  fs: FileSystemPort,
  env: EnvPort,
  git: GitPort,
  paths: PathsService,
  input: { alias: string; path: string; mainBranch?: string; workingBranch?: string },
): Promise<{ alias: string; path: string; working_branch: string | null } | { error: string }> {
  const path = resolve(paths.workspaceDir(), input.path);
  if (!(await fs.exists(path)))
    return { error: `la ruta de la fuente ${input.alias} no existe en este host: ${path}` };
  if (!(await git.isGitRepo(path)))
    return { error: `la ruta de la fuente ${input.alias} no es un repositorio git: ${path}` };
  const block = await readWorkspaceBlock(fs, paths.workspaceDir(), paths.blockMarkers());
  const prior = block?.fuentes.find((source) => source.alias === input.alias);
  const main = input.mainBranch ?? prior?.main_branch;
  if (!prior && !main)
    return { error: `la fuente nueva ${input.alias} requiere su rama principal` };
  const branch =
    input.workingBranch ??
    block?.working_branches[input.alias] ??
    (prior ? null : await git.currentBranch(path)) ??
    null;
  if (branch && branch !== main) {
    const outcome = await ensureWorkingBranch(
      git,
      { alias: input.alias, path, main_branch: main ?? null },
      branch,
      main ?? "",
    );
    if (!outcome.ok) return { error: outcome.reason };
  }
  const result = await runWorkspaceInit(fs, env, paths, {
    sources: [{ alias: input.alias, path: input.path, ...(main ? { mainBranch: main } : {}) }],
    ...(branch && branch !== main ? { workingBranches: { [input.alias]: branch } } : {}),
  });
  if ("error" in result) return { error: result.hint ?? result.error };
  if (!result.ok) return { error: "no se pudo declarar la fuente en el bloque o multiroot" };
  await writeWorkspaceLocalConfig(fs, paths, { [input.alias]: path });
  return { alias: input.alias, path, working_branch: branch && branch !== main ? branch : null };
}
