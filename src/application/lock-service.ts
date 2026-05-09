import { dirname } from "node:path";
import type { FileSystemPort } from "../ports/file-system.js";

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

export async function acquireLock(
  lockPath: string,
  fs: FileSystemPort,
  options: LockOptions = {},
): Promise<LockHandle> {
  const ttlMs = options.ttlMs ?? DEFAULT_LOCK_TTL_MS;
  const pid = options.pid ?? process.pid;
  const now = options.now ?? Date.now;
  const ts = now();

  if (await fs.exists(lockPath)) {
    const raw = await fs.readText(lockPath);
    const existing = parseLock(raw);
    if (existing && !isExpired(existing, ts, ttlMs)) {
      throw new LockBusyError(lockPath, existing);
    }
  }

  await fs.mkdirp(dirname(lockPath));
  const content: LockFileContent = { pid, ts: new Date(ts).toISOString() };
  await fs.writeText(lockPath, JSON.stringify(content));

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
