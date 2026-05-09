import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { parseDependencias } from "./parsers/dependencias.js";
import type { PathsService } from "./paths-service.js";
import { relpath } from "./paths.js";
import { canonicalArtifactPath, findArtifact } from "./session-artifacts.js";
import { resolveSession } from "./session-resolver.js";

export interface DependenciasCommandInput {
  code?: string;
}

export interface DependenciasCommandOutput {
  session: string;
  path: string;
  exists: boolean;
  headers: string[];
  rows: Record<string, string>[];
  count: number;
}

export interface DependenciasCommandError {
  error: string;
  code: string | null;
}

export type DependenciasCommandResult = DependenciasCommandOutput | DependenciasCommandError;

export async function runDependenciasCommand(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  input: DependenciasCommandInput,
): Promise<DependenciasCommandResult> {
  const session = await resolveSession(fs, env, paths, input.code, true);
  if (!session) {
    return { error: "session_not_found", code: input.code ?? null };
  }
  const depPath = await findArtifact(session.path, "dependencies", fs);
  if (!depPath) {
    return {
      session: session.folder,
      path: relpath(canonicalArtifactPath(session.path, "dependencies"), env.cwd()),
      exists: false,
      headers: [],
      rows: [],
      count: 0,
    };
  }
  const pathPosix = relpath(depPath, env.cwd());
  const text = await fs.readText(depPath);
  const parsed = parseDependencias(text);
  return {
    session: session.folder,
    path: pathPosix,
    exists: true,
    ...parsed,
  };
}
