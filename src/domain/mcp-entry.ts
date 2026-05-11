export type McpHost = "claude" | "codex" | "warp";

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

export function buildMcpEntry(instance: McpInstance, dsnVar?: string): McpEntry {
  const normalized = normalizeMcpInstance(instance);
  const env: Record<string, string> = {
    MAX_ROWS: "1000",
    READONLY: "true",
    TRANSPORT: "stdio",
  };
  if (dsnVar !== undefined) {
    env.DBHUB_DSN_VAR = normalizeDsnVarName(dsnVar);
  }
  return {
    name: mcpEntryNameFor(normalized),
    command: "agent-workflow",
    args: ["mcp", "dbhub", normalized],
    env,
  };
}
