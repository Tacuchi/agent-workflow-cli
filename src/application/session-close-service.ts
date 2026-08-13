import { join } from "node:path";
import { reservationMarker } from "../domain/reservation.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { historyFields, upsertHistoryRow } from "./history-update-service.js";
import { withCwdLock } from "./lock-service.js";
import type { PathsService } from "./paths-service.js";
import { canonicalArtifactPath } from "./session-artifacts.js";
import { invalidateBindingsTo } from "./session-binding-service.js";
import { writeSessionNarrative } from "./session-narrative.js";
import {
  CLOSED_MARKER,
  type SessionEntry,
  type SessionResolutionError,
  resolveSessionTarget,
} from "./session-resolver.js";

export interface SessionCloseInput {
  code?: string;
  /** Optional refs for the HISTORY row (`kind:val` CSV; free text renders as-is). */
  refs?: string;
}

export interface SessionCloseOutput {
  code: string;
  folder: string;
  closed: boolean;
  checkpoint_path: string;
  backlog_path: string;
  refs?: string;
  /** HISTORY.md row upsert performed by close (durable record of closed work). */
  history?: { action: string; state: string };
  /** Non-fatal: close succeeds even if the HISTORY write failed. */
  history_error?: string;
  /** Conversation associations dropped because they pointed at this session. */
  bindings_invalidated: number;
  /**
   * Units this session still holds, with the command that integrates each one.
   *
   * Closing does NOT integrate and does not release: the work in a unit is
   * commits nobody has merged yet, and a close that quietly disposed of them
   * would be the one way this feature could lose work. So the close SAYS it,
   * and leaves the decision where it belongs.
   */
  pending_integration?: Array<{ alias: string; branch: string; path: string; command: string }>;
  /**
   * Numbering reservations this session held and never completed, now removed.
   *
   * The opposite decision from a unit, for the opposite reason: a unit holds
   * commits nobody merged, and a reservation holds NOTHING — it is a claimed
   * correlative whose document was never written. Leaving it behind is what put
   * empty files in `docs/plans` that later readers had to interpret. Only slots
   * still holding exactly this session's marker are released; anything published,
   * edited or owned elsewhere is left alone.
   */
  reservations_released?: string[];
  /**
   * Non-fatal: close succeeds even if the reservations could not be scanned.
   *
   * Reported rather than swallowed, for the same reason `history_error` is: a
   * slot that could not be given back is still held, and an empty
   * `reservations_released` would say "there was nothing to release".
   */
  reservations_error?: string;
}

export interface SessionCloseFullOutput {
  sessionClose: SessionCloseOutput;
}

export interface SessionCloseError {
  error: string;
  code?: string;
}

export type SessionCloseResult =
  | SessionCloseFullOutput
  | SessionCloseError
  | { sessionError: SessionResolutionError };

export async function runSessionClose(
  fs: FileSystemPort,
  paths: PathsService,
  input: SessionCloseInput,
  isolation?: IsolationReader,
): Promise<SessionCloseResult> {
  // Closing is destructive to continuity: it always names its target. Falling
  // back to "the sole active one" would let a conversation close a line it
  // never selected.
  if (!input.code) return { error: "--code es obligatorio" };
  const resolution = await resolveSessionTarget(fs, paths, { code: input.code, allowClosed: true });
  if (resolution.outcome !== "resolved") return { sessionError: resolution };
  const session = resolution.session;

  // Durable artifacts survive close. CHECKPOINT is a resume safety net (no-op
  // when the loop already wrote one). BACKLOG is NOT fabricated: the owning loop
  // writes it only when there is deferred content; `backlog_path` still reports
  // the canonical path.
  const checkpointPath = canonicalArtifactPath(session.path, "checkpoint");
  await ensureFile(fs, checkpointPath, "# CHECKPOINT\n");

  const refs = input.refs?.trim();
  const closure = await closeUnderLock(fs, paths, session, {
    code: session.code ?? input.code,
    ...(refs !== undefined && refs.length > 0 ? { refs } : {}),
  });
  if ("error" in closure) return closure;

  const sessionClose: SessionCloseOutput = {
    code: session.code ?? input.code,
    folder: session.folder,
    closed: true,
    checkpoint_path: checkpointPath,
    backlog_path: canonicalArtifactPath(session.path, "backlog"),
    ...(refs !== undefined && refs.length > 0 ? { refs } : {}),
    bindings_invalidated: closure.bindings_invalidated,
    ...(closure.history ? { history: closure.history } : {}),
    ...(closure.history_error !== undefined ? { history_error: closure.history_error } : {}),
  };
  const held = await heldUnits(isolation, session.folder);
  if (held.length > 0) sessionClose.pending_integration = held;
  const reservations = await releaseReservations(fs, paths, session.folder);
  if (reservations.released.length > 0) {
    sessionClose.reservations_released = reservations.released;
  }
  if (reservations.error !== undefined) sessionClose.reservations_error = reservations.error;
  // Last write of the session's life, and the one that matters most: whoever
  // opens a closed session months later reads the block, and a block left saying
  // "abierta" would be the closing act failing to record itself.
  await writeSessionNarrative(fs, paths, { folder: session.folder, path: session.path });
  return { sessionClose };
}

/** Reads this workspace's live isolation units; absent when the caller has no git port. */
export type IsolationReader = () => Promise<
  Array<{ alias: string; session: string; path: string; branch: string }>
>;

async function heldUnits(
  isolation: IsolationReader | undefined,
  folder: string,
): Promise<NonNullable<SessionCloseOutput["pending_integration"]>> {
  if (isolation === undefined) return [];
  let units: Awaited<ReturnType<IsolationReader>>;
  try {
    units = await isolation();
  } catch {
    return [];
  }
  return units
    .filter((u) => u.session === folder)
    .map((u) => ({
      alias: u.alias,
      branch: u.branch,
      path: u.path,
      command: `aw worktree integrate --source ${u.alias} --code ${folder}`,
    }));
}

/**
 * Give back every correlative this session claimed and never wrote into.
 *
 * Bytes-exact and owner-scoped, which is the whole safety argument: the only
 * files it can remove are the ones still holding this session's own marker, so a
 * published document, a slot somebody edited and another session's reservation
 * are all invisible to it. Non-fatal — a close that failed over garbage
 * collection would strand a session — but never silent: what it could not scan
 * comes back as the error beside what it did release, because an empty list and
 * an unreadable directory are different facts.
 *
 * The scan walks every immediate subdirectory of `docs/`, not a list of
 * categories: the claim mechanism is category-agnostic, and a hardcoded list is a
 * second place to update the day something else claims a number.
 */
async function releaseReservations(
  fs: FileSystemPort,
  paths: PathsService,
  folder: string,
): Promise<{ released: string[]; error?: string }> {
  const marker = reservationMarker(folder);
  const docs = join(paths.workspaceDir(), "docs");
  const released: string[] = [];
  try {
    if (!(await fs.exists(docs))) return { released };
    for (const category of await fs.list(docs)) {
      if (category.type !== "dir") continue;
      for (const entry of await fs.list(category.path)) {
        if (entry.type !== "file" || !/^\d{3}-/.test(entry.name)) continue;
        if ((await fs.readText(entry.path)) !== marker) continue;
        await fs.remove(entry.path);
        released.push(`docs/${category.name}/${entry.name}`);
      }
    }
  } catch (error) {
    return {
      released: released.sort(),
      error: `no se pudo revisar las reservas de ${folder} en docs/: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { released: released.sort() };
}

interface Closure {
  bindings_invalidated: number;
  history?: { action: string; state: string };
  history_error?: string;
}

/**
 * The whole shared-state mutation of a close, under ONE lock acquisition:
 * invalidate the associations pointing here, write the `.closed` marker, upsert
 * the HISTORY row. HISTORY goes through the lock-free primitive on purpose —
 * its public command takes the lock itself, and nesting would deadlock.
 *
 * The registry goes FIRST: if it cannot be read, the close aborts having
 * mutated nothing, rather than leaving a closed session that conversations are
 * still associated with.
 */
async function closeUnderLock(
  fs: FileSystemPort,
  paths: PathsService,
  session: SessionEntry,
  row: { code: string; refs?: string },
): Promise<Closure | SessionCloseError> {
  // `failure` (not `error`) so the busy-lock envelope `withCwdLock` returns
  // stays distinguishable from a failure raised inside the critical section.
  type Locked = { ok: true; closure: Closure } | { ok: false; failure: SessionCloseError };

  const result = await withCwdLock(fs, paths, async (): Promise<Locked> => {
    const invalidated = await invalidateBindingsTo(fs, paths, session.folder);
    if (!invalidated.ok) {
      return { ok: false, failure: { error: invalidated.reason, code: "SESSION_BINDING_INVALID" } };
    }
    await fs.writeText(join(session.path, CLOSED_MARKER), "");
    const closure: Closure = { bindings_invalidated: invalidated.removed };
    try {
      const history = await upsertHistoryRow(
        fs,
        paths,
        historyFields({ ...row, state: "closed" }, session, row.code),
      );
      closure.history = { action: history.action, state: history.state };
    } catch (err) {
      // Non-fatal, as before: the caller re-runs `aw history-update` on this.
      closure.history_error = err instanceof Error ? err.message : String(err);
    }
    return { ok: true, closure };
  });

  if ("error" in result) return { error: result.error, code: "LOCK_BUSY" };
  return result.ok ? result.closure : result.failure;
}

async function ensureFile(fs: FileSystemPort, path: string, defaultContent: string): Promise<void> {
  if (await fs.exists(path)) return;
  await fs.writeText(path, defaultContent);
}
