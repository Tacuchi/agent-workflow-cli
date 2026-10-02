import { basename, dirname, join, relative, sep } from "node:path";
import type { FileSystemPort } from "../ports/file-system.js";
import {
  RUNTIME_GITIGNORE_HEADER,
  appendGitignoreEntries,
  belongsToGit,
} from "./hub-materialization-service.js";
import { listRegisteredHubs } from "./hub-registry.js";
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

export interface HubsSyncOutput {
  dry_run: boolean;
  ide: { hubs: IdeHubResult[] } | null;
}

export interface HubsSyncOptions {
  ide: boolean;
  dryRun: boolean;
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
  fs: FileSystemPort,
  home: string,
  namespace: string,
  tempRoots: readonly string[],
  options: HubsSyncOptions,
): Promise<HubsSyncOutput> {
  const hubs = await listRegisteredHubs(fs, home, namespace, tempRoots);
  const ide: IdeHubResult[] = [];
  for (const hub of hubs) {
    const file = join(hub.root, `${basename(hub.root)}.code-workspace`);
    if (hub.state !== "ok") {
      if (options.ide)
        ide.push({ name: hub.name, root: hub.root, action: "skipped", file, reason: hub.state });
      continue;
    }
    if (options.ide)
      ide.push(await syncWorkspaceFile(fs, home, namespace, hub, file, options.dryRun));
  }
  return { dry_run: options.dryRun, ide: options.ide ? { hubs: ide } : null };
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
