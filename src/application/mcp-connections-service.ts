import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  type McpConnectionRef,
  validateDsnVarName,
  validateMcpInstance,
} from "../domain/mcp-entry.js";
import type { EnvPort } from "../ports/env.js";
import { readDsnFile } from "./dsn-reader-service.js";
import type { PathsService } from "./paths-service.js";

export type McpConnectionProvider = "postgres";

/** A corrupt registry is never silently treated as an empty registry. */
export class McpConnectionsError extends Error {
  constructor(message = "mcp-connections.json no contiene una forma válida de registro MCP.") {
    super(message);
    this.name = "McpConnectionsError";
  }
}

/** The persisted v2 shape always names its provider explicitly. */
export interface StoredMcpConnection extends McpConnectionRef {
  provider: McpConnectionProvider;
}

export interface McpConnection extends StoredMcpConnection {
  dsnPresent: boolean;
}

interface McpConnectionsFileV2 {
  version: 2;
  connections: StoredMcpConnection[];
}

export interface McpConnectionWriteResult {
  path: string;
  connection: StoredMcpConnection;
}

export interface McpConnectionDeleteResult {
  path: string;
  removed: boolean;
}

export type McpConnectionSelectionErrorCode =
  | "NO_MCP_CONNECTIONS"
  | "MCP_CONNECTION_SELECTION_CONFLICT"
  | "MCP_CONNECTION_INVALID"
  | "MCP_CONNECTION_NOT_REGISTERED"
  | "MCP_INSTANCE_REQUIRED";

export interface McpConnectionSelectionError {
  ok: false;
  code: McpConnectionSelectionErrorCode;
  message: string;
}

export interface McpConnectionSelection {
  ok: true;
  connections: StoredMcpConnection[];
}

export type McpConnectionSelectionResult = McpConnectionSelection | McpConnectionSelectionError;

export function readMcpConnections(paths: PathsService, env: EnvPort): McpConnection[] {
  const stored = readStoredConnections(paths);
  const dsn = readDsnFile(paths);
  return stored.map((connection) => ({
    ...connection,
    dsnPresent: Boolean(env.get(connection.dsnVar)) || Boolean(dsn.values[connection.dsnVar]),
  }));
}

/**
 * Resolves a registry-owned connection set for every direct MCP operation.
 *
 * The registry is the only authority for a connection name and its DSN
 * variable: an explicit name must already exist there, omission selects the
 * sole registered connection, and a fan-out is opt-in through
 * `--all-connections` at the CLI boundary.
 */
export function resolveMcpConnectionSelection(
  paths: PathsService,
  input: { instance?: string; allConnections?: boolean } = {},
): McpConnectionSelectionResult {
  if (input.allConnections && input.instance !== undefined) {
    return selectionFailure(
      "MCP_CONNECTION_SELECTION_CONFLICT",
      "Usá --instance <nombre> o --all-connections, no ambos.",
    );
  }

  let connections: StoredMcpConnection[];
  try {
    connections = readStoredConnections(paths);
  } catch (error) {
    if (error instanceof McpConnectionsError) {
      return selectionFailure("MCP_CONNECTION_INVALID", error.message);
    }
    throw error;
  }
  if (connections.length === 0) {
    return selectionFailure(
      "NO_MCP_CONNECTIONS",
      "No hay conexiones MCP registradas. Registrá una con 'aw self mcp use-env --name <nombre> --dsn-var <VARIABLE>'.",
    );
  }

  if (input.allConnections) return { ok: true, connections };

  if (input.instance !== undefined) {
    const validation = validateMcpInstance(input.instance);
    if (!validation.ok) return selectionFailure("MCP_CONNECTION_INVALID", validation.error);
    const connection = connections.find((item) => item.name === validation.value);
    if (connection === undefined) {
      return selectionFailure(
        "MCP_CONNECTION_NOT_REGISTERED",
        `La conexión MCP '${validation.value}' no está registrada en ${paths.userMcpConnectionsFile()}.`,
      );
    }
    return { ok: true, connections: [connection] };
  }

  if (connections.length === 1) return { ok: true, connections };
  return selectionFailure(
    "MCP_INSTANCE_REQUIRED",
    `Hay ${connections.length} conexiones MCP registradas. Indicá --instance <nombre> o --all-connections.`,
  );
}

export function upsertMcpConnection(
  paths: PathsService,
  input: { name: string; dsnVar: string; provider?: McpConnectionProvider },
): McpConnectionWriteResult {
  return withConnectionsLock(paths, () => {
    const connection = normalizeConnection(input);
    const existing = readStoredConnections(paths);
    const byName = new Map(existing.map((item) => [item.name, item]));
    byName.set(connection.name, connection);
    writeStoredConnections(paths, [...byName.values()].sort(compareConnections));
    return { path: paths.userMcpConnectionsFile(), connection };
  });
}

export function deleteMcpConnection(
  paths: PathsService,
  input: { name: string },
): McpConnectionDeleteResult {
  return withConnectionsLock(paths, () => {
    const validation = validateMcpInstance(input.name);
    if (!validation.ok) throw new Error(validation.error);
    const name = validation.value;
    const existing = readStoredConnections(paths);
    const next = existing.filter((item) => item.name !== name);
    writeStoredConnections(paths, next);
    return { path: paths.userMcpConnectionsFile(), removed: next.length !== existing.length };
  });
}

export function validateMcpConnectionInput(input: {
  name: string;
  dsnVar: string;
  provider?: string;
}): { ok: true; value: StoredMcpConnection } | { ok: false; error: string } {
  const name = validateMcpInstance(input.name);
  if (!name.ok) return name;
  const dsnVar = validateDsnVarName(input.dsnVar);
  if (!dsnVar.ok) return dsnVar;
  if (input.provider !== undefined && input.provider !== "postgres") {
    return {
      ok: false,
      error: `provider MCP inválido: '${input.provider}'. V1 sólo admite postgres.`,
    };
  }
  return { ok: true, value: { name: name.value, dsnVar: dsnVar.value, provider: "postgres" } };
}

function normalizeConnection(input: {
  name: string;
  dsnVar: string;
  provider?: McpConnectionProvider;
}): StoredMcpConnection {
  const validation = validateMcpConnectionInput(input);
  if (!validation.ok) throw new Error(validation.error);
  return validation.value;
}

function selectionFailure(
  code: McpConnectionSelectionErrorCode,
  message: string,
): McpConnectionSelectionError {
  return { ok: false, code, message };
}

function readStoredConnections(paths: PathsService): StoredMcpConnection[] {
  const file = paths.userMcpConnectionsFile();
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, "utf-8");
  if (raw.trim().length === 0) throw new McpConnectionsError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new McpConnectionsError();
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.connections)) throw new McpConnectionsError();
  const version = parsed.version;
  if (version !== 1 && version !== 2 && version !== undefined) throw new McpConnectionsError();
  const out: StoredMcpConnection[] = [];
  const names = new Set<string>();
  for (const item of parsed.connections) {
    if (!isStoredConnectionForVersion(item, version)) throw new McpConnectionsError();
    const validation = validateMcpConnectionInput(item);
    if (!validation.ok) throw new McpConnectionsError();
    if (names.has(validation.value.name)) throw new McpConnectionsError();
    names.add(validation.value.name);
    out.push(validation.value);
  }
  return out.sort(compareConnections);
}

function writeStoredConnections(paths: PathsService, connections: StoredMcpConnection[]): void {
  const file = paths.userMcpConnectionsFile();
  mkdirSync(dirname(file), { recursive: true });
  const payload: McpConnectionsFileV2 = { version: 2, connections };
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  try {
    chmodSync(temporary, 0o600);
  } catch {
    // ignore chmod failures
  }
  renameSync(temporary, file);
}

/** Serialize registry read-modify-write rather than risking a silent lost alias. */
function withConnectionsLock<T>(paths: PathsService, work: () => T): T {
  const file = paths.userMcpConnectionsFile();
  const lock = `${file}.lock`;
  mkdirSync(dirname(file), { recursive: true });
  let descriptor: number;
  try {
    descriptor = openSync(lock, "wx", 0o600);
  } catch (error) {
    const code =
      error !== null && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
    if (code === "EEXIST") {
      throw new Error(
        "Otro proceso está actualizando mcp-connections.json; reintentá la operación.",
      );
    }
    throw error;
  }
  try {
    return work();
  } finally {
    try {
      closeSync(descriptor);
    } finally {
      try {
        unlinkSync(lock);
      } catch {
        // Fail closed on the next write instead of assuming a concurrent lock is stale.
      }
    }
  }
}

function compareConnections(a: StoredMcpConnection, b: StoredMcpConnection): number {
  return a.name.localeCompare(b.name);
}

function isStoredConnectionForVersion(
  value: unknown,
  version: unknown,
): value is { name: string; dsnVar: string; provider?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = version === 2 ? ["dsnVar", "name", "provider"] : ["dsnVar", "name"];
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index]) &&
    typeof record.name === "string" &&
    typeof record.dsnVar === "string" &&
    (version === 2 ? record.provider === "postgres" : record.provider === undefined)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
