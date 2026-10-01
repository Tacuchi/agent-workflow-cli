import { resolve } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { GitPort } from "../ports/git.js";
import { runHubInit } from "./hub-init-service.js";
import { writeHubLocalConfig } from "./hub-local-config.js";
import { readHubBlock } from "./parsers/hub-block.js";
import type { PathsService } from "./paths-service.js";
import { ensureWorkingBranch } from "./working-branch-service.js";

export async function addSource(
  fs: FileSystemPort,
  env: EnvPort,
  git: GitPort,
  paths: PathsService,
  input: { alias: string; path: string; mainBranch?: string; workingBranch?: string },
): Promise<{ alias: string; path: string; working_branch: string | null } | { error: string }> {
  const path = resolve(paths.hubDir(), input.path);
  if (!(await fs.exists(path)))
    return { error: `la ruta de la fuente ${input.alias} no existe en este host: ${path}` };
  if (!(await git.isGitRepo(path)))
    return { error: `la ruta de la fuente ${input.alias} no es un repositorio git: ${path}` };
  const block = await readHubBlock(fs, paths.hubDir(), paths.blockMarkers());
  const prior = block?.fuentes.find((source) => source.alias === input.alias);
  const main = input.mainBranch ?? prior?.main_branch;
  if (!prior && !main)
    return { error: `la fuente nueva ${input.alias} requiere su rama principal` };
  const branch =
    input.workingBranch ??
    block?.working_branches[input.alias] ??
    (prior ? null : await git.currentBranch(path)) ??
    null;
  const branchFailure = await ensureSourceBranch(git, input.alias, path, main, branch);
  if (branchFailure !== null) return branchFailure;
  const workingBranch = branch && branch !== main ? branch : null;
  const result = await runHubInit(fs, env, paths, {
    sources: [{ alias: input.alias, path: input.path, ...(main ? { mainBranch: main } : {}) }],
    ...(workingBranch ? { workingBranches: { [input.alias]: workingBranch } } : {}),
  });
  if ("error" in result) return { error: result.hint ?? result.error };
  if (!result.ok) return { error: "no se pudo declarar la fuente en el bloque o multiroot" };
  await writeHubLocalConfig(fs, paths, { [input.alias]: path });
  return { alias: input.alias, path, working_branch: workingBranch };
}

async function ensureSourceBranch(
  git: GitPort,
  alias: string,
  path: string,
  main: string | null | undefined,
  branch: string | null,
): Promise<{ error: string } | null> {
  if (branch && branch !== main) {
    const outcome = await ensureWorkingBranch(
      git,
      { alias: alias, path, main_branch: main ?? null },
      branch,
      main ?? "",
    );
    if (!outcome.ok) return { error: outcome.reason };
  }
  return null;
}
