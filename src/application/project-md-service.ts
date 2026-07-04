import { join } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { type ParsedProjectBlock, readWorkspaceBlock } from "./parsers/project-block.js";
import type { PathsService } from "./paths-service.js";
import { relpath } from "./paths.js";

export interface ProjectReadOutput {
  block: ParsedProjectBlock | null;
  files: string[];
  cache_used?: boolean;
}

export async function runProjectMdRead(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  options: { verbose?: boolean } = {},
): Promise<ProjectReadOutput> {
  const cwd = env.cwd();
  const files = [join(cwd, "CLAUDE.md"), join(cwd, "AGENTS.md")];
  const block: ParsedProjectBlock | null = await readWorkspaceBlock(fs, cwd, paths.blockMarkers());
  const payload: ProjectReadOutput = {
    block,
    files: files.map((f) => relpath(f, cwd)),
  };
  if (options.verbose === true) {
    payload.cache_used = false;
  }
  return payload;
}
