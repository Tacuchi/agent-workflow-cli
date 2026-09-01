import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { FileSystemPort } from "../ports/file-system.js";
import type { PathsService } from "./paths-service.js";

export interface LockFileContent {
  pid: number;
  ts: string;
  /**
   * Identifies one acquisition by one process.  `pid` and `ts` alone can repeat
   * when a process releases and re-acquires a lock within the same millisecond;
   * a late release must never remove that newer holder.
   */
  token?: string;
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
   * Retained for source compatibility. Releases now always remove their own
   * lock rather than writing the historical empty marker: a marker let two
   * waiters each clear the path after a third had acquired it.
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

const MAX_CLAIM_RETRIES = 3;

const DEFAULT_WAIT_STEP_MS = 15;

/**
 * Serializes the small read/create/cleanup window for callers in this Node
 * process. The filesystem lock remains the inter-process arbiter for live
 * holders; this queue closes the same-process window where multiple async
 * callers observed and cleared the same released marker.
 */
const localLockTails = new Map<string, Promise<void>>();

async function underLocalLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = localLockTails.get(path) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  localLockTails.set(path, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release?.();
    if (localLockTails.get(path) === tail) localLockTails.delete(path);
  }
}

type AcquisitionStep =
  | { kind: "acquired" }
  | { kind: "held"; holder: LockFileContent }
  | { kind: "retry"; lastSeen: LockFileContent | null };

async function tryAcquireStep(
  fs: FileSystemPort,
  lockPath: string,
  serialized: string,
  nowMs: number,
  ttlMs: number,
): Promise<AcquisitionStep> {
  return await underLocalLock(lockPath, async () => {
    const result = await fs.writeTextExclusive(lockPath, serialized);
    if (result.created) return { kind: "acquired" };

    const slot = await readSlot(fs, lockPath, nowMs, ttlMs);
    if (slot.held) return { kind: "held", holder: slot.holder };

    // A missing path is already available for a fresh exclusive create. Do not
    // remove it: another process can have acquired it between the failed create
    // and the read. Free legacy/stale contents are cleared while the local queue
    // owns the inspection, then the next loop creates afresh.
    if (slot.present) await fs.remove(lockPath);
    return { kind: "retry", lastSeen: slot.holder };
  });
}

interface LockRequest {
  ttlMs: number;
  pid: number;
  now: () => number;
  ts: number;
  deadline: number;
  waitStepMs: number;
}

function lockRequest(options: LockOptions): LockRequest {
  const now = options.now ?? Date.now;
  const ts = now();
  return {
    ttlMs: options.ttlMs ?? DEFAULT_LOCK_TTL_MS,
    pid: options.pid ?? process.pid,
    now,
    ts,
    deadline: ts + (options.waitMs ?? 0),
    waitStepMs: options.waitStepMs ?? DEFAULT_WAIT_STEP_MS,
  };
}

function serializedLock(request: LockRequest): string {
  return JSON.stringify({
    pid: request.pid,
    ts: new Date(request.ts).toISOString(),
    token: randomUUID(),
  } satisfies LockFileContent);
}

async function waitForLock(
  fs: FileSystemPort,
  lockPath: string,
  serialized: string,
  request: LockRequest,
): Promise<LockHandle> {
  let lastSeen: LockFileContent | null = null;
  // Two budgets, and conflating them breaks either one. `steals` bounds how often
  // a competing claimer may take the slot we just cleared — the fail-fast caller's
  // only bound. `deadline` bounds how long a WAITING caller sits on a holder that
  // is alive and working, and while there is clock left, contention is not a steal:
  // N claimers queueing on one released marker would otherwise burn three attempts
  // each and all report "busy" over a lock nobody holds.
  let steals = 0;
  while (steals < MAX_CLAIM_RETRIES) {
    const step = await tryAcquireStep(fs, lockPath, serialized, request.now(), request.ttlMs);
    if (step.kind === "acquired") {
      return makeHandle(fs, lockPath, request.pid, request.ts, serialized);
    }

    if (step.kind === "held") {
      if (await keepWaiting(request.now, request.deadline, request.waitStepMs)) continue;
      throw new LockBusyError(lockPath, step.holder);
    }
    if (step.lastSeen !== null) lastSeen = step.lastSeen;

    // Stale, release marker, corrupt or already gone: the local section either
    // cleared the old content or observed an already-free path. Yield before
    // retrying so a just-released in-process holder cannot be starved.
    if (await keepWaiting(request.now, request.deadline, 0)) continue;
    steals++;
  }

  // Exceeded retries — another claimer kept stealing the slot. Surface as busy.
  throw new LockBusyError(lockPath, lastSeen ?? { pid: 0, ts: new Date(request.ts).toISOString() });
}

export async function acquireLock(
  lockPath: string,
  fs: FileSystemPort,
  options: LockOptions = {},
): Promise<LockHandle> {
  const request = lockRequest(options);
  await fs.mkdirp(dirname(lockPath));
  return await waitForLock(fs, lockPath, serializedLock(request), request);
}

/** A live holder, or a slot free for the taking (stale, released, corrupt, gone). */
type Slot =
  | { held: true; holder: LockFileContent }
  | { held: false; holder: LockFileContent | null; present: boolean };

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
    return { held: false, holder: null, present: false };
  }
  const existing = parseLock(raw);
  if (existing !== null && !isExpired(existing, nowMs, ttlMs)) {
    return { held: true, holder: existing };
  }
  return { held: false, holder: existing, present: true };
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
  serialized: string,
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
        await underLocalLock(lockPath, async () => {
          let current: string;
          try {
            current = await fs.readText(lockPath);
          } catch {
            return;
          }
          // A stale holder may wake up after a new process acquired the same
          // pathname. It can only release the bytes it created itself.
          if (current === serialized) await fs.remove(lockPath);
        });
      } catch {
        // Best effort: a stale lock can still be recovered after its TTL.
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
