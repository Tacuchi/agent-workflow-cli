import {
  type McpConnectionRef,
  type McpDriftReport,
  type McpEntryState,
  type McpHost,
  buildMcpEntry,
} from "../domain/mcp-entry.js";
import { containsSensitiveData } from "../domain/redaction.js";
import type { EnvPort } from "../ports/env.js";
import { readDsnFile } from "./dsn-reader-service.js";
import { classifyMcpEntry } from "./mcp-entry-classification.js";
import { readMcpEntry } from "./mcp-host-reader.js";
import { type McpScopeInput, resolveScopeDir } from "./mcp-scope-common.js";
import type { PathsService } from "./paths-service.js";

export type McpDoctorInput = McpScopeInput & {
  hosts: McpHost[];
  connections: McpConnectionRef[];
  namespace?: string;
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
    legacy_entry: number;
    foreign_entry: number;
    malformed_entry: number;
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
      reports.push(buildReport(env, host, connection, scopeDir, dsn, input.scope, input.namespace));
    }
  }

  const summary = {
    ok: reports.filter((r) => r.status === "ok").length,
    missing_mcp: reports.filter((r) => r.status === "missing-mcp").length,
    dsn_mismatch: reports.filter((r) => r.status === "dsn-mismatch").length,
    missing_dsn: reports.filter((r) => r.status === "missing-dsn").length,
    extra: reports.filter((r) => r.status === "extra-entry").length,
    legacy_entry: reports.filter((r) => r.status === "legacy-entry").length,
    foreign_entry: reports.filter((r) => r.status === "foreign-entry").length,
    malformed_entry: reports.filter((r) => r.status === "malformed-entry").length,
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
  namespace: string | undefined,
): McpDriftReport {
  const entry = buildMcpEntry(connection.name, connection.dsnVar, {
    host,
    scope,
    ...(namespace === undefined ? {} : { namespace }),
  });
  const snapshot = readMcpEntry(host, scopeDir, entry.name, scope);
  const classification = classifyMcpEntry(host, snapshot, entry, connection);
  const dsnKey = connection.dsnVar;
  const dsnPresent = Boolean(env.get(dsnKey)) || Boolean(dsn.values[dsnKey]);

  const dsnInfo = {
    path: dsn.path,
    exists: dsn.exists,
    key: dsnKey,
    present: dsnPresent,
  };

  const mcp = {
    name: entry.name,
    present: snapshot.exists || Boolean(snapshot.present),
    matches: classification.state === "current",
  };
  const launchMode: McpDriftReport["launch_mode"] =
    scope === "workspace" ? "path-dependent" : "absolute";
  const base = {
    host,
    instance: connection.name,
    scope,
    target: snapshot.target,
    dsn: dsnInfo,
    mcp,
    entry_state: classification.state,
    launch_mode: launchMode,
  };
  const entryDecision = entryStateDecision(
    classification.state,
    dsnPresent,
    entry.name,
    connection.name,
    snapshot.target,
    hasEmbeddedCredential(snapshot),
  );
  if (entryDecision !== undefined) return { ...base, ...entryDecision };

  if (!dsnPresent) {
    return {
      ...base,
      status: "dsn-mismatch",
      detail: `MCP '${entry.name}' registrado pero ${dsnKey} no está en ${dsn.path}`,
    };
  }

  const detail = launchDetail(launchMode, host);
  return {
    ...base,
    status: "ok",
    ...(detail === undefined ? {} : { detail }),
  };
}

type ReportDecision = Pick<McpDriftReport, "status" | "detail">;

function entryStateDecision(
  state: McpEntryState,
  dsnPresent: boolean,
  entryName: string,
  instance: string,
  target: string,
  embeddedCredential: boolean,
): ReportDecision | undefined {
  if (state === "current") return undefined;
  if (state === "missing") {
    return {
      status: dsnPresent ? "missing-mcp" : "missing-dsn",
      detail: dsnPresent
        ? `Falta entrada MCP '${entryName}' en ${target}`
        : `Ni DSN ni MCP registrados para ${instance}`,
    };
  }
  return {
    status: entryStateStatus(state),
    detail: entryStateDetail(state, entryName, embeddedCredential),
  };
}

function entryStateStatus(
  state: Exclude<McpEntryState, "current" | "missing">,
): ReportDecision["status"] {
  switch (state) {
    case "malformed":
      return "malformed-entry";
    case "foreign":
      return "foreign-entry";
    case "known-legacy":
      return "legacy-entry";
  }
}

function entryStateDetail(
  state: Exclude<McpEntryState, "current" | "missing">,
  entryName: string,
  embeddedCredential: boolean,
): string {
  switch (state) {
    case "malformed":
      return embeddedCredential
        ? `${malformedEntryDetail(entryName)}; parece contener una credencial embebida; retirala y rotá esa credencial.`
        : malformedEntryDetail(entryName);
    case "foreign":
      return embeddedCredential
        ? `La entrada '${entryName}' no coincide con una forma publicada por Workline y parece contener una credencial embebida; retirala y rotá esa credencial.`
        : `La entrada '${entryName}' no coincide con una forma publicada por Workline`;
    case "known-legacy":
      return embeddedCredential
        ? `La entrada '${entryName}' usa un descriptor histórico de Workline y parece contener una credencial embebida; retirala y rotá esa credencial.`
        : `La entrada '${entryName}' usa un descriptor histórico de Workline`;
  }
}

function malformedEntryDetail(entryName: string): string {
  return `La entrada '${entryName}' no puede interpretarse de forma segura`;
}

/** Never return a value from a host entry; this only drives a safe remediation hint. */
export function hasEmbeddedCredential(snapshot: ReturnType<typeof readMcpEntry>): boolean {
  return containsSensitiveData({
    ...(snapshot.command === undefined ? {} : { command: snapshot.command }),
    ...(snapshot.args === undefined ? {} : { args: snapshot.args }),
    ...(snapshot.env === undefined ? {} : { env: snapshot.env }),
    ...(snapshot.raw === undefined ? {} : { raw: snapshot.raw }),
  });
}

function launchDetail(
  launchMode: "absolute" | "path-dependent",
  host: McpHost,
): string | undefined {
  const detail = [
    ...(launchMode === "path-dependent"
      ? ["Descriptor portable dependiente de PATH; la garantía absoluta aplica a user scope/TUI."]
      : []),
    ...(host === "warp"
      ? ["Recordá activar 'File-based MCP Servers' en Warp Settings para que Warp lo spawnee."]
      : []),
  ].join(" ");
  return detail.length === 0 ? undefined : detail;
}
