import { isDeepStrictEqual } from "node:util";
import {
  type McpConnectionRef,
  type McpEntry,
  type McpEntryState,
  type McpHost,
  knownLegacyMcpEntries,
  mcpEntryShapeForHost,
  previousReliableMcpEntry,
} from "../domain/mcp-entry.js";
import { WORKLINE_MCP_ENTRY_NAME, worklineMcpEntry } from "../domain/workline-mcp-entry.js";
import type { McpEntrySnapshot } from "./mcp-host-reader.js";

export interface McpEntryClassification {
  state: McpEntryState;
  legacy?: McpEntry;
  /** Host config file holding the same-named entry this state describes; absent when `missing`. */
  target?: string;
}

export function classifyMcpEntry(
  host: McpHost,
  snapshot: McpEntrySnapshot,
  current: McpEntry,
  connection: McpConnectionRef,
): McpEntryClassification {
  const primary = classifySnapshot(host, snapshot, current, connection);
  if (host === "claude" && snapshot.legacy_location && primary.state === "current") {
    // A current descriptor in the old location is safe to move, but it must
    // not be reported as fully current because Claude may still load it.
    return { state: "known-legacy", legacy: current, target: snapshot.target };
  }
  if (snapshot.secondary === undefined || primary.state !== "current") return primary;
  const secondary = classifySnapshot(host, snapshot.secondary, current, connection);
  if (secondary.state === "missing") return primary;
  if (secondary.state === "current") {
    return { state: "known-legacy", legacy: current, target: snapshot.secondary.target };
  }
  return secondary;
}

// The state plus, whenever an entry is there at all, the file it was read from.
// A Claude entry may sit in the historical location, so a consumer cannot
// recompute the file from the host alone — only the snapshot knows.
function classifySnapshot(
  host: McpHost,
  snapshot: McpEntrySnapshot,
  current: McpEntry,
  connection: McpConnectionRef,
): McpEntryClassification {
  const shape = classifyShape(host, snapshot, current, connection);
  return shape.state === "missing" ? shape : { ...shape, target: snapshot.target };
}

function classifyShape(
  host: McpHost,
  snapshot: McpEntrySnapshot,
  current: McpEntry,
  connection: McpConnectionRef,
): McpEntryClassification {
  if (!snapshot.exists) {
    if (!snapshot.present) return { state: "missing" };
    // Readers retain a raw same-named scalar so it remains a foreign entry,
    // whereas an unparseable container has no raw shape and is malformed.
    return { state: snapshot.raw === undefined ? "malformed" : "foreign" };
  }
  if (
    snapshot.malformed ||
    snapshot.raw === undefined ||
    snapshot.command === undefined ||
    snapshot.args === undefined
  ) {
    return { state: "malformed" };
  }
  if (isDeepStrictEqual(snapshot.raw, mcpEntryShapeForHost(host, current))) {
    return { state: "current" };
  }
  const previous = previousReliableMcpEntry(current);
  if (
    previous !== undefined &&
    isDeepStrictEqual(snapshot.raw, mcpEntryShapeForHost(host, previous))
  ) {
    return { state: "known-legacy", legacy: previous };
  }
  const legacy = knownLegacyMcpEntries(connection.name, connection.dsnVar).find((entry) =>
    isDeepStrictEqual(snapshot.raw, mcpEntryShapeForHost(host, entry)),
  );
  if (legacy !== undefined) return { state: "known-legacy", legacy };

  // Before database MCP used the connection name, surface installation wrote a
  // single elicitation server called `agent-workflow`. A database connection
  // with that valid name must not be rejected or overwrite it implicitly: its
  // exact historic shape is migratable only through the explicit migration
  // flow. Every other same-named shape remains foreign.
  const elicitation = legacyElicitationEntry(host, current);
  if (
    elicitation !== undefined &&
    isDeepStrictEqual(snapshot.raw, mcpEntryShapeForHost(host, elicitation))
  ) {
    return { state: "known-legacy", legacy: elicitation };
  }
  return { state: "foreign" };
}

function legacyElicitationEntry(host: McpHost, current: McpEntry): McpEntry | undefined {
  return current.name === WORKLINE_MCP_ENTRY_NAME ? worklineMcpEntry(host) : undefined;
}
