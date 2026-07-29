import { copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ParsedArgs } from "../../cli/parser.js";
import type { CliContext } from "../../cli/types.js";
import type { CommandResult } from "../../domain/types.js";
import { hooksTemplateToToml, upsertManagedHooksBlock } from "./hooks-toml.js";
import {
  INSTALL_TARGETS,
  type InstallTarget,
  SKILL_DIR_NAME,
  findUpward,
} from "./install-skill.js";
import { HOOKS_MANAGED_TARGETS } from "./install-targets.js";

export interface HookEntry {
  matcher?: string;
  hooks: HookCommand[];
}

export interface HookCommand {
  type: string;
  command?: string;
  prompt?: string;
  timeout?: number;
  statusMessage?: string;
}

export interface HooksTemplate {
  hooks: Record<string, HookEntry[]>;
}

export interface SelfInstallHooksData {
  status: "installed" | "dry-run" | "noop" | "unsupported";
  target: InstallTarget;
  config_path: string | null;
  events_installed: string[];
  events_already_present: string[];
  backup_path: string | null;
  warning?: string;
}

// Every install target is a valid --target; hooks merge-into-config is only
// implemented for claude, so the rest resolve to an explanatory "unsupported"
// result (not a generic INVALID_TARGET). Derived from INSTALL_TARGETS so a new
// host can't silently fall into the invalid bucket (the clean-legacy lesson).
const HOOK_TARGET_CHOICES: readonly InstallTarget[] = INSTALL_TARGETS;

export async function selfInstallHooks(
  args: ParsedArgs,
  ctx: CliContext,
  resolveTemplate: () => Promise<string | null> = resolveBundledHookTemplate,
): Promise<CommandResult<SelfInstallHooksData>> {
  const dryRun = args.flags.has("--dry-run");
  const targetArg = args.values.get("target");

  if (targetArg === undefined || targetArg.trim().length === 0) {
    return {
      ok: false,
      error: {
        code: "TARGET_REQUIRED",
        message: `--target is required. Pick one of: ${HOOK_TARGET_CHOICES.join(", ")}.`,
      },
      exitCode: 1,
    };
  }

  if (!HOOK_TARGET_CHOICES.includes(targetArg as InstallTarget)) {
    return {
      ok: false,
      error: {
        code: "INVALID_TARGET",
        message: `--target must be one of: ${HOOK_TARGET_CHOICES.join(", ")}. Got '${targetArg}'.`,
      },
      exitCode: 1,
    };
  }

  const target = targetArg as InstallTarget;

  if (!HOOKS_MANAGED_TARGETS.has(target)) {
    return {
      ok: true,
      data: {
        status: "unsupported",
        target,
        config_path: null,
        events_installed: [],
        events_already_present: [],
        backup_path: null,
        warning: `Workline does not manage hooks on '${target}'. Managed hosts: ${[...HOOKS_MANAGED_TARGETS].join(", ")}. The rest use file-based or no-hook mechanisms.`,
      },
      exitCode: 0,
    };
  }

  const templatePathArg = args.values.get("template");
  const templatePath = templatePathArg ?? (await resolveTemplate());
  if (templatePath === null) {
    return {
      ok: false,
      error: {
        code: "TEMPLATE_NOT_FOUND",
        message:
          "hooks.template.json not found in bundled skill location. Pass --template <path> to override.",
      },
      exitCode: 1,
    };
  }
  if (!(await ctx.fs.exists(templatePath))) {
    return {
      ok: false,
      error: {
        code: "TEMPLATE_NOT_FOUND",
        message: `hooks template not found at ${templatePath}.`,
      },
      exitCode: 1,
    };
  }

  const templateText = await ctx.fs.readText(templatePath);
  let template: HooksTemplate;
  try {
    template = JSON.parse(templateText);
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "TEMPLATE_INVALID_JSON",
        message: `hooks template at ${templatePath} is invalid JSON: ${(err as Error).message}`,
      },
      exitCode: 1,
    };
  }
  if (!isHooksTemplate(template)) {
    return {
      ok: false,
      error: {
        code: "TEMPLATE_INVALID_SCHEMA",
        message: `hooks template at ${templatePath} missing 'hooks' top-level key.`,
      },
      exitCode: 1,
    };
  }

  return installHooksFor(target, ctx, template, dryRun);
}

/**
 * Per-host hook installers. A host in `HOOKS_MANAGED_TARGETS` MUST have one —
 * `hookInstallerCoverage()` proves it, so "managed" can never mean "declared
 * managed and quietly doing nothing".
 */
const HOOK_INSTALLERS: Partial<
  Record<
    InstallTarget,
    (
      ctx: CliContext,
      target: InstallTarget,
      template: HooksTemplate,
      dryRun: boolean,
    ) => Promise<CommandResult<SelfInstallHooksData>>
  >
> = {
  claude: installClaudeHooks,
  kimi: installKimiHooks,
};

/** Managed targets with no installer wired. Must be empty. */
export function hookInstallerCoverage(): InstallTarget[] {
  return [...HOOKS_MANAGED_TARGETS].filter((t) => HOOK_INSTALLERS[t] === undefined);
}

function installHooksFor(
  target: InstallTarget,
  ctx: CliContext,
  template: HooksTemplate,
  dryRun: boolean,
): Promise<CommandResult<SelfInstallHooksData>> {
  const installer = HOOK_INSTALLERS[target];
  if (installer === undefined) {
    return Promise.resolve({
      ok: false,
      error: {
        code: "HOOKS_INSTALLER_MISSING",
        message: `'${target}' is declared as a hooks-managed host but has no installer wired. This is a bug in the CLI, not in your setup.`,
      },
      exitCode: 1,
    });
  }
  return installer(ctx, target, template, dryRun);
}

/**
 * Kimi Code keeps hooks in `[[hooks]]` tables inside its USER-GLOBAL
 * `config.toml` — there is no project-level config to write instead (verified
 * against v0.29.2 plus a live probe). Our entries live inside a marked block so
 * everything the user wrote around it survives install, reinstall and uninstall
 * untouched, and the file is backed up before any write.
 */
async function installKimiHooks(
  ctx: CliContext,
  target: InstallTarget,
  template: HooksTemplate,
  dryRun: boolean,
): Promise<CommandResult<SelfInstallHooksData>> {
  const configPath = join(ctx.env.homeDir(), ".kimi-code", "config.toml");
  const existing = (await ctx.fs.exists(configPath)) ? await ctx.fs.readText(configPath) : "";

  const { entries, skipped } = hooksTemplateToToml(template);
  const eventsInstalled = [...new Set(entries.map((e) => e.event))];
  const next = upsertManagedHooksBlock(existing, entries).text;

  const warning =
    skipped.length > 0
      ? `Not expressible in Kimi Code and therefore skipped: ${skipped
          .map((s) => `${s.event} (${s.reason})`)
          .join("; ")}.`
      : undefined;

  if (next === existing) {
    return {
      ok: true,
      data: {
        status: "noop",
        target,
        config_path: configPath,
        events_installed: [],
        events_already_present: eventsInstalled,
        backup_path: null,
        ...(warning ? { warning } : {}),
      },
      exitCode: 0,
    };
  }

  if (dryRun) {
    return {
      ok: true,
      data: {
        status: "dry-run",
        target,
        config_path: configPath,
        events_installed: eventsInstalled,
        events_already_present: [],
        backup_path: null,
        ...(warning ? { warning } : {}),
      },
      exitCode: 0,
    };
  }

  await ctx.fs.mkdirp(dirname(configPath));
  const backup = await tryBackup(configPath, ctx);
  await ctx.fs.writeText(configPath, next);

  return {
    ok: true,
    data: {
      status: "installed",
      target,
      config_path: configPath,
      events_installed: eventsInstalled,
      events_already_present: [],
      backup_path: backup,
      ...(warning ? { warning } : {}),
    },
    exitCode: 0,
  };
}

/** Claude Code: JSON merge into `~/.claude/settings.json` → `hooks{}`. */
async function installClaudeHooks(
  ctx: CliContext,
  target: InstallTarget,
  template: HooksTemplate,
  dryRun: boolean,
): Promise<CommandResult<SelfInstallHooksData>> {
  const settingsPath = join(ctx.env.homeDir(), ".claude", "settings.json");
  let existingData: Record<string, unknown> = {};
  if (await ctx.fs.exists(settingsPath)) {
    const text = await ctx.fs.readText(settingsPath);
    try {
      const parsed = JSON.parse(text);
      if (isRecord(parsed)) existingData = parsed;
    } catch (err) {
      return {
        ok: false,
        error: {
          code: "SETTINGS_INVALID_JSON",
          message: `~/.claude/settings.json is invalid JSON: ${(err as Error).message}. Fix manually before retrying.`,
        },
        exitCode: 1,
      };
    }
  }

  const existingHooks = isRecord(existingData.hooks)
    ? (existingData.hooks as Record<string, unknown>)
    : {};

  const eventsInstalled: string[] = [];
  const eventsAlreadyPresent: string[] = [];
  const merged: Record<string, unknown> = { ...existingHooks };
  for (const [event, entries] of Object.entries(template.hooks)) {
    const existing = existingHooks[event];
    if (isDeepStrictEqual(existing, entries)) {
      eventsAlreadyPresent.push(event);
    } else {
      eventsInstalled.push(event);
      merged[event] = entries;
    }
  }

  if (eventsInstalled.length === 0) {
    return {
      ok: true,
      data: {
        status: "noop",
        target,
        config_path: settingsPath,
        events_installed: [],
        events_already_present: eventsAlreadyPresent,
        backup_path: null,
      },
      exitCode: 0,
    };
  }

  if (dryRun) {
    return {
      ok: true,
      data: {
        status: "dry-run",
        target,
        config_path: settingsPath,
        events_installed: eventsInstalled,
        events_already_present: eventsAlreadyPresent,
        backup_path: null,
      },
      exitCode: 0,
    };
  }

  await ctx.fs.mkdirp(dirname(settingsPath));
  const backup = await tryBackup(settingsPath, ctx);
  const newData = { ...existingData, hooks: merged };
  await ctx.fs.writeText(settingsPath, `${JSON.stringify(newData, null, 2)}\n`);

  return {
    ok: true,
    data: {
      status: "installed",
      target,
      config_path: settingsPath,
      events_installed: eventsInstalled,
      events_already_present: eventsAlreadyPresent,
      backup_path: backup,
    },
    exitCode: 0,
  };
}

async function tryBackup(path: string, ctx: CliContext): Promise<string | null> {
  if (!(await ctx.fs.exists(path))) return null;
  const ts = Math.floor(Date.now() / 1000);
  const backupPath = `${path}.bak.${ts}`;
  try {
    await copyFile(path, backupPath);
    return backupPath;
  } catch {
    return null;
  }
}

function isHooksTemplate(value: unknown): value is HooksTemplate {
  return isRecord(value) && isRecord((value as Record<string, unknown>).hooks);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function resolveBundledHookTemplate(): Promise<string | null> {
  return findUpward(join("skills", SKILL_DIR_NAME, "hooks", "hooks.template.json"));
}
