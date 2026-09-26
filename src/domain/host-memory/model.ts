import type { Harness, HarnessId } from "../harnesses.js";

/**
 * What reading one host's curated memory came to. None of them fails the
 * command: a host with nothing to offer is a row of the report, not an error.
 */
export type HostMemoryState =
  /** The memory was found and parsed. */
  | "read"
  /** The host or its memory is not on this machine. */
  | "absent"
  /** The host is here, but it keeps no curated memory of its own. */
  | "no-curated-memory"
  /** The host has a memory feature and it is switched off. */
  | "disabled"
  /** The memory is there and its format was not recognized. */
  | "unreadable";

export interface HostMemorySource {
  path: string;
  /** Where inside the file, for a memory that keeps several learnings in one. */
  section: string | null;
}

export type HostMemoryProvenance =
  | { kind: "native" }
  /** Saved from another host's memory: its id is the original's, read from the mark it carries. */
  | { kind: "copy"; origin_host: string; origin_date: string | null };

/** An `aw` command the learning names as code and the installed CLI does not have. */
export interface HostMemoryStaleSignal {
  command: string;
  cli_version: string;
}

export interface HostMemoryEntry {
  /** Stable across readings: derived from the host and the learning's key in its memory. */
  id: string;
  host: HarnessId;
  /** `YYYY-MM-DD` as the memory records it; null when it records none — never the file's mtime. */
  date: string | null;
  /** The brief form: a note's description or a single bullet. */
  text: string;
  source: HostMemorySource;
  provenance: HostMemoryProvenance;
  /** Whether the current host's destination already holds it; null when there is none or it could not be read. */
  present_in_destination: boolean | null;
  stale: HostMemoryStaleSignal[];
  /** The line a save copies verbatim, so the next reading knows the copy for what it is. */
  origin_mark: string;
}

/** A file inside a readable memory that could not be read as a learning. */
export interface HostMemorySkip {
  path: string;
  reason: string;
}

export interface HostMemoryRow {
  host: HarnessId;
  label: string;
  state: HostMemoryState;
  reason: string | null;
  /** Learnings about Workline, all listed in the report's `entries`. */
  workline_entries: number;
  /** Everything else is only counted: its text never leaves the host. */
  other_entries: number;
  skipped: HostMemorySkip[];
}

/** Where the current host saves a learning, through its own channel. */
export interface HostMemoryDestination {
  path: string;
  channel: "claude-code-memory-note" | "codex-ad-hoc-note";
  /** The file name the channel expects, when it fixes one. */
  name_format: string | null;
}

export interface HostMemoryReport {
  current_host: {
    id: Harness;
    detected_via: string;
    destination: HostMemoryDestination | null;
    /** Why there is nowhere to save, when `destination` is null. */
    destination_reason: string | null;
  };
  hosts: HostMemoryRow[];
  entries: HostMemoryEntry[];
}
