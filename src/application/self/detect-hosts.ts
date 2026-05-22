import { join } from "node:path";
import type { CliContext } from "../../cli/types.js";
import type { CommandResult } from "../../domain/types.js";
import { type InstallTarget, SKILL_DIR_NAME, TARGET_ROOTS } from "./install-skill.js";

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

const HOST_ORDER: readonly InstallTarget[] = ["claude", "codex", "warp", "oz", "agents"];

export async function selfDetectHosts(
  ctx: CliContext,
): Promise<CommandResult<SelfDetectHostsData>> {
  const home = ctx.env.homeDir();
  const hosts: DetectedHost[] = [];

  for (const target of HOST_ORDER) {
    const skillPath = join(home, ...TARGET_ROOTS[target], SKILL_DIR_NAME);
    const configDir = join(home, `.${target}`);
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
    return "No host config directories detected. Run any host (Claude Code / Codex / Warp / OZ) once to create them.";
  }
  return `Detected ${detected} host config dir(s); SKILL installed in ${installed}.`;
}
