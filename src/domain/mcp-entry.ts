export type McpHost = "claude" | "codex" | "warp" | "gemini" | "opencode" | "crush";

export type McpInstance = string;

export type McpEntryName = string;

export const DEFAULT_MCP_INSTANCES = ["cert", "prod"] as const;

export interface McpEntry {
  name: McpEntryName;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface McpWriteOpts {
  dryRun?: boolean;
  force?: boolean;
}

export type McpWriteAction = "written" | "removed" | "skipped-idempotent" | "dry-run";

export interface McpWriteResult {
  host: McpHost;
  target: string;
  name: string;
  action: McpWriteAction;
  backup: string | null;
  diff?: string[];
}

export type McpDriftStatus = "ok" | "missing-mcp" | "dsn-mismatch" | "extra-entry" | "missing-dsn";

export interface McpDriftReport {
  host: McpHost;
  instance: McpInstance;
  scope: "workspace" | "global";
  target: string;
  dsn: { path: string; exists: boolean; key: string; present: boolean };
  mcp: { name: string; present: boolean; matches: boolean };
  status: McpDriftStatus;
  detail?: string;
}

export function normalizeMcpInstance(input: string): McpInstance {
  return input
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
}

export function validateMcpInstance(
  input: string,
): { ok: true; value: McpInstance } | { ok: false; error: string } {
  const value = normalizeMcpInstance(input);
  if (value.length === 0) {
    return { ok: false, error: "el nombre de conexión MCP no puede estar vacío" };
  }
  if (!/^[a-z][a-z0-9-]*$/.test(value)) {
    return {
      ok: false,
      error: `nombre de conexión MCP inválido: '${input}'. Usá letras, números y guiones; debe iniciar con letra`,
    };
  }
  if (value === "both") {
    return { ok: false, error: "'both' está reservado para selección múltiple" };
  }
  return { ok: true, value };
}

export function mcpEntryNameFor(instance: McpInstance): McpEntryName {
  return normalizeMcpInstance(instance);
}

export function normalizeDsnVarName(input: string): string {
  return input.trim().toUpperCase();
}

export function validateDsnVarName(
  input: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const value = normalizeDsnVarName(input);
  if (value.length === 0) {
    return { ok: false, error: "el nombre de variable DSN no puede estar vacío" };
  }
  if (!/^[A-Z_][A-Z0-9_]*$/.test(value)) {
    return {
      ok: false,
      error: `variable DSN inválida: '${input}'. Usá letras, números y guiones bajos; debe iniciar con letra o '_'`,
    };
  }
  return { ok: true, value };
}

/**
 * Ownership check: true when an existing config entry plausibly belongs to this
 * tool. Every shape this CLI ever wrote launches dbhub ("agent-workflow mcp
 * dbhub <x>" today; "npx @bytebase/dbhub" in the legacy era), so a same-named
 * entry with neither marker is the user's own server — remove/cleanup must
 * leave it untouched (at user scope the blast radius is every project).
 */
export function isDbhubManagedEntry(raw: { command?: unknown; args?: unknown }): boolean {
  const command = typeof raw.command === "string" ? raw.command : "";
  const args = Array.isArray(raw.args) ? raw.args.filter((x) => typeof x === "string") : [];
  const haystack = [command, ...args].join(" ");
  return haystack.includes("dbhub") || haystack.includes("agent-workflow");
}

export function buildMcpEntry(
  instance: McpInstance,
  dsnVar?: string,
  platform: string = process.platform,
): McpEntry {
  const normalized = normalizeMcpInstance(instance);
  const env: Record<string, string> = {
    MAX_ROWS: "1000",
    READONLY: "true",
    TRANSPORT: "stdio",
  };
  if (dsnVar !== undefined) {
    env.DBHUB_DSN_VAR = normalizeDsnVarName(dsnVar);
  }
  // Windows: el bin npm global es un shim `agent-workflow.cmd`; los hosts que
  // spawnean el server sin shell fallan (ENOENT/EINVAL) → envolver en `cmd /c`.
  // El doctor compara contra esta misma forma en la misma máquina, sin drift.
  const isWin = platform === "win32";
  return {
    name: mcpEntryNameFor(normalized),
    command: isWin ? "cmd" : "agent-workflow",
    args: isWin
      ? ["/c", "agent-workflow", "mcp", "dbhub", normalized]
      : ["mcp", "dbhub", normalized],
    env,
  };
}
