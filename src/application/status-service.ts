import type { SessionPhase } from "../domain/session/narrative.js";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { GitPort } from "../ports/git.js";
import type { DesignGraph } from "./design/design-graph-service.js";
import { type FlowRunProjection, projectRun } from "./flow/run-projection.js";
import type { PathsService } from "./paths-service.js";
import { type TerminalEvent, readEvents } from "./retirement/history-events.js";
import {
  type IndexedDiscarded,
  type IndexedPlan,
  type IndexedSpec,
  type IndexedWorkspace,
  type PendingRetirement,
  type PipelineItem,
  type SessionUnit,
  buildWorklineIndex,
} from "./workline-index-service.js";
import type { OrphanUnit } from "./worktree-service.js";

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
  workspace: IndexedWorkspace;
  specs: IndexedSpec[];
  plans: IndexedPlan[];
  sessions: {
    active: StatusSession[];
    closed: StatusSession[];
  };
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
  /** the design traceability graph, so a broken reference is visible without opening files */
  designs: DesignGraph;
  /** Units that outlived their session: pending cleanup, never cleaned on their own. */
  orphan_units: OrphanUnit[];
  /** Invalid `[docs]` config: no documentary path was guessed. */
  docs_canon_error?: string;
  counts: {
    specs: number;
    specs_refined: number;
    plans: number;
    sessions_active: number;
    sessions_closed: number;
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
 * Read-only whole-workspace status aggregator. Never throws on a reachable cwd:
 * an uninitialized workspace returns `initialized:false` with empty collections;
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

  const active: StatusSession[] = [];
  const closed: StatusSession[] = [];
  for (const session of index.sessions) {
    const isClosed = session.state === "closed";
    (isClosed ? closed : active).push({
      code: session.code,
      folder: session.folder,
      type: session.type,
      summary: session.summary,
      phase: session.phase,
      date: session.date,
      relative: session.relative,
      flow: isClosed ? null : await projectRun(fs, paths, session.folder),
      units: session.units,
    });
  }

  return {
    workspace: index.workspace,
    specs: index.specs,
    plans: index.plans,
    sessions: { active, closed },
    discarded: index.discarded,
    terminal_events: events,
    pending_retirements: index.pending_retirements,
    pipeline: index.pipeline,
    loose_sessions: index.loose_sessions,
    designs: index.designs,
    orphan_units: index.orphan_units,
    ...(index.docs_canon_error !== undefined ? { docs_canon_error: index.docs_canon_error } : {}),
    counts: {
      specs: index.specs.length,
      specs_refined: index.specs.filter((s) => s.refined).length,
      plans: index.plans.length,
      sessions_active: active.length,
      sessions_closed: closed.length,
      discarded: index.discarded.length,
      terminal_events: events.length,
      pending: index.pipeline.length,
    },
  };
}
