import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { type ParsedDecision, parseDecisiones } from "./parsers/decisiones.js";
import type { PathsService } from "./paths-service.js";
import { relpath } from "./paths.js";
import { canonicalArtifactPath, findArtifact } from "./session-artifacts.js";
import { resolveSession } from "./session-resolver.js";

export interface DecisionesCommandInput {
  code?: string;
  full?: boolean;
}

export interface DecisionesCommandOutput {
  session: string;
  path: string;
  exists: boolean;
  count: number;
  items: ParsedDecision[];
}

export interface DecisionesCommandError {
  error: string;
  code: string | null;
}

export type DecisionesCommandResult = DecisionesCommandOutput | DecisionesCommandError;

export async function runDecisionesCommand(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  input: DecisionesCommandInput,
): Promise<DecisionesCommandResult> {
  const session = await resolveSession(fs, env, paths, input.code, true);
  if (!session) {
    return { error: "session_not_found", code: input.code ?? null };
  }
  const decPath = await findArtifact(session.path, "decisions", fs);
  if (!decPath) {
    return {
      session: session.folder,
      path: relpath(canonicalArtifactPath(session.path, "decisions"), env.cwd()),
      exists: false,
      count: 0,
      items: [],
    };
  }
  const pathPosix = relpath(decPath, env.cwd());
  const text = await fs.readText(decPath);
  const items = parseDecisiones(text, input.full === true);
  return {
    session: session.folder,
    path: pathPosix,
    exists: true,
    count: items.length,
    items,
  };
}
