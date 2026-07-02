import { join } from "node:path";

/**
 * Global config files de OpenCode y Crush, compartidos por writer, reader y
 * detect (una sola fuente: la asimetría writer↔reader ya causó el bug v14.5.0).
 *
 * Verificado 2026-07 contra docs oficiales:
 * - OpenCode (opencode.ai/docs/config): global en `~/.config/opencode/opencode.json`
 *   en TODAS las plataformas (también Windows nativo), honrando XDG_CONFIG_HOME.
 * - Crush (charmbracelet/crush README): Unix `~/.config/crush/crush.json` (XDG);
 *   Windows `%LOCALAPPDATA%\crush\crush.json`; override por CRUSH_GLOBAL_CONFIG.
 *
 * `homeDir` es inyectable (los tests pasan un tmpdir); env/platform se leen de
 * process para reflejar la máquina real salvo que se inyecten.
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
