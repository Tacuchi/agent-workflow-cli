import { execFile } from "node:child_process";
import { readdir, rename } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { workspaceKey } from "../domain/isolation-unit.js";
import { custodyCompleteness, sealCustody } from "../domain/session/custody.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { isWorklineRoot } from "../runtime/workline-marker.js";
import { repositoryRoot } from "../runtime/workspace-resolution.js";
import { declaringHubs, registerHub } from "./hub-registry.js";
import { readWorkspaceBlock } from "./parsers/project-block.js";
import { PathsService } from "./paths-service.js";
import { readCustody, writeCustody } from "./session-custody-service.js";
import { listSessionFolders } from "./session-resolver.js";
import { hubUnitPaths } from "./unit-membership.js";
import { type WorkspaceLocalConfig, readWorkspaceLocalConfig } from "./workspace-local-config.js";

const git = promisify(execFile);

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function relocate(path: string, oldRoot: string, newRoot: string): string {
  return within(oldRoot, path) ? join(newRoot, relative(oldRoot, path)) : path;
}

export interface WorkspaceMoveResult {
  from: string;
  to: string;
  moved: boolean;
  dry_run: boolean;
  changes: string[];
  warnings: string[];
}

export async function moveWorkspace(
  fs: FileSystemPort,
  paths: PathsService,
  options: {
    destination?: string;
    repair: boolean;
    from?: string;
    dryRun: boolean;
    renameWorkspace?: typeof rename;
  },
): Promise<WorkspaceMoveResult> {
  const root = paths.workspaceDir();
  const home = dirname(paths.userRoot());
  if (!(await fs.exists(paths.cwdMarkerFile())) && !(await fs.exists(paths.cwdSessionsDir()))) {
    throw new Error(`${root} no es un workspace materializado`);
  }
  const next = options.repair ? root : resolve(root, "..", options.destination ?? "");
  await validateMoveDestination(fs, paths, options, root, home, next);
  const sessions = await listSessionFolders(fs, paths.cwdSessionsDir());
  const candidates = await previousWorkspaceRoots(fs, sessions);
  // Legacy or empty hubs have no subject path from which to infer the old root.
  const inferredRoot = inferMoveOrigin(options, candidates, root);
  const changes: string[] = [];
  const warnings: string[] = [];
  const local = await readWorkspaceLocalConfig(fs, paths.cwdLocalConfigFile());
  if (local.config === null) throw new Error(`local.json ilegible: ${local.error}`);
  const oldRoot = repairOrigin(inferredRoot, root, options.repair, local.config);
  if (oldRoot === null) {
    return { from: root, to: root, moved: false, dry_run: options.dryRun, changes, warnings };
  }
  await fixExternalSourcePaths(fs, paths, root, options.repair, local.config, changes);
  if (!options.dryRun && !options.repair && changes.length > 0) {
    await fs.writeText(paths.cwdLocalConfigFile(), `${JSON.stringify(local.config, null, 2)}\n`);
  }
  if (!options.repair && !options.dryRun) {
    await renameWorkspaceRoot(root, next, options.renameWorkspace ?? rename);
  }
  if (options.dryRun) {
    return previewWorkspaceMove(
      fs,
      sessions,
      root,
      oldRoot,
      next,
      options.repair,
      changes,
      warnings,
    );
  }

  return finishWorkspaceMove(fs, paths, home, oldRoot, next, options.repair, changes, warnings);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

type MoveOptions = Parameters<typeof moveWorkspace>[2];

async function validateMoveDestination(
  fs: FileSystemPort,
  paths: PathsService,
  options: MoveOptions,
  root: string,
  home: string,
  next: string,
): Promise<void> {
  if (!options.repair && !options.destination) throw new Error("Indica un destino para hub-move.");
  if (!options.repair && (await fs.exists(next))) throw new Error(`El destino ${next} ya existe.`);
  if (
    next === home ||
    (!options.repair && (within(root, next) || within(paths.userUnitsDir(), next)))
  )
    throw new Error(`Destino de workspace inválido: ${next}`);
  if (!options.repair) await rejectNestedWorkspace(fs, paths, next);
  const journal = join(paths.cwdRoot(), ".retirement");
  if ((await fs.exists(journal)) && (await readdir(journal)).length > 0)
    throw new Error("Hay un retiro en curso; termina el retiro antes de mover o reparar.");
  if (!options.repair) await rejectActiveMoveLock(fs, paths);
  if (
    !options.repair &&
    (await repositoryRoot(next)) !== null &&
    (await declaringHubs(fs, home, paths.namespace, next)).length > 0
  ) {
    throw new Error(`El destino ${next} está dentro de una fuente declarada.`);
  }
}

async function previousWorkspaceRoots(
  fs: FileSystemPort,
  sessions: Awaited<ReturnType<typeof listSessionFolders>>,
): Promise<Set<string>> {
  const candidates = new Set<string>();
  for (const folder of sessions) {
    const read = await readCustody(fs, folder.path);
    if (read.status === "present" && read.custody.subject_path.endsWith(`/${folder.name}`)) {
      candidates.add(dirname(dirname(dirname(read.custody.subject_path))));
    }
  }
  return candidates;
}

async function fixExternalSourcePaths(
  fs: FileSystemPort,
  paths: PathsService,
  root: string,
  repair: boolean,
  config: WorkspaceLocalConfig,
  changes: string[],
): Promise<void> {
  const block = await readWorkspaceBlock(fs, root, paths.blockMarkers());
  // External relative paths would change identity on rename. Fix them before moving.
  for (const source of block?.fuentes ?? []) {
    if (
      !source.path ||
      !source.declared_path ||
      isAbsolute(source.declared_path) ||
      source.declared_path === "(local)"
    )
      continue;
    if (!repair && !within(root, source.path)) {
      config.sources[source.alias] = source.path;
      changes.push(`fuente externa ${source.alias} fijada en local.json`);
    }
  }
}

async function renameWorkspaceRoot(
  root: string,
  next: string,
  renameWorkspace: typeof rename,
): Promise<void> {
  try {
    if (within(root, process.cwd())) process.chdir(dirname(root));
    await renameWorkspace(root, next);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EXDEV")
      throw new Error(
        "No se puede renombrar entre discos: mueve el hub a mano y ejecuta hub-move --repair.",
      );
    if (code === "EPERM" || code === "EBUSY")
      throw new Error(
        `No se puede mover ${root} (${code}): cierra los procesos que lo usan y reintenta.`,
      );
    throw error;
  }
}

async function previewWorkspaceMove(
  fs: FileSystemPort,
  sessions: Awaited<ReturnType<typeof listSessionFolders>>,
  root: string,
  oldRoot: string,
  next: string,
  repair: boolean,
  changes: string[],
  warnings: string[],
): Promise<WorkspaceMoveResult> {
  changes.push(`local.json: clave anterior ${workspaceKey(oldRoot)}`);
  for (const session of sessions) {
    const custody = await readCustody(fs, session.path);
    if (custody.status === "present" && custodyCompleteness(custody.custody).complete)
      changes.push(`custodia ${session.name}`);
    else if (custody.status === "unreadable" || custody.status === "present")
      warnings.push(`Custodia ${session.name} ilegible o editada: no se re-sella.`);
  }
  for (const file of [
    join(root, ".claude", "settings.local.json"),
    join(root, ".codex", "config.toml"),
  ]) {
    if ((await fs.exists(file)) && (await fs.readText(file)).includes(oldRoot)) changes.push(file);
  }
  changes.push("registro de hubs");
  return { from: oldRoot, to: next, moved: !repair, dry_run: true, changes, warnings };
}

async function recoverExternalSources(
  fs: FileSystemPort,
  newPaths: PathsService,
  next: string,
  oldRoot: string,
  config: WorkspaceLocalConfig,
  changes: string[],
): Promise<void> {
  const relocatedBlock = await readWorkspaceBlock(fs, next, newPaths.blockMarkers());
  for (const source of relocatedBlock?.fuentes ?? []) {
    const declared = source.declared_path;
    if (!declared || isAbsolute(declared) || declared === "(local)" || config.sources[source.alias])
      continue;
    const original = resolve(oldRoot, declared);
    if (!within(oldRoot, original) && (await fs.exists(original))) {
      config.sources[source.alias] = original;
      changes.push(`fuente relativa externa ${source.alias} recuperada desde ${oldRoot}`);
    }
  }
}

async function relocateSessionCustody(
  fs: FileSystemPort,
  newPaths: PathsService,
  oldRoot: string,
  next: string,
  changes: string[],
  warnings: string[],
): Promise<void> {
  for (const folder of await listSessionFolders(fs, newPaths.cwdSessionsDir())) {
    const read = await readCustody(fs, folder.path);
    if (read.status === "absent") continue;
    if (read.status === "unreadable" || !custodyCompleteness(read.custody).complete) {
      warnings.push(`Custodia ${folder.name} ilegible o editada: no se re-sella.`);
      continue;
    }
    const prior = read.custody;
    const subject = relocate(prior.subject_path, oldRoot, next);
    const sources = prior.sources.map((source) => ({
      ...source,
      path: relocate(source.path, oldRoot, next),
    }));
    if (
      subject !== prior.subject_path ||
      sources.some((source, i) => source.path !== prior.sources[i]?.path)
    ) {
      await writeCustody(
        fs,
        folder.path,
        sealCustody({
          subject: prior.subject,
          subjectPath: subject,
          parents: prior.parents,
          created: prior.created,
          artifacts: prior.artifacts,
          sources,
          effects: prior.effects,
        }),
      );
      changes.push(`custodia ${folder.name}`);
    }
  }
}

async function relocateHostPaths(
  fs: FileSystemPort,
  oldRoot: string,
  next: string,
  changes: string[],
): Promise<void> {
  for (const file of [
    join(next, ".claude", "settings.local.json"),
    join(next, ".codex", "config.toml"),
  ]) {
    if (!(await fs.exists(file))) continue;
    const before = await fs.readText(file);
    // Replace only a path component, not a sibling like /hub-old-backup.
    const escaped = oldRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const after = before.replace(new RegExp(`${escaped}(?=[/"'])`, "g"), next);
    if (after !== before) {
      await fs.writeText(file, after);
      changes.push(file);
    }
  }
}

async function repairUnitLinks(
  fs: FileSystemPort,
  newPaths: PathsService,
  next: string,
  changes: string[],
  warnings: string[],
): Promise<void> {
  const sources = await readWorkspaceBlock(fs, next, newPaths.blockMarkers());
  const unitsRoot = await fs.realPath(newPaths.userUnitsDir()).catch(() => newPaths.userUnitsDir());
  const owns = await hubUnitPaths(fs, newPaths, unitsRoot);
  for (const source of sources?.fuentes ?? []) {
    if (!source.path || !within(next, source.path)) continue;
    try {
      const units = await git("git", ["-C", source.path, "worktree", "list", "--porcelain"]);
      const paths = [...units.stdout.matchAll(/^worktree (.+)$/gm)]
        .map((match) => match[1])
        .filter((path): path is string => path !== undefined);
      const mine = paths.filter(owns);
      if (mine.length) {
        await git("git", ["-C", source.path, "worktree", "repair", ...mine]);
        changes.push(`enlaces git de ${source.alias}`);
      }
    } catch (error) {
      warnings.push(`git worktree repair ${source.alias}: ${String(error)}`);
    }
  }
}

function repairOrigin(
  oldRoot: string | null | undefined,
  root: string,
  repair: boolean,
  config: WorkspaceLocalConfig,
): string | null {
  if (oldRoot == null) {
    if (repair && Array.isArray(config.previous_keys) && config.previous_keys.length > 0)
      return null;
    throw new Error("No se puede deducir una raíz vieja única; indica --from <ruta>.");
  }
  if (repair && oldRoot === root) {
    if (Array.isArray(config.previous_keys) && config.previous_keys.length > 0) {
      return null;
    }
    throw new Error(
      "El workspace ya está en su ubicación registrada; indica --from si necesitas reparar otra ruta.",
    );
  }
  return oldRoot;
}

async function finishWorkspaceMove(
  fs: FileSystemPort,
  paths: PathsService,
  home: string,
  oldRoot: string,
  next: string,
  repair: boolean,
  changes: string[],
  warnings: string[],
): Promise<WorkspaceMoveResult> {
  const newPaths = new PathsService(paths.namespace, home, next);
  const fixed = await readWorkspaceLocalConfig(fs, newPaths.cwdLocalConfigFile());
  if (fixed.config === null) throw new Error(`local.json ilegible: ${fixed.error}`);
  if (repair) {
    await recoverExternalSources(fs, newPaths, next, oldRoot, fixed.config, changes);
  }
  for (const [alias, path] of Object.entries(fixed.config.sources)) {
    fixed.config.sources[alias] = relocate(path, oldRoot, next);
  }
  const keys = new Set(
    Array.isArray(fixed.config.previous_keys) ? (fixed.config.previous_keys as string[]) : [],
  );
  keys.add(workspaceKey(oldRoot));
  fixed.config.previous_keys = [...keys];
  await fs.writeText(newPaths.cwdLocalConfigFile(), `${JSON.stringify(fixed.config, null, 2)}\n`);
  changes.push("rutas locales y claves anteriores");

  await relocateSessionCustody(fs, newPaths, oldRoot, next, changes, warnings);

  await relocateHostPaths(fs, oldRoot, next, changes);

  await repairUnitLinks(fs, newPaths, next, changes, warnings);
  await registerHub(fs, newPaths, next);
  changes.push("registro de hubs");
  return { from: oldRoot, to: next, moved: !repair, dry_run: false, changes, warnings };
}

async function rejectNestedWorkspace(
  fs: FileSystemPort,
  paths: PathsService,
  next: string,
): Promise<void> {
  let ancestor = dirname(next);
  while (ancestor !== dirname(ancestor)) {
    if (await isWorklineRoot(fs, ancestor, paths.namespace))
      throw new Error(`El destino ${next} cae dentro del workspace ${ancestor}.`);
    ancestor = dirname(ancestor);
  }
}

async function rejectActiveMoveLock(fs: FileSystemPort, paths: PathsService): Promise<void> {
  if (await fs.exists(paths.cwdLockFile())) {
    try {
      const lock = JSON.parse(await fs.readText(paths.cwdLockFile())) as { pid?: number };
      if (lock.pid && processAlive(lock.pid))
        throw new Error("Hay un candado de corrida en uso; espera a que termine antes de mover.");
    } catch (error) {
      if (error instanceof Error && error.message.includes("candado")) throw error;
    }
  }
}

function inferMoveOrigin(
  options: MoveOptions,
  candidates: Set<string>,
  root: string,
): string | null | undefined {
  const inferredRoot = options.repair
    ? (options.from ?? (candidates.size === 1 ? [...candidates][0] : null))
    : root;
  return inferredRoot;
}
