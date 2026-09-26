import type { HostMemorySkip, HostMemorySource } from "../../domain/host-memory/model.js";
import type { FileSystemPort } from "../../ports/file-system.js";

/** One learning as a host's memory holds it, before the topic filter. */
export interface RawMemoryItem {
  /** The learning's place in its host's memory, relative to that memory: the seed of its id. */
  key: string;
  date: string | null;
  text: string;
  /** What the topic filter judges: the whole note, or for Codex the group the bullet belongs to. */
  topic: string;
  /** The learning's own full text: where a code span or an origin mark is looked for. */
  body: string;
  source: HostMemorySource;
}

export type ReaderOutcome =
  | { state: "read"; items: RawMemoryItem[]; skipped: HostMemorySkip[] }
  | { state: "absent" | "disabled" | "unreadable"; reason: string };

/**
 * Reads one host's curated memory, never writing. Each host keeps its own format,
 * so each reader owns its rules; a host that starts keeping memory adds a reader.
 */
export type HostMemoryReader = (fs: FileSystemPort, home: string) => Promise<ReaderOutcome>;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}/;

/** The `YYYY-MM-DD` a memory recorded, or null when what it recorded is not a date. */
export function isoDay(value: string | undefined): string | null {
  return value?.match(ISO_DAY)?.[0] ?? null;
}

export async function sortedEntries(fs: FileSystemPort, dir: string) {
  return (await fs.list(dir)).sort((a, b) => a.name.localeCompare(b.name));
}
