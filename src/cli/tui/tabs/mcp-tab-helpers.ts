// Pure helpers for the MCP tab — extracted so the rendering/UX logic is unit-
// testable without mounting the Ink component. The async command wiring
// (selfMcpConfig / testMcpConnection) stays in mcp-tab.tsx, thin over these.

import type { MetaTone } from "../components/list-row.js";

/** Whether a connection is present in the workspace `.mcp.json` for the current
 *  host. Mirror of the (unexported) `InstallStatus` in `self/mcp-config.ts`. */
export type WorkspaceInstallStatus = "si" | "no" | "drift";

/**
 * Suggest a DSN env var name from a connection alias, mirroring the CLI's
 * `defaultDsnVar`: `cert` → `DB_CERT_DSN`, `my-db` → `DB_MY_DB_DSN`. Returns ""
 * for an empty alias (no suggestion to prefill).
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
 * Row state pill reflecting whether the connection is installed in the
 * workspace `.mcp.json` (vs. merely registered in profile.json).
 */
export function installStatusPill(status: WorkspaceInstallStatus): {
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
export function installActionLabel(status: WorkspaceInstallStatus): string {
  switch (status) {
    case "no":
      return "Install to workspace";
    case "drift":
      return "Update .mcp.json";
    case "si":
      return "Reinstall to workspace";
  }
}
