import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
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
  let degradation: HerdrDegradation | null = null;
  for (const hub of hubs) {
    if (degradation !== null) {
      results.push({ ...herdrBase(hub), action: "skipped", reason: `herdr ${degradation.kind}` });
      continue;
    }
    const step = await syncHerdrHub(fs, cli, hub, status.get(hub.root), listed.value, dryRun);
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
  const hub = await fs.realPath(root);
  for (const pane of panes) {
    for (const cwd of [pane.cwd, pane.foreground_cwd]) {
      if (cwd === null) continue;
      const inside = relative(hub, await fs.realPath(cwd));
      if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside))) return true;
    }
  }
  return false;
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

  let current: Record<string, unknown> | null = null;
  if (await fs.exists(file)) {
    current = parseWorkspace(await fs.readText(file));
    if (current === null) {
      return {
        ...base,
        action: "skipped",
        reason: "el archivo no es un objeto JSON legible",
        ...extra,
      };
    }
  }
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
  for (const source of block?.fuentes ?? []) {
    if (source.path === null) {
      omitted.push({ alias: source.alias, reason: source.path_reason ?? "sin ruta local" });
      continue;
    }
    if (source.path === hub.root) continue;
    folders.push({ name: source.alias, path: folderPath(hub.root, source.path, home) });
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

function parseWorkspace(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
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
