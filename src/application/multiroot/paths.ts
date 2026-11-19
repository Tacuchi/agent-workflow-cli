export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

export function toCodexPath(p: string): string {
  const np = normalizePath(p);
  return process.platform === "win32" ? np.replace(/\//g, "\\") : np;
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
