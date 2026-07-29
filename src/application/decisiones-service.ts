import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { type ParsedDecision, parseDecisiones } from "./parsers/decisiones.js";
import type { PathsService } from "./paths-service.js";
import { relpath } from "./paths.js";
import { canonicalArtifactPath, findArtifact } from "./session-artifacts.js";
import {
  type SessionResolutionError,
  resolveSessionTarget,
  sessionReadRequest,
} from "./session-resolver.js";

export interface DecisionesCommandInput {
  code?: string;
  full?: boolean;
  /** Opaque conversation id; resolution falls back to its durable association. */
  contextId?: string;
}

export interface DecisionesCommandOutput {
  session: string;
  path: string;
  exists: boolean;
  count: number;
  items: ParsedDecision[];
}

export type DecisionesCommandResult =
  | DecisionesCommandOutput
  | { sessionError: SessionResolutionError };

export async function runDecisionesCommand(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  input: DecisionesCommandInput,
): Promise<DecisionesCommandResult> {
  const resolution = await resolveSessionTarget(fs, paths, sessionReadRequest(input));
  if (resolution.outcome !== "resolved") return { sessionError: resolution };
  const session = resolution.session;
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
