import { join, resolve } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { type MultirootError, type MultirootResult, runMultiroot } from "./multiroot-service.js";
import { normalizePath } from "./multiroot/paths.js";
import { parseProjectBlock } from "./parsers/project-block.js";
import type { PathsService } from "./paths-service.js";
import {
  type ProjectMdUpsertError,
  type ProjectMdUpsertOutput,
  runProjectMdUpsertWrite,
} from "./project-md-upsert-service.js";

/** Archivos de visibilidad multi-root: rutas absolutas machine-specific → gitignored. */
const VISIBILITY_GITIGNORE = [".claude/settings.local.json", ".codex/config.toml"];

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
  /** Reconcile: detach de las fuentes que estaban en el bloque previo y ya no. */
  detached_removed?: MultirootResult | MultirootError;
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
      attach_multiroot: { dry_run_preview: { paths: input.fuentes.map((f) => f.path), workspace } },
    };
  }

  const targetEnv = workspace !== resolve(env.cwd()) ? overrideCwd(env, workspace) : env;

  // Reconcile: capturar las fuentes del bloque PREVIO antes de sobrescribirlo,
  // para detachear las que el usuario removió en este run.
  const previousPaths = await readBlockSourcePaths(fs, workspace, paths);

  const projectMd = await runProjectMdUpsertWrite(fs, targetEnv, paths, {
    op: "init",
    mode: "hub",
    proyecto: input.proyecto,
    fuentes: input.fuentes.map((f) => ({ alias: f.alias, path: f.path })),
    // El set de fuentes declarado es autoritativo (soporta remover: re-correr con el set nuevo).
    replaceFuentes: true,
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

  // Visibilidad SIEMPRE (no opt-in, no prompt). Reconcile: detach de removidas + attach de actuales.
  const currentNorm = new Set(input.fuentes.map((f) => normalizePath(f.path)));
  const removed = previousPaths.filter((p) => !currentNorm.has(normalizePath(p)));
  const detached =
    removed.length > 0
      ? await runMultiroot(fs, targetEnv, paths, "detach", { paths: removed, workspace })
      : undefined;

  const attach = await runMultiroot(fs, targetEnv, paths, "attach", {
    fromSources: true,
    workspace,
  });

  await ensureVisibilityGitignore(fs, workspace);

  const attachOk = !("error" in attach);
  return {
    ok: projectMd.ok && attachOk,
    dry_run: false,
    workspace,
    project_md: projectMd,
    attach_multiroot: attach,
    ...(detached !== undefined ? { detached_removed: detached } : {}),
  };
}

function overrideCwd(env: EnvPort, cwd: string): EnvPort {
  return {
    get: (k) => env.get(k),
    homeDir: () => env.homeDir(),
    cwd: () => cwd,
  };
}

/** Paths de las fuentes declaradas en el bloque AW-PROJECT actual (antes de reescribir). */
async function readBlockSourcePaths(
  fs: FileSystemPort,
  workspace: string,
  paths: PathsService,
): Promise<string[]> {
  const markers = paths.blockMarkers();
  for (const fname of ["CLAUDE.md", "AGENTS.md"]) {
    const file = join(workspace, fname);
    if (!(await fs.exists(file))) continue;
    const block = parseProjectBlock(await fs.readText(file), markers);
    if (block && block.fuentes.length > 0) {
      return block.fuentes.map((f) => f.path).filter((p) => p.length > 0);
    }
  }
  return [];
}

/** Asegura que el `.gitignore` del hub ignore los archivos de visibilidad (idempotente). */
async function ensureVisibilityGitignore(fs: FileSystemPort, workspace: string): Promise<void> {
  const file = join(workspace, ".gitignore");
  const existing = (await fs.exists(file)) ? await fs.readText(file) : "";
  const present = new Set(
    existing
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0),
  );
  const missing = VISIBILITY_GITIGNORE.filter((e) => !present.has(e));
  if (missing.length === 0) return;
  const block = `# Visibilidad multi-root (rutas machine-specific — no commitear)\n${missing.join("\n")}\n`;
  const body = existing.replace(/\s+$/, "");
  await fs.writeText(file, body.length === 0 ? block : `${body}\n\n${block}`);
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
