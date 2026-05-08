import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import {
  type GraduateContext,
  type GraduateResult,
  graduateConclusion,
  graduateDecision,
  graduateEspecificacion,
  graduateManual,
  graduateScript,
} from "./graduate/handlers.js";
import { PathsService, resolveWorkspaceRoot } from "./paths-service.js";
import { resolveSession } from "./session-resolver.js";

export type {
  GraduateConclusionOutput,
  GraduateDecisionOutput,
  GraduateEspecificacionOutput,
  GraduateError,
  GraduateManualOutput,
  GraduateOutput,
  GraduateResult,
  GraduateScriptOutput,
} from "./graduate/handlers.js";

const ALLOWED_KINDS = [
  "decision",
  "manual",
  "script",
  "especificacion",
  "conclusion",
  "release",
] as const;
export type GraduateKind = (typeof ALLOWED_KINDS)[number];

export interface GraduateInput {
  kind?: string;
  session?: string;
  decId?: string;
  slug?: string;
  source?: string;
}

interface ValidatedInput {
  kind: GraduateKind;
  slug: string;
  decId?: string;
}

export async function runGraduate(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  input: GraduateInput,
): Promise<GraduateResult> {
  const validation = validateInput(input);
  if ("error" in validation) return validation;

  const workspaceRoot = await resolveWorkspaceRoot(fs, env, paths);
  const wsPaths =
    workspaceRoot === env.cwd()
      ? paths
      : new PathsService(paths.namespace, env.homeDir(), workspaceRoot);

  const session = await resolveSession(fs, env, wsPaths, input.session, true);
  if (!session) return { error: `Sesión no encontrada: ${input.session}` };
  const ctx: GraduateContext = {
    fs,
    workspaceRoot,
    sessionPath: session.path,
    folder: session.folder,
    slug: validation.slug,
  };

  switch (validation.kind) {
    case "decision":
      return graduateDecision(ctx, validation.decId);
    case "manual":
      return graduateManual(ctx, input.source);
    case "script":
      return graduateScript(ctx);
    case "especificacion":
      return graduateEspecificacion(ctx, input.source);
    case "conclusion":
      return graduateConclusion(ctx);
    case "release":
      return {
        error:
          "El kind 'release' no se gradúa con `graduate`; usá el comando `release` (consolida sesiones en un paquete de paso a producción).",
      };
  }
}

function validateInput(input: GraduateInput): ValidatedInput | { error: string } {
  if (input.kind === undefined || !isAllowedKind(input.kind)) {
    return {
      error: `--kind debe ser uno de: ${ALLOWED_KINDS.join(", ")}`,
    };
  }
  if (!input.session || !input.slug) {
    return { error: "--session y --slug son obligatorios" };
  }
  if (input.kind === "decision" && !input.decId) {
    return { error: "--id (DEC-NNN) obligatorio para --kind decision" };
  }
  if (input.kind === "release") {
    return {
      error:
        "El kind 'release' no se gradúa con `graduate`; usá el comando `release` (consolida sesiones en un paquete de paso a producción).",
    };
  }
  const validated: ValidatedInput = {
    kind: input.kind,
    slug: input.slug,
  };
  if (input.decId !== undefined) validated.decId = input.decId;
  return validated;
}

function isAllowedKind(value: string): value is GraduateKind {
  return (ALLOWED_KINDS as ReadonlyArray<string>).includes(value);
}
