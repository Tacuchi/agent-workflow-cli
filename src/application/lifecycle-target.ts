import type { FileSystemPort } from "../ports/file-system.js";
import type { PathsService } from "./paths-service.js";
import {
  type SessionCandidate,
  type SessionEntry,
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
  /**
   * The host's own lifecycle event completes, but Workline writes, restores and
   * closes nothing on the session line, and says so. There is no third outcome
   * on purpose: see {@link resolveLifecycleTarget}.
   */
  | { outcome: "degraded"; reason: string; candidates: SessionCandidate[]; action: string };

/** The unresolved half of {@link LifecycleTarget}, for callers that report it. */
export type LifecycleDegraded = Extract<LifecycleTarget, { outcome: "degraded" }>;

/**
 * Resolve the target, and NEVER hold the host's event back over it.
 *
 * There used to be a third outcome: a host that declared it could pause its
 * compaction got `blocked` on an ambiguity, so a person could name the session
 * before anything was written. It was a trap. The remedy the notice offered —
 * `aw checkpoint-write --code NNN`, run by the agent from inside the very
 * conversation being compacted — does not always bind that conversation, so the
 * next `/compact` hit the same ambiguity and blocked again: irrecoverable from
 * inside, with the compaction the run needed to survive never happening.
 *
 * So an unresolved target degrades, always. What replaces the protective pause
 * is the refuge checkpoint the degraded write path parks (see
 * `checkpoint-write-service.ts`): the state is preserved out of the way and
 * adopted once the session does resolve.
 */
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
  return {
    outcome: "degraded",
    reason: resolution.message,
    candidates: resolution.candidates,
    action: resolution.action,
  };
}
