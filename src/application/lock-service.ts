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
  /**
   * Total budget to WAIT for a lock another holder is actively using, instead of
   * failing fast. `0` (the default) keeps the historical behaviour: a live holder
   * is a `LockBusyError` on the spot.
   *
   * Waiting is what a CLAIM needs and a reconciliation does not. `HISTORY.md` and
   * the project block fail fast on purpose — their caller can retry a whole
   * command. A correlative mint and the process registry cannot: by the time they
   * take the lock the number is being handed out or the process is already
   * spawned, so losing the race there loses real work rather than a retry.
   */
  waitMs?: number;
  /** Poll step while waiting for a busy lock. */
  waitStepMs?: number;
  /**
   * Remove the lock on release instead of leaving the historical empty marker.
   * Used by first-workspace materialization so a virgin write creates only its
   * declared runtime effects. Existing callers retain the release-marker
   * protocol by default.
   */
  removeOnRelease?: boolean;
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

const DEFAULT_WAIT_STEP_MS = 15;

export async function acquireLock(
  lockPath: string,
  fs: FileSystemPort,
  options: LockOptions = {},
): Promise<LockHandle> {
  const ttlMs = options.ttlMs ?? DEFAULT_LOCK_TTL_MS;
  const pid = options.pid ?? process.pid;
  const now = options.now ?? Date.now;
  const ts = now();
  const waitMs = options.waitMs ?? 0;
  const waitStepMs = options.waitStepMs ?? DEFAULT_WAIT_STEP_MS;
  const deadline = ts + waitMs;

  await fs.mkdirp(dirname(lockPath));
  const content: LockFileContent = { pid, ts: new Date(ts).toISOString() };
  const serialized = JSON.stringify(content);

  let lastSeen: LockFileContent | null = null;
  // Two budgets, and conflating them breaks either one. `steals` bounds how often
  // a competing claimer may take the slot we just cleared — the fail-fast caller's
  // only bound. `deadline` bounds how long a WAITING caller sits on a holder that
  // is alive and working, and while there is clock left, contention is not a steal:
  // N claimers queueing on one released marker would otherwise burn three attempts
  // each and all report "busy" over a lock nobody holds.
  let steals = 0;
  while (steals < MAX_CLAIM_RETRIES) {
    const result = await fs.writeTextExclusive(lockPath, serialized);
    if (result.created) {
      return makeHandle(fs, lockPath, pid, ts, options.removeOnRelease === true);
    }

    const slot = await readSlot(fs, lockPath, now(), ttlMs);
    if (slot.holder !== null) lastSeen = slot.holder;

    if (slot.held) {
      if (await keepWaiting(now, deadline, waitStepMs)) continue;
      throw new LockBusyError(lockPath, slot.holder);
    }

    // Stale, release marker, corrupted or already gone: clear it and race again.
    await fs.remove(lockPath);
    if (await keepWaiting(now, deadline, 0)) continue;
    steals++;
  }

  // Exceeded retries — another claimer kept stealing the slot. Surface as busy.
  throw new LockBusyError(lockPath, lastSeen ?? { pid: 0, ts: new Date(ts).toISOString() });
}

/** A live holder, or a slot free for the taking (stale, released, corrupt, gone). */
type Slot =
  | { held: true; holder: LockFileContent }
  | { held: false; holder: LockFileContent | null };

async function readSlot(
  fs: FileSystemPort,
  lockPath: string,
  nowMs: number,
  ttlMs: number,
): Promise<Slot> {
  let raw: string;
  try {
    raw = await fs.readText(lockPath);
  } catch {
    // Removed between the EEXIST and this read: the slot is free again.
    return { held: false, holder: null };
  }
  const existing = parseLock(raw);
  if (existing !== null && !isExpired(existing, nowMs, ttlMs)) {
    return { held: true, holder: existing };
  }
  return { held: false, holder: existing };
}

/**
 * Whether there is still wait budget, sleeping `stepMs` before the next attempt.
 *
 * `stepMs: 0` still yields to the event loop, which is what lets the in-process
 * holder actually reach its `release()` instead of being starved by a tight
 * retry loop in the same tick.
 */
async function keepWaiting(now: () => number, deadline: number, stepMs: number): Promise<boolean> {
  if (now() >= deadline) return false;
  await sleep(stepMs);
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeHandle(
  fs: FileSystemPort,
  lockPath: string,
  pid: number,
  ts: number,
  removeOnRelease: boolean,
): LockHandle {
  let released = false;
  return {
    path: lockPath,
    pid,
    ts,
    release: async () => {
      if (released) return;
      released = true;
      try {
        if (removeOnRelease) await fs.remove(lockPath);
        else await fs.writeText(lockPath, RELEASED_MARKER);
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
