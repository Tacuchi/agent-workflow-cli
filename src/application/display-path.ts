import { sep } from "node:path";

/**
 * `~` for a path under `home`, the path itself otherwise. Presentation only —
 * the result names a file to a person and never goes back to the file system.
 */
export function homeRelative(path: string, home: string): string {
  const base = home.replace(/[\\/]+$/, "");
  if (path === base) return "~";
  return path.startsWith(`${base}${sep}`) ? `~${path.slice(base.length)}` : path;
}
