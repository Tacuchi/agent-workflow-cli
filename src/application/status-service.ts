import { sameCorrelative } from "../domain/correlative.js";
import type { SessionPhase } from "../domain/session/narrative.js";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { GitPort } from "../ports/git.js";
import { type FlowRunProjection, projectRun } from "./flow/run-projection.js";
import { readHistoryRows } from "./history-table.js";
import type { PathsService } from "./paths-service.js";
import { type TerminalEvent, readEvents } from "./retirement/history-events.js";
import { sessionNumericCode } from "./session-resolver.js";
import {
  type IndexedDiscarded,
  type IndexedHub,
  type IndexedPlan,
  type IndexedReservation,
  type IndexedSpec,
  type PendingRetirement,
  type PipelineItem,
  type SessionUnit,
  buildWorklineIndex,
} from "./workline-index-service.js";
import type { OrphanUnit, WorktreeListOutput } from "./worktree-service.js";

/**
 * `status` projected out of the Workline index.
 *
 * The reading itself lives in `workline-index-service` — this module only
 * shapes it for one command, so `status` and `resume` can never answer the
 * same question differently. Everything here is derivation; nothing re-reads
 * the filesystem and nothing writes to it.
 */

export type { PipelineItem } from "./workline-index-service.js";

export interface StatusSession {
  code: string | null;
  folder: string;
  type: string | null;
  summary: string;
  /**
   * `abierta` | `reanudada` | `cerrada` — the session's own reading of itself.
   *
   * The board already said `active`/`closed`, which answers whether the folder is
   * open and nothing else. This is the distinction somebody scanning the board
   * needs: a session waiting to start and one somebody left mid-way look
   * identical under `active`. Derived by the same rule the session's own entry
   * point uses, so the two cannot describe it differently.
   */
  phase: SessionPhase;
  date: string;
  relative: string;
  /**
   * Where this session's directed run stands, or `null` when it has none.
   *
   * Read only for ACTIVE sessions: a closed one has nothing to resume, and the
   * dashboard would pay one file read per session of the whole history to say so.
   */
  flow: FlowRunProjection | null;
  /** Isolation units this flow is editing in; empty when it took none. */
  units: SessionUnit[];
}

export interface StatusOutput {
  hub: IndexedHub;
  last_activity: string | null;
  specs: IndexedSpec[];
  plans: IndexedPlan[];
  sessions: {
    active: StatusSession[];
    closed: StatusSession[];
    paused: StatusSession[];
    abandoned: StatusSession[];
  };
  /** Rows from another machine; retired rows are historical, not missing folders. */
  history_remote_rows: string[];
  history_collisions: Array<{ local: string; registered: string; action: string }>;
  discarded: IndexedDiscarded[];
  /**
   * Terminal retirement events, read from `HISTORY.md`'s own append-only ledger.
   *
   * Deliberately NOT folded into `discarded`, which means items a session deferred
   * or excluded from its scope: one of those is recoverable and the other is not,
   * and a board where "discarded" means both is a board nobody can act on.
   */
  terminal_events: TerminalEvent[];
  /**
   * Retirements in flight. While one is here, nothing on this board is a settled
   * reading — and finishing it is a mutation, so what a read owes is the fact.
   */
  pending_retirements: PendingRetirement[];
  /**
   * Correlatives held by a reservation or a legacy placeholder.
   *
   * Reported as their own thing, never counted among `specs` or `plans` and never
   * a pipeline row: a held number is not work anybody should weigh against an open
   * plan, and presenting one as an executable document is exactly what this board
   * used to do.
   */
  reservations: IndexedReservation[];
  /** Non-fatal, never silent: an unreadable `docs/` is not an empty one. */
  reservations_error?: string;
  /** what is left to do, in priority order — the same list `resume` routes from */
  pipeline: PipelineItem[];
  /**
   * Active sessions holding work with no document of their own, by folder.
   *
   * A notice, never a row of pending work: the session mechanics belong to the
   * central workline, and asking a person to weigh a loose checkpoint against an
   * open plan asked them to do the runtime's bookkeeping.
   */
  loose_sessions: string[];
  /** Units that outlived their session: pending cleanup, never cleaned on their own. */
  orphan_units: OrphanUnit[];
  unreadable_sources?: WorktreeListOutput["unreadable"];
  isolation_error?: string;
  /** Invalid `[docs]` config: no documentary path was guessed. */
  docs_canon_error?: string;
  counts: {
    specs: number;
    specs_refined: number;
    plans: number;
    sessions_active: number;
    sessions_closed: number;
    sessions_paused: number;
    sessions_abandoned: number;
    discarded: number;
    /** How many retirements the ledger records. */
    terminal_events: number;
    pending: number;
  };
}

export interface StatusInput {
  now?: Date;
  /** Read isolation units too; without it the output is the pre-units one. */
  git?: GitPort;
}

/**
 * Read-only whole-hub status aggregator. Never throws on a reachable cwd:
 * an uninitialized hub returns `initialized:false` with empty collections;
 * a single unreadable file is skipped rather than tanking the command.
 */
export async function runStatusCommand(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  input: StatusInput = {},
): Promise<StatusOutput> {
  const index = await buildWorklineIndex(fs, env, paths, input);
  const events = await readEvents(fs, paths);

  const { active, closed, paused, abandoned } = await statusSessions(fs, paths, index);

  const historyPath = paths.cwdHistoryFile();
  const rows = (await fs.exists(historyPath))
    ? readHistoryRows(await fs.readText(historyPath))
    : [];
  const localFolders = new Set(index.sessions.map((session) => session.folder));
  const sameFolder = (rowKey: string) =>
    localFolders.has(rowKey) ||
    [...localFolders].some((folder) => folder.replace(/^session(?=\d)/, "") === rowKey);
  const historyRemoteRows = rows
    .filter((row) => row.state !== "retired" && !sameFolder(row.key))
    .map((row) => row.key);
  const historyCollisions = findHistoryCollisions(index, rows);

  return {
    hub: index.hub,
    last_activity: index.last_activity,
    specs: index.specs,
    plans: index.plans,
    sessions: { active, closed, paused, abandoned },
    history_remote_rows: historyRemoteRows,
    history_collisions: historyCollisions,
    discarded: index.discarded,
    terminal_events: events,
    pending_retirements: index.pending_retirements,
    reservations: index.reservations,
    ...(index.reservations_error !== undefined
      ? { reservations_error: index.reservations_error }
      : {}),
    pipeline: index.pipeline,
    loose_sessions: index.loose_sessions,
    orphan_units: index.orphan_units,
    ...(index.unreadable_sources !== undefined
      ? { unreadable_sources: index.unreadable_sources }
      : {}),
    ...(index.isolation_error !== undefined ? { isolation_error: index.isolation_error } : {}),
    ...(index.docs_canon_error !== undefined ? { docs_canon_error: index.docs_canon_error } : {}),
    counts: {
      specs: index.specs.length,
      specs_refined: index.specs.filter((s) => s.status === "ready-for-plan").length,
      plans: index.plans.length,
      sessions_active: active.length,
      sessions_closed: closed.length,
      sessions_paused: paused.length,
      sessions_abandoned: abandoned.length,
      discarded: index.discarded.length,
      terminal_events: events.length,
      pending: index.pipeline.length,
    },
  };
}

function findHistoryCollisions(
  index: Awaited<ReturnType<typeof buildWorklineIndex>>,
  rows: ReturnType<typeof readHistoryRows>,
): StatusOutput["history_collisions"] {
  const historyCollisions: StatusOutput["history_collisions"] = [];
  for (const session of index.sessions) {
    const number = sessionNumericCode(session.folder);
    if (number === null) continue;
    for (const row of rows) {
      const recorded = sessionNumericCode(row.key);
      if (
        recorded === null ||
        !sameCorrelative(number, recorded) ||
        row.key === session.folder ||
        session.folder.replace(/^session(?=\d)/, "") === row.key ||
        !row.key.includes("-")
      )
        continue;
      historyCollisions.push({
        local: session.folder,
        registered: row.key,
        action: "aw hub-migrate --renumber",
      });
    }
  }

  return historyCollisions;
}

async function statusSessions(
  fs: FileSystemPort,
  paths: PathsService,
  index: Awaited<ReturnType<typeof buildWorklineIndex>>,
): Promise<StatusOutput["sessions"]> {
  const active: StatusSession[] = [];
  const closed: StatusSession[] = [];
  const paused: StatusSession[] = [];
  const abandoned: StatusSession[] = [];
  for (const session of index.sessions) {
    const destination =
      session.state === "closed"
        ? closed
        : session.state === "paused"
          ? paused
          : session.state === "abandoned"
            ? abandoned
            : active;
    destination.push({
      code: session.code,
      folder: session.folder,
      type: session.type,
      summary: session.summary,
      phase: session.phase,
      date: session.date,
      relative: session.relative,
      flow: session.state === "active" ? await projectRun(fs, paths, session.folder) : null,
      units: session.units,
    });
  }

  return { active, closed, paused, abandoned };
}
