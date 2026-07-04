import { copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ParsedArgs } from "../../cli/parser.js";
import type { CliContext } from "../../cli/types.js";
import type { CommandResult } from "../../domain/types.js";
import { INSTALL_TARGETS, type InstallTarget, SKILL_DIR_NAME } from "./install-skill.js";

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

const SUPPORTED_HOOK_TARGETS: ReadonlySet<InstallTarget> = new Set(["claude"]);

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

  if (!SUPPORTED_HOOK_TARGETS.has(target)) {
    return {
      ok: true,
      data: {
        status: "unsupported",
        target,
        config_path: null,
        events_installed: [],
        events_already_present: [],
        backup_path: null,
        warning: `Hooks via merge-into-config are not yet implemented for host '${target}'. Currently supported: claude. Other hosts use file-based or no-hook mechanisms.`,
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

  return installClaudeHooks(ctx, target, template, dryRun);
}

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
    if (deepEqual(existing, entries)) {
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

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) return arrayEqual(a, b);
  if (typeof a === "object" && typeof b === "object") return objectEqual(a, b);
  return false;
}

function arrayEqual(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!deepEqual(a[i], b[i])) return false;
  }
  return true;
}

function objectEqual(a: unknown, b: unknown): boolean {
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const ka = Object.keys(ra);
  if (ka.length !== Object.keys(rb).length) return false;
  for (const k of ka) {
    if (!deepEqual(ra[k], rb[k])) return false;
  }
  return true;
}

export async function resolveBundledHookTemplate(): Promise<string | null> {
  // Walk up from current module to find skills/w/hooks/hooks.template.json
  const { fileURLToPath } = await import("node:url");
  const { stat } = await import("node:fs/promises");
  const here = dirname(fileURLToPath(import.meta.url));
  let current = here;
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(current, "skills", SKILL_DIR_NAME, "hooks", "hooks.template.json");
    try {
      await stat(candidate);
      return candidate;
    } catch {
      // not here
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}
