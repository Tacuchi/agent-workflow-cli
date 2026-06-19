import { join } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { LockBusyError, acquireLock } from "./lock-service.js";
import {
  type ParsedProjectBlock,
  type ProjectBlockMarkers,
  type ProjectFuente,
  type ProjectMode,
  parseProjectBlock,
} from "./parsers/project-block.js";
import type { PathsService } from "./paths-service.js";
import { relpath } from "./paths.js";
import { type RenderProjectBlockInput, renderProjectBlock } from "./render/project-block.js";
import { detectStackDict } from "./stack-detect.js";

export type UpsertOp = "init";

export interface ProjectMdUpsertFuente {
  alias: string;
  path: string;
  /** Falls back to `ProjectMdUpsertInput.mainBranch` then to `"certificacion"` at render. */
  mainBranch?: string;
}

export interface ProjectMdUpsertInput {
  op: UpsertOp;
  proyecto?: string;
  mode?: ProjectMode;
  workingBranches?: Record<string, string>;
  /** Hub-mode `--init`: declare fuentes from CLI flags (`--fuente alias:path[:rama]`, repetible). */
  fuentes?: ProjectMdUpsertFuente[];
  /** Si true, las `fuentes` declaradas REEMPLAZAN a las existentes (no merge). hub-init lo usa para ser autoritativo y soportar remover fuentes. */
  replaceFuentes?: boolean;
  /** Default rama principal applied to fuentes that do not declare one. */
  mainBranch?: string;
  verbose?: boolean;
  /** Optional fixed `Última actividad` value. Used by golden tests to keep output deterministic. */
  lastActivity?: string;
}

export interface UpsertFileResult {
  file: string;
  path: string;
  action?: "created" | "updated" | "unchanged" | "appended";
  error?: string;
}

export interface ProjectMdUpsertOutput {
  ok: boolean;
  action: UpsertOp;
  results?: UpsertFileResult[];
  mode?: UpsertOp;
  workspace_mode?: ProjectMode;
  working_branches?: Record<string, string>;
}

export interface ProjectMdUpsertError {
  error: string;
}

export async function runProjectMdUpsertWrite(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  input: ProjectMdUpsertInput,
): Promise<ProjectMdUpsertOutput | ProjectMdUpsertError> {
  const cwd = env.cwd();
  const files = [join(cwd, "CLAUDE.md"), join(cwd, "AGENTS.md")];
  const markers = paths.blockMarkers();
  const existing = await readExistingBlock(fs, files, markers);

  const renderInput = await buildRenderInput(fs, cwd, input, existing);
  renderInput.markers = markers;
  if (input.lastActivity !== undefined) {
    renderInput.lastActivity = input.lastActivity;
  }
  const block = renderProjectBlock(renderInput);

  let lock: import("./lock-service.js").LockHandle;
  try {
    lock = await acquireLock(paths.cwdLockFile(), fs);
  } catch (err) {
    if (err instanceof LockBusyError) {
      return {
        error: `lock ocupado (pid ${err.holder.pid} desde ${err.holder.ts}); reintenta o espera 5min`,
      };
    }
    throw err;
  }

  try {
    const writeResults = await writeAllFiles(fs, files, cwd, block, markers);
    return composePayload(input, writeResults, renderInput);
  } finally {
    await lock.release();
  }
}

async function readExistingBlock(
  fs: FileSystemPort,
  files: string[],
  markers: ProjectBlockMarkers,
): Promise<ParsedProjectBlock | null> {
  for (const f of files) {
    if (!(await fs.exists(f))) continue;
    const parsed = parseProjectBlock(await fs.readText(f), markers);
    if (parsed) return parsed;
  }
  return null;
}

async function buildRenderInput(
  fs: FileSystemPort,
  cwd: string,
  input: ProjectMdUpsertInput,
  existing: ParsedProjectBlock | null,
): Promise<RenderProjectBlockInput> {
  const proyecto = input.proyecto ?? existing?.proyecto ?? "";
  const fuentes = mergeFuentes(existing?.fuentes ?? [], input);
  const stack =
    existing?.stack && Object.keys(existing.stack).length > 0
      ? existing.stack
      : await detectStackDict(fs, cwd);
  const mode: ProjectMode = input.mode ?? existing?.mode ?? "project";
  const workingBranches: Record<string, string> = {
    ...(existing?.working_branches ?? {}),
    ...(input.workingBranches ?? {}),
  };
  return { proyecto, fuentes, stack, mode, workingBranches };
}

/**
 * Merge CLI-declared fuentes over existing ones (alias-keyed, last wins). Fills
 * `main_branch` for new fuentes from `input.mainBranch` then defaults to
 * "certificacion" — same fallback the renderer applies, but resolved here so
 * the parsed block round-trips deterministically.
 */
function mergeFuentes(existing: ProjectFuente[], input: ProjectMdUpsertInput): ProjectFuente[] {
  if (!input.fuentes || input.fuentes.length === 0) return existing;
  const defaultRama = input.mainBranch ?? "certificacion";
  const byAlias = new Map<string, ProjectFuente>();
  // replaceFuentes: el set declarado es autoritativo; no se preservan las existentes.
  if (!input.replaceFuentes) {
    for (const f of existing) byAlias.set(f.alias, f);
  }
  for (const f of input.fuentes) {
    byAlias.set(f.alias, {
      alias: f.alias,
      path: f.path,
      main_branch: f.mainBranch ?? defaultRama,
    });
  }
  return Array.from(byAlias.values());
}

interface WriteSummary {
  results: UpsertFileResult[];
  hasError: boolean;
}

async function writeAllFiles(
  fs: FileSystemPort,
  files: string[],
  cwd: string,
  block: string,
  markers: ProjectBlockMarkers,
): Promise<WriteSummary> {
  const results: UpsertFileResult[] = [];
  let hasError = false;
  for (const f of files) {
    const baseInfo = { file: pathBasename(f), path: relpath(f, cwd) };
    try {
      const action = await upsertProjectBlockInFile(fs, f, block, markers);
      results.push({ ...baseInfo, action });
    } catch (err) {
      hasError = true;
      results.push({
        ...baseInfo,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { results, hasError };
}

function composePayload(
  input: ProjectMdUpsertInput,
  write: WriteSummary,
  renderInput: RenderProjectBlockInput,
): ProjectMdUpsertOutput {
  if (input.verbose === true) {
    return {
      ok: !write.hasError,
      action: input.op,
      mode: input.op,
      workspace_mode: renderInput.mode ?? "project",
      working_branches: renderInput.workingBranches ?? {},
      results: write.results,
    };
  }
  const compact: ProjectMdUpsertOutput = { ok: !write.hasError, action: input.op };
  if (write.hasError) {
    compact.results = write.results.filter((r) => r.error !== undefined);
  }
  return compact;
}

async function upsertProjectBlockInFile(
  fs: FileSystemPort,
  filePath: string,
  block: string,
  markers: ProjectBlockMarkers,
): Promise<"created" | "updated" | "unchanged" | "appended"> {
  if (!(await fs.exists(filePath))) {
    await fs.writeText(filePath, `${block}\n`);
    return "created";
  }
  const text = await fs.readText(filePath);
  if (text.includes(markers.start) && text.includes(markers.end)) {
    return replaceBlock(fs, filePath, text, block, markers);
  }
  return appendBlock(fs, filePath, text, block);
}

async function replaceBlock(
  fs: FileSystemPort,
  filePath: string,
  text: string,
  block: string,
  markers: ProjectBlockMarkers,
): Promise<"updated" | "unchanged"> {
  const start = text.indexOf(markers.start);
  const end = text.indexOf(markers.end, start) + markers.end.length;
  const replaced = text.slice(0, start) + block + text.slice(end);
  if (replaced === text) return "unchanged";
  await fs.writeText(filePath, replaced);
  return "updated";
}

async function appendBlock(
  fs: FileSystemPort,
  filePath: string,
  text: string,
  block: string,
): Promise<"appended"> {
  let appended = text;
  if (appended.length > 0 && !appended.endsWith("\n")) appended += "\n";
  if (appended.length > 0 && !appended.endsWith("\n\n")) appended += "\n";
  await fs.writeText(filePath, `${appended}${block}\n`);
  return "appended";
}

function pathBasename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}
