import { createRequire } from "node:module";
import { join } from "node:path";
import type { CliContext } from "../../cli/types.js";
import { HARNESSES } from "../../domain/harnesses.js";
import type { CommandResult } from "../../domain/types.js";
import {
  AGENTS_LOCK_REL,
  type InstallTarget,
  LEGACY_SKILL_NAMES,
  SKILL_DIR_NAME,
  TARGET_ROOTS,
} from "./install-skill.js";

/** First existing legacy skill dir among LEGACY_SKILL_NAMES under `roots`, or null. */
async function firstExistingLegacy(
  ctx: CliContext,
  home: string,
  roots: readonly string[],
): Promise<string | null> {
  for (const name of LEGACY_SKILL_NAMES) {
    const p = join(home, ...roots, name);
    if (await ctx.fs.exists(p)) return p;
  }
  return null;
}

export interface SkillTargetReport {
  target: InstallTarget;
  path: string;
  installed: boolean;
  legacy_leftover?: boolean;
  legacy_leftover_path?: string;
  legacy_leftover_warning?: string;
  lock_present?: boolean;
  lock_canonical_entry?: boolean;
  lock_legacy_entry?: boolean;
  lock_warning?: string;
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

const FS_TARGETS: readonly InstallTarget[] = HARNESSES.filter((h) => h.mcpHostId !== null).map(
  (h) => h.installTarget,
);

export async function selfDoctor(ctx: CliContext): Promise<CommandResult<SelfDoctorReport>> {
  const home = ctx.env.homeDir();
  const targetReports: SkillTargetReport[] = [];

  for (const target of FS_TARGETS) {
    targetReports.push(await reportFsTarget(ctx, home, target));
  }
  const agentsReport = await reportAgentsTarget(ctx, home);
  if (agentsReport) targetReports.push(agentsReport);

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
        installed: targetReports.some((t) => t.installed),
        targets: targetReports,
      },
    },
    exitCode: 0,
  };
}

async function reportFsTarget(
  ctx: CliContext,
  home: string,
  target: InstallTarget,
): Promise<SkillTargetReport> {
  const skillPath = join(home, ...TARGET_ROOTS[target], SKILL_DIR_NAME);
  const installed = await ctx.fs.exists(skillPath);
  const legacyPath = await firstExistingLegacy(ctx, home, TARGET_ROOTS[target]);

  return {
    target,
    path: skillPath,
    installed,
    ...(legacyPath
      ? {
          legacy_leftover: true,
          legacy_leftover_path: legacyPath,
          legacy_leftover_warning: legacyWarning(legacyPath, skillPath),
        }
      : {}),
  };
}

async function reportAgentsTarget(
  ctx: CliContext,
  home: string,
): Promise<SkillTargetReport | null> {
  const agentsRoot = join(home, ...TARGET_ROOTS.agents.slice(0, 1));
  if (!(await ctx.fs.exists(agentsRoot))) return null;

  const skillPath = join(home, ...TARGET_ROOTS.agents, SKILL_DIR_NAME);
  const installed = await ctx.fs.exists(skillPath);
  const legacyPath = await firstExistingLegacy(ctx, home, TARGET_ROOTS.agents);

  const lockPath = join(home, ...AGENTS_LOCK_REL);
  const lockPresent = await ctx.fs.exists(lockPath);
  let lockCanonical: boolean | undefined;
  let lockLegacy: boolean | undefined;
  let lockWarning: string | undefined;

  if (lockPresent) {
    try {
      const raw = await ctx.fs.readText(lockPath);
      const parsed = JSON.parse(raw) as { skills?: Record<string, unknown> };
      const skills = parsed.skills ?? {};
      lockCanonical = Object.hasOwn(skills, SKILL_DIR_NAME);
      lockLegacy = LEGACY_SKILL_NAMES.some((n) => Object.hasOwn(skills, n));
    } catch (err) {
      lockWarning = `Could not parse ${lockPath}: ${(err as Error).message}. Skipping lock-based detection — filesystem scan still reliable.`;
    }
  }

  return {
    target: "agents",
    path: skillPath,
    installed,
    ...(legacyPath
      ? {
          legacy_leftover: true,
          legacy_leftover_path: legacyPath,
          legacy_leftover_warning: legacyWarning(legacyPath, skillPath),
        }
      : {}),
    lock_present: lockPresent,
    ...(lockCanonical !== undefined ? { lock_canonical_entry: lockCanonical } : {}),
    ...(lockLegacy !== undefined ? { lock_legacy_entry: lockLegacy } : {}),
    ...(lockWarning ? { lock_warning: lockWarning } : {}),
  };
}

function legacyWarning(legacyPath: string, skillPath: string): string {
  return `Skill legacy detectada en ${legacyPath}. Reemplazada por '${skillPath}' tras el rename de agent-workflow-manager → agent-workflow. Usá 'agent-workflow self uninstall-skill --legacy' para limpiar.`;
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
