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
 * Quita una fuente del workspace por completo, componiendo servicios existentes
 * en orden idempotente: (1) detach de la visibilidad multi-root (4 hosts), (2)
 * poda del bloque WORKSPACE (Fuentes + working/qa branches), (3) detener los
 * procesos corriendo lanzados desde la fuente, (4) borrar `.workflow/launch/<alias>`.
 *
 * NO borra el repo del filesystem: solo lo saca del workspace. Cada paso tolera
 * "ya no está", así que re-correrlo no falla. Permite dejar el workspace en 0
 * fuentes.
 */
export async function removeSource(
  deps: RemoveSourceDeps,
  alias: string,
): Promise<RemoveSourceResult | RemoveSourceError> {
  const { fs, env, proc, paths } = deps;

  if (!alias || alias.trim().length === 0) {
    return { error: "alias_required" };
  }

  // 1. Resolver alias → fuente desde el bloque WORKSPACE. Fail-fast si no existe.
  const fuente = await findFuente(fs, paths, alias);
  if (!fuente) {
    return { error: `unknown_source: ${alias}` };
  }

  // 2. Quitar visibilidad multi-root (claude/codex/warp/oz). Idempotente por host.
  await runMultiroot(fs, env, paths, "detach", { paths: [fuente.path] });

  // 3. Podar el bloque WORKSPACE: Fuentes + working_branches + qa_branches del alias.
  await runProjectMdUpsertWrite(fs, env, paths, { op: "init", removeAliases: [alias] });

  // 4. Detener los procesos corriendo lanzados desde esta fuente.
  const registry = new ProcessRegistryService(fs, proc, paths.cwdProcessesFile());
  const running = (await registry.list()).filter(
    (r) => r.sourceAlias === alias && r.state === "running",
  );
  for (const record of running) {
    await proc.killTree(record.pid);
    await registry.markStopped(record.id);
  }

  // 5. Borrar los scripts de arranque generados (.workflow/launch/<alias>).
  await fs.remove(join(paths.cwdLaunchDir(), alias));

  return { alias, path: fuente.path, processesStopped: running.length };
}

/** Lee el bloque WORKSPACE (CLAUDE.md → AGENTS.md) y devuelve la fuente del alias. */
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
