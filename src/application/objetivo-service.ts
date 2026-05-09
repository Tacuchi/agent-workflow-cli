import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { ResolvedRuntime } from "../runtime/types.js";
import { type ParsedObjetivo, parseObjetivo } from "./parsers/objetivo.js";
import type { PathsService } from "./paths-service.js";
import { relpath } from "./paths.js";
import { findArtifact } from "./session-artifacts.js";
import { resolveSession } from "./session-resolver.js";

export interface ObjetivoCommandOutput extends ParsedObjetivo {
  session: string;
  path: string;
  code: string | null;
  flow: string | null;
}

export interface ObjetivoCommandError {
  error: string;
  code?: string | null;
  session?: string;
  hint?: string;
}

export type ObjetivoCommandResult = ObjetivoCommandOutput | ObjetivoCommandError;

export interface ObjetivoCommandInput {
  code?: string;
}

export async function runObjetivoCommand(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  input: ObjetivoCommandInput,
  runtime?: ResolvedRuntime,
): Promise<ObjetivoCommandResult> {
  const session = await resolveSession(fs, env, paths, input.code, true);
  if (!session) {
    return notFound(input.code);
  }
  const objetivoPath = await findArtifact(session.path, "objective", fs);
  if (!objetivoPath) {
    const migrateCmd =
      runtime?.slashCommands?.migrate ?? "(run namespace-specific migrate command)";
    return {
      error: "objetivo_not_found",
      session: session.folder,
      hint: `La sesión usa REQUIREMENTS.md (legacy) o no tiene OBJETIVO. Migrar con ${migrateCmd}.`,
    };
  }
  const text = await fs.readText(objetivoPath);
  const parsed = parseObjetivo(text);

  return {
    session: session.folder,
    path: relpath(objetivoPath, env.cwd()),
    code: session.code,
    flow: session.flow,
    ...parsed,
  };
}

function notFound(code: string | undefined): ObjetivoCommandError {
  return { error: "session_not_found", code: code ?? null };
}
