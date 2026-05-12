import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  type McpDriftReport,
  type McpHost,
  type McpInstance,
  buildMcpEntry,
  normalizeMcpInstance,
} from "../domain/mcp-entry.js";
import type { EnvPort } from "../ports/env.js";
import { dsnKeyForInstance, readBootstrapDsn } from "./dsn-reader-service.js";
import { readMcpEntry } from "./mcp-host-reader.js";
import type { PathsService } from "./paths-service.js";

export interface McpDoctorInput {
  hosts: McpHost[];
  instances: McpInstance[];
  scope: "workspace" | "global";
  workspace?: string;
  dsnVars?: Record<string, string>;
}

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
  const dsn = readBootstrapDsn(paths);
  const reports: McpDriftReport[] = [];

  for (const host of input.hosts) {
    for (const instance of input.instances) {
      reports.push(buildReport(env, host, instance, scopeDir, dsn, input.scope, input.dsnVars));
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
  instance: McpInstance,
  scopeDir: string,
  dsn: ReturnType<typeof readBootstrapDsn>,
  scope: "workspace" | "global",
  dsnVars: Record<string, string> | undefined,
): McpDriftReport {
  const dsnKey = dsnVars?.[normalizeMcpInstance(instance)] ?? dsnKeyForInstance(instance);
  const entry = buildMcpEntry(instance, dsnVars?.[normalizeMcpInstance(instance)]);
  const snapshot = readMcpEntry(host, scopeDir, entry.name, scope);
  const dsnPresent = Boolean(env.get(dsnKey)) || (dsn.exists && Boolean(dsn.values[dsnKey]));

  const dsnInfo = {
    path: dsn.path,
    exists: dsn.exists,
    key: dsnKey,
    present: dsnPresent,
  };

  if (!snapshot.exists) {
    return {
      host,
      instance,
      scope,
      target: snapshot.target,
      dsn: dsnInfo,
      mcp: { name: entry.name, present: false, matches: false },
      status: dsnPresent ? "missing-mcp" : "missing-dsn",
      detail: dsnPresent
        ? `Falta entrada MCP '${entry.name}' en ${snapshot.target}`
        : `Ni DSN ni MCP registrados para ${instance}`,
    };
  }

  const matches = matchesEntry(snapshot, entry);
  if (!dsnPresent) {
    return {
      host,
      instance,
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
      instance,
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
    instance,
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
  if (!arraysEqual(snapshot.args ?? [], entry.args)) return false;
  if (!recordsEqual(snapshot.env ?? {}, entry.env)) return false;
  return true;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function recordsEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i += 1) {
    if (keysA[i] !== keysB[i]) return false;
    const k = keysA[i] ?? "";
    if (a[k] !== b[k]) return false;
  }
  return true;
}

function resolveScopeDir(env: EnvPort, input: McpDoctorInput): string {
  if (input.scope === "global") return homedir();
  if (input.workspace) return resolve(input.workspace);
  return resolve(env.cwd());
}
