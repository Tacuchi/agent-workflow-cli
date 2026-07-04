import { resolve } from "node:path";
import { HARNESSES, resolveGlobalMcpRawPath } from "../domain/harnesses.js";
import type { McpHost, McpInstance } from "../domain/mcp-entry.js";
import type { EnvPort } from "../ports/env.js";
import { McpWriterError } from "./mcp-host-writer.js";

export interface McpScopeInput {
  scope: "workspace" | "global";
  workspace?: string;
}

export interface McpScopeRefusal {
  ok: false;
  error: string;
  hint: string;
  exitCode: 2;
}

export interface McpErrorRecord {
  host: McpHost;
  instance: McpInstance;
  target: string;
  message: string;
}

export function resolveScopeDir(env: EnvPort, input: McpScopeInput): string {
  // Global scope resolves through the port (not os.homedir()) so tests can
  // inject a sandbox home instead of writing the developer's real configs.
  if (input.scope === "global") return env.homeDir();
  if (input.workspace) return resolve(input.workspace);
  return resolve(env.cwd());
}

export function buildGlobalHint(hosts: McpHost[]): string {
  const paths = HARNESSES.filter((h) => hosts.includes(h.mcpHostId as McpHost))
    .map((h) => resolveGlobalMcpRawPath(h))
    .filter((p): p is string => p !== null);
  const files = paths.length > 0 ? paths.join(", ") : "archivos de config globales";
  return `Tocar ${files} afecta TODOS los proyectos. Reintentá con --force o usá --dry-run para previsualizar.`;
}

export function buildGlobalRefusal(hosts: McpHost[]): McpScopeRefusal {
  return {
    ok: false,
    error: "global_requires_force",
    hint: buildGlobalHint(hosts),
    exitCode: 2,
  };
}

export function toErrorRecord(
  host: McpHost,
  instance: McpInstance,
  scopeDir: string,
  err: unknown,
): McpErrorRecord {
  if (err instanceof McpWriterError) {
    return {
      host,
      instance,
      target: err.target,
      message: `${err.message}${err.cause ? ` (${err.cause})` : ""}`,
    };
  }
  return { host, instance, target: scopeDir, message: (err as Error).message };
}
