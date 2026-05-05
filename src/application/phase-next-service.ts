import { join } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { parseProjectBlock } from "./parsers/project-block.js";
import type { PathsService } from "./paths-service.js";
import { normalizePhase } from "./phase-detect-service.js";
import { runProjectMdUpsertWrite } from "./project-md-upsert-service.js";
import { resolveSession } from "./session-resolver.js";

const PHASE_ORDER = ["planning", "execution", "validation", "closure"] as const;

export interface PhaseNextOutput {
  code: string;
  folder: string;
  previous_phase?: string | null;
  new_phase?: string;
  updated: boolean;
  reason?: string;
}

export interface PhaseNextFullOutput {
  projectMd: import("./project-md-upsert-service.js").ProjectMdUpsertOutput | null;
  phaseNext: PhaseNextOutput;
}

export interface PhaseNextError {
  error: string;
}

export async function runPhaseNext(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  code: string | undefined,
): Promise<PhaseNextFullOutput | PhaseNextError> {
  if (!code) return { error: "--code es obligatorio" };
  const session = await resolveSession(fs, env, paths, code, true);
  if (!session) return { error: `Sesión no encontrada: ${code}` };

  const cwd = env.cwd();
  const current = await readPhaseFromBlock(fs, cwd, paths, session.folder);
  if (current === null) {
    return {
      projectMd: null,
      phaseNext: {
        code: session.code ?? code,
        folder: session.folder,
        updated: false,
        reason: "session_not_in_qtc_project",
      },
    };
  }

  const currentNorm = normalizePhase(current);
  if (currentNorm === null) {
    return {
      projectMd: null,
      phaseNext: {
        code: session.code ?? code,
        folder: session.folder,
        updated: false,
        reason: `unknown_current_phase:${current}`,
      },
    };
  }

  const idx = PHASE_ORDER.indexOf(currentNorm as (typeof PHASE_ORDER)[number]);
  if (idx === PHASE_ORDER.length - 1) {
    return {
      projectMd: null,
      phaseNext: {
        code: session.code ?? code,
        folder: session.folder,
        previous_phase: current,
        new_phase: currentNorm,
        updated: false,
        reason: "already_in_closure",
      },
    };
  }

  const newPhase = PHASE_ORDER[idx + 1];
  if (newPhase === undefined) {
    return {
      projectMd: null,
      phaseNext: {
        code: session.code ?? code,
        folder: session.folder,
        updated: false,
        reason: "no_next_phase",
      },
    };
  }

  const projectMd = await runProjectMdUpsertWrite(fs, env, paths, {
    op: "update-phase",
    sessionFolder: session.folder,
    phase: newPhase,
  });
  if ("error" in projectMd) {
    return { error: projectMd.error };
  }

  return {
    projectMd,
    phaseNext: {
      code: session.code ?? code,
      folder: session.folder,
      previous_phase: current,
      new_phase: newPhase,
      updated: true,
    },
  };
}

async function readPhaseFromBlock(
  fs: FileSystemPort,
  cwd: string,
  paths: PathsService,
  folder: string,
): Promise<string | null> {
  for (const file of [join(cwd, "CLAUDE.md"), join(cwd, "AGENTS.md")]) {
    if (!(await fs.exists(file))) continue;
    const block = parseProjectBlock(await fs.readText(file), paths.blockMarkers());
    if (!block) continue;
    for (const s of block.sessions) {
      if (s.folder === folder) return s.phase;
    }
  }
  return null;
}
