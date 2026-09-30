import { join, relative } from "node:path";
import type { FileSystemPort } from "../ports/file-system.js";
import type { GitPort } from "../ports/git.js";
import { unlinkUnitDependencies } from "./unit-dependencies.js";

/** Fail closed before removing an unregistered folder; never follow a link. */
export async function residueBlockers(
  fs: FileSystemPort,
  git: GitPort,
  source: string,
  unit: string,
  branch: string | null,
): Promise<string[]> {
  if (!branch?.startsWith("aw/")) return ["la carpeta no tiene rama aw/* comprobable"];
  const root = await fs.lstat(unit);
  if (root?.type !== "dir" || root.isSymlink)
    return [`la ruta ${unit} no es un directorio de unidad sin enlaces`];
  if (
    !git.treeEntries ||
    !git.hashWorktreePath ||
    !git.worktreeFileMode ||
    !git.ignoredOutsideIndex
  )
    return ["git no puede comprobar los archivos recuperables"];
  const ignoredOutsideIndex = git.ignoredOutsideIndex.bind(git);
  const worktreeFileMode = git.worktreeFileMode.bind(git);
  const hashWorktreePath = git.hashWorktreePath.bind(git);
  const tip = await git.refValue(source, `refs/heads/${branch}`);
  if (tip === null) return [`la rama ${branch} ya no existe: no se puede comprobar su árbol`];
  const tracked = new Map((await git.treeEntries(source, tip)).map((entry) => [entry.path, entry]));
  const trackedPaths = [...tracked.keys()];
  const blockers: string[] = [];
  const rootIgnoreMissing = (await fs.lstat(join(unit, ".gitignore"))) === null;
  const ignored = async (name: string): Promise<boolean> =>
    (await ignoredOutsideIndex(source, unit, name)) ||
    (rootIgnoreMissing &&
      git.ignoredInSource !== undefined &&
      (await git.ignoredInSource(source, name)));
  async function checkTrackedFile(path: string, name: string, isSymlink: boolean): Promise<void> {
    const expected = tracked.get(name);
    if (expected !== undefined) {
      const mode = await worktreeFileMode(path);
      const hash = await hashWorktreePath(source, path, isSymlink);
      if (expected.mode !== mode || expected.hash !== hash) blockers.push(name);
    } else if (!(await ignored(name))) blockers.push(name);
  }
  async function visitPath(path: string): Promise<void> {
    const name = relative(unit, path).split("\\").join("/");
    const stat = await fs.lstat(path);
    if (stat === null) return;
    if (name === ".git" && stat.type === "file") return;
    if (
      name === "node_modules" &&
      stat.isSymlink &&
      (await fs.realPath(path)) === (await fs.realPath(join(source, "node_modules")))
    )
      return;
    if (stat.type === "dir" && !stat.isSymlink) {
      if (
        (await ignored(name)) &&
        !trackedPaths.some((trackedPath) => trackedPath.startsWith(`${name}/`))
      )
        return;
      await visit(path);
      return;
    }
    await checkTrackedFile(path, name, stat.isSymlink);
  }
  async function visit(folder: string): Promise<void> {
    for (const item of await fs.list(folder)) await visitPath(item.path);
  }
  await visit(unit);
  return blockers;
}

/** A directory is dropped only after its complete content is known recoverable. */
export async function finishResidue(
  fs: FileSystemPort,
  git: GitPort,
  source: string,
  unit: string,
  branch: string | null,
): Promise<string[]> {
  const blockers = await residueBlockers(fs, git, source, unit, branch);
  if (blockers.length > 0) return blockers;
  await unlinkUnitDependencies(fs, source, unit);
  await fs.remove(unit);
  return [];
}
