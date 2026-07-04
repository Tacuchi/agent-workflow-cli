import { resolve } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { readWorkspaceBlock } from "./parsers/project-block.js";
import { PathsService } from "./paths-service.js";
import {
  type SourceArtifactResult,
  generateSourceLaunchArtifacts,
} from "./source-launch-scripts-service.js";

export interface GenerateLaunchInput {
  /** Restrict to these source aliases; empty/undefined = every declared source. */
  aliases?: string[];
  /** Overwrite hand-edited scripts too (default preserves them). */
  force?: boolean;
  /** Preview only — classify each file, write nothing. */
  dryRun?: boolean;
  /** Override the target workspace dir (defaults to cwd). */
  workspace?: string;
}

export interface GenerateLaunchInputError {
  error: string;
  hint?: string;
}

export interface GenerateLaunchResult {
  ok: boolean;
  dry_run: boolean;
  workspace: string;
  /** Per-source artifact outcomes (one entry per source actually processed). */
  sources: SourceArtifactResult[];
  /** Requested `--source` aliases not declared in the WORKSPACE block. */
  unknown_aliases?: string[];
  /** Declared sources whose path does not exist on disk (skipped). */
  missing_sources?: string[];
}

/**
 * (Re)generate the per-source launch artifacts (`.workflow/launch/<alias>/`:
 * `launch.json` + `run.sh` + `run.ps1`) by detecting each source's stack.
 * Sources come from the WORKSPACE block; the underlying generation is
 * idempotent (pristine files regenerate, hand-edited ones are preserved unless
 * `force`). This is the explicit counterpart to the launch flow's on-demand
 * generation at the first launch — used to refresh after adding a start script,
 * changing `.env` profiles, or when a source was not launchable at init time.
 */
export async function runGenerateLaunch(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  input: GenerateLaunchInput = {},
): Promise<GenerateLaunchResult | GenerateLaunchInputError> {
  const workspace = input.workspace ? resolve(input.workspace) : resolve(env.cwd());
  const wsPaths = new PathsService(paths.namespace, env.homeDir(), workspace);

  const block = await readWorkspaceBlock(fs, workspace, wsPaths.blockMarkers());
  const declared = (block?.fuentes ?? []).filter((f) => f.path.length > 0);
  if (declared.length === 0) {
    return {
      error: "no_sources_declared",
      hint: "no sources in the WORKSPACE block — run workspace-init first (or cd into the workspace root)",
    };
  }

  // Optional alias filter: keep declared order, report unknown aliases.
  let selected = declared;
  let unknown: string[] = [];
  if (input.aliases && input.aliases.length > 0) {
    const declaredAliases = new Set(declared.map((f) => f.alias));
    unknown = input.aliases.filter((a) => !declaredAliases.has(a));
    const wanted = new Set(input.aliases);
    selected = declared.filter((f) => wanted.has(f.alias));
    if (selected.length === 0) {
      return {
        error: "no_matching_sources",
        hint: `no declared source matches --source; unknown: ${unknown.join(", ")}`,
      };
    }
  }

  const dryRun = input.dryRun ?? false;
  const force = input.force ?? false;
  const launchDir = wsPaths.cwdLaunchDir();
  const sources: SourceArtifactResult[] = [];
  const missing: string[] = [];
  for (const fuente of selected) {
    const sourcePath = resolve(workspace, fuente.path);
    if (!(await fs.exists(sourcePath))) {
      missing.push(fuente.alias);
      continue;
    }
    sources.push(
      await generateSourceLaunchArtifacts(fs, launchDir, sourcePath, fuente.alias, {
        force,
        dryRun,
      }),
    );
  }

  return {
    ok: true,
    dry_run: dryRun,
    workspace,
    sources,
    ...(unknown.length > 0 ? { unknown_aliases: unknown } : {}),
    ...(missing.length > 0 ? { missing_sources: missing } : {}),
  };
}
