import type { CliContext } from "../types.js";
import { workspaceRoot } from "./workspace-root.js";

/** Read only the public `aw status --format json` contract, never a flow session. */
export interface PublicStatusSummary {
  state: "available" | "unavailable";
  sessionsLabel: string;
  pending: number | null;
  next: string | null;
}

const UNAVAILABLE: PublicStatusSummary = {
  state: "unavailable",
  sessionsLabel: "— sessions",
  pending: null,
  next: null,
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export async function readPublicStatus(ctx: CliContext): Promise<PublicStatusSummary> {
  try {
    const result = await ctx.process.run(ctx.runtime.binName, ["status", "--format", "json"], {
      cwd: workspaceRoot(ctx),
      timeoutMs: 5000,
    });
    if (result.code !== 0) return UNAVAILABLE;
    const body: unknown = JSON.parse(result.stdout);
    if (!record(body) || !record(body.counts) || !Array.isArray(body.pipeline)) return UNAVAILABLE;
    const counts = body.counts;
    if (
      !count(counts.sessions_active) ||
      !count(counts.sessions_closed) ||
      !count(counts.sessions_paused) ||
      !count(counts.sessions_abandoned) ||
      !count(counts.pending)
    )
      return UNAVAILABLE;
    let next: string | null = counts.pending === 0 ? "sin trabajo pendiente" : null;
    if (body.pipeline.length > 0) {
      const first: unknown = body.pipeline[0];
      if (!record(first) || !record(first.detail) || typeof first.detail.next !== "string")
        return UNAVAILABLE;
      next = `${typeof first.file === "string" ? `${first.file}: ` : ""}${first.detail.next}`;
    }
    const total =
      counts.sessions_active +
      counts.sessions_closed +
      counts.sessions_paused +
      counts.sessions_abandoned;
    return {
      state: "available",
      sessionsLabel: `${total} sessions · ${counts.sessions_active} active`,
      pending: counts.pending,
      next,
    };
  } catch {
    return UNAVAILABLE;
  }
}
