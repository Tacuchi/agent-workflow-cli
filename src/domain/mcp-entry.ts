export type McpHost = "claude" | "codex" | "warp" | "gemini" | "opencode" | "crush" | "kimi";

export type McpInstance = string;

export type McpEntryName = string;

/** A registered connection and the exact DSN variable it owns. */
export interface McpConnectionRef {
  name: McpInstance;
  dsnVar: string;
}

export interface McpEntry {
  name: McpEntryName;
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * The complete persisted shape for one host's MCP entry.
 *
 * Ownership is deliberately structural: a server bearing the same name is not
 * ours unless this entire generated representation matches. Keeping the shape
 * next to the entry contract lets writers and read-only state probes enforce
 * the same rule without each inventing a partial "looks like Workline" test.
 */
export function mcpEntryShapeForHost(host: McpHost, entry: McpEntry): Record<string, unknown> {
  switch (host) {
    case "opencode":
      return {
        type: "local",
        command: [entry.command, ...entry.args],
        environment: { ...entry.env },
        enabled: true,
      };
    case "crush":
      return {
        type: "stdio",
        command: entry.command,
        args: [...entry.args],
        env: { ...entry.env },
      };
    case "claude":
    case "codex":
    case "warp":
    case "gemini":
    case "kimi":
      return {
        command: entry.command,
        args: [...entry.args],
        env: { ...entry.env },
      };
  }
}

export interface McpWriteOpts {
  dryRun?: boolean;
}

export type McpWriteAction =
  | "written"
  | "removed"
  | "skipped-idempotent"
  | "dry-run"
  /** A same-named entry has a different shape and belongs to someone else. */
  | "conflict";

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

export function buildMcpEntry(
  instance: McpInstance,
  dsnVar: string,
  platform: string = process.platform,
): McpEntry {
  const normalized = normalizeMcpInstance(instance);
  const env: Record<string, string> = {
    MAX_ROWS: "1000",
    READONLY: "true",
    TRANSPORT: "stdio",
  };
  env.DBHUB_DSN_VAR = normalizeDsnVarName(dsnVar);
  // Windows: the global npm bin is an `agent-workflow.cmd` shim; hosts that
  // spawn the server without a shell fail (ENOENT/EINVAL) → wrap in `cmd /c`.
  // The doctor compares against this same shape on the same machine — no drift.
  const isWin = platform === "win32";
  return {
    name: mcpEntryNameFor(normalized),
    command: isWin ? "cmd" : "agent-workflow",
    args: isWin
      ? ["/c", "agent-workflow", "mcp", "dbhub", "--instance", normalized]
      : ["mcp", "dbhub", "--instance", normalized],
    env,
  };
}
