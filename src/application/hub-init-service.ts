import { resolve } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { type MultirootError, type MultirootResult, runMultiroot } from "./multiroot-service.js";
import type { PathsService } from "./paths-service.js";
import {
  type ProjectMdUpsertError,
  type ProjectMdUpsertOutput,
  runProjectMdUpsertWrite,
} from "./project-md-upsert-service.js";

export interface HubInitFuente {
  alias: string;
  path: string;
}

export interface HubInitInput {
  proyecto: string;
  fuentes: HubInitFuente[];
  workingBranches: Record<string, string>;
  mainBranch?: string;
  workspace?: string;
  /** Opt-in: además del bloque, configura la visibilidad multi-root (attach a hosts). Default = solo scaffold. */
  attach?: boolean;
  dryRun?: boolean;
}

export interface HubInitProjectMdPreview {
  dry_run_preview: { fuentes: number; mode: "hub" };
}

export interface HubInitAttachSkipped {
  skipped: true;
  reason: string;
}

export interface HubInitAttachPreview {
  dry_run_preview: { paths: string[]; workspace: string };
}

export interface HubInitResult {
  ok: boolean;
  dry_run: boolean;
  workspace: string;
  project_md: ProjectMdUpsertOutput | ProjectMdUpsertError | HubInitProjectMdPreview;
  attach_multiroot: MultirootResult | MultirootError | HubInitAttachSkipped | HubInitAttachPreview;
}

export interface HubInitInputError {
  error: string;
  hint?: string;
}

export async function runHubInit(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  input: HubInitInput,
): Promise<HubInitResult | HubInitInputError> {
  const validation = validateInput(input);
  if (validation) return validation;

  const workspace = input.workspace ? resolve(input.workspace) : resolve(env.cwd());

  if (input.dryRun) {
    return {
      ok: true,
      dry_run: true,
      workspace,
      project_md: { dry_run_preview: { fuentes: input.fuentes.length, mode: "hub" } },
      attach_multiroot: input.attach
        ? {
            dry_run_preview: { paths: input.fuentes.map((f) => f.path), workspace },
          }
        : { skipped: true, reason: "attach is opt-in" },
    };
  }

  const targetEnv = workspace !== resolve(env.cwd()) ? overrideCwd(env, workspace) : env;
  const projectMd = await runProjectMdUpsertWrite(fs, targetEnv, paths, {
    op: "init",
    mode: "hub",
    proyecto: input.proyecto,
    fuentes: input.fuentes.map((f) => ({ alias: f.alias, path: f.path })),
    workingBranches: input.workingBranches,
    ...(input.mainBranch !== undefined ? { mainBranch: input.mainBranch } : {}),
    verbose: true,
  });

  if ("error" in projectMd) {
    return {
      ok: false,
      dry_run: false,
      workspace,
      project_md: projectMd,
      attach_multiroot: { skipped: true, reason: "project_md_failed" },
    };
  }

  if (!input.attach) {
    return {
      ok: projectMd.ok,
      dry_run: false,
      workspace,
      project_md: projectMd,
      attach_multiroot: { skipped: true, reason: "attach is opt-in" },
    };
  }

  const attach = await runMultiroot(fs, targetEnv, paths, "attach", {
    fromSources: true,
    workspace,
  });

  const attachOk = !("error" in attach);
  return {
    ok: projectMd.ok && attachOk,
    dry_run: false,
    workspace,
    project_md: projectMd,
    attach_multiroot: attach,
  };
}

function overrideCwd(env: EnvPort, cwd: string): EnvPort {
  return {
    get: (k) => env.get(k),
    homeDir: () => env.homeDir(),
    cwd: () => cwd,
  };
}

function validateInput(input: HubInitInput): HubInitInputError | null {
  if (!input.proyecto || input.proyecto.trim().length === 0) {
    return { error: "missing_proyecto", hint: "--proyecto es obligatorio" };
  }
  if (!input.fuentes || input.fuentes.length < 2) {
    return {
      error: "insufficient_fuentes",
      hint: "hub-init requiere mínimo 2 fuentes (--fuente alias:path repetible)",
    };
  }
  const aliases = new Set<string>();
  for (const f of input.fuentes) {
    if (!f.alias || !f.path) {
      return { error: "invalid_fuente", hint: `fuente sin alias o path: ${JSON.stringify(f)}` };
    }
    if (aliases.has(f.alias)) {
      return { error: "duplicate_alias", hint: `alias duplicado: ${f.alias}` };
    }
    aliases.add(f.alias);
  }
  return null;
}
