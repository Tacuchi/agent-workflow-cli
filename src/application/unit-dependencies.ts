import { join } from "node:path";
import type { FileSystemPort } from "../ports/file-system.js";
import type { GitPort } from "../ports/git.js";

const LOCKFILES = ["npm-shrinkwrap.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"];

export interface UnitDependencyState {
  status: "linked" | "not_linked";
  message: string;
}

/** A unit never installs into the source; it only borrows an identical installation. */
export async function linkUnitDependencies(
  fs: FileSystemPort,
  git: GitPort,
  source: string,
  unit: string,
): Promise<UnitDependencyState> {
  const modules = join(source, "node_modules");
  const unitModules = join(unit, "node_modules");
  const sourceModules = await fs.lstat(modules);
  if (sourceModules === null || sourceModules.type !== "dir")
    return {
      status: "not_linked",
      message: "sin node_modules en la fuente; instalá dependencias en la unidad",
    };

  const matchingLock = await firstLock(fs, unit);
  if (
    matchingLock === null ||
    (await firstLock(fs, source)) !== matchingLock ||
    !(await sameBytes(fs, join(source, "package.json"), join(unit, "package.json"))) ||
    !(await sameBytes(fs, join(source, matchingLock), join(unit, matchingLock)))
  ) {
    const install = installCommand(matchingLock);
    return {
      status: "not_linked",
      message: `manifiesto o lockfile distinto o ausente; quitá cualquier enlace antes de instalar y corré '${install}' en la unidad`,
    };
  }

  const present = await fs.lstat(unitModules);
  if (present !== null) {
    if (!present.isSymlink || (await fs.realPath(unitModules)) !== (await fs.realPath(modules)))
      return {
        status: "not_linked",
        message: "node_modules propio en la unidad; no se sustituye ni se modifica",
      };
  } else {
    await fs.symlink(modules, unitModules);
  }
  try {
    await ensureModulesIgnored(git, source, unit);
  } catch (err) {
    if (present === null) await fs.remove(unitModules);
    throw err;
  }
  return {
    status: "linked",
    message:
      "node_modules enlazado con la fuente: instalar aquí escribe en la fuente; npm ci vaciaría su node_modules. Quitá el enlace 'node_modules' antes de instalar en la unidad",
  };
}

async function firstLock(fs: FileSystemPort, root: string): Promise<string | null> {
  for (const lock of LOCKFILES) if ((await fs.lstat(join(root, lock))) !== null) return lock;
  return null;
}

async function sameBytes(fs: FileSystemPort, left: string, right: string): Promise<boolean> {
  try {
    const a = await fs.readBytes(left);
    const b = await fs.readBytes(right);
    return Buffer.from(a).equals(Buffer.from(b));
  } catch {
    return false;
  }
}

/** A link is ours only when its resolved target is the source installation. */
export async function unlinkUnitDependencies(
  fs: FileSystemPort,
  source: string,
  unit: string,
): Promise<boolean> {
  const path = join(unit, "node_modules");
  const link = await fs.lstat(path);
  if (
    !link?.isSymlink ||
    (await fs.realPath(path)) !== (await fs.realPath(join(source, "node_modules")))
  )
    return false;
  await fs.remove(path);
  return true;
}

/** Shared by release, integrate, reclaim and retirement. No recursive traversal of a link. */
export async function removeUnitSafely(
  fs: FileSystemPort,
  git: GitPort,
  source: string,
  unit: string,
): Promise<void> {
  if ((await git.operationState(unit)) !== "clean" || (await git.isDirty(unit)))
    throw new Error(`la unidad ${unit} tiene cambios sin commitear u operación git pendiente`);
  const removedLink = await unlinkUnitDependencies(fs, source, unit);
  try {
    await git.worktreeRemove(source, unit);
  } catch (err) {
    if (removedLink && (await fs.lstat(unit)) !== null)
      await fs.symlink(join(source, "node_modules"), join(unit, "node_modules"));
    throw err;
  }
}

function installCommand(matchingLock: string | null): string {
  const install =
    matchingLock === "package-lock.json" || matchingLock === "npm-shrinkwrap.json"
      ? "npm ci"
      : matchingLock === "yarn.lock"
        ? "yarn install --frozen-lockfile"
        : matchingLock === "pnpm-lock.yaml"
          ? "pnpm install --frozen-lockfile"
          : "npm install";
  return install;
}

async function ensureModulesIgnored(git: GitPort, source: string, unit: string): Promise<void> {
  if (!git.ignoredOutsideIndex || !git.excludePattern)
    throw new Error("git no permite verificar el ignore de node_modules");
  if (!(await git.ignoredOutsideIndex(source, unit, "node_modules"))) {
    await git.excludePattern(source, "/node_modules");
    if (!(await git.ignoredOutsideIndex(source, unit, "node_modules")))
      throw new Error("git sigue mostrando node_modules como no rastreado");
  }
}
