import { createHash } from "node:crypto";
import { AW_COMMAND_MENTION } from "./topic.js";

/**
 * Where a learning came from, carried as a mark the saving host copies verbatim.
 *
 * The mark is what lets a copy be told from a native learning on the next
 * reading, and a learning found by two hosts on their own be told from one host
 * quoting the other: the id travels with it, so the copy answers to its original.
 */
const ORIGIN_MARK =
  /\[aw-origin id=(hm-[0-9a-f]{16}) host=([a-z-]+) date=(\d{4}-\d{2}-\d{2}|unknown)\]/;
const UNKNOWN_DATE = "unknown";

export interface OriginMark {
  id: string;
  host: string;
  date: string | null;
}

/** Stable across readings of the same memory: the host plus the learning's key inside it. */
export function entryId(host: string, key: string): string {
  return `hm-${createHash("sha256").update(`${host}\n${key}`).digest("hex").slice(0, 16)}`;
}

export function formatOriginMark(mark: OriginMark): string {
  return `[aw-origin id=${mark.id} host=${mark.host} date=${mark.date ?? UNKNOWN_DATE}]`;
}

export function readOriginMark(text: string): OriginMark | null {
  const match = ORIGIN_MARK.exec(text);
  if (match === null) return null;
  const [, id = "", host = "", date = UNKNOWN_DATE] = match;
  return { id, host, date: date === UNKNOWN_DATE ? null : date };
}

const CODE_SPAN = /`([^`\n]+)`/g;

/**
 * The `aw <command>` a learning names inside a code span and the installed CLI
 * does not have. Only code spans count: prose says "aw" for other things, and a
 * command written as code is a claim about the tool.
 */
export function missingCommands(text: string, commands: ReadonlySet<string>): string[] {
  const missing = new Set<string>();
  for (const span of text.matchAll(CODE_SPAN)) {
    for (const mention of (span[1] ?? "").matchAll(AW_COMMAND_MENTION)) {
      const command = mention[1] ?? "";
      if (!commands.has(command)) missing.add(command);
    }
  }
  return [...missing].sort();
}
