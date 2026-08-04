/**
 * Reading and writing the run state — the only place that touches the file.
 *
 * Two properties matter here and nothing else does:
 *
 * - **Serialized.** Every application takes the run's own lock (the
 *   `lock-service` that already exists — exclusive create, TTL, pid), re-reads
 *   the state INSIDE it and only then computes the next one. Two processes
 *   racing on one run cannot produce last-writer-wins: the second is told the
 *   lock is held and gets an action, it never overwrites applied transitions.
 * - **All-or-nothing.** The next state is fully built, validated and sealed
 *   before the single write happens, so a failure halfway through leaves the
 *   previous state exactly as it was rather than a half-applied one.
 */

import { join } from "node:path";
import type { CapabilityFailure } from "../../domain/capability/protocol.js";
import {
  FLOW_RUN_STATE_FILE,
  type FlowRunRead,
  type FlowRunState,
  parseRunState,
  serializeRunState,
} from "../../domain/flow/run-state.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import { LockBusyError, type LockOptions, acquireLock } from "../lock-service.js";
import type { PathsService } from "../paths-service.js";

export interface FlowRunLocation {
  session: string;
  dir: string;
  statePath: string;
  lockPath: string;
}

export function locateRun(paths: PathsService, session: string): FlowRunLocation {
  const dir = join(paths.cwdSessionsDir(), session);
  return {
    session,
    dir,
    statePath: join(dir, FLOW_RUN_STATE_FILE),
    lockPath: join(dir, `${FLOW_RUN_STATE_FILE}.lock`),
  };
}

/**
 * Read the run state.
 *
 * `FLOW_RUN_ABSENT` is a first-class answer, not an error to swallow: a session
 * opened before the engine existed has no state, and treating that as corruption
 * would send a legacy run to a repair action it does not need. Its action is
 * adoption.
 */
export async function readRun(fs: FileSystemPort, location: FlowRunLocation): Promise<FlowRunRead> {
  if (!(await fs.exists(location.statePath))) {
    return {
      ok: false,
      failure: {
        code: "FLOW_RUN_ABSENT",
        message: `la sesión '${location.session}' no tiene estado de corrida`,
        action:
          "es una sesión legacy: adoptala con 'aw flow advance --session <código> --flow <flow> --adopt'",
      },
    };
  }
  return parseRunState(await fs.readText(location.statePath));
}

/** What a mutation returns, and what {@link applyUnderLock} returns in turn. */
export type FlowRunMutation<T> =
  | { ok: true; state: FlowRunState; value: T }
  | { ok: false; failure: CapabilityFailure };

export interface ApplyOptions extends LockOptions {
  /**
   * The digest the caller reasoned over. When it no longer matches the state
   * read under the lock, nothing is applied — the world moved between the
   * directive and this answer.
   */
  expectDigest?: string;
  /** Allow a missing state: the mutation receives `null` and creates the run. */
  allowAbsent?: boolean;
}

/**
 * Run one mutation under the run's lock and persist its result.
 *
 * The mutation receives the state as it is INSIDE the lock — never the copy the
 * caller had — which is what makes this a compare-and-swap instead of a hopeful
 * overwrite.
 */
export async function applyUnderLock<T>(
  fs: FileSystemPort,
  location: FlowRunLocation,
  mutate: (current: FlowRunState | null) => Promise<FlowRunMutation<T>> | FlowRunMutation<T>,
  options: ApplyOptions = {},
): Promise<FlowRunMutation<T>> {
  const { expectDigest, allowAbsent, ...lockOptions } = options;
  await fs.mkdirp(location.dir);

  let lock: Awaited<ReturnType<typeof acquireLock>>;
  try {
    lock = await acquireLock(location.lockPath, fs, lockOptions);
  } catch (err) {
    if (err instanceof LockBusyError) {
      return {
        ok: false,
        failure: {
          code: "FLOW_RUN_LOCKED",
          message: `otra invocación tiene la corrida tomada (pid ${err.holder.pid} desde ${err.holder.ts})`,
          action:
            "esperá a que termine y volvé a correr 'aw flow advance': no se pisan transiciones aplicadas",
        },
      };
    }
    throw err;
  }

  try {
    const current = await readRun(fs, location);
    if (!current.ok) {
      const absent = current.failure.code === "FLOW_RUN_ABSENT";
      if (!absent || allowAbsent !== true) return { ok: false, failure: current.failure };
    }
    const state = current.ok ? current.state : null;
    if (expectDigest !== undefined && state?.digest !== expectDigest) {
      return {
        ok: false,
        failure: {
          code: "FLOW_RUN_STALE",
          message: "el estado de la corrida cambió después de emitirse la directiva",
          action: "volvé a correr 'aw flow advance' y respondé sobre la frontera recalculada",
        },
      };
    }

    const result = await mutate(state);
    if (!result.ok) return result;
    // One write, after the next state is complete and sealed: nothing partial
    // can be observed because nothing partial is ever written.
    await fs.writeText(location.statePath, serializeRunState(result.state));
    return result;
  } finally {
    await lock.release();
  }
}
