import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DirEntry, FileStat, FileSystemPort, LinkStat } from "../ports/file-system.js";
import { acquireLock } from "./lock-service.js";
import type { PathsService } from "./paths-service.js";

/** Machine-local runtime paths which must never become project history. */
export function runtimeGitignoreEntries(namespace: string): string[] {
  return [
    `.${namespace}/sessions/`,
    `.${namespace}/.lock`,
    `.${namespace}/processes.json`,
    `.${namespace}/launch/`,
    "docs/logs/",
  ];
}

export const RUNTIME_GITIGNORE_HEADER =
  "# agent-workflow runtime (machine-specific — do not commit)";

export interface MaterializationEffect {
  kind: "gitignore" | "sessions";
  path: string;
  status: "created" | "updated" | "existing" | "skipped";
}

/** Every observable effect of one first-write materialization. */
export interface WorklineMaterialization {
  root: string;
  namespace: string;
  materialized: boolean;
  effects: MaterializationEffect[];
}

/**
 * A filesystem boundary for command dispatch.
 *
 * Most mutations are deliberately implemented in small domain services rather
 * than funnelled through one giant command switch.  That is good for their
 * local contracts, but it used to leave a hole: a direct writer such as
 * `next-number --publish` could create `docs/` before the Workline runtime had
 * a canonical marker.  This adapter closes that hole without making reads (or
 * invalid command paths that never write) materialize a workspace.
 *
 * It uses the underlying filesystem to materialize, never itself, so the
 * materializer's lock and marker writes cannot recursively re-enter the guard.
 * The first successful workspace-scoped write retains its receipt for the CLI
 * dispatcher to expose alongside the command result.
 */
export class MaterializingWorkspaceFileSystem implements FileSystemPort {
  private receipt: WorklineMaterialization | undefined;
  private materializing: Promise<WorklineMaterialization> | undefined;
  private readonly root: string;

  constructor(
    private readonly delegate: FileSystemPort,
    private readonly paths: PathsService,
  ) {
    this.root = resolve(paths.workspaceDir());
  }

  /** The materialization this dispatch caused, if its command wrote locally. */
  materialization(): WorklineMaterialization | undefined {
    return this.receipt;
  }

  /**
   * Reuse the same operation when a service explicitly asks to materialize.
   * This is what keeps service-level callers and the dispatcher guard from
   * racing each other or turning a newly-created receipt into an "existing"
   * one.
   */
  async ensureMaterialized(): Promise<WorklineMaterialization> {
    if (this.receipt !== undefined) return this.receipt;
    if (this.materializing !== undefined) {
      this.receipt = await this.materializing;
      return this.receipt;
    }
    const materializing = ensureWorklineMaterialized(this.delegate, this.paths);
    this.materializing = materializing;
    try {
      this.receipt = await materializing;
      return this.receipt;
    } finally {
      if (this.materializing === materializing) this.materializing = undefined;
    }
  }

  async readText(path: string): Promise<string> {
    return await this.delegate.readText(path);
  }

  async readBytes(path: string): Promise<Uint8Array> {
    return await this.delegate.readBytes(path);
  }

  async writeText(path: string, content: string): Promise<void> {
    await this.beforeWorkspaceMutation(path);
    await this.delegate.writeText(path, content);
  }

  async appendText(path: string, content: string): Promise<void> {
    await this.beforeWorkspaceMutation(path);
    await this.delegate.appendText(path, content);
  }

  async writeTextExclusive(path: string, content: string): Promise<{ created: boolean }> {
    await this.beforeWorkspaceMutation(path);
    return await this.delegate.writeTextExclusive(path, content);
  }

  async publishTextExclusive(path: string, content: string): Promise<{ created: boolean }> {
    await this.beforeWorkspaceMutation(path);
    return await this.delegate.publishTextExclusive(path, content);
  }

  async remove(path: string): Promise<void> {
    await this.beforeWorkspaceMutation(path);
    await this.delegate.remove(path);
  }

  async exists(path: string): Promise<boolean> {
    return await this.delegate.exists(path);
  }

  async list(path: string): Promise<DirEntry[]> {
    return await this.delegate.list(path);
  }

  async mkdirp(path: string): Promise<void> {
    await this.beforeWorkspaceMutation(path);
    await this.delegate.mkdirp(path);
  }

  async stat(path: string): Promise<FileStat> {
    return await this.delegate.stat(path);
  }

  async symlink(target: string, path: string): Promise<void> {
    await this.beforeWorkspaceMutation(path);
    await this.delegate.symlink(target, path);
  }

  async lstat(path: string): Promise<LinkStat | null> {
    return await this.delegate.lstat(path);
  }

  async realPath(path: string): Promise<string> {
    return await this.delegate.realPath(path);
  }

  private async beforeWorkspaceMutation(path: string): Promise<void> {
    if (!this.isWorkspacePath(path) || this.receipt !== undefined) return;
    await this.ensureMaterialized();
  }

  private isWorkspacePath(path: string): boolean {
    const candidate = resolve(path);
    // `relative` is the containment primitive rather than a string prefix:
    // Node uses `\\` on Windows, while a literal `"/"` would leave every
    // nested workspace write unguarded there. It also handles `root === "/"`
    // without constructing the accidental prefix `"//"`.
    const fromRoot = relative(this.root, candidate);
    return (
      fromRoot.length === 0 ||
      (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot))
    );
  }
}

/** True only for the canonical marker; a bare `.<ns>/` is not a workspace. */
export async function hasCanonicalSessionsMarker(
  fs: FileSystemPort,
  paths: PathsService,
): Promise<boolean> {
  try {
    return (await fs.stat(paths.cwdSessionsDir())).type === "dir";
  } catch {
    return false;
  }
}

/**
 * Materialize the minimum runtime state exactly once, under the workspace lock.
 *
 * The lock itself may temporarily create `.<ns>/`, but it deliberately does not
 * create the canonical `sessions/` marker.  The marker is created last, after
 * the optional Git ignore block, so every reader either sees an implicit root or
 * a fully usable materialized Workline directory.
 */
export async function ensureWorklineMaterialized(
  fs: FileSystemPort,
  paths: PathsService,
): Promise<WorklineMaterialization> {
  // Services may receive the dispatcher guard directly. Delegate back to it so
  // their explicit materialization participates in the same receipt rather
  // than recursively intercepting the lock's own writes.
  if (fs instanceof MaterializingWorkspaceFileSystem) return await fs.ensureMaterialized();
  const root = paths.workspaceDir();
  const base = {
    root,
    namespace: paths.namespace,
  };
  if (await hasCanonicalSessionsMarker(fs, paths)) {
    return {
      ...base,
      materialized: false,
      effects: [{ kind: "sessions", path: paths.cwdSessionsDir(), status: "existing" }],
    };
  }

  // Remove the lock atomically on release.  Leaving the legacy empty lock file
  // behind would make a virgin first write create more runtime state than the
  // materialization contract declares.
  const lock = await acquireLock(paths.cwdLockFile(), fs, {
    removeOnRelease: true,
    // Two first writes are one logical materialization race, not a reason for a
    // caller to retry a command that has not yet done any work of its own.
    waitMs: 1_000,
    waitStepMs: 5,
  });
  try {
    if (await hasCanonicalSessionsMarker(fs, paths)) {
      return {
        ...base,
        materialized: false,
        effects: [{ kind: "sessions", path: paths.cwdSessionsDir(), status: "existing" }],
      };
    }

    const effects: MaterializationEffect[] = [];
    const git = await belongsToGit(fs, root);
    if (git) {
      const gitignore = join(root, ".gitignore");
      const before = await gitignoreEffectStatus(
        fs,
        root,
        runtimeGitignoreEntries(paths.namespace),
      );
      const changed = await appendGitignoreEntries(
        fs,
        root,
        RUNTIME_GITIGNORE_HEADER,
        runtimeGitignoreEntries(paths.namespace),
      );
      effects.push({
        kind: "gitignore",
        path: gitignore,
        // The lock makes `before` authoritative. Keep the defensive fallback
        // for an unusual filesystem that reports a changed write after a
        // concurrent/manual rewrite.
        status: changed ? (before === "existing" ? "updated" : before) : "existing",
      });
    } else {
      effects.push({ kind: "gitignore", path: join(root, ".gitignore"), status: "skipped" });
    }

    // `acquireLock` created the parent `.<ns>/` if necessary.  Keep this call
    // last: `sessions/` is the only public marker a resolver is allowed to use.
    await fs.mkdirp(paths.cwdSessionsDir());
    effects.push({ kind: "sessions", path: paths.cwdSessionsDir(), status: "created" });
    return { ...base, materialized: true, effects };
  } finally {
    await lock.release();
  }
}

/** Preview the same receipt without creating a lock, marker or .gitignore. */
export async function previewWorklineMaterialization(
  fs: FileSystemPort,
  paths: PathsService,
): Promise<WorklineMaterialization> {
  const root = paths.workspaceDir();
  const sessions = await hasCanonicalSessionsMarker(fs, paths);
  const git = await belongsToGit(fs, root);
  const gitignore = join(root, ".gitignore");
  return {
    root,
    namespace: paths.namespace,
    materialized: !sessions,
    effects: [
      {
        kind: "gitignore",
        path: gitignore,
        status: !git
          ? "skipped"
          : await gitignoreEffectStatus(fs, root, runtimeGitignoreEntries(paths.namespace)),
      },
      { kind: "sessions", path: paths.cwdSessionsDir(), status: sessions ? "existing" : "created" },
    ],
  };
}

/** The receipt status a runtime gitignore operation would have, without writing. */
async function gitignoreEffectStatus(
  fs: FileSystemPort,
  workspace: string,
  entries: readonly string[],
): Promise<Extract<MaterializationEffect["status"], "created" | "updated" | "existing">> {
  const file = join(workspace, ".gitignore");
  if (!(await fs.exists(file))) return "created";
  let text: string;
  try {
    text = await fs.readText(file);
  } catch {
    // A file that disappeared/read-failed after exists is going to be created
    // by the write path; preview the conservative effect rather than claiming
    // it was already complete.
    return "created";
  }
  const present = new Set(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
  return entries.every((entry) => present.has(entry)) ? "existing" : "updated";
}

/**
 * Check Git membership without using it as a workspace-root heuristic.  A
 * nested implicit Workline remains rooted at its invoked cwd; Git only decides
 * whether that root's own `.gitignore` should receive the runtime block.
 */
async function belongsToGit(fs: FileSystemPort, start: string): Promise<boolean> {
  let dir = start;
  while (true) {
    if (await fs.exists(join(dir, ".git"))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * Add missing entries beneath one owned block, preserving user lines and EOL.
 * Returns whether this call wrote the file.
 */
export async function appendGitignoreEntries(
  fs: FileSystemPort,
  workspace: string,
  header: string,
  entries: readonly string[],
): Promise<boolean> {
  const file = join(workspace, ".gitignore");
  const existing = (await fs.exists(file)) ? await fs.readText(file) : "";
  const lines = existing.split(/\r?\n/);
  const present = new Set(lines.map((line) => line.trim()).filter((line) => line.length > 0));
  const missing = entries.filter((entry) => !present.has(entry));
  if (missing.length === 0) return false;

  const headerIdx = lines.findIndex((line) => line.trim() === header);
  if (headerIdx >= 0) {
    let end = headerIdx + 1;
    while (end < lines.length && (lines[end] ?? "").trim().length > 0) end++;
    lines.splice(end, 0, ...missing);
    const eol = existing.includes("\r\n") ? "\r\n" : "\n";
    await fs.writeText(file, lines.join(eol));
    return true;
  }

  const block = `${header}\n${missing.join("\n")}\n`;
  const body = existing.replace(/\s+$/, "");
  await fs.writeText(file, body.length === 0 ? block : `${body}\n\n${block}`);
  return true;
}
