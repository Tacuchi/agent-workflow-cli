import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseToml } from "smol-toml";
import type { ParsedArgs } from "../../cli/parser.js";
import type { CliContext } from "../../cli/types.js";
import { DESIGN_DESCRIPTOR } from "../../domain/design/capability.js";
import type { CommandResult } from "../../domain/types.js";
import { uninstallCapabilitySkill } from "../capability/wrapper.js";
import { crushGlobalMcpFile, opencodeGlobalMcpFile } from "../mcp-host-paths.js";
import { CODEX_PLUGIN_DIR, isOurCodexPlugin } from "./codex-plugin.js";
import { isOurCommand } from "./hooks-dialect.js";
import { stripOurAgyHooks, stripOurCrushHooks } from "./hooks-json.js";
import {
  countOurHookEntries,
  stripOurHookEntries as stripOurKimiHookEntries,
} from "./hooks-toml.js";
import { type HooksTemplate, resolveBundledHookTemplate } from "./install-hooks.js";
import {
  type InstallTarget,
  LEGACY_SKILL_NAMES,
  SKILL_DIR_NAME,
  TARGET_ROOTS,
  USER_COMMANDS_BY_TARGET,
  isOwnedBundleDir,
  isOwnedSynthesizedDir,
  removeDirIfEmpty,
} from "./install-skill.js";
import {
  COMMAND_SKILLS_HOSTS,
  HOOKS_MANAGED_TARGETS,
  HOST_INSTALL_TARGETS,
  INSTALL_TARGETS,
  LEGACY_SKILL_ROOTS_BY_TARGET,
  SHARED_INSTALL_TARGETS,
} from "./install-targets.js";
import { type McpOfferOutcome, withdrawWorklineServer } from "./mcp-offer.js";
import {
  OPENCODE_PLUGIN_FILE,
  isOurOpencodePlugin,
  undeclareOpencodePlugin,
} from "./opencode-plugin.js";
import { updateAgentsLock } from "./uninstall-skill.js";

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
  status: "removed" | "dry-run" | "noop" | "partial";
  steps: UninstallStep[];
  /** Resultado de retirar el servidor MCP propio de los hosts seleccionados. */
  mcp_server?: McpOfferOutcome[];
  lock_updated: boolean;
  lock_path?: string;
  lock_warning?: string;
  /** What `--target all` deliberately did not touch. Present only for `all`. */
  untouched_note?: string;
}

// `--target all` means EVERY HOST, exactly like `install-skill --target all`:
// the two used to disagree (install skipped `agents`, uninstall included it), so
// `all` removed more than `all` had installed. Shared skills dirs are reached
// explicitly with `--target agents`.
const ALL_TARGETS: readonly InstallTarget[] = HOST_INSTALL_TARGETS;
// Every target stays a valid explicit choice — including the shared ones.
const TARGET_CHOICES: readonly UninstallTargetChoice[] = [...INSTALL_TARGETS, "all"];

// Derived from the install-side map so both sides stay symmetric by construction.
export const USER_COMMANDS_RELPATH_BY_TARGET: Record<InstallTarget, string | null> = {
  ...(Object.fromEntries(
    INSTALL_TARGETS.map((t) => [t, USER_COMMANDS_BY_TARGET[t]?.relpath ?? null]),
  ) as Record<InstallTarget, string | null>),
  // codex: `.codex/commands/w` was written by ≤v18 but Codex never read it;
  // still cleaned every time (inert dir of ours).
  codex: ".codex/commands/w",
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
  kimi: null,
};

/**
 * Per-host hook removers, mirroring `HOOK_INSTALLERS` on the install side. The
 * MAP is the set: there is no second list of "targets we can clean" to fall out
 * of step with the branches — `hookRemoverCoverage()` reads this very object.
 */
const HOOK_REMOVERS: Partial<
  Record<
    InstallTarget,
    (
      ctx: CliContext,
      home: string,
      target: InstallTarget,
      dryRun: boolean,
    ) => Promise<UninstallStep | null>
  >
> = {
  claude: removeClaudeHooks,
  kimi: removeKimiHooks,
  crush: removeCrushHooks,
  gemini: removeAgyHooks,
};

/** Hooks-managed targets with no remover wired — they would strand hooks. Must be empty. */
export function hookRemoverCoverage(): InstallTarget[] {
  return [...HOOKS_MANAGED_TARGETS].filter((t) => HOOK_REMOVERS[t] === undefined);
}

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
        message: `--target must be one of: ${TARGET_CHOICES.join(", ")}. Got '${targetArg}'. 'all' means every host (${ALL_TARGETS.join("|")}); shared skills dirs are explicit.`,
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

  // The lock lives in the shared `.agents` root — and `oz` installs INTO that
  // same root, so it must be pruned whenever any target is rooted there, not
  // only when the literal `agents` target was asked for.
  const touchesAgentsRoot = targets.some((t) => TARGET_ROOTS[t][0] === ".agents");
  const lockResult = touchesAgentsRoot
    ? await updateAgentsLock(ctx, home, flags.includeLegacy, flags.dryRun)
    : { updated: false };

  // `self uninstall` es también la ruta de la TUI. Retira el mismo servidor
  // que ofrecieron `self install` e `install-skill`, y conserva una entrada
  // homónima ajena como conflicto en vez de deducir que es nuestra.
  const mcpServer = withdrawWorklineServer({
    targets,
    scopeDir: home,
    dryRun: flags.dryRun,
  });
  return buildUninstallResult({
    dryRun: flags.dryRun,
    targetArg,
    steps,
    mcpServer,
    lockUpdated: lockResult.updated,
    lockPath: lockResult.path,
    lockWarning: lockResult.warning,
  });
}

interface UninstallResultInput {
  dryRun: boolean;
  targetArg: UninstallTargetChoice;
  steps: UninstallStep[];
  mcpServer: McpOfferOutcome[];
  lockUpdated: boolean;
  lockPath: string | undefined;
  lockWarning: string | undefined;
}

function buildUninstallResult({
  dryRun,
  targetArg,
  steps,
  mcpServer,
  lockUpdated,
  lockPath,
  lockWarning,
}: UninstallResultInput): CommandResult<SelfUninstallData> {
  const removedCount = steps.filter((step) => step.status === "removed").length;
  const status: SelfUninstallData["status"] = dryRun
    ? "dry-run"
    : removedCount === 0
      ? "noop"
      : "removed";
  const hasMcpProblems = mcpServer.some(
    (outcome) => outcome.state === "conflict" || outcome.state === "failed",
  );
  const error = hasMcpProblems
    ? {
        code: "MCP_WITHDRAW_PARTIAL",
        message:
          "La desinstalación retiró sus archivos, pero no el servidor MCP de todos los hosts.",
      }
    : undefined;

  return {
    ok: !hasMcpProblems,
    data: {
      status: hasMcpProblems ? "partial" : status,
      steps,
      ...(mcpServer.length === 0 ? {} : { mcp_server: mcpServer }),
      lock_updated: lockUpdated,
      ...(lockPath ? { lock_path: lockPath } : {}),
      ...(lockWarning ? { lock_warning: lockWarning } : {}),
      ...(targetArg === "all"
        ? {
            untouched_note: `--target all covers hosts only (${ALL_TARGETS.join(", ")}); shared skills dirs are removed explicitly with --target ${SHARED_INSTALL_TARGETS.join(" / --target ")}.`,
          }
        : {}),
    },
    ...(error === undefined ? {} : { error }),
    exitCode: hasMcpProblems ? 1 : 0,
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
  // Symmetric with install: the capability wrapper goes on every host and is
  // NOT a command wrapper, so it is not gated by `--no-commands`. Ownership is
  // fail-closed — a foreign skill under that name is reported, never deleted.
  steps.push(...(await removeCapabilitySkill(ctx, home, target, flags.dryRun)));
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

async function removeCapabilitySkill(
  ctx: CliContext,
  home: string,
  target: InstallTarget,
  dryRun: boolean,
): Promise<UninstallStep[]> {
  const targetRoot = join(home, ...TARGET_ROOTS[target]);
  const path = join(targetRoot, DESIGN_DESCRIPTOR.name);
  if (!(await ctx.fs.exists(path))) return [];
  if (dryRun) return [{ target, kind: "skill", path, status: "dry-run" }];

  const outcome = await uninstallCapabilitySkill(targetRoot, DESIGN_DESCRIPTOR.name);
  if (!outcome.ok) {
    // Someone else's skill wearing the name. Preserved, and said out loud: a
    // silent skip would read as "there was nothing there".
    return [{ target, kind: "skill", path, status: "skipped", reason: outcome.failure.message }];
  }
  return outcome.removed ? [{ target, kind: "skill", path, status: "removed" }] : [];
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
  // Codex's bundle is not a managed install, but it IS an artifact we wrote —
  // and leaving it behind would strand a plugin the person may later install.
  if (target === "codex") return removeCodexPlugin(ctx, home, target, dryRun);
  if (target === "opencode") return removeOpencodePlugin(ctx, home, target, dryRun);
  if (!HOOKS_MANAGED_TARGETS.has(target)) return null;
  const remover = HOOK_REMOVERS[target];
  if (remover === undefined) {
    // Guarded by hookRemoverCoverage(); reported rather than silently skipped.
    return {
      target,
      kind: "hooks",
      path: "(none)",
      status: "skipped",
      reason: `'${target}' is a hooks-managed host with no remover wired — report this as a CLI bug`,
    };
  }
  return remover(ctx, home, target, dryRun);
}

/** Claude Code: strip our entries from the `hooks{}` map in settings.json. */
async function removeClaudeHooks(
  ctx: CliContext,
  home: string,
  target: InstallTarget,
  dryRun: boolean,
): Promise<UninstallStep | null> {
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

  const template = await loadHookTemplate(ctx);
  const removed = stripOurHookEntries(parsed, template);
  if (removed.events.length === 0) return null;

  if (!dryRun) await persistSettings(home, settingsPath, parsed);

  return {
    target,
    kind: "hooks",
    path: settingsPath,
    status: dryRun ? "dry-run" : "removed",
    reason: `Removed ${removed.entries} of our hook entries under: ${removed.events.join(", ")}${
      removed.preserved > 0 ? ` (${removed.preserved} of your own entries preserved)` : ""
    }`,
  };
}

/**
 * Kimi Code: drop our marked block from `~/.kimi-code/config.toml`. Everything
 * outside the markers — the user's models, providers and any hooks of their own
 * — is preserved byte for byte, and the file is backed up before the write.
 */
async function removeKimiHooks(
  ctx: CliContext,
  home: string,
  target: InstallTarget,
  dryRun: boolean,
): Promise<UninstallStep | null> {
  const configPath = join(home, ".kimi-code", "config.toml");
  if (!(await ctx.fs.exists(configPath))) return null;

  const current = await ctx.fs.readText(configPath);
  const { text, removed } = stripOurKimiHookEntries(current);
  if (removed === 0) return null;

  if (!dryRun) {
    await persistTextWithBackup(configPath, current, text);
  }
  // Belt: if a parse still sees hooks of ours, the host wrote them in a shape the
  // text sweep does not recognise. Say so instead of reporting a clean removal.
  const leftover = dryRun ? 0 : (countOurHookEntries(text, parseToml) ?? 0);
  return {
    target,
    kind: "hooks",
    path: configPath,
    status: dryRun ? "dry-run" : "removed",
    reason:
      leftover > 0
        ? `Removed ${removed} of our [[hooks]] entries, but ${leftover} more remain in a shape this version does not recognise — remove them by hand`
        : `Removed ${removed} of our [[hooks]] entries; the rest of config.toml is untouched`,
  };
}

/**
 * Crush: drop our entries from `hooks` in its `crush.json`.
 *
 * The file also carries the person's models, lsp and mcp config, so it is read,
 * edited and written back — never replaced with a hooks-only document.
 */
async function removeCrushHooks(
  ctx: CliContext,
  home: string,
  target: InstallTarget,
  dryRun: boolean,
): Promise<UninstallStep | null> {
  return removeJsonHooks(ctx, target, dryRun, crushGlobalMcpFile(home), stripOurCrushHooks);
}

/**
 * Codex: delete the plugin bundle we generated, and only when it is ours.
 *
 * Ownership is read from the descriptor's `name`, never from the path: a bundle
 * the person put there is not ours to delete because it sits where we would have
 * written one.
 */
async function removeCodexPlugin(
  ctx: CliContext,
  home: string,
  target: InstallTarget,
  dryRun: boolean,
): Promise<UninstallStep | null> {
  const root = join(home, ...CODEX_PLUGIN_DIR);
  const descriptor = join(root, ".codex-plugin", "plugin.json");
  if (!(await ctx.fs.exists(descriptor))) return null;
  if (!isOurCodexPlugin(await ctx.fs.readText(descriptor))) {
    return {
      target,
      kind: "hooks",
      path: root,
      status: "skipped",
      reason: "a plugin bundle is there but its descriptor is not ours; left untouched",
    };
  }
  if (!dryRun) {
    await rm(root, { recursive: true, force: true });
    await removeDirIfEmpty(dirname(root));
  }
  return {
    target,
    kind: "hooks",
    path: root,
    status: dryRun ? "dry-run" : "removed",
    reason:
      "Removed the generated Codex plugin bundle; if it was ever installed, run 'codex plugin uninstall agent-workflow' too",
  };
}

/**
 * opencode: delete the module we generated and undeclare it, leaving every other
 * plugin — on disk and in `plugin[]` — exactly where it was.
 *
 * Ownership is the module's own first line: a file of the person's that happens
 * to sit at that path is not ours to delete.
 */
async function removeOpencodePlugin(
  ctx: CliContext,
  home: string,
  target: InstallTarget,
  dryRun: boolean,
): Promise<UninstallStep | null> {
  const configPath = opencodeGlobalMcpFile(home);
  const pluginPath = join(dirname(configPath), "plugin", OPENCODE_PLUGIN_FILE);
  if (!(await ctx.fs.exists(pluginPath))) return null;
  if (!isOurOpencodePlugin(await ctx.fs.readText(pluginPath))) {
    return {
      target,
      kind: "hooks",
      path: pluginPath,
      status: "skipped",
      reason: "a module is there but it is not the one we generated; left untouched",
    };
  }
  if (!dryRun) {
    await rm(pluginPath, { force: true });
    await removeDirIfEmpty(dirname(pluginPath));
    await undeclareInConfig(ctx, configPath, pluginPath);
  }
  return {
    target,
    kind: "hooks",
    path: pluginPath,
    status: dryRun ? "dry-run" : "removed",
    reason: "Removed the generated opencode plugin and its entry in opencode.json",
  };
}

/** Drops the plugin's `plugin[]` entry, and only that, from a config we can read. */
async function undeclareInConfig(
  ctx: CliContext,
  configPath: string,
  pluginPath: string,
): Promise<void> {
  if (!(await ctx.fs.exists(configPath))) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await ctx.fs.readText(configPath));
  } catch {
    // An unreadable config is the person's to fix; rewriting it blind would be
    // worse than leaving one stale entry pointing at a file that is gone.
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
  const { value, removed } = undeclareOpencodePlugin(parsed as Record<string, unknown>, pluginPath);
  if (removed) await ctx.fs.writeText(configPath, `${JSON.stringify(value, null, 2)}\n`);
}

/** agy: drop our named hook from `~/.agents/hooks.json`, leaving anyone else's. */
async function removeAgyHooks(
  ctx: CliContext,
  home: string,
  target: InstallTarget,
  dryRun: boolean,
): Promise<UninstallStep | null> {
  return removeJsonHooks(
    ctx,
    target,
    dryRun,
    join(home, ".agents", "hooks.json"),
    stripOurAgyHooks,
  );
}

/** The removal both JSON dialects share, down to the reason they report. */
async function removeJsonHooks(
  ctx: CliContext,
  target: InstallTarget,
  dryRun: boolean,
  path: string,
  strip: (doc: Record<string, unknown>) => {
    value: Record<string, unknown>;
    removed: number;
    preserved: number;
  },
): Promise<UninstallStep | null> {
  if (!(await ctx.fs.exists(path))) return null;
  const current = await ctx.fs.readText(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(current);
  } catch {
    return {
      target,
      kind: "hooks",
      path,
      status: "skipped",
      reason: `${path} is invalid JSON; not modified`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

  const { value, removed, preserved } = strip(parsed as Record<string, unknown>);
  if (removed === 0) return null;
  if (!dryRun) {
    await persistTextWithBackup(path, current, `${JSON.stringify(value, null, 2)}\n`);
  }
  return {
    target,
    kind: "hooks",
    path,
    status: dryRun ? "dry-run" : "removed",
    reason: `Removed ${removed} of our hook entries${preserved > 0 ? ` (${preserved} of your own preserved)` : ""}`,
  };
}

async function persistTextWithBackup(path: string, original: string, next: string): Promise<void> {
  const ts = Math.floor(Date.now() / 1000);
  try {
    await writeFile(`${path}.bak.${ts}`, original, "utf8");
  } catch {
    // best-effort backup
  }
  await writeFile(path, next, "utf8");
}

/** The bundled template, or null when it cannot be read (ownership then falls back to the command prefix). */
async function loadHookTemplate(ctx: CliContext): Promise<HooksTemplate | null> {
  try {
    const path = await resolveBundledHookTemplate();
    if (path === null || !(await ctx.fs.exists(path))) return null;
    const parsed = JSON.parse(await ctx.fs.readText(path)) as HooksTemplate;
    return parsed?.hooks && typeof parsed.hooks === "object" ? parsed : null;
  } catch {
    return null;
  }
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

export interface HookStripResult {
  /** Events where at least one of our entries was removed. */
  events: string[];
  /** How many of our entries were removed. */
  entries: number;
  /** How many entries were left in place because they are not ours. */
  preserved: number;
}

/**
 * Removes OUR hook entries and nothing else.
 *
 * It used to delete the whole event whenever its name matched one we install —
 * so a user with their own `PreToolUse` hook lost it on uninstall, exactly the
 * opposite of what the code claimed to do. Ownership is now decided per ENTRY:
 * an entry deep-equal to one in the bundled template is ours, and so is one
 * whose every command invokes this CLI (covers templates that drifted since
 * install). An entry mixing our command with the user's is left alone: it
 * cannot be split without guessing.
 *
 * Scanning every event, not a hardcoded list, also means a new event added to
 * the template is swept without touching this code.
 */
export function stripOurHookEntries(
  data: Record<string, unknown>,
  template: HooksTemplate | null,
): HookStripResult {
  const hooks = data.hooks as Record<string, unknown>;
  const events: string[] = [];
  let entries = 0;
  let preserved = 0;

  for (const [event, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) continue;
    const templateEntries = template?.hooks?.[event];
    const kept = value.filter((entry) => !isOurHookEntry(entry, templateEntries));
    preserved += kept.length;
    if (kept.length === value.length) continue;
    entries += value.length - kept.length;
    events.push(event);
    if (kept.length === 0) Reflect.deleteProperty(hooks, event);
    else hooks[event] = kept;
  }

  if (Object.keys(hooks).length === 0) {
    Reflect.deleteProperty(data, "hooks");
  }
  return { events, entries, preserved };
}

function isOurHookEntry(entry: unknown, templateEntries: unknown): boolean {
  if (Array.isArray(templateEntries) && templateEntries.some((t) => isDeepStrictEqual(t, entry))) {
    return true;
  }
  return entryInvokesOurCli(entry);
}

/** True when the entry carries commands and EVERY one of them runs this CLI. */
function entryInvokesOurCli(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const hooks = (entry as { hooks?: unknown }).hooks;
  if (!Array.isArray(hooks) || hooks.length === 0) return false;
  const commands = hooks
    .map((h) => (typeof h === "object" && h !== null ? (h as { command?: unknown }).command : null))
    .filter((c): c is string => typeof c === "string");
  if (commands.length === 0) return false;
  return commands.every(isOurCommand);
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
