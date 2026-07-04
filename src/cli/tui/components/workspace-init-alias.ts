// Alias inference for the workspace-init form. Deliberately cross-platform:
// splits on `/` and `\` without relying on `path.basename` (which on POSIX
// does not split on `\`, so it would break on Windows paths typed on a posix
// machine and in the tests). The alias is the folder name as-is (untransformed).

/** A source's alias = its folder name (last path segment). */
export function deriveAlias(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const segment = trimmed.split(/[/\\]/).pop() ?? "";
  return segment || trimmed || path;
}

/** Suffixes -2, -3, … when two sources share a folder name. Does not mutate `seen`. */
export function dedupeAlias(alias: string, seen: Set<string>): string {
  let candidate = alias;
  let n = 2;
  while (seen.has(candidate)) candidate = `${alias}-${n++}`;
  return candidate;
}
