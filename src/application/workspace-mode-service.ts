import { join } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { type ProjectFuente, parseProjectBlock } from "./parsers/project-block.js";
import { relpath } from "./paths.js";

export interface WorkspaceModeOutput {
  mode: "project" | "hub";
  sources: ProjectFuente[];
  working_branches: Record<string, string>;
  source_file: string | null;
  reason?: string;
  sources_count?: number;
  is_hub?: boolean;
}

export async function runWorkspaceMode(
  fs: FileSystemPort,
  env: EnvPort,
  options: { verbose?: boolean } = {},
): Promise<WorkspaceModeOutput> {
  const cwd = env.cwd();
  const candidates = [join(cwd, "CLAUDE.md"), join(cwd, "AGENTS.md")];
  for (const file of candidates) {
    if (!(await fs.exists(file))) continue;
    const block = parseProjectBlock(await fs.readText(file));
    if (!block) continue;
    const out: WorkspaceModeOutput = {
      mode: block.mode,
      sources: block.fuentes,
      working_branches: block.working_branches,
      source_file: relpath(file, cwd),
    };
    if (options.verbose === true) {
      out.sources_count = block.fuentes.length;
      out.is_hub = block.mode === "hub";
    }
    return out;
  }
  const empty: WorkspaceModeOutput = {
    mode: "project",
    sources: [],
    working_branches: {},
    source_file: null,
    reason: "no_qtc_project_block_found",
  };
  if (options.verbose === true) {
    empty.sources_count = 0;
    empty.is_hub = false;
    empty.source_file = null;
  }
  return empty;
}
