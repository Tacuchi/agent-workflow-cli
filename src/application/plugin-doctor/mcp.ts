import { join } from "node:path";
import type { EnvPort } from "../../ports/env.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import type { ResolvedRuntime } from "../../runtime/types.js";
import { type DoctorFinding, isRecord, type McpServerInfo } from "./common.js";

export interface McpResult {
  mcpInfo: Record<string, McpServerInfo>;
  findings: DoctorFinding[];
}

export async function validateMcp(
  pluginRoot: string,
  runtime: ResolvedRuntime,
  env: EnvPort,
  fs: FileSystemPort,
): Promise<McpResult> {
  const findings: DoctorFinding[] = [];
  const mcpInfo: Record<string, McpServerInfo> = {};
  const mcpPath = join(pluginRoot, ".mcp.json");
  const expectedMcpServers = runtime.expectedMcpServers ?? [];
  if (expectedMcpServers.length === 0 || !(await fs.exists(mcpPath))) {
    return { mcpInfo, findings };
  }
  let mcpData: unknown = null;
  try {
    mcpData = JSON.parse(await fs.readText(mcpPath));
  } catch (e) {
    findings.push({
      level: "error",
      file: ".mcp.json",
      msg: `invalid JSON: ${(e as Error).message}`,
    });
    return { mcpInfo, findings };
  }
  if (!isRecord(mcpData)) return { mcpInfo, findings };
  const servers = isRecord(mcpData.mcpServers) ? mcpData.mcpServers : {};
  for (const exp of expectedMcpServers) {
    const server = (servers as Record<string, unknown>)[exp];
    mcpInfo[exp] = validateMcpServer(server, exp, env, findings);
  }
  return { mcpInfo, findings };
}

function validateMcpServer(
  server: unknown,
  exp: string,
  env: EnvPort,
  findings: DoctorFinding[],
): McpServerInfo {
  if (server === undefined) {
    findings.push({
      level: "warn",
      file: ".mcp.json",
      msg: `expected server '${exp}' not configured`,
    });
    return "missing";
  }
  const dsnRaw =
    isRecord(server) && isRecord(server.env) && typeof server.env.DSN === "string"
      ? server.env.DSN
      : "";
  const m = dsnRaw.match(/^\$\{(\w+)\}$/);
  if (!m?.[1]) return { dsn_env: null, env_set: null };
  const envVar = m[1];
  const envSet = Boolean(env.get(envVar));
  if (!envSet) {
    findings.push({
      level: "warn",
      file: ".mcp.json",
      msg: `env var ${envVar} not set (required by mcp server '${exp}')`,
    });
  }
  return { dsn_env: envVar, env_set: envSet };
}
