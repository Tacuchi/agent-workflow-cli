import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { runHubBlockUpsertWrite } from "./hub-block-upsert-service.js";
import { writeHubLocalConfig } from "./hub-local-config.js";
import {
  type WorklineMaterialization,
  ensureWorklineMaterialized,
} from "./hub-materialization-service.js";
import { runMultiroot } from "./multiroot-service.js";
import { type HubFuente, readHubBlock } from "./parsers/hub-block.js";
import type { PathsService } from "./paths-service.js";

export interface RemoveSourceDeps {
  fs: FileSystemPort;
  env: EnvPort;
  paths: PathsService;
}

export interface RemoveSourceResult {
  alias: string;
  path: string;
  /** Runtime receipt when this removal materialized an implicit Workline root. */
  materialization?: WorklineMaterialization;
}

export interface RemoveSourceError {
  error: string;
}

/**
 * Removes a source from the hub entirely, composing existing services in
 * idempotent order: detach multi-root visibility, then prune the hub
 * block (Fuentes + working/qa branches). Legacy launch files and processes
 * belong to the operator and remain untouched.
 *
 * Does NOT delete the repo from the filesystem: it only removes it from the
 * hub. Every step tolerates "already gone", so re-running never fails.
 * Leaving the hub with 0 sources is allowed.
 */
export async function removeSource(
  deps: RemoveSourceDeps,
  alias: string,
): Promise<RemoveSourceResult | RemoveSourceError> {
  const { fs, env, paths } = deps;

  if (!alias || alias.trim().length === 0) {
    return { error: "alias_required" };
  }

  // 1. Resolve alias → source from the hub block. Fail fast when unknown.
  const fuente = await findFuente(fs, paths, alias);
  if (!fuente) {
    return { error: `unknown_source: ${alias}` };
  }

  // `runMultiroot` writes host-owned files synchronously, outside the generic
  // FileSystemPort guard. Resolve the target first, then materialize before its
  // first possible mutation (and before the ensuing block rewrite), retaining
  // the receipt in this operation's result.
  const materialization = await ensureWorklineMaterialized(fs, paths);

  // 2. Remove multi-root visibility (claude/codex/warp/oz). Idempotent per host.
  if (fuente.path !== null) await runMultiroot(fs, env, paths, "detach", { paths: [fuente.path] });

  // 3. Prune the hub block: Fuentes + working_branches + qa_branches for the alias.
  const updated = await runHubBlockUpsertWrite(fs, env, paths, {
    op: "init",
    removeAliases: [alias],
  });
  if ("error" in updated || !updated.ok)
    return {
      error:
        "error" in updated
          ? updated.error
          : (updated.results?.find((file) => file.error)?.error ?? "el bloque no se publicó"),
    };
  await writeHubLocalConfig(fs, paths, { [alias]: null });

  return {
    alias,
    path: fuente.path ?? "(local)",
    ...(materialization.materialized ? { materialization } : {}),
  };
}

/** Read the hub block (CLAUDE.md → AGENTS.md) and return the source for the alias. */
async function findFuente(
  fs: FileSystemPort,
  paths: PathsService,
  alias: string,
): Promise<HubFuente | null> {
  const block = await readHubBlock(fs, paths.hubDir(), paths.blockMarkers(), (b) =>
    b.fuentes.some((f) => f.alias === alias),
  );
  return block?.fuentes.find((f) => f.alias === alias) ?? null;
}
