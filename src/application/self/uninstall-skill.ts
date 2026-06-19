import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ParsedArgs } from "../../cli/parser.js";
import type { CliContext } from "../../cli/types.js";
import type { CommandResult } from "../../domain/types.js";
import {
  AGENTS_LOCK_REL,
  type InstallTarget,
  LEGACY_SKILL_NAMES,
  SKILL_DIR_NAME,
  TARGET_ROOTS,
} from "./install-skill.js";

export type UninstallTargetChoice = InstallTarget | "all";

export interface UninstallRemoval {
  target: InstallTarget;
  path: string;
  kind: "canonical" | "legacy";
  status: "removed" | "dry-run" | "skipped";
  reason?: string;
}

export interface SelfUninstallSkillData {
  status: "removed" | "dry-run" | "noop";
  removed: UninstallRemoval[];
  lock_updated: boolean;
  lock_path?: string;
  lock_warning?: string;
}

const ALL_TARGETS: readonly InstallTarget[] = ["claude", "codex", "agents", "warp", "oz"];
const TARGET_CHOICES: readonly UninstallTargetChoice[] = [...ALL_TARGETS, "all"];

export async function selfUninstallSkill(
  args: ParsedArgs,
  ctx: CliContext,
): Promise<CommandResult<SelfUninstallSkillData>> {
  const dryRun = args.flags.has("--dry-run");
  const includeLegacy = args.flags.has("--legacy");
  const targetArg = (args.values.get("target") ?? "all") as UninstallTargetChoice;

  if (!TARGET_CHOICES.includes(targetArg)) {
    return {
      ok: false,
      error: {
        code: "INVALID_TARGET",
        message: `--target must be one of: ${TARGET_CHOICES.join(", ")}. Got '${targetArg}'.`,
      },
      exitCode: 1,
    };
  }

  const targets: InstallTarget[] =
    targetArg === "all" ? [...ALL_TARGETS] : [targetArg as InstallTarget];
  const home = ctx.env.homeDir();

  const removals: UninstallRemoval[] = [];
  for (const target of targets) {
    removals.push(...(await removeFromTarget(ctx, home, target, includeLegacy, dryRun)));
  }

  const lockResult = targets.includes("agents")
    ? await updateAgentsLock(ctx, home, includeLegacy, dryRun)
    : { updated: false };

  return {
    ok: true,
    data: {
      status: resolveStatus(dryRun, removals.length),
      removed: removals,
      lock_updated: lockResult.updated,
      ...(lockResult.path ? { lock_path: lockResult.path } : {}),
      ...(lockResult.warning ? { lock_warning: lockResult.warning } : {}),
    },
    exitCode: 0,
  };
}

async function removeFromTarget(
  ctx: CliContext,
  home: string,
  target: InstallTarget,
  includeLegacy: boolean,
  dryRun: boolean,
): Promise<UninstallRemoval[]> {
  const out: UninstallRemoval[] = [];
  const canonical = join(home, ...TARGET_ROOTS[target], SKILL_DIR_NAME);
  if (await ctx.fs.exists(canonical)) {
    if (!dryRun) await rm(canonical, { recursive: true, force: true });
    out.push({
      target,
      path: canonical,
      kind: "canonical",
      status: dryRun ? "dry-run" : "removed",
    });
  }

  if (includeLegacy) {
    for (const legacyName of LEGACY_SKILL_NAMES) {
      const legacy = join(home, ...TARGET_ROOTS[target], legacyName);
      if (await ctx.fs.exists(legacy)) {
        if (!dryRun) await rm(legacy, { recursive: true, force: true });
        out.push({
          target,
          path: legacy,
          kind: "legacy",
          status: dryRun ? "dry-run" : "removed",
        });
      }
    }
  }
  return out;
}

function resolveStatus(dryRun: boolean, removedCount: number): SelfUninstallSkillData["status"] {
  if (dryRun) return "dry-run";
  return removedCount === 0 ? "noop" : "removed";
}

async function updateAgentsLock(
  ctx: CliContext,
  home: string,
  includeLegacy: boolean,
  dryRun: boolean,
): Promise<{ updated: boolean; path?: string; warning?: string }> {
  const lockPath = join(home, ...AGENTS_LOCK_REL);
  if (!(await ctx.fs.exists(lockPath))) return { updated: false };

  let parsed: { skills?: Record<string, unknown> } & Record<string, unknown>;
  try {
    parsed = JSON.parse(await ctx.fs.readText(lockPath));
  } catch (err) {
    return {
      updated: false,
      path: lockPath,
      warning: `Could not parse ${lockPath}: ${(err as Error).message}. Lock left untouched.`,
    };
  }

  const skills = (parsed.skills ?? {}) as Record<string, unknown>;
  const before = Object.keys(skills);
  const namesToRemove = [SKILL_DIR_NAME, ...(includeLegacy ? LEGACY_SKILL_NAMES : [])];
  for (const name of namesToRemove) {
    delete skills[name];
  }
  const after = Object.keys(skills);
  const changed = before.length !== after.length;

  if (!changed) return { updated: false, path: lockPath };

  if (!dryRun) {
    parsed.skills = skills;
    await writeFile(lockPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  }
  return { updated: true, path: lockPath };
}
