import { copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ParsedArgs } from "../../cli/parser.js";
import type { CliContext } from "../../cli/types.js";
import type { InstallTarget } from "../../domain/harnesses.js";
import type { CommandResult } from "../../domain/types.js";
import { INSTALL_TARGETS, TARGET_ROOTS } from "./install-targets.js";
import { type CacheTarget, selfClearPluginCache } from "./plugin-cache-clear.js";

export const SKILL_DIR_NAME = "w";
export const BUNDLED_SKILL_REL_PATH = `skills/${SKILL_DIR_NAME}`;

// InstallTarget is defined canonically in domain/harnesses.ts (HarnessSpec.installTarget).
// The target→dir map lives in install-targets.ts (cycle-free); both are
// re-exported here since detect-hosts and callers import them from this module.
export type { InstallTarget };
export { INSTALL_TARGETS, TARGET_ROOTS };

export const AGENTS_LOCK_REL = [".agents", ".skill-lock.json"] as const;
/**
 * Skill dir names from prior releases, cleaned up by `--legacy`. Oldest first.
 * `agent-workflow` was the canonical bundle dir before the `w` rename (P1), so an
 * upgrade from the old plugin leaves it behind alongside the even-older
 * `agent-workflow-manager`.
 */
export const LEGACY_SKILL_NAMES = ["agent-workflow-manager", "agent-workflow"] as const;

export interface SelfInstallTargetResult {
  target: InstallTarget;
  dest: string;
  status: "installed" | "dry-run" | "skipped";
  overwrote_existing: boolean;
  files_copied?: number;
  cache_cleared?: boolean;
  cache_clear_warning?: string;
  user_commands_dest?: string;
  user_commands_files?: number;
  user_commands_warning?: string;
  /** Legacy artifact dirs (pre-`w` rename) removed during this install. */
  cleaned_legacy?: string[];
  hooks_status?: string;
  hooks_warning?: string;
  flattened_subskills?: number;
  flattened_warnings?: string[];
  error?: string;
}

export interface SelfInstallSkillData {
  status: "installed" | "dry-run" | "partial";
  source: string;
  source_kind: "path" | "bundled";
  dests: SelfInstallTargetResult[];
}

const TARGET_CHOICES: readonly (InstallTarget | "all")[] = [...INSTALL_TARGETS, "all"];

// `--target all` skips `agents`: it is the shared cross-host dir, not a host.
const ALL_INSTALL_TARGETS: readonly InstallTarget[] = INSTALL_TARGETS.filter((t) => t !== "agents");

const CACHE_CLEAR_HOSTS: ReadonlySet<InstallTarget> = new Set([
  "claude",
  "codex",
  "warp",
  "agents",
]);

// Hosts que listan slash commands solo desde directorios top-level de
// ~/<host>/skills/. Para estos hosts, los sub-skills anidados del SKILL
// universal (loops/*, exports/*, roles/*) NO son visibles por default —
// el flatten copia cada sub-skill a su propio directorio top-level con
// prefix `w-` para evitar colisiones con otros plugins.
// Hosts no incluidos (claude, codex) cargan sub-skills via su propia
// resolución (Skill tool / SKILL.md frontmatter recursivo).
const FLATTEN_SUBSKILLS_HOSTS: ReadonlySet<InstallTarget> = new Set(["warp", "oz"]);
const FLATTEN_PARENT_DIRS = ["loops", "exports", "roles"] as const;
const FLATTEN_DEST_PREFIX = "w-";

// Per-target user-level commands directory (subdir = namespace).
// File `<base>/<filename>.md` is invoked as `/w:<filename>`.
// Claude Code + Codex follow the same convention. Warp/Oz do not use a
// file-based user-commands dir — they list slash commands from the `name:`
// frontmatter of each SKILL.md found in top-level subdirs of ~/<host>/skills/.
// The installer applies flattenSubSkillsForHost() below to expose nested
// sub-skills (loops/*, exports/*, roles/*) at the level Warp/Oz can see.
const USER_COMMANDS_RELPATH_BY_TARGET: Record<InstallTarget, string | null> = {
  claude: ".claude/commands/w",
  codex: ".codex/commands/w",
  warp: null,
  oz: null,
  agents: null,
  // gemini uses .gemini/commands/*.toml (not .md), opencode .opencode/command/*.md,
  // crush n/a — native command install deferred to Phase 3; skills-as-command meanwhile.
  gemini: null,
  opencode: null,
  crush: null,
};

// Pre-`w`-rename user-commands dirs (slash namespace `/agent-workflow:*`). Removed
// on install so an upgrade from the old plugin doesn't leave stale slash commands.
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

/**
 * Remove legacy artifacts from a prior install (before the `agent-workflow` → `w`
 * rename) for `target`: the old SKILL dirs (LEGACY_SKILL_NAMES), the old
 * user-commands dir (`/agent-workflow:*`), and — for flatten hosts — the old
 * `agent-workflow-*` flattened sub-skills. Returns the paths removed.
 */
async function cleanLegacyArtifacts(
  target: InstallTarget,
  home: string,
  ctx: CliContext,
): Promise<string[]> {
  const removed: string[] = [];
  const tryRemove = async (p: string): Promise<void> => {
    if (await ctx.fs.exists(p)) {
      await rm(p, { recursive: true, force: true });
      removed.push(p);
    }
  };
  const skillsRoot = join(home, ...TARGET_ROOTS[target]);
  for (const name of LEGACY_SKILL_NAMES) {
    await tryRemove(join(skillsRoot, name));
  }
  const legacyCmd = LEGACY_USER_COMMANDS_RELPATH_BY_TARGET[target];
  if (legacyCmd !== null) await tryRemove(join(home, legacyCmd));
  if (FLATTEN_SUBSKILLS_HOSTS.has(target)) {
    try {
      for (const entry of await readdir(skillsRoot, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith("agent-workflow-")) {
          await tryRemove(join(skillsRoot, entry.name));
        }
      }
    } catch {
      // skills root absent / unreadable — nothing to sweep.
    }
  }
  return removed;
}

// Hosts where install-hooks merges into a user-level config (JSON/TOML).
// Codex has a different config format (TOML) and no settled hook syntax at
// the user level yet — see DEC-W4 for Warp/OZ (no hook system at all).
const HOOKS_AUTOINSTALL_TARGETS: ReadonlySet<InstallTarget> = new Set(["claude"]);

function explainSkipReason(target: InstallTarget, kind: "commands" | "hooks"): string {
  if (kind === "commands") {
    if (target === "warp" || target === "oz") {
      return `${target}: file-based user-commands dir is not used by this host. Slash commands derive from each SKILL.md frontmatter (top-level dirs under ~/${target === "warp" ? ".warp" : ".agents"}/skills/); sub-skills are exposed via flatten at install time.`;
    }
    return `${target}: user-level commands install not implemented yet. SKILL is installed; CLI invocations work from within the host.`;
  }
  // hooks
  if (target === "warp" || target === "oz") {
    return `${target}: no hook system per DEC-W4. Skipped silently.`;
  }
  if (target === "codex") {
    return `codex: hook merge into config.toml not implemented yet (different format from Claude's settings.json). SKILL works without hooks; CLI commands still callable manually.`;
  }
  return `${target}: hooks auto-install not supported yet.`;
}

export async function selfInstallSkill(
  args: ParsedArgs,
  ctx: CliContext,
  resolveBundled: () => Promise<string | null> = resolveBundledSkillPath,
): Promise<CommandResult<SelfInstallSkillData>> {
  const force = args.flags.has("--force");
  const dryRun = args.flags.has("--dry-run");
  const keepCache = args.flags.has("--keep-cache");
  const keepLegacy = args.flags.has("--keep-legacy");
  const confirmAll = args.flags.has("--confirm-all");
  const skillOnly = args.flags.has("--skill-only");
  const skipCommands = skillOnly || args.flags.has("--no-commands");
  const skipHooks = skillOnly || args.flags.has("--no-hooks");
  const targetArg = args.values.get("target");

  if (targetArg === undefined || targetArg.trim().length === 0) {
    return {
      ok: false,
      error: {
        code: "TARGET_REQUIRED",
        message: `--target is required. Pick one of: ${TARGET_CHOICES.join(", ")}. Example: 'agent-workflow self install-skill --target claude'.`,
      },
      exitCode: 1,
    };
  }

  if (targetArg === "all" && !confirmAll && !dryRun) {
    return {
      ok: false,
      error: {
        code: "CONFIRM_ALL_REQUIRED",
        message: `--target all installs into every supported host. Pass --confirm-all to acknowledge, or pick a specific host (${ALL_INSTALL_TARGETS.join("|")}).`,
      },
      exitCode: 1,
    };
  }

  const targetsResult = resolveTargets(targetArg);
  if (!targetsResult.ok) return targetsResult.result;
  const targets = targetsResult.value;

  const sourceResult = await resolveSource(args.values.get("from"), resolveBundled);
  if (!sourceResult.ok) return sourceResult.result;
  const { sourceArg, sourceKind } = sourceResult.value;

  const destByTarget = buildDestByTarget(ctx.env.homeDir());
  const existingTargets = await Promise.all(
    targets.map(async (t) => ({ target: t, exists: await ctx.fs.exists(destByTarget[t]) })),
  );

  const blocking = existingTargets.filter((t) => t.exists && !force && !dryRun);
  if (blocking.length > 0) {
    const names = blocking.map((t) => destByTarget[t.target]).join(", ");
    return {
      ok: false,
      error: {
        code: "DEST_EXISTS",
        message: `Destination already exists: ${names}. Use --force to overwrite, --dry-run to preview, or --target <host> to install only one.`,
      },
      exitCode: 1,
    };
  }

  if (dryRun) {
    return {
      ok: true,
      data: {
        status: "dry-run",
        source: sourceArg,
        source_kind: sourceKind,
        dests: existingTargets.map((t) => ({
          target: t.target,
          dest: destByTarget[t.target],
          status: "dry-run",
          overwrote_existing: t.exists,
        })),
      },
      exitCode: 0,
    };
  }

  const validation = await validateSourceContents(sourceArg, ctx);
  if (validation) return validation;

  const results: SelfInstallTargetResult[] = [];
  for (const t of existingTargets) {
    const entry = await installOneTarget(t, destByTarget[t.target], sourceArg, ctx, {
      force,
      keepCache,
      skipCommands,
      skipHooks,
      keepLegacy,
    });
    results.push(entry);
  }

  return {
    ok: true,
    data: {
      status: "installed",
      source: sourceArg,
      source_kind: sourceKind,
      dests: results,
    },
    exitCode: 0,
  };
}

type Resolved<T> =
  | { ok: true; value: T }
  | { ok: false; result: CommandResult<SelfInstallSkillData> };

function resolveTargets(targetArg: string): Resolved<InstallTarget[]> {
  if (!TARGET_CHOICES.includes(targetArg as InstallTarget | "all")) {
    return {
      ok: false,
      result: {
        ok: false,
        error: {
          code: "INVALID_TARGET",
          message: `--target must be one of: ${TARGET_CHOICES.join(", ")}. Got '${targetArg}'.`,
        },
        exitCode: 1,
      },
    };
  }
  const targets: InstallTarget[] =
    targetArg === "all" ? [...ALL_INSTALL_TARGETS] : [targetArg as InstallTarget];
  return { ok: true, value: targets };
}

async function resolveSource(
  fromArg: string | undefined,
  resolveBundled: () => Promise<string | null>,
): Promise<Resolved<{ sourceArg: string; sourceKind: "path" | "bundled" }>> {
  if (fromArg !== undefined) {
    if (looksLikeRemoteUrl(fromArg)) {
      return {
        ok: false,
        result: {
          ok: false,
          error: {
            code: "INVALID_SOURCE",
            message:
              "--from must be a local filesystem path. Remote URLs are no longer supported — the skill is bundled inside the CLI tarball. Drop --from to install the bundled skill, or pass a local checkout path.",
          },
          exitCode: 1,
        },
      };
    }
    return { ok: true, value: { sourceArg: fromArg, sourceKind: "path" } };
  }
  const bundled = await resolveBundled();
  if (bundled === null) {
    return {
      ok: false,
      result: {
        ok: false,
        error: {
          code: "BUNDLED_NOT_FOUND",
          message: `Bundled skill not found relative to the CLI install. This usually means you are running from a dev checkout without a build, or the tarball is missing 'skills/'. Use --from <local-path> to override.`,
        },
        exitCode: 1,
      },
    };
  }
  return { ok: true, value: { sourceArg: bundled, sourceKind: "bundled" } };
}

function buildDestByTarget(home: string): Record<InstallTarget, string> {
  return {
    claude: join(home, ...TARGET_ROOTS.claude, SKILL_DIR_NAME),
    codex: join(home, ...TARGET_ROOTS.codex, SKILL_DIR_NAME),
    agents: join(home, ...TARGET_ROOTS.agents, SKILL_DIR_NAME),
    warp: join(home, ...TARGET_ROOTS.warp, SKILL_DIR_NAME),
    oz: join(home, ...TARGET_ROOTS.oz, SKILL_DIR_NAME),
    gemini: join(home, ...TARGET_ROOTS.gemini, SKILL_DIR_NAME),
    opencode: join(home, ...TARGET_ROOTS.opencode, SKILL_DIR_NAME),
    crush: join(home, ...TARGET_ROOTS.crush, SKILL_DIR_NAME),
  };
}

async function validateSourceContents(
  sourceArg: string,
  ctx: CliContext,
): Promise<CommandResult<SelfInstallSkillData> | null> {
  if (!(await ctx.fs.exists(sourceArg))) {
    return {
      ok: false,
      error: {
        code: "SOURCE_NOT_FOUND",
        message: `Source path '${sourceArg}' does not exist.`,
      },
      exitCode: 1,
    };
  }
  const skillPath = join(sourceArg, "SKILL.md");
  if (!(await ctx.fs.exists(skillPath))) {
    return {
      ok: false,
      error: {
        code: "INVALID_SKILL_REPO",
        message: `Source missing SKILL.md at ${skillPath}.`,
      },
      exitCode: 1,
    };
  }
  const skillContent = await readFile(skillPath, "utf8");
  if (!hasValidFrontmatter(skillContent)) {
    return {
      ok: false,
      error: {
        code: "INVALID_SKILL_FRONTMATTER",
        message: "SKILL.md frontmatter must include 'name' and 'description'.",
      },
      exitCode: 1,
    };
  }
  return null;
}

function looksLikeRemoteUrl(value: string): boolean {
  return /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/.test(value);
}

function hasValidFrontmatter(content: string): boolean {
  const match = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return false;
  const block = match[1] ?? "";
  return /^name:\s*\S/m.test(block) && /^description:\s*\S/m.test(block);
}

async function copyTree(src: string, dest: string): Promise<number> {
  let count = 0;
  await copyDirCounting(src, dest, () => {
    count += 1;
  });
  return count;
}

async function copyDirCounting(src: string, dest: string, onFile: () => void): Promise<void> {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirCounting(srcPath, destPath, onFile);
    } else {
      await copyFile(srcPath, destPath);
      onFile();
    }
  }
}

interface InstallOneFlags {
  force: boolean;
  keepCache: boolean;
  skipCommands: boolean;
  skipHooks: boolean;
  keepLegacy: boolean;
}

async function installOneTarget(
  t: { target: InstallTarget; exists: boolean },
  dest: string,
  sourceArg: string,
  ctx: CliContext,
  flags: InstallOneFlags,
): Promise<SelfInstallTargetResult> {
  const cacheOutcome = await preClearCache(t.target, ctx, flags.keepCache);
  if (t.exists && flags.force) {
    await rm(dest, { recursive: true, force: true });
  }
  const filesCopied = await copyTree(sourceArg, dest);
  const entry: SelfInstallTargetResult = {
    target: t.target,
    dest,
    status: "installed",
    overwrote_existing: t.exists,
    files_copied: filesCopied,
    cache_cleared: cacheOutcome.cleared,
  };
  if (cacheOutcome.warning !== undefined) entry.cache_clear_warning = cacheOutcome.warning;
  if (FLATTEN_SUBSKILLS_HOSTS.has(t.target)) {
    const flatten = await flattenSubSkillsForHost(t.target, dest, sourceArg, flags.force);
    entry.flattened_subskills = flatten.count;
    if (flatten.warnings.length > 0) entry.flattened_warnings = flatten.warnings;
  }
  if (!flags.skipCommands) {
    const cmdResult = await installUserCommands(t.target, sourceArg, ctx);
    if (cmdResult.dest !== null) entry.user_commands_dest = cmdResult.dest;
    if (cmdResult.installed) entry.user_commands_files = cmdResult.files_copied;
    if (cmdResult.warning !== undefined) entry.user_commands_warning = cmdResult.warning;
  }
  if (!flags.skipHooks) {
    const hookResult = await installHooksForTarget(t.target, ctx);
    entry.hooks_status = hookResult.status;
    if (hookResult.warning !== undefined) entry.hooks_warning = hookResult.warning;
  }
  if (!flags.keepLegacy) {
    const cleaned = await cleanLegacyArtifacts(t.target, ctx.env.homeDir(), ctx);
    if (cleaned.length > 0) entry.cleaned_legacy = cleaned;
  }
  return entry;
}

// Para hosts que solo listan top-level (Warp/Oz): copia cada sub-skill
// (`<src>/doctrine/<X>/`, `<src>/specialties/<X>/`, …) a un directorio
// hermano top-level del SKILL universal, namespaced con `agent-workflow-`.
// El frontmatter `name:` del SKILL.md interno define el slash command que
// el host lista (ej. `name: doctor` → `/doctor`); el directorio solo
// resuelve la unicidad en filesystem.
async function flattenSubSkillsForHost(
  target: InstallTarget,
  skillDest: string,
  sourceSkillPath: string,
  force: boolean,
): Promise<{ count: number; warnings: string[] }> {
  if (!FLATTEN_SUBSKILLS_HOSTS.has(target)) return { count: 0, warnings: [] };
  const targetRoot = dirname(skillDest);
  let count = 0;
  const warnings: string[] = [];
  for (const parentDir of FLATTEN_PARENT_DIRS) {
    const parentPath = join(sourceSkillPath, parentDir);
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(parentPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const subSkillPath = join(parentPath, entry.name);
      const skillMdPath = join(subSkillPath, "SKILL.md");
      try {
        await stat(skillMdPath);
      } catch {
        continue;
      }
      const destDir = join(targetRoot, `${FLATTEN_DEST_PREFIX}${entry.name}`);
      try {
        await rm(destDir, { recursive: true, force: true });
        await copyTree(subSkillPath, destDir);
        count += 1;
      } catch (err) {
        if (!force) {
          warnings.push(`flatten failed for ${entry.name}: ${(err as Error).message}`);
        }
      }
    }
  }
  return { count, warnings };
}

async function installUserCommands(
  target: InstallTarget,
  sourceSkillPath: string,
  ctx: CliContext,
): Promise<{ installed: boolean; dest: string | null; files_copied: number; warning?: string }> {
  const relpath = USER_COMMANDS_RELPATH_BY_TARGET[target];
  if (relpath === null) {
    return {
      installed: false,
      dest: null,
      files_copied: 0,
      warning: explainSkipReason(target, "commands"),
    };
  }
  const destDir = join(ctx.env.homeDir(), relpath);
  const srcDir = join(sourceSkillPath, "commands");
  if (!(await ctx.fs.exists(srcDir))) {
    return {
      installed: false,
      dest: destDir,
      files_copied: 0,
      warning: `Source commands dir not found: ${srcDir}`,
    };
  }
  await rm(destDir, { recursive: true, force: true });
  await mkdir(destDir, { recursive: true });
  const entries = await readdir(srcDir, { withFileTypes: true });
  let copied = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".md")) continue;
    if (entry.name === "README.md") continue;
    await copyFile(join(srcDir, entry.name), join(destDir, entry.name));
    copied += 1;
  }
  return { installed: true, dest: destDir, files_copied: copied };
}

async function installHooksForTarget(
  target: InstallTarget,
  ctx: CliContext,
): Promise<{ status: string; warning?: string }> {
  if (!HOOKS_AUTOINSTALL_TARGETS.has(target)) {
    return {
      status: "skipped",
      warning: explainSkipReason(target, "hooks"),
    };
  }
  const { selfInstallHooks } = await import("./install-hooks.js");
  const hookArgs: ParsedArgs = {
    rest: ["install-hooks"],
    plugin: {},
    flags: new Set(),
    values: new Map<string, string>([["target", target]]),
    valuesMulti: new Map(),
  };
  try {
    const result = await selfInstallHooks(hookArgs, ctx);
    if (!result.ok) {
      return { status: "error", warning: result.error?.message ?? "unknown error" };
    }
    return { status: result.data?.status ?? "unknown" };
  } catch (err) {
    return { status: "exception", warning: (err as Error).message };
  }
}

async function preClearCache(
  target: InstallTarget,
  ctx: CliContext,
  keepCache: boolean,
): Promise<{ cleared: boolean; warning?: string }> {
  if (keepCache) return { cleared: false };
  if (!CACHE_CLEAR_HOSTS.has(target)) return { cleared: false };

  const cacheArgs: ParsedArgs = {
    rest: ["clear-plugin-cache"],
    plugin: {},
    flags: new Set(),
    values: new Map<string, string>([
      ["plugin", SKILL_DIR_NAME],
      ["target", target as CacheTarget],
    ]),
    valuesMulti: new Map(),
  };

  try {
    const result = await selfClearPluginCache(cacheArgs, ctx);
    if (!result.ok) {
      return {
        cleared: false,
        warning: `cache_clear_failed: ${result.error?.message ?? "unknown"}`,
      };
    }
    return { cleared: true };
  } catch (err) {
    return {
      cleared: false,
      warning: `cache_clear_exception: ${(err as Error).message}`,
    };
  }
}

export async function resolveBundledSkillPath(): Promise<string | null> {
  const here = dirname(fileURLToPath(import.meta.url));
  let current = here;
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(current, BUNDLED_SKILL_REL_PATH);
    const skillFile = join(candidate, "SKILL.md");
    try {
      await stat(skillFile);
      return candidate;
    } catch {
      // not here, walk up
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}
