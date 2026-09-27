/** Both the category layout and published flat bundles share one rollback rule. */
export function isRollbackSql(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  const name = normalized.split("/").pop() ?? "";
  return /(?:^|\/)rollback\//i.test(normalized) || /(?:\.rollback|[-_]rollback)\.sql$/i.test(name);
}
