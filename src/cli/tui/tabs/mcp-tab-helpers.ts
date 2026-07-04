// Pure helpers for the MCP tab — extracted so the rendering/UX logic is unit-
// testable without mounting the Ink component. The async command wiring
// (selfMcpConfig / testMcpConnection) stays in mcp-tab.tsx, thin over these.

import { harnessForMcpHost, resolveGlobalMcpRawPath } from "../../../domain/harnesses.js";
import type { McpHost } from "../../../domain/mcp-entry.js";
import type { ParsedArgs } from "../../parser.js";
import type { MetaTone } from "../components/list-row.js";

/** Whether a connection is present in the host's user-scope (global) config.
 *  Mirror of the (unexported) `InstallStatus` in `self/mcp-config.ts`. */
export type HostInstallStatus = "si" | "no" | "drift";

/** `ParsedArgs` skeleton to drive `selfMcpConfig` actions from the TUI. */
export function buildArgs(action: string, values: Record<string, string> = {}): ParsedArgs {
  return {
    rest: ["mcp", action],
    plugin: {},
    flags: new Set(),
    values: new Map(Object.entries(values)),
    valuesMulti: new Map(),
  };
}

/**
 * Suggest a DSN env var name from a connection alias, mirroring the CLI's
 * `dsnKeyForInstance`: `cert` → `DB_CERT_DSN`, `my-db` → `DB_MY_DB_DSN`.
 * Returns "" for an empty alias (no suggestion to prefill).
 */
export function suggestDsnVar(alias: string): string {
  const normalized = alias
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  if (normalized.length === 0) return "";
  return `DB_${normalized}_DSN`;
}

/**
 * Row state pill reflecting whether the connection is installed in the host's
 * user-scope config (vs. merely registered in mcp-connections.json).
 */
export function installStatusPill(status: HostInstallStatus): {
  label: string;
  tone: MetaTone;
} {
  switch (status) {
    case "si":
      return { label: "installed", tone: "ok" };
    case "drift":
      return { label: "drift", tone: "warn" };
    case "no":
      return { label: "registered", tone: "dim" };
  }
}

/** Detail-panel install action label, adapting to the current install status. */
export function installActionLabel(status: HostInstallStatus): string {
  switch (status) {
    case "no":
      return "Install → user scope";
    case "drift":
      return "Update user config";
    case "si":
      return "Reinstall → user scope";
  }
}

/**
 * Display path of the host's user-scope (global) MCP config, straight from the
 * harness registry (e.g. claude → `~/.claude.json`) so labels never drift from
 * the file the installer actually writes.
 */
export function installDestination(host: McpHost): string {
  const spec = harnessForMcpHost(host);
  const raw = spec ? resolveGlobalMcpRawPath(spec) : null;
  return raw ?? "user config";
}
