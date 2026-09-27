import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { FileSystemPort } from "../ports/file-system.js";
import type { CommitReceipt, GitPort } from "../ports/git.js";
import type { ProcessPort } from "../ports/process.js";
import { readClaimEvents } from "./claims-ledger.js";
import { locateRun, readRun } from "./flow/run-state-service.js";
import type { PathsService } from "./paths-service.js";
import { semanticDigest } from "./semantic-operation/protocol.js";
import { readCustody } from "./session-custody-service.js";
import { listSessionFolders, readSessionState, resolveSessionTarget } from "./session-resolver.js";

export interface WorkspaceCommitProposal {
  repo: string;
  branch: string;
  head: string;
  message: string;
  paths: string[];
  excluded: string[];
  approval: string;
}

export type WorkspaceCommitResult =
  | { proposal: WorkspaceCommitProposal; committed?: CommitReceipt }
  | { error: string };

interface CommitInput {
  code?: string;
  exportPath?: string;
  approval?: string;
}

/** Prepare an exact pathspec; re-derive it before applying an approval, never use `git add .`. */
export async function runWorkspaceCommit(
  fs: FileSystemPort,
  git: GitPort,
  process: ProcessPort | undefined,
  paths: PathsService,
  input: CommitInput,
): Promise<WorkspaceCommitResult> {
  if ((input.code === undefined) === (input.exportPath === undefined))
    return { error: "indicá exactamente --code <sesión> o --export <ruta>" };
  const root = paths.workspaceDir();
  const canonicalRoot = await fs.realPath(root);
  const prefix = await git.repoPrefix(root);
  if (prefix === null) return { error: "el workspace no pertenece a un repositorio Git" };
  const repo = process
    ? await (async () => {
        const location = await process.run("git", ["rev-parse", "--show-toplevel"], { cwd: root });
        return location.code === 0 ? fs.realPath(location.stdout.trim()) : null;
      })()
    : resolve(
        canonicalRoot,
        ...prefix
          .split("/")
          .filter(Boolean)
          .map(() => ".."),
      );
  if (repo === null) return { error: "no se pudo ubicar la raíz del repositorio Git" };
  const branch = await git.currentBranch(repo);
  const head = await git.head(repo);
  if (!branch || !head) return { error: "el repositorio necesita una rama y un HEAD legibles" };
  const selected = input.code
    ? await sessionPaths(fs, paths, input.code)
    : await exportPaths(fs, paths, input.exportPath as string);
  if ("error" in selected) return selected;
  const pathspec = selected.paths.map((path) => safeRepoPath(repo, canonicalRoot, path));
  const escaped = selected.paths.find((_path, index) => pathspec[index] === null);
  if (escaped !== undefined) return { error: `una ruta sale del repositorio: ${escaped}` };
  const pathsToCommit = [...new Set(pathspec as string[])].sort();
  if (!pathsToCommit.length) return { error: "no hay rutas propias para commitear" };
  const excluded = selected.excluded
    .map((path) => safeRepoPath(repo, canonicalRoot, path) ?? path)
    .sort();
  const subject = { repo, branch, head, message: selected.message, paths: pathsToCommit, excluded };
  const proposal: WorkspaceCommitProposal = {
    ...subject,
    approval: semanticDigest(subject),
  };
  if (input.approval === undefined) return { proposal };
  if (input.approval !== proposal.approval)
    return { error: "la propuesta cambió de rama, HEAD o rutas; preparala otra vez" };
  for (const path of pathsToCommit) {
    if (!(await fs.exists(join(repo, path))))
      return { error: `la ruta aprobada falta al aplicar el commit: ${path}` };
  }
  try {
    const committed = await git.commitPaths(repo, proposal.message, pathsToCommit);
    return { proposal, committed };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function safeRepoPath(repo: string, workspace: string, workspacePath: string): string | null {
  const absolute = resolve(workspace, workspacePath);
  const own = relative(workspace, absolute);
  const fromRepo = relative(repo, absolute);
  if (
    !own ||
    own === ".." ||
    own.startsWith(`..${sep}`) ||
    isAbsolute(own) ||
    !fromRepo ||
    fromRepo === ".." ||
    fromRepo.startsWith(`..${sep}`) ||
    isAbsolute(fromRepo)
  )
    return null;
  return fromRepo;
}

async function sessionPaths(
  fs: FileSystemPort,
  paths: PathsService,
  code: string,
): Promise<{ paths: string[]; excluded: string[]; message: string } | { error: string }> {
  const resolved = await resolveSessionTarget(fs, paths, {
    code,
    allowClosed: true,
    intent: "read",
  });
  if (resolved.outcome !== "resolved") return { error: `sesión no resoluble: ${code}` };
  const { folder, path } = resolved.session;
  const custody = await readCustody(fs, path);
  if (custody.status === "unreadable") return { error: custody.reason };
  const documents = new Set<string>();
  if (custody.status === "present") {
    for (const effect of custody.custody.effects) {
      if (effect.kind !== "artifact_published") continue;
      for (const artifact of effect.paths) documents.add(artifact);
    }
  }
  // A proposal is an intent, not a publication. Custody's artifact_published
  // receipts are the only authority for what this session actually wrote.
  const pending = new Set<string>();
  for (const other of await listSessionFolders(fs, paths.cwdSessionsDir())) {
    if (other.name === folder) continue;
    const state = await readSessionState(fs, other.path);
    if (state !== "active" && state !== "paused") continue;
    const owner = await readCustody(fs, other.path);
    if (owner.status === "unreadable") return { error: `custodia ajena ilegible: ${other.name}` };
    if (owner.status === "present") {
      for (const artifact of owner.custody.artifacts) pending.add(artifact.path);
    }
    const otherRun = await readRun(fs, locateRun(paths, other.name));
    if (otherRun.ok)
      for (const artifact of otherRun.state.proposal?.artifacts ?? []) pending.add(artifact.path);
  }
  const excluded = [...documents].filter((path) => pending.has(path)).sort();
  for (const path of excluded) documents.delete(path);
  const archive = join(paths.cwdRoot(), "archive", folder);
  const archived: string[] = [];
  const currentState = await readSessionState(fs, path);
  if (currentState === "closed" || currentState === "abandoned") {
    if (await fs.exists(archive)) {
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await fs.list(dir)) {
          if (entry.type === "dir") await walk(entry.path);
          else if (entry.type === "file") archived.push(relative(paths.workspaceDir(), entry.path));
        }
      };
      await walk(archive);
    }
  } else {
    // Before finalize, predict the exact allowlisted minimum it will copy.
    // CHECKPOINT is created by close even when absent at the human gate.
    const collect = async (dir: string, prefix: string, sqlOnly: boolean): Promise<void> => {
      if (!(await fs.exists(dir)) || (await fs.lstat(dir))?.isSymlink) return;
      for (const entry of await fs.list(dir)) {
        const stat = await fs.lstat(entry.path);
        if (stat?.isSymlink) continue;
        if (stat?.type === "dir") await collect(entry.path, join(prefix, entry.name), sqlOnly);
        else if (stat?.type === "file" && (!sqlOnly || entry.name.toLowerCase().endsWith(".sql")))
          archived.push(relative(paths.workspaceDir(), join(archive, prefix, entry.name)));
      }
    };
    for (const name of ["CHECKPOINT.md", "DECISION.md", "BACKLOG.md"]) {
      if (name === "CHECKPOINT.md" || (await fs.exists(join(path, name))))
        archived.push(relative(paths.workspaceDir(), join(archive, name)));
    }
    for (const entry of await fs.list(path)) {
      if (entry.type === "file" && entry.name.toLowerCase().endsWith(".sql"))
        archived.push(relative(paths.workspaceDir(), join(archive, entry.name)));
    }
    await collect(join(path, "scripts"), "scripts", true);
    await collect(join(path, "evidence"), "evidence", false);
  }
  const ledger = await readClaimEvents(fs, paths);
  if (ledger.unreadable)
    return { error: "claims.jsonl ilegible: no se puede decidir la inclusión" };
  const claimed = ledger.events.some((event) => event.claim.owner === folder);
  const relativeWorkspace = (file: string) => relative(paths.workspaceDir(), file);
  const shared = [relativeWorkspace(paths.cwdHistoryFile())];
  if (claimed) shared.push(relativeWorkspace(join(paths.cwdRoot(), "claims.jsonl")));
  const branches = join(paths.cwdRoot(), "doc-branches.jsonl");
  if (await fs.exists(branches)) shared.push(relativeWorkspace(branches));
  return {
    paths: [...shared, ...archived, ...documents],
    excluded,
    message: `Cerrar sesión ${folder}`,
  };
}

async function exportPaths(
  fs: FileSystemPort,
  paths: PathsService,
  value: string,
): Promise<{ paths: string[]; excluded: string[]; message: string } | { error: string }> {
  if (isAbsolute(value) || value.includes("..") || !value.startsWith("docs/"))
    return { error: "--export requiere una ruta relativa dentro de docs/" };
  const destination = join(paths.workspaceDir(), value);
  if (!(await fs.exists(destination))) return { error: `export no encontrado: ${value}` };
  const files: string[] = [];
  const walk = async (path: string): Promise<void> => {
    const stat = await fs.lstat(path);
    if (stat?.isSymlink) return;
    if (stat?.type === "file") files.push(relative(paths.workspaceDir(), path));
    if (stat?.type === "dir") for (const entry of await fs.list(path)) await walk(entry.path);
  };
  await walk(destination);
  return {
    paths: [...files, relative(paths.workspaceDir(), paths.cwdHistoryFile())],
    excluded: [],
    message: `Exportar ${value}`,
  };
}
