import { copyFileSync, existsSync } from "node:fs";

export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

export function toCodexPath(p: string): string {
  const np = normalizePath(p);
  return process.platform === "win32" ? np.replace(/\//g, "\\") : np;
}

export function backupFile(path: string): string | null {
  if (!existsSync(path)) return null;
  const ts = Math.floor(Date.now() / 1000);
  const backupPath = withSuffixAdd(path, `.bak.${ts}`);
  copyFileSync(path, backupPath);
  return backupPath;
}

export function withSuffixAdd(path: string, extra: string): string {
  return `${path}${extra}`;
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
