import { createRequire } from "node:module";
import { join } from "node:path";
import type { CliContext } from "../../cli/types.js";
import type { CommandResult } from "../../domain/types.js";
import { type InstallTarget, SKILL_DIR_NAME, TARGET_ROOTS } from "./install-skill.js";

export interface SkillTargetReport {
  target: InstallTarget;
  path: string;
  installed: boolean;
  legacy_leftover?: boolean;
  legacy_leftover_path?: string;
  legacy_leftover_warning?: string;
}

export interface SelfDoctorReport {
  cli_version: string;
  namespace: { value: string; source: string };
  paths: {
    user_root: string;
    cwd_root: string;
    runtime_json: string;
  };
  runtime: {
    package_name: string;
    bin_name: string;
    source: string;
    config_path?: string;
    display_name?: string;
  };
  skill: {
    installed: boolean;
    targets: SkillTargetReport[];
  };
}

const LEGACY_SKILL_DIR = "agent-workflow-manager";

export async function selfDoctor(ctx: CliContext): Promise<CommandResult<SelfDoctorReport>> {
  const home = ctx.env.homeDir();
  const targets: InstallTarget[] = ["claude", "codex"];

  const targetReports: SkillTargetReport[] = [];
  for (const target of targets) {
    const skillPath = join(home, ...TARGET_ROOTS[target], SKILL_DIR_NAME);
    const legacyPath = join(home, ...TARGET_ROOTS[target], LEGACY_SKILL_DIR);
    const installed = await ctx.fs.exists(skillPath);
    const legacyLeftover = await ctx.fs.exists(legacyPath);

    targetReports.push({
      target,
      path: skillPath,
      installed,
      ...(legacyLeftover
        ? {
            legacy_leftover: true,
            legacy_leftover_path: legacyPath,
            legacy_leftover_warning: `Skill legacy detectada en ${legacyPath}. Reemplazada por '${skillPath}' tras el rename de agent-workflow-manager → agent-workflow. Recomendado: mv ${legacyPath} ${legacyPath}.bak (preserva evidencia) y cuando estés tranquilo, rm -rf el .bak.`,
          }
        : {}),
    });
  }

  const installedAny = targetReports.some((t) => t.installed);

  return {
    ok: true,
    data: {
      cli_version: readPackageVersion(),
      namespace: {
        value: ctx.namespace.namespace,
        source: ctx.namespace.source,
      },
      paths: {
        user_root: ctx.paths.userRoot(),
        cwd_root: ctx.paths.cwdRoot(),
        runtime_json: ctx.paths.userRuntimeJson(),
      },
      runtime: {
        package_name: ctx.runtime.packageName,
        bin_name: ctx.runtime.binName,
        source: ctx.runtime.source,
        ...(ctx.runtime.configPath ? { config_path: ctx.runtime.configPath } : {}),
        ...(ctx.runtime.displayName ? { display_name: ctx.runtime.displayName } : {}),
      },
      skill: {
        installed: installedAny,
        targets: targetReports,
      },
    },
    exitCode: 0,
  };
}

function readPackageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../../../package.json") as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}
