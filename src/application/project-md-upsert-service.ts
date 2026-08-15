import { basename, join } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { withCwdLock } from "./lock-service.js";
import {
  BLOCK_MIRROR_FILES,
  type DefaultBranches,
  type ParsedProjectBlock,
  type PreservedLine,
  type ProjectBlockMarkers,
  type ProjectFuente,
  type ProjectStack,
  parseProjectBlock,
  readWorkspaceBlock,
} from "./parsers/project-block.js";
import type { PathsService } from "./paths-service.js";
import { relpath } from "./paths.js";
import { type RenderProjectBlockInput, renderProjectBlock } from "./render/project-block.js";
import { detectStackDict } from "./stack-detect.js";

export type UpsertOp = "init";

export interface ProjectMdUpsertFuente {
  alias: string;
  path: string;
  /** Falls back to `ProjectMdUpsertInput.mainBranch`, else the cell is left empty. */
  mainBranch?: string;
}

export interface ProjectMdUpsertInput {
  op: UpsertOp;
  /**
   * Project description. A SINGLE line renames the workspace and keeps the rest
   * of the Proyecto section; a multi-line value declares the whole section.
   */
  proyecto?: string;
  /** Workspace branch defaults; merged per role over the existing ones. */
  defaultBranches?: DefaultBranches;
  workingBranches?: Record<string, string>;
  qaBranches?: Record<string, string>;
  /** `--init`: declare fuentes from CLI flags (`--fuente alias:path[:rama]`, repeatable). */
  fuentes?: ProjectMdUpsertFuente[];
  /** When true, the declared `fuentes` REPLACE the existing ones (no merge). workspace-init uses it to be authoritative and support removing sources. */
  replaceFuentes?: boolean;
  /** Aliases to prune from the block: removed from `Fuentes` + `working_branches` + `qa_branches`. Used by remove-source. */
  removeAliases?: string[];
  /** Default main branch applied to fuentes that do not declare one. */
  mainBranch?: string;
  verbose?: boolean;
  /** Optional fixed `Última actividad` value. Used by golden tests to keep output deterministic. */
  lastActivity?: string;
}

export type UpsertAction = "created" | "updated" | "unchanged" | "appended";

export interface UpsertFileResult {
  file: string;
  path: string;
  action?: UpsertAction;
  error?: string;
}

export interface ProjectMdUpsertOutput {
  ok: boolean;
  action: UpsertOp;
  results?: UpsertFileResult[];
  mode?: UpsertOp;
  working_branches?: Record<string, string>;
  qa_branches?: Record<string, string>;
  /**
   * CLI-owned records the rewrite could not honour (a branch entry whose source
   * is no longer declared). Reported so a prune is never silent; foreign lines
   * are not here because they are carried over, not lost.
   */
  dropped_lines?: string[];
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
  const markers = paths.blockMarkers();
  const plan = await buildUpsertPlan(fs, cwd, markers, input);

  return withCwdLock(fs, paths, async () => {
    const writeResults = await writeAllFiles(fs, cwd, plan.block, markers);
    return composePayload(input, writeResults, plan);
  });
}

/**
 * What {@link runProjectMdUpsertWrite} WOULD do, decided from the same render
 * and the same per-file rule but without touching disk (no lock either). A
 * preview that recomputed its own answer would be free to disagree with the run.
 */
export async function previewProjectMdUpsert(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  input: ProjectMdUpsertInput,
): Promise<ProjectMdUpsertOutput> {
  const cwd = env.cwd();
  const markers = paths.blockMarkers();
  const plan = await buildUpsertPlan(fs, cwd, markers, input);
  const results: UpsertFileResult[] = [];
  for (const file of blockFiles(cwd)) {
    const write = await planBlockWrite(fs, file, plan.block, markers);
    results.push({ ...fileInfo(file, cwd), action: write.action });
  }
  // A preview whose per-file verdict is hidden behind --detail is not a preview.
  return composePayload({ ...input, verbose: true }, { results, hasError: false }, plan);
}

function blockFiles(cwd: string): string[] {
  return BLOCK_MIRROR_FILES.map((name) => join(cwd, name));
}

function fileInfo(file: string, cwd: string): { file: string; path: string } {
  return { file: basename(file), path: relpath(file, cwd) };
}

interface UpsertPlan {
  /** The rendered block, byte for byte what a write would put in both files. */
  block: string;
  render: RenderProjectBlockInput;
  /** CLI records this rewrite drops; declared by the caller, never silent. */
  dropped: string[];
}

async function buildUpsertPlan(
  fs: FileSystemPort,
  cwd: string,
  markers: ProjectBlockMarkers,
  input: ProjectMdUpsertInput,
): Promise<UpsertPlan> {
  const existing = await readWorkspaceBlock(fs, cwd, markers);
  const mirrored = await readMirroredExtras(fs, cwd, markers);
  const render = await buildRenderInput(fs, cwd, input, existing);
  render.markers = markers;
  if (mirrored.preserved.length > 0) render.preservedLines = mirrored.preserved;
  if (input.lastActivity !== undefined) render.lastActivity = input.lastActivity;

  const dropped = [...mirrored.dropped, ...pruneUndeclaredBranches(input, render)];
  return { block: renderProjectBlock(render), render, dropped };
}

/**
 * Foreign and unhonourable lines from BOTH mirrors of the block. The same block
 * lives in CLAUDE.md and AGENTS.md, and a person edits whichever file their host
 * reads — collecting only from the first one would wipe a note left in the other.
 */
async function readMirroredExtras(
  fs: FileSystemPort,
  cwd: string,
  markers: ProjectBlockMarkers,
): Promise<{ preserved: PreservedLine[]; dropped: string[] }> {
  const preserved: PreservedLine[] = [];
  const dropped: string[] = [];
  const seenPreserved = new Set<string>();
  const seenDropped = new Set<string>();
  for (const file of blockFiles(cwd)) {
    if (!(await fs.exists(file))) continue;
    const block = parseProjectBlock(await fs.readText(file), markers);
    if (block === null) continue;
    for (const line of block.preserved_lines ?? []) {
      const key = `${line.slot}\u0000${line.text}`;
      if (seenPreserved.has(key)) continue;
      seenPreserved.add(key);
      preserved.push(line);
    }
    for (const line of block.dropped_lines ?? []) {
      if (seenDropped.has(line)) continue;
      seenDropped.add(line);
      dropped.push(line);
    }
  }
  return { preserved, dropped };
}

/**
 * Intersect the branch surfaces with the declared sources when the caller is
 * authoritative (`replaceFuentes`). `remove-source` already purges both
 * surfaces; reconciling reaches the same block through another door, and left
 * alone it kept a working branch for a source it had just removed.
 */
function pruneUndeclaredBranches(
  input: ProjectMdUpsertInput,
  render: RenderProjectBlockInput,
): string[] {
  if (input.replaceFuentes !== true) return [];
  const declared = new Set(render.fuentes.map((f) => f.alias));
  return [
    ...dropUndeclared(render.workingBranches, declared),
    ...dropUndeclared(render.qaBranches, declared),
  ];
}

function dropUndeclared(
  branches: Record<string, string> | undefined,
  declared: ReadonlySet<string>,
): string[] {
  if (branches === undefined) return [];
  const removed: string[] = [];
  for (const [alias, branch] of Object.entries(branches)) {
    if (declared.has(alias)) continue;
    delete branches[alias];
    removed.push(`  - ${alias}: ${branch}`);
  }
  return removed;
}

async function buildRenderInput(
  fs: FileSystemPort,
  cwd: string,
  input: ProjectMdUpsertInput,
  existing: ParsedProjectBlock | null,
): Promise<RenderProjectBlockInput> {
  const proyecto = resolveProyectoText(input.proyecto, existing?.proyecto);
  const remove = new Set(input.removeAliases ?? []);
  const fuentes = mergeFuentes(existing?.fuentes ?? [], input).filter((f) => !remove.has(f.alias));
  const stack =
    existing?.stack && Object.keys(existing.stack).length > 0
      ? existing.stack
      : await detectStackFromSources(fs, input.fuentes ?? [], cwd);
  const defaultBranches: DefaultBranches = {
    ...(existing?.default_branches ?? {}),
    ...(input.defaultBranches ?? {}),
  };
  const workingBranches: Record<string, string> = {
    ...(existing?.working_branches ?? {}),
    ...(input.workingBranches ?? {}),
  };
  const qaBranches: Record<string, string> = {
    ...(existing?.qa_branches ?? {}),
    ...(input.qaBranches ?? {}),
  };
  for (const alias of remove) {
    delete workingBranches[alias];
    delete qaBranches[alias];
  }
  return { proyecto, fuentes, stack, defaultBranches, workingBranches, qaBranches };
}

/**
 * `--proyecto` names the workspace; it does not author its description. A single
 * line therefore replaces only the FIRST line of the Proyecto section and keeps
 * the paragraphs under it — those were written by a person, and renaming used to
 * delete them with exit 0 and no warning. A multi-line value is taken verbatim:
 * that caller IS declaring the whole section (it is also how a reconcile hands
 * back the section it just read, which keeps the merge idempotent).
 */
function resolveProyectoText(next: string | undefined, existing: string | undefined): string {
  const current = (existing ?? "").trim();
  const declared = (next ?? "").trim();
  if (declared.length === 0) return current;
  if (declared.includes("\n") || current.length === 0) return declared;
  const currentLines = current.split("\n");
  if (currentLines.length === 1) return declared;
  return [declared, ...currentLines.slice(1)].join("\n");
}

/**
 * Detect the stack from the SOURCE paths, not the workspace folder. In the hub
 * model the workspace dir is just scaffolding (empty), while the real code lives
 * in the (often external) source repos — scanning `cwd` would always miss it.
 * Scans each declared source and returns the first non-empty detection; falls
 * back to the workspace folder when there are no sources / none are detectable.
 */
async function detectStackFromSources(
  fs: FileSystemPort,
  fuentes: ProjectMdUpsertFuente[],
  cwdFallback: string,
): Promise<ProjectStack> {
  for (const f of fuentes) {
    if (!f.path) continue;
    const detected = await detectStackDict(fs, f.path);
    if (Object.keys(detected).length > 0) return detected;
  }
  return detectStackDict(fs, cwdFallback);
}

/**
 * Merge CLI-declared fuentes over existing ones (alias-keyed, last wins). Fills
 * `main_branch` from the per-fuente value, then `input.mainBranch`.
 *
 * With NEITHER the cell is left empty (null) on purpose: an undeclared base now
 * means "resolve me through the workspace `principal` default". Stamping a
 * literal here would make that default unreachable — and silently override what
 * the user set in [Config].
 */
function mergeFuentes(existing: ProjectFuente[], input: ProjectMdUpsertInput): ProjectFuente[] {
  if (!input.fuentes || input.fuentes.length === 0) return existing;
  const defaultRama = input.mainBranch ?? null;
  const byAlias = new Map<string, ProjectFuente>();
  // replaceFuentes: the declared set is authoritative; existing ones are not preserved.
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
  cwd: string,
  block: string,
  markers: ProjectBlockMarkers,
): Promise<WriteSummary> {
  const results: UpsertFileResult[] = [];
  let hasError = false;
  for (const f of blockFiles(cwd)) {
    const baseInfo = fileInfo(f, cwd);
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
  plan: UpsertPlan,
): ProjectMdUpsertOutput {
  const payload: ProjectMdUpsertOutput = { ok: !write.hasError, action: input.op };
  if (input.verbose === true) {
    payload.mode = input.op;
    payload.working_branches = plan.render.workingBranches ?? {};
    payload.qa_branches = plan.render.qaBranches ?? {};
    payload.results = write.results;
  } else if (write.hasError) {
    payload.results = write.results.filter((r) => r.error !== undefined);
  }
  // Always reported: a loss the caller cannot see is a loss in silence.
  if (plan.dropped.length > 0) payload.dropped_lines = plan.dropped;
  return payload;
}

interface FileWritePlan {
  action: UpsertAction;
  /** Absent when the file already holds this exact block (`unchanged`). */
  text?: string;
}

/** The single decision about a file, shared by the write and by the preview. */
async function planBlockWrite(
  fs: FileSystemPort,
  filePath: string,
  block: string,
  markers: ProjectBlockMarkers,
): Promise<FileWritePlan> {
  if (!(await fs.exists(filePath))) return { action: "created", text: `${block}\n` };
  const current = await fs.readText(filePath);
  if (!current.includes(markers.start) || !current.includes(markers.end)) {
    return { action: "appended", text: appendedText(current, block) };
  }
  const replaced = replacedText(current, block, markers);
  return replaced === current ? { action: "unchanged" } : { action: "updated", text: replaced };
}

async function upsertProjectBlockInFile(
  fs: FileSystemPort,
  filePath: string,
  block: string,
  markers: ProjectBlockMarkers,
): Promise<UpsertAction> {
  const plan = await planBlockWrite(fs, filePath, block, markers);
  if (plan.text !== undefined) await fs.writeText(filePath, plan.text);
  return plan.action;
}

function replacedText(text: string, block: string, markers: ProjectBlockMarkers): string {
  const start = text.indexOf(markers.start);
  const end = text.indexOf(markers.end, start) + markers.end.length;
  return text.slice(0, start) + block + text.slice(end);
}

function appendedText(text: string, block: string): string {
  let appended = text;
  if (appended.length > 0 && !appended.endsWith("\n")) appended += "\n";
  if (appended.length > 0 && !appended.endsWith("\n\n")) appended += "\n";
  return `${appended}${block}\n`;
}
