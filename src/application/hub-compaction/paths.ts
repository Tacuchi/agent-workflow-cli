import { isAbsolute, join, relative, resolve } from "node:path";
import type { FileSystemPort } from "../../ports/file-system.js";
import type { PathsService } from "../paths-service.js";

export function compactionError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code: `COMPACTION_${code}` });
}

export function safeRelative(path: string): string {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.includes(":") ||
    path.split("/").some((part) => !part || part === "." || part === "..") ||
    Array.from(path).some((character) => character.charCodeAt(0) < 32)
  ) {
    throw compactionError("PATH", `Ruta relativa inválida: ${path}`);
  }
  return path;
}

/** Check every component, including an absent destination's existing parents. */
export async function inside(fs: FileSystemPort, root: string, path: string): Promise<string> {
  safeRelative(path);
  const rootReal = await fs.realPath(root);
  let current = rootReal;
  for (const part of path.split("/")) {
    current = join(current, part);
    const entry = await fs.lstat(current);
    if (entry?.isSymlink) throw compactionError("PATH", `Enlace protegido: ${path}`);
    const actual = relative(rootReal, await fs.realPath(current));
    if (isAbsolute(actual) || actual === ".." || actual.startsWith("../")) {
      throw compactionError("PATH", `Ruta externa: ${path}`);
    }
  }
  return resolve(rootReal, path);
}

export function catalogRelative(paths: PathsService): string {
  return `.${paths.namespace}/compactions`;
}

export function operationRelative(paths: PathsService, id: string): string {
  if (!/^[a-f0-9]{64}$/u.test(id)) throw compactionError("ID", "Id de compactación inválido");
  return `${catalogRelative(paths)}/${id}`;
}
