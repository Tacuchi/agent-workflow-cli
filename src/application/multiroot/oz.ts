/**
 * Oz adapter — MCP emitter (no file writer).
 *
 * Oz does not use a config file for MCP servers. Instead, MCP config is passed
 * via the --mcp CLI flag when invoking `oz agent run`. This module provides:
 * 1. A JSON builder for the --mcp payload.
 * 2. A command string that the user can copy-paste or pipe.
 */

export interface OzMcpServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface OzMcpPayload {
  [serverName: string]: OzMcpServer;
}

export interface OzMcpInvocation {
  /** The complete oz agent run command including --mcp flag. */
  command: string;
  /** The JSON string passed to --mcp (minified). */
  mcpJson: string;
  /** Human-readable hint for the user. */
  hint: string;
}

/**
 * Builds the oz agent run --mcp invocation for one or more MCP server entries.
 */
export function buildOzMcpInvocation(
  agentArgs: string[],
  mcpServers: OzMcpPayload,
): OzMcpInvocation {
  const mcpJson = JSON.stringify(mcpServers);
  const escapedJson = mcpJson.replace(/'/g, "'\\''");
  const baseCmd = ["oz", "agent", "run", ...agentArgs].join(" ");
  const command = `${baseCmd} --mcp '${escapedJson}'`;
  return {
    command,
    mcpJson,
    hint: "Oz does not write a config file. Run the command above or set OZ_MCP_CONFIG env var.",
  };
}

/**
 * Converts a single McpEntry into an OzMcpServer shape.
 */
export function mcpEntryToOzServer(entry: {
  command: string;
  args: string[];
  env: Record<string, string>;
}): OzMcpServer {
  return {
    command: entry.command,
    args: entry.args,
    ...(Object.keys(entry.env).length > 0 ? { env: entry.env } : {}),
  };
}

/**
 * Workspace path attachment for Oz. Oz is a cloud agent orchestrator with no
 * local workspace config file. This is intentionally a no-op.
 */
export interface OzAttachNoop {
  skipped: true;
  reason: "oz_cloud_no_local_config";
}

export function attachOz(_paths: string[], _scopeDir: string): OzAttachNoop {
  return { skipped: true, reason: "oz_cloud_no_local_config" };
}

export function detachOz(_paths: string[], _scopeDir: string): OzAttachNoop {
  return { skipped: true, reason: "oz_cloud_no_local_config" };
}
