import { copyFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

export function toCodexPath(p: string): string {
  const np = normalizePath(p);
  return process.platform === "win32" ? np.replace(/\//g, "\\") : np;
}

/** Delete every `<file>.bak.<epoch>` sibling (best-effort, never throws). */
export function purgeStaleBackups(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) return;
  const base = basename(filePath);
  const re = new RegExp(`^${escapeRegex(base)}\\.bak\\.\\d+$`);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!re.test(entry)) continue;
    try {
      unlinkSync(join(dir, entry));
    } catch {
      // ignore individual failure
    }
  }
}

/**
 * Keep-latest backup: purge older `.bak.<epoch>` siblings first, then copy a
 * fresh one — host-config files never accumulate unbounded backups.
 */
export function backupFile(path: string): string | null {
  if (!existsSync(path)) return null;
  purgeStaleBackups(path);
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
