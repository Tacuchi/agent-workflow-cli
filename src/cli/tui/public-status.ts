import type { CliContext } from "../types.js";
import { hubRoot } from "./hub-root.js";

/** One pending item of the hub, as the public `aw status --format json` gives it. */
export interface PendingItem {
  file: string;
  next: string;
  command: string | null;
}

export type PendingRead = { state: "available"; items: PendingItem[] } | { state: "unavailable" };

const UNAVAILABLE: PendingRead = { state: "unavailable" };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pendingItem(entry: unknown): PendingItem | null {
  if (!record(entry) || typeof entry.file !== "string") return null;
  if (!record(entry.detail) || typeof entry.detail.next !== "string") return null;
  return {
    file: entry.file,
    next: entry.detail.next,
    command: typeof entry.command === "string" ? entry.command : null,
  };
}

/**
 * Reads the hub's pending work only through the public `aw status --format json`
 * contract, in a subprocess, so the TUI never loads the flow engine. It reads
 * the pipeline and nothing else: no counters, so a field the CLI retires can
 * never leave the screen without its pending list.
 */
export async function readPending(ctx: CliContext): Promise<PendingRead> {
  try {
    const result = await ctx.process.run(ctx.runtime.binName, ["status", "--format", "json"], {
      cwd: hubRoot(ctx),
      timeoutMs: 5000,
    });
    if (result.code !== 0) return UNAVAILABLE;
    const body: unknown = JSON.parse(result.stdout);
    if (!record(body)) return UNAVAILABLE;
    // The default JSON leaves an empty pipeline out: absent means nothing pending.
    const pipeline = body.pipeline ?? [];
    if (!Array.isArray(pipeline)) return UNAVAILABLE;
    const items = pipeline.map(pendingItem);
    if (items.some((item) => item === null)) return UNAVAILABLE;
    return { state: "available", items: items as PendingItem[] };
  } catch {
    return UNAVAILABLE;
  }
}
