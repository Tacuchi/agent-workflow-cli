import { homedir } from "node:os";
import { resolve } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { type ClaudeResult, attachClaude, detachClaude } from "./multiroot/claude.js";
import { type CodexResult, attachCodex, detachCodex } from "./multiroot/codex.js";
import { type OzAttachNoop, attachOz, detachOz } from "./multiroot/oz.js";
import { type WarpResult, attachWarp, detachWarp } from "./multiroot/warp.js";
import { readHubBlock, requireSourcePath } from "./parsers/hub-block.js";
import type { PathsService } from "./paths-service.js";

export interface MultirootInput {
  paths?: string[];
  pathsCsv?: string;
  fromSources?: boolean;
  useGlobal?: boolean;
  hub?: string;
  /** Compute host-config changes without creating directories, backups or files. */
  dryRun?: boolean;
  skipClaude?: boolean;
  skipCodex?: boolean;
  skipWarp?: boolean;
  skipOz?: boolean;
}

export interface MultirootError {
  error: string;
  hint?: string;
}

export interface MultirootResult {
  scope: "global" | "hub";
  scope_dir: string;
  paths_input: string[];
  claude: ClaudeResult | { skipped: true };
  codex: CodexResult | { skipped: true };
  warp: WarpResult | { skipped: true };
  oz: OzAttachNoop | { skipped: true };
}

type Mode = "attach" | "detach";

export async function runMultiroot(
  fs: FileSystemPort,
  _env: EnvPort,
  pathsService: PathsService,
  mode: Mode,
  input: MultirootInput,
): Promise<MultirootResult | MultirootError> {
  let resolved: Awaited<ReturnType<typeof resolveScopeAndPaths>>;
  try {
    resolved = await resolveScopeAndPaths(fs, pathsService, input);
  } catch (err) {
    return { error: "SOURCE_PATH_MISSING", hint: (err as Error).message };
  }
  const { paths, scopeDir, scope } = resolved;

  if (input.fromSources && paths.length === 0) {
    return {
      error: "no_sources_in_hub_block",
      hint: "El bloque del hub no declara fuentes; pasá --path explícito.",
    };
  }
  if (paths.length === 0) {
    return {
      error: "no_paths_provided",
      hint: "Usá --path <path> [--path <path2>...] o --from-sources.",
    };
  }

  let result: MultirootResult;
  try {
    result = updateHosts(paths, scopeDir, scope, mode, input);
  } catch (err) {
    const target = String(
      (err as { target?: string; path?: string }).target ?? (err as { path?: string }).path ?? "",
    );
    const host = target.includes(".codex")
      ? "codex"
      : target.includes(".claude")
        ? "claude"
        : "host";
    return { error: `${host}: host_write_failed`, hint: (err as Error).message };
  }
  if ("error" in result.claude)
    return {
      error: `claude: ${result.claude.error}`,
      ...(result.claude.detail ? { hint: result.claude.detail } : {}),
    };
  return result;
}

/** Whether a real attach/detach would change a host configuration. */
export function multirootWouldMutate(result: MultirootResult): boolean {
  return [result.claude, result.codex].some((host) => {
    if (typeof host !== "object" || host === null) return false;
    const candidate = host as { written?: unknown; would_write?: unknown };
    return candidate.written === true || candidate.would_write === true;
  });
}

async function resolveScopeAndPaths(
  fs: FileSystemPort,
  pathsService: PathsService,
  input: MultirootInput,
): Promise<{ paths: string[]; scopeDir: string; scope: "global" | "hub" }> {
  let paths: string[] = [];
  if (input.paths) paths.push(...input.paths);
  if (input.pathsCsv) {
    paths.push(
      ...input.pathsCsv
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p.length > 0),
    );
  }
  if (input.fromSources) {
    paths = await readSourcesFromHub(fs, pathsService);
  }

  let scopeDir: string;
  let scope: "global" | "hub";
  if (input.useGlobal) {
    scopeDir = homedir();
    scope = "global";
  } else if (input.hub) {
    scopeDir = resolve(input.hub);
    scope = "hub";
  } else {
    scopeDir = pathsService.hubDir();
    scope = "hub";
  }
  return { paths, scopeDir, scope };
}

async function readSourcesFromHub(
  fs: FileSystemPort,
  pathsService: PathsService,
): Promise<string[]> {
  const block = await readHubBlock(
    fs,
    pathsService.hubDir(),
    pathsService.blockMarkers(),
    (b) => b.fuentes.length > 0,
  );
  return block ? Promise.all(block.fuentes.map((f) => requireSourcePath(fs, f))) : [];
}

function updateHosts(
  paths: string[],
  scopeDir: string,
  scope: MultirootResult["scope"],
  mode: Mode,
  input: MultirootInput,
): MultirootResult {
  return {
    scope,
    scope_dir: scopeDir,
    paths_input: paths,
    claude: input.skipClaude
      ? { skipped: true }
      : mode === "attach"
        ? attachClaude(paths, scopeDir, { dryRun: input.dryRun === true })
        : detachClaude(paths, scopeDir, { dryRun: input.dryRun === true }),
    codex: input.skipCodex
      ? { skipped: true }
      : mode === "attach"
        ? attachCodex(paths, scopeDir, { dryRun: input.dryRun === true })
        : detachCodex(paths, scopeDir, { dryRun: input.dryRun === true }),
    warp: input.skipWarp
      ? { skipped: true }
      : mode === "attach"
        ? attachWarp(paths, scopeDir)
        : detachWarp(paths, scopeDir),
    oz: input.skipOz
      ? { skipped: true }
      : mode === "attach"
        ? attachOz(paths, scopeDir)
        : detachOz(paths, scopeDir),
  };
}
