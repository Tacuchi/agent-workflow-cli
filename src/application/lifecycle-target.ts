import type { FileSystemPort } from "../ports/file-system.js";
import type { PathsService } from "./paths-service.js";
import {
  type SessionCandidate,
  type SessionEntry,
  type SessionResolutionError,
  resolveSessionTarget,
} from "./session-resolver.js";

/**
 * The one target a lifecycle surface (PreCompact / PostCompact / SessionEnd) is
 * allowed to act on.
 *
 * These surfaces used to stand in for identity: `resume-summary` took
 * `actives[0]`, `auto-compact-on-close` iterated EVERY active session and could
 * checkpoint another conversation's line. They now resolve the same canonical
 * target as every other session-scoped operation, and an unresolvable one is a
 * visible outcome — never a silently chosen session.
 */
export interface LifecycleOptions {
  code?: string;
  contextId?: string;
  /**
   * The host declared it can hold its compaction while a human selects. Comes
   * from the adapter, NEVER inferred: guessing it produces false blocks on
   * hosts that cannot pause, so the default is "it cannot".
   */
  canPauseCompaction?: boolean;
}

/**
 * Whether resolving ALSO claims the line for this conversation.
 *
 * It used to be unconditional — `bind: true` hardcoded inside the resolve —
 * so a pure read moved the association: a `checkpoint-read --code 006` returned
 * `checkpoint: null` and, on the way, redirected the conversation to 006; the
 * SessionEnd hook then checkpointed 006 and left the real line with nothing.
 * Every surface now has to say it out loud, which is why this is a required
 * argument and not an optional flag with a convenient default.
 */
export type LifecycleBinding = "bind" | "read-only";

export type LifecycleTarget =
  | { outcome: "resolved"; session: SessionEntry }
  /** Pausable host: stop and require a selection before anything is written. */
  | { outcome: "blocked"; error: SessionResolutionError }
  /**
   * Non-pausable host: its native compaction completes, but Workline writes,
   * restores and closes nothing, and says so.
   */
  | { outcome: "degraded"; reason: string; candidates: SessionCandidate[]; action: string };

export async function resolveLifecycleTarget(
  fs: FileSystemPort,
  paths: PathsService,
  options: LifecycleOptions,
  binding: LifecycleBinding,
): Promise<LifecycleTarget> {
  // `allowClosed` stays off: a lifecycle surface writes or restores state, and
  // a closed line is not a valid destination for either.
  const resolution = await resolveSessionTarget(fs, paths, {
    intent: "write",
    ...(options.code !== undefined ? { code: options.code } : {}),
    ...(options.contextId !== undefined ? { contextId: options.contextId } : {}),
    bind: binding === "bind",
  });
  if (resolution.outcome === "resolved") {
    return { outcome: "resolved", session: resolution.session };
  }
  // Holding the host's compaction is only worth it when a SELECTION actually
  // resolves the situation — that is ambiguity, and the spec scopes pausable
  // blocking to exactly that ("Si una compactación AMBIGUA puede pausarse").
  // Every other outcome has nothing to pick from: a workspace with no active
  // session is the normal state between runs, and blocking there would fail
  // every single compaction with an empty candidate list.
  if (options.canPauseCompaction === true && resolution.code === "SESSION_AMBIGUOUS") {
    return { outcome: "blocked", error: resolution };
  }
  return {
    outcome: "degraded",
    reason: resolution.message,
    candidates: resolution.candidates,
    action: resolution.action,
  };
}

/** Why the target could not be resolved, in whichever form the outcome took. */
export function unresolvedDetail(
  target: Extract<LifecycleTarget, { outcome: "blocked" | "degraded" }>,
): { reason: string; candidates: SessionCandidate[]; action: string } {
  return target.outcome === "blocked"
    ? {
        reason: target.error.message,
        candidates: target.error.candidates,
        action: target.error.action,
      }
    : { reason: target.reason, candidates: target.candidates, action: target.action };
}
