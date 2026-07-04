import { join } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { ProcessPort } from "../ports/process.js";
import { runMultiroot } from "./multiroot-service.js";
import { type ProjectFuente, parseProjectBlock } from "./parsers/project-block.js";
import type { PathsService } from "./paths-service.js";
import { ProcessRegistryService } from "./process-registry-service.js";
import { runProjectMdUpsertWrite } from "./project-md-upsert-service.js";

export interface RemoveSourceDeps {
  fs: FileSystemPort;
  env: EnvPort;
  proc: ProcessPort;
  paths: PathsService;
}

export interface RemoveSourceResult {
  alias: string;
  path: string;
  /** Processes (launched from this source) that were running and got stopped. */
  processesStopped: number;
}

export interface RemoveSourceError {
  error: string;
}

/**
 * Removes a source from the workspace entirely, composing existing services in
 * idempotent order: (1) detach multi-root visibility (4 hosts), (2) prune the
 * WORKSPACE block (Fuentes + working/qa branches), (3) stop running processes
 * launched from the source, (4) delete `.workflow/launch/<alias>`.
 *
 * Does NOT delete the repo from the filesystem: it only removes it from the
 * workspace. Every step tolerates "already gone", so re-running never fails.
 * Leaving the workspace with 0 sources is allowed.
 */
export async function removeSource(
  deps: RemoveSourceDeps,
  alias: string,
): Promise<RemoveSourceResult | RemoveSourceError> {
  const { fs, env, proc, paths } = deps;

  if (!alias || alias.trim().length === 0) {
    return { error: "alias_required" };
  }

  // 1. Resolve alias → source from the WORKSPACE block. Fail fast when unknown.
  const fuente = await findFuente(fs, paths, alias);
  if (!fuente) {
    return { error: `unknown_source: ${alias}` };
  }

  // 2. Remove multi-root visibility (claude/codex/warp/oz). Idempotent per host.
  await runMultiroot(fs, env, paths, "detach", { paths: [fuente.path] });

  // 3. Prune the WORKSPACE block: Fuentes + working_branches + qa_branches for the alias.
  await runProjectMdUpsertWrite(fs, env, paths, { op: "init", removeAliases: [alias] });

  // 4. Stop running processes launched from this source.
  const registry = new ProcessRegistryService(fs, proc, paths.cwdProcessesFile());
  const running = (await registry.list()).filter(
    (r) => r.sourceAlias === alias && r.state === "running",
  );
  for (const record of running) {
    await proc.killTree(record.pid);
    await registry.markStopped(record.id);
  }

  // 5. Delete the generated launch scripts (.workflow/launch/<alias>).
  await fs.remove(join(paths.cwdLaunchDir(), alias));

  return { alias, path: fuente.path, processesStopped: running.length };
}

/** Read the WORKSPACE block (CLAUDE.md → AGENTS.md) and return the source for the alias. */
async function findFuente(
  fs: FileSystemPort,
  paths: PathsService,
  alias: string,
): Promise<ProjectFuente | null> {
  const cwd = paths.workspaceDir();
  for (const file of [join(cwd, "CLAUDE.md"), join(cwd, "AGENTS.md")]) {
    if (!(await fs.exists(file))) continue;
    const block = parseProjectBlock(await fs.readText(file), paths.blockMarkers());
    const fuente = block?.fuentes.find((f) => f.alias === alias);
    if (fuente) return fuente;
  }
  return null;
}
