import { join } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { type ParsedHubBlock, readHubBlock } from "./parsers/hub-block.js";
import type { PathsService } from "./paths-service.js";
import { relpath } from "./paths.js";

export interface HubReadOutput {
  block: ParsedHubBlock | null;
  files: string[];
  cache_used?: boolean;
}

export async function runHubBlockRead(
  fs: FileSystemPort,
  _env: EnvPort,
  paths: PathsService,
  options: { verbose?: boolean } = {},
): Promise<HubReadOutput> {
  const cwd = paths.hubDir();
  const files = [join(cwd, "CLAUDE.md"), join(cwd, "AGENTS.md")];
  const block: ParsedHubBlock | null = await readHubBlock(fs, cwd, paths.blockMarkers());
  const payload: HubReadOutput = {
    block,
    files: files.map((f) => relpath(f, cwd)),
  };
  if (options.verbose === true) {
    payload.cache_used = false;
  }
  return payload;
}
