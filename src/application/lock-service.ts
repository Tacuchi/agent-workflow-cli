import { dirname } from "node:path";
import type { FileSystemPort } from "../ports/file-system.js";
import type { PathsService } from "./paths-service.js";

export interface LockFileContent {
  pid: number;
  ts: string;
}

export interface LockHandle {
  path: string;
  pid: number;
  ts: number;
  release: () => Promise<void>;
}

export interface LockOptions {
  ttlMs?: number;
  pid?: number;
  now?: () => number;
}

export class LockBusyError extends Error {
  constructor(
    public lockPath: string,
    public holder: LockFileContent,
  ) {
    super(`Lock at ${lockPath} held by pid ${holder.pid} since ${holder.ts}`);
    this.name = "LockBusyError";
  }
}

export const DEFAULT_LOCK_TTL_MS = 5 * 60 * 1000;

const RELEASED_MARKER = "";

const MAX_CLAIM_RETRIES = 3;

export async function acquireLock(
  lockPath: string,
  fs: FileSystemPort,
  options: LockOptions = {},
): Promise<LockHandle> {
  const ttlMs = options.ttlMs ?? DEFAULT_LOCK_TTL_MS;
  const pid = options.pid ?? process.pid;
  const now = options.now ?? Date.now;
  const ts = now();

  await fs.mkdirp(dirname(lockPath));
  const content: LockFileContent = { pid, ts: new Date(ts).toISOString() };
  const serialized = JSON.stringify(content);

  let lastSeen: LockFileContent | null = null;
  for (let attempt = 0; attempt < MAX_CLAIM_RETRIES; attempt++) {
    const result = await fs.writeTextExclusive(lockPath, serialized);
    if (result.created) {
      return makeHandle(fs, lockPath, pid, ts);
    }

    // Path exists — read to determine if active, stale, or release marker.
    let raw: string;
    try {
      raw = await fs.readText(lockPath);
    } catch {
      // Race: file removed between EEXIST and read. Loop will retry.
      continue;
    }
    const existing = parseLock(raw);
    lastSeen = existing;

    if (existing && !isExpired(existing, ts, ttlMs)) {
      throw new LockBusyError(lockPath, existing);
    }

    // Stale, release marker, or corrupted — try to remove and retry.
    await fs.remove(lockPath);
  }

  // Exceeded retries — another claimer kept stealing the slot. Surface as busy.
  throw new LockBusyError(lockPath, lastSeen ?? { pid: 0, ts: new Date(ts).toISOString() });
}

function makeHandle(fs: FileSystemPort, lockPath: string, pid: number, ts: number): LockHandle {
  let released = false;
  return {
    path: lockPath,
    pid,
    ts,
    release: async () => {
      if (released) return;
      released = true;
      try {
        await fs.writeText(lockPath, RELEASED_MARKER);
      } catch {
        // best-effort: stale lock will auto-expire via ttl
      }
    },
  };
}

/**
 * Acquire the cwd-level lock, run `fn`, release in finally. Centralizes the
 * acquire/try/release pattern used by services that touch HISTORY.md or the
 * CLAUDE.md/AGENTS.md project block.
 *
 * If the lock is busy, returns `{ error: "lock ocupado..." }` matching the
 * shape used by history-update-service. Other errors propagate.
 */
export async function withCwdLock<T>(
  fs: FileSystemPort,
  paths: PathsService,
  fn: () => Promise<T>,
  options: LockOptions = {},
): Promise<T | { error: string }> {
  let lock: LockHandle;
  try {
    lock = await acquireLock(paths.cwdLockFile(), fs, options);
  } catch (err) {
    if (err instanceof LockBusyError) {
      return {
        error: `lock ocupado (pid ${err.holder.pid} desde ${err.holder.ts}); reintenta o espera 5min`,
      };
    }
    throw err;
  }
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

export function parseLock(raw: string): LockFileContent | null {
  if (raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "pid" in parsed &&
      "ts" in parsed &&
      typeof (parsed as { pid: unknown }).pid === "number" &&
      typeof (parsed as { ts: unknown }).ts === "string"
    ) {
      return parsed as LockFileContent;
    }
    return null;
  } catch {
    return null;
  }
}

export function isExpired(lock: LockFileContent, nowMs: number, ttlMs: number): boolean {
  const lockTime = Date.parse(lock.ts);
  if (Number.isNaN(lockTime)) return true;
  return nowMs - lockTime > ttlMs;
}
