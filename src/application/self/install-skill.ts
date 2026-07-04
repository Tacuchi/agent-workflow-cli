import { copyFile, mkdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ParsedArgs } from "../../cli/parser.js";
import type { CliContext } from "../../cli/types.js";
import type { InstallTarget } from "../../domain/harnesses.js";
import type { CommandResult } from "../../domain/types.js";
import {
  COMMAND_SKILLS_HOSTS,
  INSTALL_TARGETS,
  LEGACY_SKILL_ROOTS_BY_TARGET,
  TARGET_ROOTS,
} from "./install-targets.js";
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
  /** Synthesized `w-<command>` skill-as-command wrappers (COMMAND_SKILLS_HOSTS). */
  command_skills?: number;
  command_skills_warnings?: string[];
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

// Hosts whose user-invocable unit is the SKILL (no file-based commands dir):
// each `commands/<cmd>.md` is synthesized as a top-level sibling skill
// `w-<cmd>/SKILL.md` (skill-as-command — harness/HARNESS.md § Command
// packaging). Bundle-relative references (`../loops/…`) are rewritten to
// `../w/…` so they resolve from the synthesized location.
// Codex reads NO commands dir and its custom prompts are deprecated/removed
// (verified vs openai/codex rust-v0.142.5 source, 2026-07); Warp/Oz derive
// slash commands from the `name:` frontmatter of each top-level SKILL.md.
// Gemini's successor Antigravity CLI (agy 1.0.16, verified vs its binary +
// bundled agy-customizations doc, 2026-07) dropped user commands entirely —
// slash commands are system-only and skills are the only user-installable
// invocable unit; it reads ~/.gemini/skills as its "Shared" tier, so the
// synthesized wrappers land next to the bundle there.
// The set itself lives in install-targets.ts: uninstall.ts consumes the same
// value so both sides stay symmetric by construction.
export { COMMAND_SKILLS_HOSTS };
// Exported: it is the bundle's namespace in the skill roots — the loose-skill
// scan (skills-manager.listSkills) excludes it so `w-*` never lists as unmanaged.
export const COMMAND_SKILL_PREFIX = "w-";

// Native command-wrapper formats. Each host that DOES read a file-based
// commands dir gets the bundle commands transformed into its dialect
// (field research 2026-07, verified against each host's source/docs):
//   claude-md    ~/.claude/commands/w/<cmd>.md   → /w:<cmd>   (as-authored)
//   gemini-toml  ~/.gemini/commands/w/<cmd>.toml → /w:<cmd>   (description + prompt, {{args}})
//   opencode-md  ~/.opencode/command/w/<cmd>.md  → /w/<cmd>   (description frontmatter + body)
//   crush-md     ~/.crush/commands/w/<cmd>.md    → user:w:<cmd> (plain body — Crush parses no frontmatter)
type CommandWrapperFormat = "claude-md" | "gemini-toml" | "opencode-md" | "crush-md";

interface UserCommandsSpec {
  relpath: string;
  format: CommandWrapperFormat;
}

export const USER_COMMANDS_BY_TARGET: Record<InstallTarget, UserCommandsSpec | null> = {
  claude: { relpath: ".claude/commands/w", format: "claude-md" },
  // codex/warp/oz: commands ship as synthesized `w-*` skills (COMMAND_SKILLS_HOSTS).
  codex: null,
  warp: null,
  oz: null,
  agents: null,
  // Legacy Gemini CLI compat only — Antigravity (agy) ignores this dir; its
  // command surface is the synthesized `w-*` skills (COMMAND_SKILLS_HOSTS).
  gemini: { relpath: ".gemini/commands/w", format: "gemini-toml" },
  opencode: { relpath: ".opencode/command/w", format: "opencode-md" },
  crush: { relpath: ".crush/commands/w", format: "crush-md" },
};

// Stale user-commands dirs from prior releases, removed on install/uninstall:
// the pre-`w`-rename namespace (`/agent-workflow:*`) everywhere, plus the
// Codex dir that ≤v18 wrote under the false "Claude Code + Codex follow the
// same convention" assumption — Codex never read it.
const LEGACY_USER_COMMANDS_RELPATHS_BY_TARGET: Record<InstallTarget, readonly string[]> = {
  claude: [".claude/commands/agent-workflow"],
  codex: [".codex/commands/agent-workflow", ".codex/commands/w"],
  warp: [],
  oz: [],
  agents: [],
  gemini: [],
  opencode: [],
  crush: [],
};

/** rmdir succeeds only on empty dirs — clears purposeless leftovers (e.g. the
 * inert ~/.codex/commands parent once its w/ subdir is gone) while anything
 * holding user content survives untouched. */
export async function removeDirIfEmpty(p: string): Promise<boolean> {
  try {
    await rmdir(p);
    return true;
  } catch {
    return false;
  }
}

/** Ownership check before deleting a `w` dir from a LEGACY root: those roots
 * can be shared namespaces, so require the bundle fingerprint — never rm by
 * dir name alone. Historical forms count: v14.5–v18 bundles shipped
 * `name: workflow` and `harness/SKILL.md` (renamed to `w`/HARNESS.md in v19),
 * and the migration window starts at v14.5 (first crush install). */
export async function isOwnedBundleDir(dir: string, ctx: CliContext): Promise<boolean> {
  try {
    const raw = await readFile(join(dir, "SKILL.md"), "utf8");
    const name = raw.match(/^name:\s*["']?([\w-]+)["']?\s*$/m)?.[1];
    if (name !== SKILL_DIR_NAME && name !== "workflow") return false;
    return (
      (await ctx.fs.exists(join(dir, "harness", "HARNESS.md"))) ||
      (await ctx.fs.exists(join(dir, "harness", "SKILL.md")))
    );
  } catch {
    return false;
  }
}

/** Sweep abandoned skill roots the host never reads
 * (LEGACY_SKILL_ROOTS_BY_TARGET): pre-rename names, the ownership-verified
 * bundle, and the root itself once emptied. Appends removed paths. */
async function cleanLegacySkillRoots(
  target: InstallTarget,
  home: string,
  ctx: CliContext,
  tryRemove: (p: string) => Promise<void>,
  removed: string[],
): Promise<void> {
  for (const legacyRoot of LEGACY_SKILL_ROOTS_BY_TARGET[target]) {
    const root = join(home, ...legacyRoot);
    for (const name of LEGACY_SKILL_NAMES) {
      await tryRemove(join(root, name));
    }
    const legacyBundle = join(root, SKILL_DIR_NAME);
    if (await isOwnedBundleDir(legacyBundle, ctx)) {
      await tryRemove(legacyBundle);
    }
    if (await removeDirIfEmpty(root)) {
      removed.push(root);
    }
  }
}

/**
 * Remove legacy artifacts from a prior install for `target`: the pre-rename
 * SKILL dirs (LEGACY_SKILL_NAMES), the old user-commands dir
 * (`/agent-workflow:*`), abandoned skill roots the host never reads
 * (LEGACY_SKILL_ROOTS_BY_TARGET, ownership-verified), and — for
 * COMMAND_SKILLS_HOSTS — the old `agent-workflow-*` flattened sub-skills.
 * Returns the paths removed.
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
  for (const legacyCmd of LEGACY_USER_COMMANDS_RELPATHS_BY_TARGET[target]) {
    const cmdDir = join(home, legacyCmd);
    if (!(await ctx.fs.exists(cmdDir))) continue;
    await tryRemove(cmdDir);
    // Prune the parent only when the legacy child was actually removed —
    // otherwise --skill-only could rmdir a pre-existing empty live commands
    // dir (e.g. ~/.claude/commands) that no wrapper install repopulates.
    if (await removeDirIfEmpty(dirname(cmdDir))) {
      removed.push(dirname(cmdDir));
    }
  }
  await cleanLegacySkillRoots(target, home, ctx, tryRemove, removed);
  if (COMMAND_SKILLS_HOSTS.has(target)) {
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
    if (COMMAND_SKILLS_HOSTS.has(target)) {
      return `${target}: this host reads no file-based commands dir — commands are installed as synthesized 'w-<command>' skills next to the bundle (skill-as-command).`;
    }
    return `${target}: shared cross-host skills dir, not a host — no command wrapper to install.`;
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
  if (!flags.skipCommands) {
    // Synthesized w-* wrappers ARE the command surface on COMMAND_SKILLS_HOSTS,
    // so --skill-only / --no-commands skips them exactly like native wrappers.
    if (COMMAND_SKILLS_HOSTS.has(t.target)) {
      const synth = await synthesizeCommandSkills(t.target, dest, sourceArg);
      entry.command_skills = synth.count;
      if (synth.warnings.length > 0) entry.command_skills_warnings = synth.warnings;
    }
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

interface CommandDoc {
  description: string | null;
  body: string;
}

// Marker line every synthesized wrapper carries. It doubles as the OWNERSHIP
// fingerprint: sweeps only delete `w-*` dirs proven ours (this marker, or the
// ≤v18 flatten fingerprint) — the skill roots are shared namespaces
// (~/.agents/skills anchor, loose skills), never swept by prefix alone.
export const COMMAND_SKILL_MARKER =
  "Skill-as-command wrapper (installed by `aw self install-skill`)";

/**
 * True when `<dirPath>/SKILL.md` proves the dir is CLI-synthesized: it carries
 * the wrapper marker, or the ≤v18 flatten fingerprint (the flatten copied
 * sub-skill `<name>` into dir `<prefix><name>` keeping `name: <name>` — a
 * user's own skill has `name:` equal to its dir, not to a de-prefixed one).
 */
export async function isOwnedSynthesizedDir(dirPath: string, prefix: string): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(join(dirPath, "SKILL.md"), "utf8");
  } catch {
    return false; // no SKILL.md — not ours, preserve.
  }
  if (text.includes(COMMAND_SKILL_MARKER)) return true;
  const dirName = dirPath.split(/[\\/]/).pop() ?? "";
  const fmName = text.match(/^name:[ \t]*(\S.*)$/m)?.[1]?.trim();
  return fmName !== undefined && `${prefix}${fmName}` === dirName;
}

// Splits a bundle command file (Claude-binding frontmatter + body). The
// frontmatter schema is the Claude Code wrapper; other hosts re-wrap the
// same contract (harness/HARNESS.md § Command packaging). Handles plain,
// quoted and block-scalar (`>-` / `|`) description values — the bundle's own
// SKILL.md models the folded style, so authors will reuse it in commands.
export function splitCommandDoc(raw: string): CommandDoc {
  const match = raw.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/);
  if (!match) return { description: null, body: raw };
  const block = match[1] ?? "";
  const body = raw.slice(match[0].length).replace(/^\s*\n/, "");
  const descMatch = block.match(/^description:[ \t]*(.*)$/m);
  if (!descMatch) return { description: null, body };
  let value = (descMatch[1] ?? "").trim();
  if (/^[>|][+-]?$/.test(value)) {
    const after = block.slice((descMatch.index ?? 0) + descMatch[0].length).replace(/^\r?\n/, "");
    const parts: string[] = [];
    for (const line of after.split(/\r?\n/)) {
      if (!/^[ \t]+\S/.test(line)) break;
      parts.push(line.trim());
    }
    value = parts.join(" ");
  } else if (
    (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
    (value.startsWith("'") && value.endsWith("'") && value.length > 1)
  ) {
    value = value.slice(1, -1);
  }
  return { description: value.length > 0 ? value : null, body };
}

// For hosts without a commands dir (COMMAND_SKILLS_HOSTS): synthesizes each
// `commands/<cmd>.md` as a top-level skill sibling of the bundle,
// `<root>/w-<cmd>/SKILL.md` (skill-as-command). The command body becomes the
// skill body; bundle-relative references go one level up from `commands/`, so
// rewriting `../` → `../w/` makes them resolve from the new location. Before
// synthesizing, it sweeps the `w-*` dirs it OWNS (marker/fingerprint — cleans
// ≤v18 flattened loops and wrappers of removed commands); a foreign dir with
// the `w-` prefix is always preserved.
async function synthesizeCommandSkills(
  target: InstallTarget,
  skillDest: string,
  sourceSkillPath: string,
): Promise<{ count: number; warnings: string[] }> {
  if (!COMMAND_SKILLS_HOSTS.has(target)) return { count: 0, warnings: [] };
  const targetRoot = dirname(skillDest);
  const warnings: string[] = [];
  try {
    for (const entry of await readdir(targetRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(COMMAND_SKILL_PREFIX)) continue;
      const dirPath = join(targetRoot, entry.name);
      if (await isOwnedSynthesizedDir(dirPath, COMMAND_SKILL_PREFIX)) {
        await rm(dirPath, { recursive: true, force: true });
      }
    }
  } catch {
    // target root absent/unreadable — nothing to sweep.
  }
  const srcDir = join(sourceSkillPath, "commands");
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(srcDir, { withFileTypes: true });
  } catch {
    return { count: 0, warnings: [`source commands dir not found: ${srcDir}`] };
  }
  let count = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "README.md") continue;
    const cmd = entry.name.slice(0, -".md".length);
    try {
      const raw = await readFile(join(srcDir, entry.name), "utf8");
      const skillName = `${COMMAND_SKILL_PREFIX}${cmd}`;
      const destDir = join(targetRoot, skillName);
      await mkdir(destDir, { recursive: true });
      await writeFile(join(destDir, "SKILL.md"), renderCommandSkill(skillName, raw), "utf8");
      count += 1;
    } catch (err) {
      warnings.push(`command skill failed for ${cmd}: ${(err as Error).message}`);
    }
  }
  return { count, warnings };
}

function renderCommandSkill(skillName: string, raw: string): string {
  const { description, body } = splitCommandDoc(raw);
  const desc = description ?? `agent-workflow command ${skillName} (see body).`;
  const rewired = body.split("../").join("../w/");
  return [
    "---",
    `name: ${skillName}`,
    "description: >-",
    `  ${desc}`,
    "---",
    "",
    `> ${COMMAND_SKILL_MARKER}. Treat the text accompanying this invocation as \`$ARGUMENTS\`. The full \`w\` bundle lives in the sibling directory \`../w/\`.`,
    "",
    rewired,
  ].join("\n");
}

// TOML string escaping for the Gemini command wrapper. The prompt goes in a
// multi-line BASIC string ("""…"""), so backslashes and quote runs must be
// escaped to round-trip the markdown body verbatim.
function tomlBasicString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function tomlMultilineBasicString(value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"""/g, '""\\"');
  return `"""\n${escaped}\n"""`;
}

function renderCommandWrapper(format: CommandWrapperFormat, raw: string): string {
  if (format === "claude-md") return raw;
  const { description, body } = splitCommandDoc(raw);
  if (format === "gemini-toml") {
    const prompt = body.split("$ARGUMENTS").join("{{args}}");
    const lines: string[] = [];
    if (description !== null) lines.push(`description = ${tomlBasicString(description)}`);
    lines.push(`prompt = ${tomlMultilineBasicString(prompt)}`);
    return `${lines.join("\n")}\n`;
  }
  if (format === "opencode-md") {
    // OpenCode supports $ARGUMENTS natively; re-emit only the frontmatter
    // keys its schema knows (description) to avoid Claude-binding leakage.
    const fm = description === null ? [] : ["---", `description: ${description}`, "---", ""];
    return [...fm, body].join("\n");
  }
  // crush-md: Crush parses no frontmatter — ship the body only. $ARGUMENTS
  // matches its ^\$[A-Z]+ named-argument rule, so Crush prompts for it.
  return body;
}

async function installUserCommands(
  target: InstallTarget,
  sourceSkillPath: string,
  ctx: CliContext,
): Promise<{ installed: boolean; dest: string | null; files_copied: number; warning?: string }> {
  const spec = USER_COMMANDS_BY_TARGET[target];
  if (spec === null) {
    return {
      installed: false,
      dest: null,
      files_copied: 0,
      warning: explainSkipReason(target, "commands"),
    };
  }
  const destDir = join(ctx.env.homeDir(), spec.relpath);
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
    const raw = await readFile(join(srcDir, entry.name), "utf8");
    const destName =
      spec.format === "gemini-toml" ? entry.name.replace(/\.md$/, ".toml") : entry.name;
    await writeFile(join(destDir, destName), renderCommandWrapper(spec.format, raw), "utf8");
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
