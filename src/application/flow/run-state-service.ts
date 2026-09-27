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

import { dirname, join } from "node:path";
import type { CapabilityFailure } from "../../domain/capability/protocol.js";
import { journeyOfFlow } from "../../domain/flow/authority.js";
import {
  FLOW_RUN_STATE_CONTINUABLE,
  FLOW_RUN_STATE_FILE,
  type FlowRunRead,
  type FlowRunState,
  alignToJourney,
  attemptCounterKeyForIteration,
  legacyRunNeedsAdoption,
  parseRunState,
  restartInvocation,
  serializeRunState,
  upgradeContinuable,
  withAttemptCounters,
} from "../../domain/flow/run-state.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import { LockBusyError, type LockOptions, acquireLock } from "../lock-service.js";
import type { PathsService } from "../paths-service.js";
import { semanticDigest } from "../semantic-operation/protocol.js";
import { journeyForRun } from "./run-journey.js";

/**
 * The attempt counter: outside the run state's seal, and outside its FOLDER.
 *
 * Two evasions, and the file's location answers the second one. The seal proved
 * it detects an edit and does not detect a restore: copying an earlier
 * `.flow-run.json` back over the current one is accepted — the file is
 * internally consistent, because it really was written by this CLI — and it
 * takes the attempt ledger back with it. So the count lives in a second file
 * that only ever grows. But while that file sat NEXT to the state, inside the
 * session folder, a `cp -r` of the folder carried both away and back, and
 * deleting it reset the cap: the counter defended against restoring a file and
 * fell to restoring the directory that contained it, which is the same move one
 * level up.
 *
 * Now it is workspace runtime — `.<ns>/sessions/.flow-attempts/<folder>.json`,
 * keyed by the session it counts, dot-prefixed so the session listing skips it
 * and already inside the gitignore the CLI manages. Restoring a session folder
 * cannot lower it, deleting the folder cannot delete it, and a recovery does not
 * delete it either: it records how many attempts were given back. See
 * `attemptsAt`.
 *
 * One file per run rather than one registry for the workspace, because two runs
 * advance concurrently under two DIFFERENT locks: a shared registry would need a
 * lock of its own, and losing that race would silently drop a run's floor —
 * rebuilding the very hole the file exists to close.
 */
const COUNTER_VERSION = 2;

/**
 * The two monotone maps: attempts ever seen, and attempts a recovery forgave.
 *
 * Both keyed by transition, because that is what the cap counts over — the
 * boundary's seal moves whenever the state does, the transition id does not.
 */
interface AttemptCounters {
  attempts: Record<string, number>;
  granted: Record<string, number>;
}

const NO_COUNTERS: AttemptCounters = { attempts: {}, granted: {} };

export interface FlowRunLocation {
  session: string;
  dir: string;
  statePath: string;
  /** Workspace runtime, NOT under {@link dir}. See {@link COUNTER_VERSION}. */
  countersPath: string;
  lockPath: string;
}

export function locateRun(paths: PathsService, session: string): FlowRunLocation {
  const dir = join(paths.cwdSessionsDir(), session);
  return {
    session,
    dir,
    statePath: join(dir, FLOW_RUN_STATE_FILE),
    countersPath: paths.cwdFlowAttemptsFile(session),
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
        action: `arrancala con 'aw flow advance --session ${location.session} --flow <flow> --adopt'`,
      },
    };
  }
  const parsed = parseRunState(await fs.readText(location.statePath), location.session);
  if (!parsed.ok) return parsed;
  // Reconciled on the way OUT, never on the way in: whoever restored an older
  // state has already handed it to us, and raising the floor here is what makes
  // the restore worthless. Every reader goes through this function, so no surface
  // of the CLI can see a run with attempts the counter says were already spent.
  const counters = await readCounters(fs, location);
  if (!counters.ok) return counters;
  const rolledBack = checkAgainstSealedFloor(parsed.state, counters.value);
  if (rolledBack !== null) return { ok: false, failure: rolledBack };
  const reconciled = withAttemptCounters(parsed.state, {
    floor: counters.value.attempts,
    grants: counters.value.granted,
  });
  // Reading historical state is deliberately non-mutating: a v7–v10 run stays
  // itself, and asking status/resume must never re-stamp it. A continuable run
  // is upgraded and aligned HERE, the one place every reader passes — advance,
  // submit, recover, prove, the internal driver and the board — so none of them
  // can resolve a boundary from a cursor another one sees differently. Nothing
  // is written: the next mutation persists what this returns.
  if (legacyRunNeedsAdoption(reconciled)) return { ok: true, state: reconciled };
  const upgraded = upgradeContinuable(reconciled);
  const base = journeyOfFlow(upgraded.flow).map((decision) => decision.id);
  return { ok: true, state: alignToJourney(upgraded, journeyForRun(upgraded), base) };
}

/**
 * Whether the counter came back BEHIND the floor the state itself carries sealed.
 *
 * The write order is the counter first and the state second, so the counter is
 * never behind: a process that dies between the two leaves it AHEAD, which costs
 * an attempt nobody spent, and that is the only one of the two errors that is
 * safe to make. The reverse cannot happen by running this CLI. It happens when
 * the counter file is deleted, truncated or replaced by an older copy while the
 * state stays — surgery on the accounting, and the only evidence of it that
 * survives inside the seal.
 *
 * Refused rather than rebuilt. Rebuilding from the state is precisely what the
 * counter exists to not do: the state is the file a restore rolls back, and
 * seeding the floor from it would hand the evader the reset they came for while
 * calling it a repair.
 */
function checkAgainstSealedFloor(
  state: FlowRunState,
  counters: AttemptCounters,
): CapabilityFailure | null {
  const behind = (sealed: Record<string, number> | undefined, live: Record<string, number>) =>
    Object.entries(sealed ?? {}).find(([transition, count]) => count > (live[transition] ?? 0));
  const lost =
    behind(state.attempt_floor, counters.attempts) ??
    behind(state.attempt_grants, counters.granted);
  if (lost === undefined) return null;
  return {
    code: "FLOW_RUN_COUNTER_ROLLED_BACK",
    message: `el contador de intentos quedó detrás del estado sellado: '${lost[0]}' declara ${lost[1]} y el contador no los tiene`,
    action: `el contador se borró o se restauró una copia anterior: restaurá el archivo de intentos de la corrida, o corré '${restartInvocation(state.session)}', que archiva la corrida entera y re-adopta — no se reconstruye desde el estado, que es justo lo que una restauración rebobina`,
  };
}

type CounterRead = { ok: true; value: AttemptCounters } | { ok: false; failure: CapabilityFailure };

/**
 * The counter as it stands, or the conservative reading when there is none.
 *
 * An ABSENT file is the normal state of every run that started before the counter
 * existed, and of every run that has not spent an attempt yet: it reads as "no
 * floor beyond the ledger", the run keeps walking, and the next write seeds the
 * file from the ledger it already has. Absence is not a hole — a state that DID
 * spend attempts carries their floor inside its own seal, so an absent counter
 * under such a state is caught by {@link checkAgainstSealedFloor} rather than
 * read as zero.
 *
 * Everything else is refused with a cause, and the checks are the state file's
 * own, in the same order: shape, then version, then the SEAL, then coherence.
 * This file is read fail-closed for exactly the reason the state is — it was the
 * surface added to resist manipulation, and while it was the only unsealed file
 * of the run it was also the easiest one to manipulate: writing `granted: 99`
 * into it turned the cap off for good.
 */
async function readCounters(fs: FileSystemPort, location: FlowRunLocation): Promise<CounterRead> {
  if (!(await fs.exists(location.countersPath))) return { ok: true, value: NO_COUNTERS };
  const refuse = (why: string): CounterRead => ({
    ok: false,
    failure: {
      code: "FLOW_RUN_COUNTER_INVALID",
      message: `el contador de intentos de la corrida ${why}`,
      action: `no se avanza con una contabilidad de intentos ilegible ni con una que fue editada fuera del CLI: restaurá el archivo, o corré '${restartInvocation(location.session)}', que archiva la corrida entera y re-adopta`,
    },
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readText(location.countersPath));
  } catch {
    return refuse("no es JSON válido");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return refuse("no es un objeto JSON");
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== COUNTER_VERSION) {
    return refuse(`declara una versión que este CLI no lee: ${String(record.version)}`);
  }
  const attempts = readCounterMap(record.attempts);
  const granted = readCounterMap(record.granted);
  if (attempts === null || granted === null) return refuse("no es un contador por transición");
  const value: AttemptCounters = { attempts, granted };
  if (record.digest !== counterDigest(location.session, value)) {
    return refuse("no coincide con su propio sello");
  }
  // A grant is what a recovery forgave, and forgiving more than was ever spent
  // is not a state this CLI can produce: `raiseCounters` only ever copies the
  // grants the state recorded, and a recovery grants exactly what it found
  // spent. A file that says otherwise is asking for a cap that never fires.
  const forgiven = Object.entries(granted).find(([id, count]) => count > (attempts[id] ?? 0));
  if (forgiven !== undefined) {
    return refuse(
      `perdona ${forgiven[1]} intentos de '${forgiven[0]}' y solo registra ${attempts[forgiven[0]] ?? 0}`,
    );
  }
  return { ok: true, value };
}

/**
 * The counter's seal — the same canonicalization the rest of the protocol uses.
 *
 * The SESSION is inside it, and not as decoration: the file lives in a shared
 * runtime folder keyed by folder name, so sealing the key is what makes one run's
 * counter unusable as another's.
 */
function counterDigest(session: string, counters: AttemptCounters): string {
  return semanticDigest({ version: COUNTER_VERSION, session, ...counters });
}

/**
 * Raise the counter to what this state knows, and hand the state back reconciled.
 *
 * Monotone by construction on both halves: the attempts seen can only go up —
 * `Math.max` against what the file already said — and the grants a recovery
 * recorded come from the state, which only ever adds to them. A state written
 * from a restored ledger therefore raises nothing and gets the live floor back.
 */
async function raiseCounters(
  fs: FileSystemPort,
  location: FlowRunLocation,
  state: FlowRunState,
): Promise<{ ok: true; state: FlowRunState } | { ok: false; failure: CapabilityFailure }> {
  const current = await readCounters(fs, location);
  if (!current.ok) return current;

  const spent = new Map<string, number>();
  for (const attempt of state.attempts) {
    const key = attemptCounterKeyForIteration(attempt.transition, attempt);
    spent.set(key, (spent.get(key) ?? 0) + 1);
  }
  const attempts = { ...current.value.attempts };
  for (const [transition, count] of spent) {
    attempts[transition] = Math.max(attempts[transition] ?? 0, count);
  }
  const granted = { ...current.value.granted };
  for (const [transition, forgiven] of Object.entries(state.attempt_grants ?? {})) {
    granted[transition] = Math.max(granted[transition] ?? 0, forgiven);
  }

  const next: AttemptCounters = { attempts, granted };
  if (changed(current.value, next)) await writeCounters(fs, location, next);
  return { ok: true, state: withAttemptCounters(state, { floor: attempts, grants: granted }) };
}

async function writeCounters(
  fs: FileSystemPort,
  location: FlowRunLocation,
  counters: AttemptCounters,
): Promise<void> {
  await fs.mkdirp(dirname(location.countersPath));
  await fs.writeText(
    location.countersPath,
    `${JSON.stringify(
      {
        version: COUNTER_VERSION,
        session: location.session,
        ...counters,
        digest: counterDigest(location.session, counters),
      },
      null,
      2,
    )}\n`,
  );
}

/**
 * Start the counter over for a run that is being created.
 *
 * The file goes rather than being zeroed, so an adopted run is byte-identical to
 * one that never had a counter: the next attempt seeds it again from the ledger.
 */
async function resetCounters(
  fs: FileSystemPort,
  location: FlowRunLocation,
  state: FlowRunState,
): Promise<{ ok: true; state: FlowRunState } | { ok: false; failure: CapabilityFailure }> {
  await fs.remove(location.countersPath);
  return { ok: true, state: withAttemptCounters(state, { floor: {}, grants: {} }) };
}

function changed(before: AttemptCounters, after: AttemptCounters): boolean {
  return (
    JSON.stringify(before.attempts) !== JSON.stringify(after.attempts) ||
    JSON.stringify(before.granted) !== JSON.stringify(after.granted)
  );
}

function readCounterMap(value: unknown): Record<string, number> | null {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.every(([, count]) => Number.isInteger(count) && (count as number) >= 0)) return null;
  return Object.fromEntries(entries) as Record<string, number>;
}

/**
 * What a mutation returns, and what {@link applyUnderLock} returns in turn.
 *
 * `persist: false` is how a BUSINESS rejection comes back: it produced a real
 * answer for the caller — the recalculated boundary — and it must not touch the
 * file. Without it, "a rejected answer writes nothing" would rest on the mutation
 * remembering to hand back the identical object, which is not a guarantee.
 */
export type FlowRunMutation<T> =
  | { ok: true; state: FlowRunState; value: T; persist?: boolean }
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

/** The run's own lock, or the refusal that names who holds it. */
async function takeRunLock(
  fs: FileSystemPort,
  location: FlowRunLocation,
  options: LockOptions,
): Promise<
  | { ok: true; lock: Awaited<ReturnType<typeof acquireLock>> }
  | { ok: false; failure: CapabilityFailure }
> {
  await fs.mkdirp(location.dir);
  try {
    return { ok: true, lock: await acquireLock(location.lockPath, fs, options) };
  } catch (err) {
    if (!(err instanceof LockBusyError)) throw err;
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
}

/** The archived registry of a restarted run: where it went and what it held. */
export interface RunArchive {
  /** Session-relative file name of the archive. */
  path: string;
  /** The registry bytes exactly as they were, or null when there was none. */
  state: string | null;
  /** The attempt counter exactly as it was, or null when there was none. */
  counters: string | null;
}

const ARCHIVE_SCHEMA = "workline.flow-run-archive/v1";

/**
 * Archive the run's registry and its counter, and seat a new run — one lock.
 *
 * The archive is a dated, sealed file inside the session folder, so what the old
 * run answered survives and the trace can name it. `seed` sees the old bytes and
 * the archive's name before anything is written: a seed that refuses (no flow to
 * adopt) leaves the run exactly as it was. The counter is not archived into the
 * new run's floor: a restart pays for its fresh attempts with the whole run, the
 * same trade an adoption makes.
 */
export async function restartUnderLock(
  fs: FileSystemPort,
  location: FlowRunLocation,
  causeOf: () => Promise<string>,
  seed: (
    cause: string,
    archived: RunArchive,
  ) => { ok: true; state: FlowRunState } | { ok: false; failure: CapabilityFailure },
  options: LockOptions & { at?: Date } = {},
): Promise<
  { ok: true; state: FlowRunState; archive: RunArchive } | { ok: false; failure: CapabilityFailure }
> {
  const { at: now = new Date(), ...lockOptions } = options;
  const taken = await takeRunLock(fs, location, lockOptions);
  if (!taken.ok) return taken;
  try {
    const readIfThere = async (path: string) =>
      (await fs.exists(path)) ? await fs.readText(path) : null;
    const state = await readIfThere(location.statePath);
    const counters = await readIfThere(location.countersPath);
    if (state === null && counters === null) {
      return {
        ok: false,
        failure: {
          code: "FLOW_RUN_ABSENT",
          message: `la sesión '${location.session}' no tiene una corrida que reiniciar`,
          action: `arrancala con 'aw flow advance --session ${location.session} --flow <flow> --adopt': no hay nada que archivar`,
        },
      };
    }
    // Read under the same lock that archives, so the cause recorded is the state
    // that was really replaced, not one another invocation moved past.
    const cause = await causeOf();
    const seal = semanticDigest({ state, counters });
    const stamp = now.toISOString().replace(/[-:.]/g, "");
    const archive: RunArchive = {
      path: `${FLOW_RUN_STATE_FILE}.archived-${stamp}-${seal.slice(0, 12)}.json`,
      state,
      counters,
    };
    const seeded = seed(cause, archive);
    if (!seeded.ok) return seeded;
    await fs.writeText(
      join(location.dir, archive.path),
      `${JSON.stringify(
        {
          schema: ARCHIVE_SCHEMA,
          session: location.session,
          archived_at: now.toISOString(),
          cause,
          state,
          counters,
          seal,
        },
        null,
        2,
      )}\n`,
    );
    const fresh = await resetCounters(fs, location, seeded.state);
    if (!fresh.ok) return fresh;
    await fs.writeText(location.statePath, serializeRunState(fresh.state));
    return { ok: true, state: fresh.state, archive };
  } finally {
    await taken.lock.release();
  }
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
  const taken = await takeRunLock(fs, location, lockOptions);
  if (!taken.ok) return taken;
  const lock = taken.lock;

  try {
    const current = await readRun(fs, location);
    if (!current.ok) {
      const absent = current.failure.code === "FLOW_RUN_ABSENT";
      if (!absent || allowAbsent !== true) return { ok: false, failure: current.failure };
    }
    const state = current.ok ? current.state : null;
    if (state !== null && legacyRunNeedsAdoption(state)) {
      return {
        ok: false,
        failure: {
          code: "FLOW_RUN_LEGACY_ADOPTION_REQUIRED",
          message: `la corrida v${state.version} se puede leer, pero no continuar: este CLI continúa desde la v${FLOW_RUN_STATE_CONTINUABLE.at(-1)}`,
          action: `corré '${restartInvocation(state.session)}': archiva el registro dentro de la sesión y re-adopta el flow '${state.flow}' — continuar su cursor inventaría límites de lote que la corrida nunca declaró`,
        },
      };
    }
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
    if (result.persist === false) return result;
    // The counter first, the state second, and the order is the contract. If the
    // process dies between them the counter is AHEAD of the ledger, which costs
    // an attempt nobody spent; the other order would leave it BEHIND, which is an
    // attempt somebody spent and can spend again. Only one of those two errors is
    // safe to make.
    //
    // An ADOPTION is the one case that starts the counter over, and it is not a
    // loophole in the monotonicity: a state that was absent means this run is
    // being created now, and the only way to get there deliberately is to throw
    // the previous run away whole — every applied transition with it. What the
    // counter defends against is keeping the position and losing the attempts;
    // paying for a reset with the entire run is not that trade. Keeping the old
    // count would be worse than useless: re-adopting after a corrupt state — the
    // repair this CLI prints — would come back pre-exhausted at its first gate.
    const raised =
      state === null
        ? await resetCounters(fs, location, result.state)
        : await raiseCounters(fs, location, result.state);
    if (!raised.ok) return raised;
    // One write, after the next state is complete and sealed: nothing partial
    // can be observed because nothing partial is ever written.
    await fs.writeText(location.statePath, serializeRunState(raised.state));
    // The reconciled state is what the caller gets back, because the digest it
    // holds is the one the next compare-and-swap will be judged against.
    return { ...result, state: raised.state };
  } finally {
    await lock.release();
  }
}
