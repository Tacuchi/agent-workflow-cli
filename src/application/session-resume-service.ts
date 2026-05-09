import { join } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { parseProjectBlock } from "./parsers/project-block.js";
import type { PathsService } from "./paths-service.js";
import { relpath } from "./paths.js";
import { findArtifact } from "./session-artifacts.js";
import { resolveSession } from "./session-resolver.js";

export interface SessionResumeInput {
  code?: string;
}

export interface SessionResumeOutput {
  code: string | null;
  folder: string;
  path: string;
  flow: string | null;
  state_from_qtc_project: string;
  phase_from_qtc_project: string;
  branches_from_qtc_project: string[];
  objetivo: string | null;
  objetivo_text: string | null;
}

export interface SessionResumeError {
  error: string;
  code: string | null;
}

export async function runSessionResume(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  input: SessionResumeInput,
): Promise<SessionResumeOutput | SessionResumeError> {
  const session = await resolveSession(fs, env, paths, input.code, true);
  if (!session) {
    return { error: "session_not_found", code: input.code ?? null };
  }
  const cwd = env.cwd();
  const objetivoPath = await findArtifact(session.path, "objective", fs);
  const objetivoText = objetivoPath ? await fs.readText(objetivoPath) : null;

  const fromBlock = await phaseFromProjectBlock(fs, cwd, paths, session.folder);
  const phase = fromBlock.phase ?? "requerimiento";
  const state = fromBlock.phase ? "active" : "closed_or_missing";

  return {
    code: session.code,
    folder: session.folder,
    path: relpath(session.path, cwd),
    flow: session.flow,
    state_from_qtc_project: state,
    phase_from_qtc_project: phase,
    branches_from_qtc_project: fromBlock.branches,
    objetivo: objetivoText,
    objetivo_text: objetivoText,
  };
}

async function phaseFromProjectBlock(
  fs: FileSystemPort,
  cwd: string,
  paths: PathsService,
  folder: string,
): Promise<{ phase: string | null; branches: string[] }> {
  for (const file of [join(cwd, "CLAUDE.md"), join(cwd, "AGENTS.md")]) {
    if (!(await fs.exists(file))) continue;
    const text = await fs.readText(file);
    const block = parseProjectBlock(text, paths.blockMarkers());
    if (!block) continue;
    for (const s of block.sessions) {
      if (s.folder === folder) {
        return { phase: s.phase, branches: s.branches };
      }
    }
  }
  return { phase: null, branches: [] };
}
