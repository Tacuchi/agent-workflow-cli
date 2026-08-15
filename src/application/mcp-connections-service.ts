import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  type McpConnectionRef,
  normalizeDsnVarName,
  normalizeMcpInstance,
  validateDsnVarName,
  validateMcpInstance,
} from "../domain/mcp-entry.js";
import type { EnvPort } from "../ports/env.js";
import { readDsnFile } from "./dsn-reader-service.js";
import type { PathsService } from "./paths-service.js";

export interface StoredMcpConnection extends McpConnectionRef {}

export interface McpConnection extends StoredMcpConnection {
  dsnPresent: boolean;
}

interface McpConnectionsFile {
  version: 1;
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

  const connections = readStoredConnections(paths);
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
  input: { name: string; dsnVar: string },
): McpConnectionWriteResult {
  const connection = normalizeConnection(input);
  const existing = readStoredConnections(paths);
  const byName = new Map(existing.map((item) => [item.name, item]));
  byName.set(connection.name, connection);
  writeStoredConnections(paths, [...byName.values()].sort(compareConnections));
  return { path: paths.userMcpConnectionsFile(), connection };
}

export function deleteMcpConnection(
  paths: PathsService,
  input: { name: string },
): McpConnectionDeleteResult {
  const validation = validateMcpInstance(input.name);
  if (!validation.ok) throw new Error(validation.error);
  const name = validation.value;
  const existing = readStoredConnections(paths);
  const next = existing.filter((item) => item.name !== name);
  writeStoredConnections(paths, next);
  return { path: paths.userMcpConnectionsFile(), removed: next.length !== existing.length };
}

export function validateMcpConnectionInput(input: {
  name: string;
  dsnVar: string;
}): { ok: true; value: StoredMcpConnection } | { ok: false; error: string } {
  const name = validateMcpInstance(input.name);
  if (!name.ok) return name;
  const dsnVar = validateDsnVarName(input.dsnVar);
  if (!dsnVar.ok) return dsnVar;
  return { ok: true, value: { name: name.value, dsnVar: dsnVar.value } };
}

function normalizeConnection(input: { name: string; dsnVar: string }): StoredMcpConnection {
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
  if (raw.trim().length === 0) return [];
  const parsed = JSON.parse(raw) as Partial<McpConnectionsFile>;
  if (!Array.isArray(parsed.connections)) return [];
  const out: StoredMcpConnection[] = [];
  for (const item of parsed.connections) {
    if (!isConnectionLike(item)) continue;
    const validation = validateMcpConnectionInput(item);
    if (validation.ok) out.push(validation.value);
  }
  return dedupeConnections(out);
}

function writeStoredConnections(paths: PathsService, connections: StoredMcpConnection[]): void {
  const file = paths.userMcpConnectionsFile();
  mkdirSync(dirname(file), { recursive: true });
  const payload: McpConnectionsFile = { version: 1, connections };
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  try {
    chmodSync(file, 0o600);
  } catch {
    // ignore chmod failures
  }
}

function dedupeConnections(connections: StoredMcpConnection[]): StoredMcpConnection[] {
  const byName = new Map<string, StoredMcpConnection>();
  for (const connection of connections) {
    byName.set(normalizeMcpInstance(connection.name), {
      name: normalizeMcpInstance(connection.name),
      dsnVar: normalizeDsnVarName(connection.dsnVar),
    });
  }
  return [...byName.values()].sort(compareConnections);
}

function compareConnections(a: StoredMcpConnection, b: StoredMcpConnection): number {
  return a.name.localeCompare(b.name);
}

function isConnectionLike(value: unknown): value is { name: string; dsnVar: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.name === "string" && typeof record.dsnVar === "string";
}
