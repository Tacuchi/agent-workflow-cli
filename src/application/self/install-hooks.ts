import { copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseToml } from "smol-toml";
import type { ParsedArgs } from "../../cli/parser.js";
import type { CliContext } from "../../cli/types.js";
import type { CommandResult } from "../../domain/types.js";
import { readPackageVersion } from "../../runtime/version.js";
import { crushGlobalMcpFile, opencodeGlobalMcpFile } from "../mcp-host-paths.js";
import { CODEX_PLUGIN_DIR, buildCodexPluginBundle } from "./codex-plugin.js";
import {
  AGY_HOOK_NAME,
  type AgyNamedHook,
  hooksTemplateToAgy,
  hooksTemplateToCrush,
  isOurHookEntry,
} from "./hooks-json.js";
import { auditHooksSection, hooksTemplateToToml, upsertManagedHooksBlock } from "./hooks-toml.js";
import {
  INSTALL_TARGETS,
  type InstallTarget,
  SKILL_DIR_NAME,
  findUpward,
} from "./install-skill.js";
import { HOOKS_MANAGED_TARGETS } from "./install-targets.js";
import {
  OPENCODE_PLUGIN_FILE,
  buildOpencodePlugin,
  declareOpencodePlugin,
} from "./opencode-plugin.js";

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
  /**
   * `blocked` = nothing was written on purpose. The prospective section carried an
   * entry the host would reject, and since its loader discards the WHOLE section
   * over one bad entry, writing would have disarmed every hook in the file —
   * ours and the user's. Reported instead of applied.
   *
   * `generated` = the artifact was written and is NOT armed, because arming it is
   * a step only the person can run. Kept apart from `installed` for the reason
   * every state here is kept apart: reporting a bundle nobody installed as
   * installed is the one thing these surfaces must never do.
   */
  status: "installed" | "dry-run" | "noop" | "unsupported" | "blocked" | "generated";
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

  // Codex is not a managed host and is not an unsupported one either: its plugin
  // route produces a real artifact that only the PERSON can install. Placed
  // before the managed check so it is not swallowed by the "unsupported" answer.
  if (target === "codex" || target === "opencode") {
    const loaded = await loadTemplate(args, ctx, resolveTemplate);
    if ("error" in loaded) return loaded.error;
    return target === "codex"
      ? generateCodexPlugin(ctx, target, loaded.template, dryRun)
      : installOpencodePlugin(ctx, target, loaded.template, dryRun);
  }

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

  const loaded = await loadTemplate(args, ctx, resolveTemplate);
  if ("error" in loaded) return loaded.error;
  return installHooksFor(target, ctx, loaded.template, dryRun);
}

/** The bundled template, resolved and validated, or the failure that stops the run. */
async function loadTemplate(
  args: ParsedArgs,
  ctx: CliContext,
  resolveTemplate: () => Promise<string | null>,
): Promise<{ template: HooksTemplate } | { error: CommandResult<SelfInstallHooksData> }> {
  const fail = (code: string, message: string): { error: CommandResult<SelfInstallHooksData> } => ({
    error: { ok: false, error: { code, message }, exitCode: 1 },
  });

  const templatePath = args.values.get("template") ?? (await resolveTemplate());
  if (templatePath === null) {
    return fail(
      "TEMPLATE_NOT_FOUND",
      "hooks.template.json not found in bundled skill location. Pass --template <path> to override.",
    );
  }
  if (!(await ctx.fs.exists(templatePath))) {
    return fail("TEMPLATE_NOT_FOUND", `hooks template not found at ${templatePath}.`);
  }
  let template: HooksTemplate;
  try {
    template = JSON.parse(await ctx.fs.readText(templatePath));
  } catch (err) {
    return fail(
      "TEMPLATE_INVALID_JSON",
      `hooks template at ${templatePath} is invalid JSON: ${(err as Error).message}`,
    );
  }
  if (!isHooksTemplate(template)) {
    return fail(
      "TEMPLATE_INVALID_SCHEMA",
      `hooks template at ${templatePath} missing 'hooks' top-level key.`,
    );
  }
  return { template };
}

/**
 * Codex: write the plugin bundle, and say plainly that it is not armed.
 *
 * The status is `generated`, never `installed`: the two `codex plugin` commands
 * that arm it are the person's, and no `trusted_hash` is written here or
 * anywhere else — forging one would forge their security approval.
 */
async function generateCodexPlugin(
  ctx: CliContext,
  target: InstallTarget,
  template: HooksTemplate,
  dryRun: boolean,
): Promise<CommandResult<SelfInstallHooksData>> {
  const root = join(ctx.env.homeDir(), ...CODEX_PLUGIN_DIR);
  const bundle = buildCodexPluginBundle(template, readPackageVersion());
  if (!dryRun) {
    for (const [relative, contents] of Object.entries(bundle.files)) {
      const path = join(root, relative);
      await ctx.fs.mkdirp(dirname(path));
      await ctx.fs.writeText(path, contents);
    }
  }
  return {
    ok: true,
    data: {
      status: dryRun ? "dry-run" : "generated",
      target,
      config_path: root,
      events_installed: Object.keys(template.hooks),
      events_already_present: [],
      backup_path: null,
      warning: [
        `The bundle was written to ${root} and is NOT armed.`,
        "Codex installs plugins through a marketplace, so arming it is yours to run:",
        bundle.install_commands.map((c) => `\`${c}\``).join(" then "),
        "Its hooks skip codex's per-hook trust review because they ship inside a plugin; nothing here writes a trusted_hash.",
      ].join(" "),
    },
    exitCode: 0,
  };
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
  crush: installCrushHooks,
  gemini: installAgyHooks,
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

  const { entries, skipped, degraded } = hooksTemplateToToml(template);
  const eventsInstalled = [...new Set(entries.map((e) => e.event))];
  const next = upsertManagedHooksBlock(existing, entries).text;

  const notices: string[] = [];
  if (skipped.length > 0) {
    notices.push(
      `Not expressible in Kimi Code and therefore skipped: ${skipped
        .map((s) => `${s.event} (${s.reason})`)
        .join("; ")}.`,
    );
  }
  if (degraded.length > 0) {
    notices.push(
      `Installed with a declared degradation: ${degraded
        .map((d) => `${d.event} (${d.reason})`)
        .join("; ")}.`,
    );
  }
  const warning = notices.length > 0 ? notices.join(" ") : undefined;

  // The section that WOULD exist, judged before it exists. Validating only our own
  // transform was not enough: one invalid entry the user already had is enough for
  // Kimi to discard the whole `hooks` section, so appending ours beside it disarms
  // everything — theirs and ours — while the install reports success.
  const audit = auditHooksSection(next, parseToml);
  const blocked = blockedResult(target, configPath, audit);
  if (blocked !== null) return blocked;

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

/**
 * The refusal to write, or `null` when the prospective section is loadable.
 *
 * Two causes, and they are told apart because the fix differs. A section that does
 * not parse is a broken file the person has to repair; a section that parses but
 * carries an invalid ENTRY names which one and whose it is — a pre-existing entry
 * of the user's is not something an installer may quietly rewrite, and one of ours
 * would be our bug.
 */
function blockedResult(
  target: InstallTarget,
  configPath: string,
  audit: ReturnType<typeof auditHooksSection>,
): CommandResult<SelfInstallHooksData> | null {
  // The transform's own notices are deliberately NOT appended here. They are
  // phrased for a write that happened ("skipped", "installed with a degradation"),
  // and nothing was written — so they would contradict the status. They stay
  // visible where they are true: a successful install, and `reportHooksArmed`.
  const blocked = (reason: string): CommandResult<SelfInstallHooksData> => ({
    ok: true,
    data: {
      status: "blocked",
      target,
      config_path: configPath,
      events_installed: [],
      events_already_present: [],
      backup_path: null,
      warning: [
        `Nothing was written to ${configPath}: ${reason}.`,
        "Kimi Code discards its ENTIRE hooks section when one entry fails validation, so writing would have disarmed every hook in the file — yours included.",
      ].join(" "),
    },
    exitCode: 0,
  });

  if (!audit.parsed) {
    return blocked("the resulting file does not parse as TOML, so its hooks cannot be validated");
  }
  if (audit.defects.length === 0) return null;
  const detail = audit.defects
    .map(
      (d) =>
        `entry #${d.index}${d.event === null ? "" : ` (${d.event})`} ${d.ours ? "installed by Workline" : "already in your config"} — ${d.reason}`,
    )
    .join("; ");
  return blocked(
    `the resulting hooks section would carry ${audit.defects.length} invalid entry/entries: ${detail}`,
  );
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

/**
 * Crush: JSON merge into its own `crush.json` → `hooks`.
 *
 * The file is the SAME one its MCP servers live in, so the merge is per key and
 * never a rewrite: everything the person configured — models, lsp, mcp, and any
 * hook of their own — is read, kept and written back beside ours.
 */
async function installCrushHooks(
  ctx: CliContext,
  target: InstallTarget,
  template: HooksTemplate,
  dryRun: boolean,
): Promise<CommandResult<SelfInstallHooksData>> {
  const configPath = crushGlobalMcpFile(ctx.env.homeDir());
  const read = await readJsonConfig(ctx, configPath, "crush.json");
  if ("error" in read) return read.error;

  const { emitted, skipped } = hooksTemplateToCrush(template);
  const warning = skipNotice(skipped, "Crush");
  const existingHooks = isRecord(read.data.hooks) ? read.data.hooks : {};
  const merged: Record<string, unknown> = { ...existingHooks };
  const events: string[] = [];
  for (const [event, ours] of Object.entries(emitted)) {
    const theirs = Array.isArray(existingHooks[event]) ? (existingHooks[event] as unknown[]) : [];
    // Ours replace ours, never theirs: a reinstall must not append a second copy,
    // and a hook the person wrote is not ours to drop.
    const kept = theirs.filter((entry) => !isOurHookEntry(entry));
    const next = [...kept, ...ours];
    if (isDeepStrictEqual(theirs, next)) continue;
    merged[event] = next;
    events.push(event);
  }

  return writeMergedConfig(ctx, {
    target,
    configPath,
    dryRun,
    changed: events,
    unchanged: events.length === 0 ? Object.keys(emitted) : [],
    next: { ...read.data, hooks: merged },
    warning,
  });
}

/**
 * agy: one named hook in `~/.agents/hooks.json`.
 *
 * `.agents/` is the customization root agy's own doc names, and the user-global
 * one is NOT verified — which is why the catalog says so and the install result
 * repeats it. Writing the artifact is what this can prove; that a running agy
 * loads it is an operator's observation, never this command's claim.
 */
async function installAgyHooks(
  ctx: CliContext,
  target: InstallTarget,
  template: HooksTemplate,
  dryRun: boolean,
): Promise<CommandResult<SelfInstallHooksData>> {
  const configPath = join(ctx.env.homeDir(), ".agents", "hooks.json");
  const read = await readJsonConfig(ctx, configPath, "hooks.json");
  if ("error" in read) return read.error;

  const { emitted, skipped } = hooksTemplateToAgy(template);
  const notices = [skipNotice(skipped, "agy")];
  notices.push(
    `Written to ${configPath}. agy documents its customization root as the workspace's .agents/; whether it also reads a user-global one is NOT verified here — confirm it in a running host before relying on it.`,
  );
  const warning = notices.filter((n) => n !== undefined).join(" ");

  if (emitted === null) {
    return {
      ok: true,
      data: {
        status: "noop",
        target,
        config_path: configPath,
        events_installed: [],
        events_already_present: [],
        backup_path: null,
        warning,
      },
      exitCode: 0,
    };
  }
  const existing = read.data[AGY_HOOK_NAME];
  const already = isDeepStrictEqual(existing, emitted as AgyNamedHook);
  return writeMergedConfig(ctx, {
    target,
    configPath,
    dryRun,
    changed: already ? [] : Object.keys(emitted),
    unchanged: already ? Object.keys(emitted) : [],
    next: { ...read.data, [AGY_HOOK_NAME]: emitted },
    warning,
  });
}

function skipNotice(
  skipped: readonly { event: string; reason: string }[],
  host: string,
): string | undefined {
  if (skipped.length === 0) return undefined;
  return `Not expressible in ${host} and therefore skipped: ${skipped
    .map((s) => `${s.event} (${s.reason})`)
    .join("; ")}.`;
}

/** A host config read as JSON, or the failure that must stop the install. */
async function readJsonConfig(
  ctx: CliContext,
  path: string,
  label: string,
): Promise<{ data: Record<string, unknown> } | { error: CommandResult<SelfInstallHooksData> }> {
  if (!(await ctx.fs.exists(path))) return { data: {} };
  const text = await ctx.fs.readText(path);
  if (text.trim().length === 0) return { data: {} };
  try {
    const parsed = JSON.parse(text);
    return { data: isRecord(parsed) ? parsed : {} };
  } catch (err) {
    return {
      error: {
        ok: false,
        error: {
          code: "SETTINGS_INVALID_JSON",
          message: `${path} is invalid ${label}: ${(err as Error).message}. Fix manually before retrying.`,
        },
        exitCode: 1,
      },
    };
  }
}

interface MergedWrite {
  target: InstallTarget;
  configPath: string;
  dryRun: boolean;
  changed: string[];
  unchanged: string[];
  next: Record<string, unknown>;
  warning: string | undefined;
}

/** The write half both JSON dialects share: noop, dry-run, or backup-then-write. */
async function writeMergedConfig(
  ctx: CliContext,
  write: MergedWrite,
): Promise<CommandResult<SelfInstallHooksData>> {
  const base = {
    target: write.target,
    config_path: write.configPath,
    ...(write.warning === undefined ? {} : { warning: write.warning }),
  };
  if (write.changed.length === 0) {
    return {
      ok: true,
      data: {
        ...base,
        status: "noop",
        events_installed: [],
        events_already_present: write.unchanged,
        backup_path: null,
      },
      exitCode: 0,
    };
  }
  if (write.dryRun) {
    return {
      ok: true,
      data: {
        ...base,
        status: "dry-run",
        events_installed: write.changed,
        events_already_present: write.unchanged,
        backup_path: null,
      },
      exitCode: 0,
    };
  }
  await ctx.fs.mkdirp(dirname(write.configPath));
  const backup = await tryBackup(write.configPath, ctx);
  await ctx.fs.writeText(write.configPath, `${JSON.stringify(write.next, null, 2)}\n`);
  return {
    ok: true,
    data: {
      ...base,
      status: "installed",
      events_installed: write.changed,
      events_already_present: write.unchanged,
      backup_path: backup,
    },
    exitCode: 0,
  };
}

/**
 * opencode: write the plugin module and declare it in `opencode.json`.
 *
 * Unlike codex's bundle this one IS armed — opencode loads what sits in its
 * plugin dir — so the status is `installed`. What it does NOT carry is the whole
 * template: only `tool.execute.before` exists here, and the guard whose matcher
 * cannot be bridged to a Claude-shaped payload is reported rather than written.
 */
async function installOpencodePlugin(
  ctx: CliContext,
  target: InstallTarget,
  template: HooksTemplate,
  dryRun: boolean,
): Promise<CommandResult<SelfInstallHooksData>> {
  const configPath = opencodeGlobalMcpFile(ctx.env.homeDir());
  const pluginPath = join(dirname(configPath), "plugin", OPENCODE_PLUGIN_FILE);
  const read = await readJsonConfig(ctx, configPath, "opencode.json");
  if ("error" in read) return read.error;

  const plugin = buildOpencodePlugin(template);
  const existing = (await ctx.fs.exists(pluginPath)) ? await ctx.fs.readText(pluginPath) : null;
  const config = declareOpencodePlugin(read.data, pluginPath);
  const changed = existing !== plugin.source || config !== read.data;

  const warning = [
    skipNotice(plugin.skipped, "the opencode plugin API"),
    `The module was written to ${pluginPath}; the user-global plugin dir is derived from opencode's global config dir, and its documented one is the workspace's .opencode/plugin/.`,
  ]
    .filter((n) => n !== undefined)
    .join(" ");

  if (!changed) {
    return {
      ok: true,
      data: {
        status: "noop",
        target,
        config_path: pluginPath,
        events_installed: [],
        events_already_present: ["PreToolUse"],
        backup_path: null,
        warning,
      },
      exitCode: 0,
    };
  }
  if (!dryRun) {
    await ctx.fs.mkdirp(dirname(pluginPath));
    await ctx.fs.writeText(pluginPath, plugin.source);
    await ctx.fs.mkdirp(dirname(configPath));
    await ctx.fs.writeText(configPath, `${JSON.stringify(config, null, 2)}\n`);
  }
  return {
    ok: true,
    data: {
      status: dryRun ? "dry-run" : "installed",
      target,
      config_path: pluginPath,
      events_installed: ["PreToolUse"],
      events_already_present: [],
      backup_path: null,
      warning,
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
