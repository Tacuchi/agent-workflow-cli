import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { type ClaudeResult, attachClaude, detachClaude } from "./multiroot/claude.js";
import { type CodexResult, attachCodex, detachCodex } from "./multiroot/codex.js";
import {
  type OzAttachNoop,
  attachOz,
  detachOz,
} from "./multiroot/oz.js";
import {
  type WarpResult,
  attachWarp,
  detachWarp,
} from "./multiroot/warp.js";
import { parseProjectBlock } from "./parsers/project-block.js";
import type { PathsService } from "./paths-service.js";

export interface MultirootInput {
  paths?: string[];
  pathsCsv?: string;
  fromSources?: boolean;
  useGlobal?: boolean;
  workspace?: string;
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
  scope: "global" | "workspace";
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
  env: EnvPort,
  pathsService: PathsService,
  mode: Mode,
  input: MultirootInput,
): Promise<MultirootResult | MultirootError> {
  const { paths, scopeDir, scope } = await resolveScopeAndPaths(fs, env, pathsService, input);

  if (input.fromSources && paths.length === 0) {
    return {
      error: "no_sources_in_project_block",
      hint: "El bloque <NS>-PROJECT no declara fuentes; pasá --path explícito.",
    };
  }
  if (paths.length === 0) {
    return {
      error: "no_paths_provided",
      hint: "Usá --path <path> [--path <path2>...] o --from-sources.",
    };
  }

  const result: MultirootResult = {
    scope,
    scope_dir: scopeDir,
    paths_input: paths,
    claude: input.skipClaude
      ? { skipped: true }
      : mode === "attach"
        ? attachClaude(paths, scopeDir)
        : detachClaude(paths, scopeDir),
    codex: input.skipCodex
      ? { skipped: true }
      : mode === "attach"
        ? attachCodex(paths, scopeDir)
        : detachCodex(paths, scopeDir),
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
  return result;
}

async function resolveScopeAndPaths(
  fs: FileSystemPort,
  env: EnvPort,
  pathsService: PathsService,
  input: MultirootInput,
): Promise<{ paths: string[]; scopeDir: string; scope: "global" | "workspace" }> {
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
    paths = await readSourcesFromProject(fs, env, pathsService);
  }

  let scopeDir: string;
  let scope: "global" | "workspace";
  if (input.useGlobal) {
    scopeDir = homedir();
    scope = "global";
  } else if (input.workspace) {
    scopeDir = resolve(input.workspace);
    scope = "workspace";
  } else {
    scopeDir = resolve(env.cwd());
    scope = "workspace";
  }
  return { paths, scopeDir, scope };
}

async function readSourcesFromProject(
  fs: FileSystemPort,
  env: EnvPort,
  pathsService: PathsService,
): Promise<string[]> {
  const cwd = env.cwd();
  for (const file of [join(cwd, "CLAUDE.md"), join(cwd, "AGENTS.md")]) {
    if (!(await fs.exists(file))) continue;
    const block = parseProjectBlock(await fs.readText(file), pathsService.blockMarkers());
    if (block && block.fuentes.length > 0) {
      return block.fuentes.map((f) => f.path).filter((p) => p && p.length > 0);
    }
  }
  return [];
}
