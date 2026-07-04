import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ParsedArgs } from "../../cli/parser.js";
import type { CliContext } from "../../cli/types.js";
import type { CommandResult } from "../../domain/types.js";
import {
  AGENTS_LOCK_REL,
  type InstallTarget,
  LEGACY_SKILL_NAMES,
  SKILL_DIR_NAME,
  TARGET_ROOTS,
  isOwnedBundleDir,
  isOwnedSynthesizedDir,
  removeDirIfEmpty,
} from "./install-skill.js";
import { COMMAND_SKILLS_HOSTS, LEGACY_SKILL_ROOTS_BY_TARGET } from "./install-targets.js";

// Synthesized `w-<command>` skills are removed for the COMMAND_SKILLS_HOSTS
// (shared value from install-targets.ts — install/uninstall symmetric by
// construction) ONLY with verified ownership (wrapper marker or the ≤v18
// flatten fingerprint) — the roots are shared namespaces (~/.agents/skills
// anchor, loose skills): never delete a foreign dir by prefix alone.
// `agent-workflow-` covers the pre-rename model.
const SYNTHESIZED_SKILL_PREFIXES = ["w-", "agent-workflow-"] as const;

export type UninstallTargetChoice = InstallTarget | "all";

export interface UninstallStep {
  target: InstallTarget;
  kind: "skill" | "legacy-skill" | "user-commands" | "legacy-user-commands" | "hooks";
  path: string;
  status: "removed" | "dry-run" | "skipped";
  reason?: string;
}

export interface SelfUninstallData {
  status: "removed" | "dry-run" | "noop";
  steps: UninstallStep[];
  lock_updated: boolean;
  lock_path?: string;
  lock_warning?: string;
}

const ALL_TARGETS: readonly InstallTarget[] = [
  "claude",
  "codex",
  "agents",
  "warp",
  "oz",
  "gemini",
  "opencode",
  "crush",
];
const TARGET_CHOICES: readonly UninstallTargetChoice[] = [...ALL_TARGETS, "all"];

export const USER_COMMANDS_RELPATH_BY_TARGET: Record<InstallTarget, string | null> = {
  claude: ".claude/commands/w",
  // codex: `.codex/commands/w` was written by ≤v18 but Codex never read it;
  // still cleaned every time (inert dir of ours).
  codex: ".codex/commands/w",
  warp: null,
  oz: null,
  agents: null,
  gemini: ".gemini/commands/w",
  opencode: ".opencode/command/w",
  crush: ".crush/commands/w",
};

// Pre-`w`-rename user-commands dirs (`/agent-workflow:*`), removed with `--legacy`.
const LEGACY_USER_COMMANDS_RELPATH_BY_TARGET: Record<InstallTarget, string | null> = {
  claude: ".claude/commands/agent-workflow",
  codex: ".codex/commands/agent-workflow",
  warp: null,
  oz: null,
  agents: null,
  gemini: null,
  opencode: null,
  crush: null,
};

const HOOKS_REMOVABLE_TARGETS: ReadonlySet<InstallTarget> = new Set(["claude"]);

// Event names we install via hooks.template.json (we only touch these on
// uninstall to avoid clobbering hooks the user added manually).
const HOOK_EVENTS_WE_INSTALL: readonly string[] = [
  "SessionStart",
  "PreToolUse",
  "SessionEnd",
  "PreCompact",
  "PostCompact",
];

interface UninstallFlags {
  dryRun: boolean;
  includeLegacy: boolean;
  skillOnly: boolean;
  withHooks: boolean;
  skipCommands: boolean;
}

export async function selfUninstall(
  args: ParsedArgs,
  ctx: CliContext,
): Promise<CommandResult<SelfUninstallData>> {
  const skillOnly = args.flags.has("--skill-only");
  const flags: UninstallFlags = {
    dryRun: args.flags.has("--dry-run"),
    includeLegacy: args.flags.has("--legacy"),
    skillOnly,
    withHooks: args.flags.has("--with-hooks"),
    skipCommands: skillOnly || args.flags.has("--no-commands"),
  };
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

  const steps: UninstallStep[] = [];
  for (const target of targets) {
    steps.push(...(await uninstallOneTarget(ctx, home, target, flags)));
  }

  const lockResult = targets.includes("agents")
    ? await updateAgentsLock(ctx, home, flags.includeLegacy, flags.dryRun)
    : { updated: false };

  const removedCount = steps.filter((s) => s.status === "removed").length;
  const status: SelfUninstallData["status"] = flags.dryRun
    ? "dry-run"
    : removedCount === 0
      ? "noop"
      : "removed";

  return {
    ok: true,
    data: {
      status,
      steps,
      lock_updated: lockResult.updated,
      ...(lockResult.path ? { lock_path: lockResult.path } : {}),
      ...(lockResult.warning ? { lock_warning: lockResult.warning } : {}),
    },
    exitCode: 0,
  };
}

async function uninstallOneTarget(
  ctx: CliContext,
  home: string,
  target: InstallTarget,
  flags: UninstallFlags,
): Promise<UninstallStep[]> {
  const steps: UninstallStep[] = [];
  steps.push(...(await removeSkill(ctx, home, target, flags.includeLegacy, flags.dryRun)));
  if (!flags.skipCommands) {
    // Synthesized w-* wrappers ARE the command surface on codex/warp/oz —
    // gated like the native command dirs (mirror of installOneTarget).
    steps.push(...(await removeSynthesizedCommandSkills(ctx, home, target, flags.dryRun)));
    steps.push(...(await removeUserCommands(ctx, home, target, flags.includeLegacy, flags.dryRun)));
  }
  if (flags.withHooks && !flags.skillOnly) {
    const hookStep = await removeHooks(ctx, home, target, flags.dryRun);
    if (hookStep !== null) steps.push(hookStep);
  }
  return steps;
}

async function removeSynthesizedCommandSkills(
  ctx: CliContext,
  home: string,
  target: InstallTarget,
  dryRun: boolean,
): Promise<UninstallStep[]> {
  if (!COMMAND_SKILLS_HOSTS.has(target)) return [];
  const targetRoot = join(home, ...TARGET_ROOTS[target]);
  if (!(await ctx.fs.exists(targetRoot))) return [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(targetRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const steps: UninstallStep[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const prefix = SYNTHESIZED_SKILL_PREFIXES.find((p) => entry.name.startsWith(p));
    if (prefix === undefined) continue;
    const path = join(targetRoot, entry.name);
    if (!(await isOwnedSynthesizedDir(path, prefix))) continue;
    if (!dryRun) await rm(path, { recursive: true, force: true });
    steps.push({
      target,
      kind: "skill",
      path,
      status: dryRun ? "dry-run" : "removed",
    });
  }
  return steps;
}

async function removeSkill(
  ctx: CliContext,
  home: string,
  target: InstallTarget,
  includeLegacy: boolean,
  dryRun: boolean,
): Promise<UninstallStep[]> {
  const out: UninstallStep[] = [];
  const canonical = join(home, ...TARGET_ROOTS[target], SKILL_DIR_NAME);
  if (await ctx.fs.exists(canonical)) {
    if (!dryRun) await rm(canonical, { recursive: true, force: true });
    out.push({
      target,
      kind: "skill",
      path: canonical,
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
          kind: "legacy-skill",
          path: legacy,
          status: dryRun ? "dry-run" : "removed",
        });
      }
    }
  }
  for (const legacyRoot of LEGACY_SKILL_ROOTS_BY_TARGET[target]) {
    const root = join(home, ...legacyRoot);
    const candidates = [SKILL_DIR_NAME, ...(includeLegacy ? LEGACY_SKILL_NAMES : [])];
    for (const name of candidates) {
      const dir = join(root, name);
      // Legacy roots can be shared namespaces: only the bundle fingerprint
      // (or the pre-rename names under --legacy) authorizes deletion.
      if (name === SKILL_DIR_NAME && !(await isOwnedBundleDir(dir, ctx))) continue;
      if (!(await ctx.fs.exists(dir))) continue;
      if (!dryRun) await rm(dir, { recursive: true, force: true });
      out.push({
        target,
        kind: name === SKILL_DIR_NAME ? "skill" : "legacy-skill",
        path: dir,
        status: dryRun ? "dry-run" : "removed",
      });
    }
    if (!dryRun) await removeDirIfEmpty(root);
  }
  return out;
}

async function removeUserCommands(
  ctx: CliContext,
  home: string,
  target: InstallTarget,
  includeLegacy: boolean,
  dryRun: boolean,
): Promise<UninstallStep[]> {
  const out: UninstallStep[] = [];
  const removeDir = async (
    relpath: string | null,
    kind: "user-commands" | "legacy-user-commands",
  ): Promise<void> => {
    if (relpath === null) return;
    const dir = join(home, relpath);
    if (!(await ctx.fs.exists(dir))) return;
    if (!dryRun) {
      await rm(dir, { recursive: true, force: true });
      await removeDirIfEmpty(dirname(dir));
    }
    out.push({ target, kind, path: dir, status: dryRun ? "dry-run" : "removed" });
  };
  await removeDir(USER_COMMANDS_RELPATH_BY_TARGET[target], "user-commands");
  if (includeLegacy) {
    await removeDir(LEGACY_USER_COMMANDS_RELPATH_BY_TARGET[target], "legacy-user-commands");
  }
  return out;
}

async function removeHooks(
  ctx: CliContext,
  home: string,
  target: InstallTarget,
  dryRun: boolean,
): Promise<UninstallStep | null> {
  if (!HOOKS_REMOVABLE_TARGETS.has(target)) return null;
  const settingsPath = join(home, ".claude", "settings.json");
  if (!(await ctx.fs.exists(settingsPath))) return null;

  const parsed = await tryParseSettings(settingsPath);
  if (parsed === "invalid") {
    return {
      target,
      kind: "hooks",
      path: settingsPath,
      status: "skipped",
      reason: "settings.json is invalid JSON; not modified",
    };
  }
  if (parsed === null) return null;

  const removed = stripOurHookEvents(parsed);
  if (removed.length === 0) return null;

  if (!dryRun) await persistSettings(home, settingsPath, parsed);

  return {
    target,
    kind: "hooks",
    path: settingsPath,
    status: dryRun ? "dry-run" : "removed",
    reason: `Removed events: ${removed.join(", ")}`,
  };
}

async function tryParseSettings(path: string): Promise<Record<string, unknown> | "invalid" | null> {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return "invalid";
  }
  if (typeof data !== "object" || data === null || !("hooks" in data)) return null;
  const hooks = data.hooks as Record<string, unknown>;
  if (typeof hooks !== "object" || hooks === null) return null;
  return data;
}

function stripOurHookEvents(data: Record<string, unknown>): string[] {
  const hooks = data.hooks as Record<string, unknown>;
  const removed: string[] = [];
  for (const event of HOOK_EVENTS_WE_INSTALL) {
    if (event in hooks) {
      hooks[event] = undefined;
      removed.push(event);
    }
  }
  for (const event of removed) {
    // Object.keys() drops undefined-valued keys in JSON.stringify; we want
    // them actually removed from the object too to keep iteration clean.
    Reflect.deleteProperty(hooks, event);
  }
  if (Object.keys(hooks).length === 0) {
    Reflect.deleteProperty(data, "hooks");
  } else {
    data.hooks = hooks;
  }
  return removed;
}

async function persistSettings(
  home: string,
  settingsPath: string,
  data: Record<string, unknown>,
): Promise<void> {
  const ts = Math.floor(Date.now() / 1000);
  const backupPath = `${settingsPath}.bak.${ts}`;
  await mkdir(join(home, ".claude"), { recursive: true });
  try {
    const original = await readFile(settingsPath, "utf8");
    await writeFile(backupPath, original, "utf8");
  } catch {
    // best-effort backup
  }
  await writeFile(settingsPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
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
