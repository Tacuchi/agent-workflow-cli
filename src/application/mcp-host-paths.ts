import { join } from "node:path";

/**
 * OpenCode and Crush global config files, shared by writer, reader and detect
 * (single source: a writer↔reader asymmetry already caused the v14.5.0 bug).
 *
 * Verified 2026-07 against official docs:
 * - OpenCode (opencode.ai/docs/config): global at `~/.config/opencode/opencode.json`
 *   on ALL platforms (native Windows too), honoring XDG_CONFIG_HOME.
 * - Crush (charmbracelet/crush README): Unix `~/.config/crush/crush.json` (XDG);
 *   Windows `%LOCALAPPDATA%\crush\crush.json`; override via CRUSH_GLOBAL_CONFIG.
 *
 * `homeDir` is injectable (tests pass a tmpdir); env/platform are read from
 * process to reflect the real machine unless injected.
 */
export function xdgConfigBase(homeDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.XDG_CONFIG_HOME || join(homeDir, ".config");
}

export function opencodeGlobalMcpFile(
  homeDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(xdgConfigBase(homeDir, env), "opencode", "opencode.json");
}

export function crushGlobalMcpFile(
  homeDir: string,
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.CRUSH_GLOBAL_CONFIG) return env.CRUSH_GLOBAL_CONFIG;
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA || join(homeDir, "AppData", "Local");
    return join(localAppData, "crush", "crush.json");
  }
  return join(xdgConfigBase(homeDir, env), "crush", "crush.json");
}
