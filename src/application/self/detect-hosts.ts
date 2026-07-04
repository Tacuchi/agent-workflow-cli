import { dirname, join } from "node:path";
import type { CliContext } from "../../cli/types.js";
import type { CommandResult } from "../../domain/types.js";
import { crushGlobalMcpFile, opencodeGlobalMcpFile } from "../mcp-host-paths.js";
import { resolveWarpGlobalMcpPath } from "../multiroot/warp.js";
import {
  INSTALL_TARGETS,
  type InstallTarget,
  SKILL_DIR_NAME,
  TARGET_ROOTS,
} from "./install-skill.js";

export interface DetectedHost {
  target: InstallTarget;
  config_dir: string;
  config_dir_present: boolean;
  skill_installed: boolean;
  skill_path: string;
}

export interface SelfDetectHostsData {
  hosts: DetectedHost[];
  detected_count: number;
  installed_count: number;
  summary: string;
}

// Config dirs that do NOT follow the ~/.<target> convention. OpenCode and Crush
// resolve via mcp-host-paths.ts (XDG_CONFIG_HOME; crush win32 = LOCALAPPDATA);
// Warp is platform-divergent (darwin ~/.warp, linux ~/.config/warp-terminal,
// win32 %LOCALAPPDATA%/warp/Warp/config) and derives from the registry via
// resolveWarpGlobalMcpPath — same source as the MCP writer/reader; the rest use
// ~/.<target>.
function overrideConfigDir(target: InstallTarget, home: string): string | null {
  if (target === "opencode") return dirname(opencodeGlobalMcpFile(home));
  if (target === "crush") return dirname(crushGlobalMcpFile(home));
  if (target === "warp") {
    const mcpFile = resolveWarpGlobalMcpPath(process.platform, () => home);
    return mcpFile ? dirname(mcpFile) : null;
  }
  return null;
}

export async function selfDetectHosts(
  ctx: CliContext,
): Promise<CommandResult<SelfDetectHostsData>> {
  const home = ctx.env.homeDir();
  const hosts: DetectedHost[] = [];

  for (const target of INSTALL_TARGETS) {
    const skillPath = join(home, ...TARGET_ROOTS[target], SKILL_DIR_NAME);
    const configDir = overrideConfigDir(target, home) ?? join(home, `.${target}`);
    const [configPresent, skillInstalled] = await Promise.all([
      ctx.fs.exists(configDir),
      ctx.fs.exists(skillPath),
    ]);
    hosts.push({
      target,
      config_dir: configDir,
      config_dir_present: configPresent,
      skill_installed: skillInstalled,
      skill_path: skillPath,
    });
  }

  const detectedCount = hosts.filter((h) => h.config_dir_present).length;
  const installedCount = hosts.filter((h) => h.skill_installed).length;
  const summary = buildSummary(detectedCount, installedCount);

  return {
    ok: true,
    data: { hosts, detected_count: detectedCount, installed_count: installedCount, summary },
    exitCode: 0,
  };
}

function buildSummary(detected: number, installed: number): string {
  if (detected === 0) {
    return "No host config directories detected. Run any host (Claude Code / Codex / Warp / OZ / Gemini / OpenCode / Crush) once to create them.";
  }
  return `Detected ${detected} host config dir(s); SKILL installed in ${installed}.`;
}
