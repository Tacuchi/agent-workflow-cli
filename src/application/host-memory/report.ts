import { sep } from "node:path";
import type { CliContext } from "../../cli/types.js";
import {
  HARNESSES,
  type Harness,
  type HarnessId,
  type HarnessSpec,
} from "../../domain/harnesses.js";
import type {
  HostMemoryEntry,
  HostMemoryReport,
  HostMemoryRow,
} from "../../domain/host-memory/model.js";
import {
  entryId,
  formatOriginMark,
  missingCommands,
  readOriginMark,
} from "../../domain/host-memory/provenance.js";
import { isWorklineTopic } from "../../domain/host-memory/topic.js";
import { readPackageVersion } from "../../runtime/version.js";
import { runHarness } from "../dev-only-services.js";
import { reportHostState } from "../self/host-states.js";
import { readClaudeCodeMemory } from "./claude-code.js";
import { readCodexMemory } from "./codex.js";
import { resolveDestination } from "./destination.js";
import type { HostMemoryReader, RawMemoryItem } from "./reader.js";

/** The hosts that keep a curated memory today. Any other host is "no curated memory". */
const HOST_MEMORY_READERS: Partial<Record<HarnessId, HostMemoryReader>> = {
  "claude-code": readClaudeCodeMemory,
  codex: readCodexMemory,
};

export interface HostMemoryOptions {
  /** The host the invocation is bound to (`--host`); detected from the environment when absent. */
  host?: HarnessId;
  /** The installed CLI's command names: what makes an `aw <x>` mention a Workline one. */
  commands: readonly string[];
}

/**
 * What the OTHER hosts of this machine learned about Workline. It only reads:
 * the report is the input a person or an agent judges, and saving anything is the
 * current host's own act, through its own channel.
 */
export async function runHostMemory(
  ctx: CliContext,
  options: HostMemoryOptions,
): Promise<HostMemoryReport> {
  const current = runHarness((name) => ctx.env.get(name), options.host);
  const commands = new Set(options.commands);
  const home = ctx.env.homeDir();
  const others = HARNESSES.filter((spec) => spec.id !== current.agent_host);
  const [readings, destination] = await Promise.all([
    Promise.all(others.map((spec) => readHost(spec, ctx, home, commands))),
    resolveDestination(current.agent_host, ctx),
  ]);
  const held = await heldIn(current.agent_host, destination.presenceRoot, ctx, home);
  const context: EntryContext = { commands, held, cliVersion: readPackageVersion() };
  return {
    current_host: {
      id: current.agent_host,
      detected_via: current.detected_via,
      destination: destination.destination,
      destination_reason: destination.reason,
    },
    hosts: readings.map((reading) => reading.row),
    entries: readings.flatMap((reading) =>
      reading.items.map((item) => toEntry(reading.row.host, item, context)),
    ),
  };
}

interface EntryContext {
  commands: ReadonlySet<string>;
  /** The ids the current host's destination already holds; null when there is none to look in. */
  held: ReadonlySet<string> | null;
  cliVersion: string;
}

/** A copy answers to its original: it takes the id and origin its mark names. */
function toEntry(host: HarnessId, item: RawMemoryItem, context: EntryContext): HostMemoryEntry {
  const mark = readOriginMark(item.body);
  const id = mark?.id ?? entryId(host, item.key);
  return {
    id,
    host,
    date: item.date,
    text: item.text,
    source: item.source,
    provenance:
      mark === null
        ? { kind: "native" }
        : { kind: "copy", origin_host: mark.host, origin_date: mark.date },
    present_in_destination: context.held === null ? null : context.held.has(id),
    stale: missingCommands(item.body, context.commands).map((command) => ({
      command,
      cli_version: context.cliVersion,
    })),
    origin_mark: formatOriginMark(mark ?? { id, host, date: item.date }),
  };
}

/**
 * What the destination already holds, by id: a native learning of the current
 * host, or a copy carrying its original's mark. Null when there is no destination
 * or its memory could not be read — "not held" would re-offer what is there.
 */
async function heldIn(
  host: Harness,
  root: string | null,
  ctx: CliContext,
  home: string,
): Promise<ReadonlySet<string> | null> {
  const reader = host === "unknown" ? undefined : HOST_MEMORY_READERS[host];
  if (root === null || reader === undefined) return null;
  try {
    const outcome = await reader(ctx.fs, home);
    if (outcome.state === "absent") return new Set();
    if (outcome.state !== "read") return null;
    const ids = new Set<string>();
    for (const item of outcome.items) {
      if (item.source.path !== root && !item.source.path.startsWith(`${root}${sep}`)) continue;
      ids.add(entryId(host, item.key));
      const mark = readOriginMark(item.body);
      if (mark !== null) ids.add(mark.id);
    }
    return ids;
  } catch {
    return null;
  }
}

interface HostReading {
  row: HostMemoryRow;
  /** Its Workline learnings, as the host's memory holds them. */
  items: RawMemoryItem[];
}

async function readHost(
  spec: HarnessSpec,
  ctx: CliContext,
  home: string,
  commands: ReadonlySet<string>,
): Promise<HostReading> {
  try {
    const reader = HOST_MEMORY_READERS[spec.id];
    if (reader === undefined) return { row: await rowWithoutReader(spec, ctx), items: [] };
    const outcome = await reader(ctx.fs, home);
    if (outcome.state !== "read") {
      return { row: emptyRow(spec, outcome.state, outcome.reason), items: [] };
    }
    const items = outcome.items.filter((item) => isWorklineTopic(item.topic, commands));
    const row = {
      ...emptyRow(spec, "read", null),
      workline_entries: items.length,
      other_entries: outcome.items.length - items.length,
      skipped: outcome.skipped,
    };
    return { row, items };
  } catch (err) {
    // One host's failure is that host's row, never the whole report.
    const reason = `la lectura falló: ${(err as Error).message}`;
    return { row: emptyRow(spec, "unreadable", reason), items: [] };
  }
}

async function rowWithoutReader(spec: HarnessSpec, ctx: CliContext): Promise<HostMemoryRow> {
  const presence = await reportHostState(spec, ctx);
  if (presence.status === "absent") {
    return emptyRow(spec, "absent", `${spec.label} no está en esta máquina`);
  }
  return emptyRow(spec, "no-curated-memory", `${spec.label} no guarda memoria curada propia`);
}

function emptyRow(
  spec: HarnessSpec,
  state: HostMemoryRow["state"],
  reason: string | null,
): HostMemoryRow {
  return {
    host: spec.id,
    label: spec.label,
    state,
    reason,
    workline_entries: 0,
    other_entries: 0,
    skipped: [],
  };
}
