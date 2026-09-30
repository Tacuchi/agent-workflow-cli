import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
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
  type ProjectPipeline,
  type ProjectStack,
  formatPipelineRecord,
  parseProjectBlock,
  readWorkspaceBlock,
} from "./parsers/project-block.js";
import type { PathsService } from "./paths-service.js";
import { type RenderProjectBlockInput, renderProjectBlock } from "./render/project-block.js";
import { publishArtifacts } from "./semantic-operation/publish.js";
import { detectStackDict } from "./stack-detect.js";
import {
  absoluteOnAnyHost,
  localSourcePath,
  readWorkspaceLocalConfig,
  writeWorkspaceLocalConfigUnlocked,
} from "./workspace-local-config.js";

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
  exceptionBranches?: Record<string, string>;
  editMode?: "in-place" | "unit";
  /** Source pipeline records merged over the existing declarations. */
  pipeline?: ProjectPipeline;
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
  migrated?: string[];
  not_migrated?: string[];
}

export interface ProjectMdUpsertError {
  error: string;
}

export async function runProjectMdUpsertWrite(
  fs: FileSystemPort,
  _env: EnvPort,
  paths: PathsService,
  input: ProjectMdUpsertInput,
): Promise<ProjectMdUpsertOutput | ProjectMdUpsertError> {
  const cwd = paths.workspaceDir();
  const markers = paths.blockMarkers();
  try {
    return await withCwdLock(fs, paths, async () => {
      const plan = await buildUpsertPlan(fs, cwd, markers, input);
      if (Object.keys(plan.localChanges).length > 0) {
        await writeWorkspaceLocalConfigUnlocked(fs, paths, plan.localChanges);
      }
      const writeResults = await writeAllFiles(fs, cwd, plan.block, markers);
      return composePayload(input, writeResults, plan);
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * What {@link runProjectMdUpsertWrite} WOULD do, decided from the same render
 * and the same per-file rule but without touching disk (no lock either). A
 * preview that recomputed its own answer would be free to disagree with the run.
 */
export async function previewProjectMdUpsert(
  fs: FileSystemPort,
  _env: EnvPort,
  paths: PathsService,
  input: ProjectMdUpsertInput,
): Promise<ProjectMdUpsertOutput> {
  const cwd = paths.workspaceDir();
  const markers = paths.blockMarkers();
  const plan = await buildUpsertPlan(fs, cwd, markers, input);
  const results: UpsertFileResult[] = [];
  for (const file of blockFiles(cwd)) {
    const write = await planBlockWrite(fs, file, plan.block, markers);
    results.push({ ...fileInfo(file), action: write.action });
  }
  // A preview whose per-file verdict is hidden behind --detail is not a preview.
  return composePayload({ ...input, verbose: true }, { results, hasError: false }, plan);
}

function blockFiles(cwd: string): string[] {
  return BLOCK_MIRROR_FILES.map((name) => join(cwd, name));
}

function fileInfo(file: string): { file: string; path: string } {
  return { file: basename(file), path: file };
}

interface UpsertPlan {
  /** The rendered block, byte for byte what a write would put in both files. */
  block: string;
  render: RenderProjectBlockInput;
  /** CLI records this rewrite drops; declared by the caller, never silent. */
  dropped: string[];
  localChanges: Record<string, string | null>;
  migrated: string[];
  notMigrated: string[];
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
  const local = await readWorkspaceLocalConfig(
    fs,
    join(
      cwd,
      `.${/^<!-- ([A-Z][A-Z0-9_-]*)-PROJECT-START -->$/.exec(markers.start)?.[1]?.toLowerCase() ?? "workflow"}`,
      "local.json",
    ),
  );
  const migration = await portableSources(
    fs,
    cwd,
    render.fuentes,
    local,
    new Set(existing?.fuentes.map((source) => source.alias) ?? []),
    new Set(input.fuentes?.map((source) => source.alias) ?? []),
  );
  render.fuentes = migration.fuentes;
  render.markers = markers;
  if (mirrored.preserved.length > 0) render.preservedLines = mirrored.preserved;
  for (const [alias, declaration] of Object.entries(mirrored.pipeline)) {
    render.pipeline ??= {};
    render.pipeline[alias] = { ...declaration, ...render.pipeline[alias] };
  }
  const namespace =
    /^<!-- ([A-Z][A-Z0-9_-]*)-PROJECT-START -->$/.exec(markers.start)?.[1]?.toLowerCase() ??
    "workflow";
  const history = `.${namespace}/HISTORY.md`;
  if (await fs.exists(join(cwd, history))) render.historicoPath = history;

  const dropped = [
    ...mirrored.dropped,
    ...pruneUndeclaredBranches(input, render),
    ...prunePipeline(render),
  ];
  return {
    block: renderProjectBlock(render),
    render,
    dropped,
    localChanges: migration.changes,
    migrated: migration.migrated,
    notMigrated: migration.notMigrated,
  };
}

async function portableSources(
  fs: FileSystemPort,
  cwd: string,
  sources: ProjectFuente[],
  local: Awaited<ReturnType<typeof readWorkspaceLocalConfig>>,
  existingAliases: ReadonlySet<string>,
  explicitAliases: ReadonlySet<string>,
): Promise<{
  fuentes: ProjectFuente[];
  changes: Record<string, string | null>;
  migrated: string[];
  notMigrated: string[];
}> {
  const changes: Record<string, string | null> = {};
  const migrated: string[] = [];
  const notMigrated: string[] = [];
  const fuentes: ProjectFuente[] = [];
  function migrateLocalSource(source: ProjectFuente, declared: string): void {
    const relativePath = relative(cwd, declared);
    const inside =
      relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
    if (!inside && local.config === null) throw new Error(`local.json ilegible: ${local.error}`);
    if (
      inside &&
      explicitAliases.has(source.alias) &&
      localSourcePath(local.config, source.alias) !== undefined
    )
      changes[source.alias] = null;
    if (
      !inside &&
      (explicitAliases.has(source.alias) ||
        localSourcePath(local.config, source.alias) === undefined)
    )
      changes[source.alias] = declared;
    migrated.push(source.alias);
    fuentes.push({ ...source, declared_path: inside ? relativePath || "." : "(local)" });
  }
  async function migrateSource(source: ProjectFuente): Promise<void> {
    const declared = source.declared_path ?? source.path ?? "";
    if (explicitAliases.has(source.alias) && local.config === null)
      throw new Error(`local.json ilegible: ${local.error}`);
    if (!absoluteOnAnyHost(declared)) {
      if (
        explicitAliases.has(source.alias) &&
        localSourcePath(local.config, source.alias) !== undefined
      )
        changes[source.alias] = null;
      fuentes.push({ ...source, declared_path: declared });
      return;
    }
    // A foreign-host absolute coordinate stays byte-for-byte until its own host migrates it.
    if (!(await sourceExistsOnHost(fs, declared))) {
      if (!existingAliases.has(source.alias))
        throw new Error(
          `la ruta de la fuente ${source.alias} no existe en este host: ${declared}; declárala con aw add-source ${source.alias}:<ruta>`,
        );
      notMigrated.push(source.alias);
      fuentes.push({ ...source, declared_path: declared });
      return;
    }
    migrateLocalSource(source, declared);
  }
  for (const source of sources) {
    await migrateSource(source);
  }
  return { fuentes, changes, migrated, notMigrated };
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
): Promise<{ preserved: PreservedLine[]; dropped: string[]; pipeline: ProjectPipeline }> {
  const preserved: PreservedLine[] = [];
  const dropped: string[] = [];
  const pipeline: ProjectPipeline = {};
  const seenPreserved = new Set<string>();
  const seenDropped = new Set<string>();
  for (const file of blockFiles(cwd)) {
    if (!(await fs.exists(file))) continue;
    const block = parseProjectBlock(await fs.readText(file), markers);
    if (block === null) continue;
    for (const [alias, declaration] of Object.entries(block.pipeline ?? {})) {
      pipeline[alias] = { ...declaration, ...pipeline[alias] };
    }
    collectPreservedLines(block.preserved_lines ?? [], seenPreserved, preserved);
    for (const line of block.dropped_lines ?? []) {
      if (seenDropped.has(line)) continue;
      seenDropped.add(line);
      dropped.push(line);
    }
  }
  return { preserved, dropped, pipeline };
}

function prunePipeline(render: RenderProjectBlockInput): string[] {
  const declared = new Set(render.fuentes.map((f) => f.alias));
  const removed: string[] = [];
  for (const [alias, value] of Object.entries(render.pipeline ?? {})) {
    if (declared.has(alias)) continue;
    removed.push(formatPipelineRecord(alias, value));
    delete render.pipeline?.[alias];
  }
  return removed;
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
    ...dropUndeclared(render.exceptionBranches, declared),
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
  const stack = await detectStackFromSources(fs, fuentes, cwd, existing?.stack ?? {});
  const { defaultBranches, workingBranches, qaBranches, exceptionBranches, pipeline } =
    renderBranchSettings(input, existing, remove);
  const editMode = input.editMode ?? existing?.edit_mode;
  return {
    proyecto,
    fuentes,
    stack,
    defaultBranches,
    workingBranches,
    qaBranches,
    exceptionBranches,
    ...(editMode ? { editMode } : {}),
    pipeline,
  };
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
  if (declared === current) return current;
  if (declared.includes("\n") || current.length === 0) return declared;
  const currentLines = current.split("\n");
  if (currentLines.length === 1) return [declared, "", currentLines[0]].join("\n");
  return [declared, ...currentLines.slice(1)].join("\n");
}

/**
 * Detect the stack from the SOURCE paths, not the workspace folder. In the hub
 * model the workspace dir is just scaffolding (empty), while the real code lives
 * in the (often external) source repos — scanning `cwd` would always miss it.
 * Scans every declared source in table order; missing sources retain previous
 * values so rendering this hub on another machine cannot erase its stack.
 */
async function detectStackFromSources(
  fs: FileSystemPort,
  fuentes: ProjectFuente[],
  workspace: string,
  previous: ProjectStack,
): Promise<ProjectStack> {
  const stack: ProjectStack = { ...(previous.db !== undefined ? { db: previous.db } : {}) };
  let missing = false;
  for (const f of fuentes) {
    const path =
      f.path === null || (absoluteOnAnyHost(f.path) && !isAbsolute(f.path))
        ? null
        : resolve(workspace, f.path);
    if (path === null || !(await fs.exists(path))) {
      missing = true;
      continue;
    }
    const detected = await detectStackDict(fs, path);
    mergeDetectedStack(stack, detected);
  }
  if (missing) {
    retainPreviousStack(stack, previous);
  }
  return stack;
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
  if (!input.fuentes || input.fuentes.length === 0) return input.replaceFuentes ? [] : existing;
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
      declared_path: f.path,
      main_branch: f.mainBranch ?? byAlias.get(f.alias)?.main_branch ?? defaultRama,
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
  const plans = await Promise.all(
    blockFiles(cwd).map(async (file) => ({
      absolute: file,
      ...fileInfo(file),
      ...(await planBlockWrite(fs, file, block, markers)),
    })),
  );
  const changes = plans.filter((plan) => plan.text !== undefined);
  if (changes.length > 0) {
    const published = await publishArtifacts(
      fs,
      cwd,
      changes.map((plan) => ({
        path: relative(cwd, plan.absolute),
        content: plan.text ?? "",
        overwrite: true,
      })),
    );
    if (!published.ok) {
      return {
        hasError: true,
        results: plans.map((plan) =>
          plan.text === undefined
            ? { ...fileInfo(plan.absolute), action: plan.action }
            : {
                ...fileInfo(plan.absolute),
                error: `${published.failure.message}; publicación revertida`,
              },
        ),
      };
    }
  }
  return {
    hasError: false,
    results: plans.map((plan) => ({ ...fileInfo(plan.absolute), action: plan.action })),
  };
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
  if (plan.migrated.length > 0) payload.migrated = plan.migrated;
  if (plan.notMigrated.length > 0) payload.not_migrated = plan.notMigrated;
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

function collectPreservedLines(
  lines: PreservedLine[],
  seenPreserved: Set<string>,
  preserved: PreservedLine[],
): void {
  for (const line of lines) {
    const key = `${line.slot}\u0000${line.text}`;
    if (seenPreserved.has(key)) continue;
    seenPreserved.add(key);
    preserved.push(line);
  }
}

function renderBranchSettings(
  input: ProjectMdUpsertInput,
  existing: ParsedProjectBlock | null,
  remove: Set<string>,
) {
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
  const exceptionBranches = {
    ...(existing?.exception_branches ?? {}),
    ...(input.exceptionBranches ?? {}),
  };
  const pipeline: ProjectPipeline = { ...(existing?.pipeline ?? {}) };
  for (const [alias, value] of Object.entries(input.pipeline ?? {})) {
    pipeline[alias] = { ...pipeline[alias], ...value };
  }
  for (const alias of remove) {
    delete workingBranches[alias];
    delete qaBranches[alias];
    delete exceptionBranches[alias];
  }
  return { defaultBranches, workingBranches, qaBranches, exceptionBranches, pipeline };
}

function mergeDetectedStack(stack: ProjectStack, detected: ProjectStack): void {
  for (const key of ["language", "framework", "build"] as const) {
    const value = detected[key];
    if (value === undefined) continue;
    const values = stack[key]?.split(", ") ?? [];
    if (!values.includes(value)) stack[key] = [...values, value].join(", ");
  }
}

function retainPreviousStack(stack: ProjectStack, previous: ProjectStack): void {
  for (const key of ["language", "framework", "build"] as const) {
    for (const value of previous[key]?.split(", ") ?? []) {
      const values = stack[key]?.split(", ") ?? [];
      if (!values.includes(value)) stack[key] = [...values, value].join(", ");
    }
  }
}

async function sourceExistsOnHost(fs: FileSystemPort, declared: string): Promise<boolean> {
  if (!isAbsolute(declared) && !/^\\\\/.test(declared)) return false;
  return fs.exists(declared);
}
