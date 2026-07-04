import { homedir } from "node:os";
import { join } from "node:path";
import { harnessById, resolveGlobalMcpRawPath } from "../../domain/harnesses.js";

export interface WarpAttachNoop {
  skipped: true;
  reason: "warp_no_workspace_dirs";
  file: string;
}

export type WarpResult = WarpAttachNoop;

/**
 * Resolves the absolute path to Warp's global .mcp.json by platform.
 * Expands `~` using homedir(). Uses the registry as source of truth (DEC-W3).
 */
export function resolveWarpGlobalMcpPath(
  platform: NodeJS.Platform = process.platform,
  homedirFn: () => string = homedir,
): string | null {
  const spec = harnessById("warp");
  const raw = spec ? resolveGlobalMcpRawPath(spec, platform) : null;
  if (!raw) return null;

  const home = homedirFn();
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
