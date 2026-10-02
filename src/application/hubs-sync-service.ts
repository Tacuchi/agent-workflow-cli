import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  HerdrCli,
  HerdrDegradation,
  HerdrPane,
  HerdrWorkspace,
} from "../adapters/herdr-cli.js";
import type { FileSystemPort } from "../ports/file-system.js";
import {
  RUNTIME_GITIGNORE_HEADER,
  appendGitignoreEntries,
  belongsToGit,
} from "./hub-materialization-service.js";
import { type RegisteredHub, listRegisteredHubs } from "./hub-registry.js";
import type { HubStatus, HubsStatusOutput } from "./hubs-status-service.js";
import { hubBlockMarkers, readHubBlock } from "./parsers/hub-block.js";

export type IdeAction = "created" | "updated" | "unchanged" | "skipped";

export interface IdeHubResult {
  name: string;
  root: string;
  action: IdeAction;
  file: string;
  reason?: string;
  omitted_sources?: { alias: string; reason: string }[];
}

export type HerdrAction = "created" | "unchanged" | "conflict" | "skipped";

export interface HerdrHubResult {
  name: string;
  root: string;
  action: HerdrAction;
  workspace_id?: string;
  published: boolean;
  reason?: string;
}

export interface HubsSyncOutput {
  dry_run: boolean;
  ide: { hubs: IdeHubResult[] } | null;
  herdr: { degradation: HerdrDegradation | null; hubs: HerdrHubResult[] } | null;
}

export interface HubsSyncOptions {
  ide: boolean;
  herdr: boolean;
  dryRun: boolean;
}

export interface HubsSyncDeps {
  fs: FileSystemPort;
  home: string;
  namespace: string;
  tempRoots: readonly string[];
  /** Required with `options.herdr`: the adapter and the `aw hubs status` reading. */
  herdr?: { cli: HerdrCli; status: () => Promise<HubsStatusOutput> };
}

interface WorkspaceFolder {
  name: string;
  path: string;
}

/**
 * Projects the registry onto the tools around it. The registry and each hub's
 * block are the only inputs: what a tool already holds is overwritten where it
 * is ours and never read back as a source, so a second run changes nothing.
 */
export async function runHubsSync(
  deps: HubsSyncDeps,
  options: HubsSyncOptions,
): Promise<HubsSyncOutput> {
  const { fs, home, namespace } = deps;
  const hubs = await listRegisteredHubs(fs, home, namespace, deps.tempRoots);
  let ide: { hubs: IdeHubResult[] } | null = null;
  if (options.ide) {
    ide = { hubs: [] };
    for (const hub of hubs) {
      const file = join(hub.root, `${basename(hub.root)}.code-workspace`);
      ide.hubs.push(
        hub.state === "ok"
          ? await syncWorkspaceFile(fs, home, namespace, hub, file, options.dryRun)
          : { name: hub.name, root: hub.root, action: "skipped", file, reason: hub.state },
      );
    }
  }
  const herdr =
    options.herdr && deps.herdr !== undefined
      ? await syncHerdr(fs, hubs, deps.herdr.cli, deps.herdr.status, options.dryRun)
      : null;
  return { dry_run: options.dryRun, ide, herdr };
}

/**
 * One workspace per hub, matched by its `hub:<name>` label and confirmed by
 * the cwd of its panes, because Herdr 0.9 lists workspaces without one. A
 * label that does not confirm, or appears twice, is left alone as a conflict.
 * The first degradation stops every later call to Herdr.
 */
async function syncHerdr(
  fs: FileSystemPort,
  hubs: RegisteredHub[],
  cli: HerdrCli,
  readStatus: () => Promise<HubsStatusOutput>,
  dryRun: boolean,
): Promise<NonNullable<HubsSyncOutput["herdr"]>> {
  const probe = await cli.probe();
  if (probe !== null) return { degradation: probe, hubs: [] };
  const listed = await cli.listWorkspaces();
  if (!listed.ok) return { degradation: listed.degradation, hubs: [] };
  const status = new Map((await readStatus()).hubs.map((hub) => [hub.root, hub]));

  const results: HerdrHubResult[] = [];
  const labels = new Set<string>();
  let degradation: HerdrDegradation | null = null;
  for (const hub of hubs) {
    if (degradation !== null) {
      results.push({ ...herdrBase(hub), action: "skipped", reason: `herdr ${degradation.kind}` });
      continue;
    }
    // Two hubs can share a name (hubNames adds only one parent): the label goes
    // to the first one that holds a workspace, never to one left in conflict.
    const label = `hub:${hub.name}`;
    if (labels.has(label)) {
      results.push({ ...herdrBase(hub), action: "skipped", reason: `nombre repetido: ${label}` });
      continue;
    }
    const step = await syncHerdrHub(fs, cli, hub, status.get(hub.root), listed.value, dryRun);
    if (step.result.action === "created" || step.result.action === "unchanged") labels.add(label);
    results.push(step.result);
    degradation = step.degradation;
  }
  return { degradation, hubs: results };
}

interface HerdrStep {
  result: HerdrHubResult;
  degradation: HerdrDegradation | null;
}

async function syncHerdrHub(
  fs: FileSystemPort,
  cli: HerdrCli,
  hub: RegisteredHub,
  tokens: HubStatus | undefined,
  listed: HerdrWorkspace[],
  dryRun: boolean,
): Promise<HerdrStep> {
  const base = herdrBase(hub);
  if (hub.state !== "ok") return done({ ...base, action: "skipped", reason: hub.state });
  if (tokens === undefined || !tokens.ok) {
    return done({
      ...base,
      action: "skipped",
      reason: tokens?.ok === false ? tokens.reason : "sin estado",
    });
  }
  const label = `hub:${hub.name}`;
  const matches = listed.filter((workspace) => workspace.label === label);
  if (matches.length > 1) {
    return done({
      ...base,
      action: "conflict",
      reason: `${matches.length} workspaces con ${label}`,
    });
  }
  const workspace = await ensureWorkspace(fs, cli, hub, label, matches[0], dryRun);
  if ("result" in workspace) return workspace;
  const { action, id } = workspace;
  if (dryRun || id === undefined) {
    return done({ ...base, action, ...(id !== undefined ? { workspace_id: id } : {}) });
  }
  const report = await cli.reportMetadata(id, { pending: tokens.pending, next: tokens.next });
  return {
    result: { ...base, action, workspace_id: id, published: report.ok },
    degradation: report.ok ? null : report.degradation,
  };
}

/** The workspace to report on, or the step that ends this hub. A dry run creates nothing and has no id. */
async function ensureWorkspace(
  fs: FileSystemPort,
  cli: HerdrCli,
  hub: RegisteredHub,
  label: string,
  match: HerdrWorkspace | undefined,
  dryRun: boolean,
): Promise<{ action: HerdrAction; id?: string } | HerdrStep> {
  const base = herdrBase(hub);
  if (match !== undefined) {
    const panes = await cli.listPanes(match.id);
    if (!panes.ok) return degraded(base, panes.degradation);
    if (!(await anyPaneUnder(fs, hub.root, panes.value))) {
      return done({
        ...base,
        action: "conflict",
        workspace_id: match.id,
        reason: "ningún panel en el hub",
      });
    }
    return { action: "unchanged", id: match.id };
  }
  if (dryRun) return { action: "created" };
  const created = await cli.createWorkspace(hub.root, label);
  return created.ok
    ? { action: "created", id: created.value }
    : degraded(base, created.degradation);
}

function herdrBase(hub: RegisteredHub): Pick<HerdrHubResult, "name" | "root" | "published"> {
  return { name: hub.name, root: hub.root, published: false };
}

function done(result: HerdrHubResult): HerdrStep {
  return { result, degradation: null };
}

function degraded(
  base: Pick<HerdrHubResult, "name" | "root" | "published">,
  degradation: HerdrDegradation,
): HerdrStep {
  return {
    result: { ...base, action: "skipped", reason: `herdr ${degradation.kind}` },
    degradation,
  };
}

async function anyPaneUnder(
  fs: FileSystemPort,
  root: string,
  panes: HerdrPane[],
): Promise<boolean> {
  const hub = await canonical(fs, root);
  if (hub === null) return false;
  for (const pane of panes) {
    for (const cwd of [pane.cwd, pane.foreground_cwd]) {
      if (await cwdUnder(fs, hub, cwd)) return true;
    }
  }
  return false;
}

async function cwdUnder(fs: FileSystemPort, hub: string, cwd: string | null): Promise<boolean> {
  // A relative cwd would resolve against wherever aw runs, not where the pane is.
  if (cwd === null || !isAbsolute(cwd)) return false;
  const path = await canonical(fs, cwd);
  if (path === null) return false;
  const inside = relative(hub, path);
  return inside === "" || (!inside.startsWith("..") && !isAbsolute(inside));
}

/** The real path, or null when it cannot be resolved (EACCES, ENOTDIR, ELOOP). */
async function canonical(fs: FileSystemPort, path: string): Promise<string | null> {
  try {
    return await fs.realPath(resolve(path));
  } catch {
    return null;
  }
}

async function syncWorkspaceFile(
  fs: FileSystemPort,
  home: string,
  namespace: string,
  hub: { name: string; root: string },
  file: string,
  dryRun: boolean,
): Promise<IdeHubResult> {
  const base = { name: hub.name, root: hub.root, file };
  const { folders, omitted } = await workspaceFolders(fs, home, namespace, hub);
  const extra = omitted.length > 0 ? { omitted_sources: omitted } : {};

  const existing = await readWorkspace(fs, file);
  if ("reason" in existing)
    return { ...base, action: "skipped", reason: existing.reason, ...extra };
  const current = existing.current;
  const action: IdeAction =
    current === null ? "created" : sameFolders(current.folders, folders) ? "unchanged" : "updated";
  if (!dryRun) {
    if (action !== "unchanged") {
      await fs.writeText(file, `${JSON.stringify({ ...(current ?? {}), folders }, null, 2)}\n`);
    }
    if (await belongsToGit(fs, hub.root)) {
      await appendGitignoreEntries(fs, hub.root, RUNTIME_GITIGNORE_HEADER, [`/${basename(file)}`]);
    }
  }
  return { ...base, action, ...extra };
}

async function workspaceFolders(
  fs: FileSystemPort,
  home: string,
  namespace: string,
  hub: { name: string; root: string },
): Promise<{ folders: WorkspaceFolder[]; omitted: { alias: string; reason: string }[] }> {
  const folders: WorkspaceFolder[] = [{ name: hub.name, path: "." }];
  const omitted: { alias: string; reason: string }[] = [];
  const block = await readHubBlock(fs, hub.root, hubBlockMarkers(namespace));
  // Compared as real paths: a source spelled through a symlink or with a trailing
  // slash is still the hub itself, and $HOME may come with either.
  const root = (await canonical(fs, hub.root)) ?? resolve(hub.root);
  // VS Code joins a relative path onto the file's folder as spelled: from a root
  // reached through a symlink, only an absolute path lands where it should.
  const spelledAsReal = root === resolve(hub.root);
  const realHome = (await canonical(fs, home)) ?? resolve(home);
  for (const source of block?.fuentes ?? []) {
    if (source.path === null) {
      omitted.push({ alias: source.alias, reason: source.path_reason ?? "sin ruta local" });
      continue;
    }
    const path = (await canonical(fs, source.path)) ?? resolve(source.path);
    if (path === root) continue;
    folders.push({
      name: source.alias,
      path: spelledAsReal ? folderPath(root, path, realHome) : path,
    });
  }
  return { folders, omitted };
}

/**
 * Relative when both sit under a common folder that is neither the filesystem
 * root nor $HOME: sharing only those says nothing about moving them together.
 */
function folderPath(hub: string, source: string, home: string): string {
  const ancestor = commonAncestor(hub, source);
  if (ancestor === null || ancestor === home || dirname(ancestor) === ancestor) return source;
  return relative(hub, source);
}

function commonAncestor(left: string, right: string): string | null {
  const a = left.split(sep);
  const b = right.split(sep);
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++;
  if (shared === 0) return null;
  return a.slice(0, shared).join(sep) || sep;
}

/** The current file as an object, null when absent, or why it is left alone. */
async function readWorkspace(
  fs: FileSystemPort,
  file: string,
): Promise<{ current: Record<string, unknown> | null } | { reason: string }> {
  if (!(await fs.exists(file))) return { current: null };
  let text: string;
  try {
    text = await fs.readText(file);
  } catch (error) {
    return {
      reason: `el archivo no se puede leer (${(error as NodeJS.ErrnoException).code ?? "error"})`,
    };
  }
  const current = parseWorkspace(text);
  return current === null ? { reason: "el archivo no es un objeto JSON legible" } : { current };
}

function parseWorkspace(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function sameFolders(current: unknown, wanted: WorkspaceFolder[]): boolean {
  return JSON.stringify(current) === JSON.stringify(wanted);
}
