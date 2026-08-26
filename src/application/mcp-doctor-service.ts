import { isDeepStrictEqual } from "node:util";
import {
  type McpConnectionRef,
  type McpDriftReport,
  type McpHost,
  buildMcpEntry,
} from "../domain/mcp-entry.js";
import type { EnvPort } from "../ports/env.js";
import { readDsnFile } from "./dsn-reader-service.js";
import { readMcpEntry } from "./mcp-host-reader.js";
import { type McpScopeInput, resolveScopeDir } from "./mcp-scope-common.js";
import type { PathsService } from "./paths-service.js";

export type McpDoctorInput = McpScopeInput & {
  hosts: McpHost[];
  connections: McpConnectionRef[];
};

export interface McpDoctorResult {
  scope: "workspace" | "global";
  scope_dir: string;
  reports: McpDriftReport[];
  summary: {
    ok: number;
    missing_mcp: number;
    dsn_mismatch: number;
    missing_dsn: number;
    extra: number;
  };
}

export function runMcpDoctor(
  env: EnvPort,
  paths: PathsService,
  input: McpDoctorInput,
): McpDoctorResult {
  const scopeDir = resolveScopeDir(env, input);
  const dsn = readDsnFile(paths);
  const reports: McpDriftReport[] = [];

  for (const host of input.hosts) {
    for (const connection of input.connections) {
      reports.push(buildReport(env, host, connection, scopeDir, dsn, input.scope));
    }
  }

  const summary = {
    ok: reports.filter((r) => r.status === "ok").length,
    missing_mcp: reports.filter((r) => r.status === "missing-mcp").length,
    dsn_mismatch: reports.filter((r) => r.status === "dsn-mismatch").length,
    missing_dsn: reports.filter((r) => r.status === "missing-dsn").length,
    extra: reports.filter((r) => r.status === "extra-entry").length,
  };

  return { scope: input.scope, scope_dir: scopeDir, reports, summary };
}

function buildReport(
  env: EnvPort,
  host: McpHost,
  connection: McpConnectionRef,
  scopeDir: string,
  dsn: ReturnType<typeof readDsnFile>,
  scope: "workspace" | "global",
): McpDriftReport {
  const entry = buildMcpEntry(connection.name, connection.dsnVar);
  const snapshot = readMcpEntry(host, scopeDir, entry.name, scope);
  const dsnKey = connection.dsnVar;
  const dsnPresent = Boolean(env.get(dsnKey)) || Boolean(dsn.values[dsnKey]);

  const dsnInfo = {
    path: dsn.path,
    exists: dsn.exists,
    key: dsnKey,
    present: dsnPresent,
  };

  if (!snapshot.exists) {
    return {
      host,
      instance: connection.name,
      scope,
      target: snapshot.target,
      dsn: dsnInfo,
      mcp: { name: entry.name, present: false, matches: false },
      status: dsnPresent ? "missing-mcp" : "missing-dsn",
      detail: dsnPresent
        ? `Falta entrada MCP '${entry.name}' en ${snapshot.target}`
        : `Ni DSN ni MCP registrados para ${connection.name}`,
    };
  }

  const matches = matchesEntry(snapshot, entry);
  if (!dsnPresent) {
    return {
      host,
      instance: connection.name,
      scope,
      target: snapshot.target,
      dsn: dsnInfo,
      mcp: { name: entry.name, present: true, matches },
      status: "dsn-mismatch",
      detail: `MCP '${entry.name}' registrado pero ${dsnKey} no está en ${dsn.path}`,
    };
  }

  if (!matches) {
    return {
      host,
      instance: connection.name,
      scope,
      target: snapshot.target,
      dsn: dsnInfo,
      mcp: { name: entry.name, present: true, matches: false },
      status: "extra-entry",
      detail: `Entrada '${entry.name}' difiere del shape esperado (command/args/env)`,
    };
  }

  return {
    host,
    instance: connection.name,
    scope,
    target: snapshot.target,
    dsn: dsnInfo,
    mcp: { name: entry.name, present: true, matches: true },
    status: "ok",
    ...(host === "warp"
      ? {
          detail:
            "Recordá activar 'File-based MCP Servers' en Warp Settings para que Warp lo spawnee.",
        }
      : {}),
  };
}

function matchesEntry(
  snapshot: ReturnType<typeof readMcpEntry>,
  entry: ReturnType<typeof buildMcpEntry>,
): boolean {
  if (snapshot.command !== entry.command) return false;
  if (!isDeepStrictEqual(snapshot.args ?? [], entry.args)) return false;
  if (!isDeepStrictEqual(snapshot.env ?? {}, entry.env)) return false;
  return true;
}
