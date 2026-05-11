import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { harnessById } from "../../domain/harnesses.js";
import type { HarnessChannel } from "../../domain/harnesses.js";
import { backupFile } from "./paths.js";

export interface WarpAttachNoop {
  skipped: true;
  reason: "warp_no_workspace_dirs";
  file: string;
}

export interface WarpMcpWriteOk {
  file: string;
  backup: string | null;
  added: string[];
  already_present: string[];
  written: boolean;
}

export interface WarpMcpWriteFail {
  file: string;
  error: string;
  skipped: true;
}

export type WarpResult = WarpAttachNoop | WarpMcpWriteOk | WarpMcpWriteFail;

/**
 * Resolves the absolute path to Warp's global .mcp.json by platform and channel.
 * Expands `~` using homedir(). Uses the registry as source of truth (DEC-W3).
 */
export function resolveWarpGlobalMcpPath(
  platform: NodeJS.Platform = process.platform,
  channel: HarnessChannel = "stable",
  homedirFn: () => string = homedir,
): string | null {
  const spec = harnessById("warp");
  if (!spec?.globalMcpPaths) return null;

  const home = homedirFn();
  const byPlatform =
    platform === "darwin"
      ? spec.globalMcpPaths.darwin
      : platform === "linux"
        ? spec.globalMcpPaths.linux
        : spec.globalMcpPaths.win32;

  const raw = (channel === "preview" ? byPlatform.preview : null) ?? byPlatform.stable;
  // Expand ~ and %LOCALAPPDATA%
  if (raw.startsWith("~")) return join(home, raw.slice(1));
  if (raw.includes("%LOCALAPPDATA%")) {
    const localAppData = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    return raw.replace("%LOCALAPPDATA%", localAppData);
  }
  return raw;
}

/**
 * Returns the project-scoped .warp/.mcp.json path.
 */
export function resolveWarpProjectMcpPath(scopeDir: string): string {
  return join(scopeDir, ".warp", ".mcp.json");
}

/**
 * Upserts an MCP server entry in Warp's .mcp.json (project or global).
 * Schema: {"mcpServers":{"<name>":{"command":"...","args":[...],"env":{}}}}
 */
export function attachWarpMcp(
  file: string,
  name: string,
  entry: { command: string; args: string[]; env: Record<string, string> },
): WarpMcpWriteOk | WarpMcpWriteFail {
  let data: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const text = readFileSync(file, "utf-8");
      if (text.trim().length > 0) {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          data = parsed as Record<string, unknown>;
        }
      }
    } catch (e) {
      return { file, error: `invalid JSON: ${(e as Error).message}`, skipped: true };
    }
  }

  if (!data.mcpServers || typeof data.mcpServers !== "object" || Array.isArray(data.mcpServers)) {
    data.mcpServers = {};
  }
  const servers = data.mcpServers as Record<string, unknown>;
  const expected = { command: entry.command, args: [...entry.args], env: { ...entry.env } };

  if (JSON.stringify(servers[name]) === JSON.stringify(expected)) {
    return { file, backup: null, added: [], already_present: [name], written: false };
  }

  servers[name] = expected;
  const newJson = `${JSON.stringify(data, null, 2)}\n`;
  mkdirSync(dirname(file), { recursive: true });
  const backup = backupFile(file);
  writeFileSync(file, newJson, "utf-8");
  return { file, backup, added: [name], already_present: [], written: true };
}

/**
 * Removes an MCP server entry from Warp's .mcp.json.
 */
export function detachWarpMcp(file: string, name: string): WarpMcpWriteOk | WarpMcpWriteFail {
  if (!existsSync(file)) {
    return { file, backup: null, added: [], already_present: [], written: false };
  }
  let data: Record<string, unknown>;
  try {
    const text = readFileSync(file, "utf-8");
    data = text.trim().length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch (e) {
    return { file, error: `invalid JSON: ${(e as Error).message}`, skipped: true };
  }

  if (!data.mcpServers || typeof data.mcpServers !== "object") {
    return { file, backup: null, added: [], already_present: [], written: false };
  }
  const servers = data.mcpServers as Record<string, unknown>;
  if (!(name in servers)) {
    return { file, backup: null, added: [], already_present: [], written: false };
  }

  delete servers[name];
  const newJson = `${JSON.stringify(data, null, 2)}\n`;
  const backup = backupFile(file);
  writeFileSync(file, newJson, "utf-8");
  return { file, backup, added: [], already_present: [name], written: true };
}

/**
 * Workspace path attachment for Warp. Warp Terminal does not have an "additionalDirectories"
 * concept — the terminal already has OS-level access to all paths. This is intentionally a
 * no-op that makes the multiroot result complete.
 */
export function attachWarp(_paths: string[], scopeDir: string): WarpResult {
  return {
    skipped: true,
    reason: "warp_no_workspace_dirs",
    file: join(scopeDir, ".warp", "settings.toml"),
  };
}

export function detachWarp(_paths: string[], scopeDir: string): WarpResult {
  return {
    skipped: true,
    reason: "warp_no_workspace_dirs",
    file: join(scopeDir, ".warp", "settings.toml"),
  };
}
