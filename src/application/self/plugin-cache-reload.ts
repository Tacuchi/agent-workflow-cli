import { join } from "node:path";
import type { ParsedArgs } from "../../cli/parser.js";
import type { CliContext } from "../../cli/types.js";
import type { CommandResult } from "../../domain/types.js";
import { type PluginSkillResult, selfInstallPluginSkills } from "./install-plugin-skills.js";
import {
  type CacheTarget,
  type PluginCacheRemoval,
  listSafe,
  selfClearPluginCache,
} from "./plugin-cache-clear.js";

export interface SelfReloadPluginCacheData {
  status: "reloaded" | "cleared-only" | "nothing" | "dry-run";
  target: CacheTarget;
  plugin: string;
  removed: PluginCacheRemoval[];
  reinstalled: PluginSkillResult[];
  hint?: string;
  summary: string;
}

export async function selfReloadPluginCache(
  args: ParsedArgs,
  ctx: CliContext,
): Promise<CommandResult<SelfReloadPluginCacheData>> {
  // Input validation (--plugin/--target) is delegated to selfClearPluginCache:
  // its INVALID_INPUT error surfaces through the passthrough below, and the
  // casts are only consumed after clearResult.ok.
  const plugin = args.values.get("plugin") as string;
  const targetArg = args.values.get("target") as CacheTarget;
  const fromArg = args.values.get("from");
  const dryRun = args.flags.has("--dry-run");

  const clearResult = await selfClearPluginCache(args, ctx);
  if (!clearResult.ok || !clearResult.data) {
    return clearResult as CommandResult<SelfReloadPluginCacheData>;
  }
  const removed = clearResult.data.removed;
  const clearSummary = clearResult.data.summary;

  if (targetArg === "claude" || targetArg === "codex") {
    return buildHostReloadResult(targetArg, plugin, removed, clearSummary, dryRun);
  }

  const source = await resolveSource(ctx, plugin, fromArg);
  if (!source) {
    return buildSourceMissingResult(targetArg, plugin, removed, clearSummary);
  }

  if (dryRun) {
    return {
      ok: true,
      data: {
        status: "dry-run",
        target: targetArg,
        plugin,
        removed,
        reinstalled: [],
        summary: `[dry-run] ${clearSummary} | se reinstalaría desde ${source}`,
      },
      exitCode: 0,
    };
  }

  return await runReinstall(ctx, plugin, targetArg, source, removed, clearSummary);
}

function buildHostReloadResult(
  target: "claude" | "codex",
  plugin: string,
  removed: PluginCacheRemoval[],
  clearSummary: string,
  dryRun: boolean,
): CommandResult<SelfReloadPluginCacheData> {
  const host = target === "claude" ? "Claude Code" : "Codex";
  const hint = `Reiniciá ${host} para que el host re-clone el plugin desde el marketplace.`;
  const status = dryRun ? "dry-run" : removed.length === 0 ? "nothing" : "cleared-only";
  const summary = dryRun ? `[dry-run] ${clearSummary} | ${hint}` : `${clearSummary} ${hint}`;
  return {
    ok: true,
    data: { status, target, plugin, removed, reinstalled: [], hint, summary },
    exitCode: 0,
  };
}

function buildSourceMissingResult(
  target: Exclude<CacheTarget, "claude" | "codex">,
  plugin: string,
  removed: PluginCacheRemoval[],
  clearSummary: string,
): CommandResult<SelfReloadPluginCacheData> {
  return {
    ok: false,
    error: {
      code: "SOURCE_NOT_FOUND",
      message: `No se encontró source para reinstalar '${plugin}' en ${target}. Pasá --from <path-skills-dir> o instalá el plugin en Claude Code primero (provee cache compartido).`,
    },
    data: {
      status: removed.length === 0 ? "nothing" : "cleared-only",
      target,
      plugin,
      removed,
      reinstalled: [],
      summary: clearSummary,
    },
    exitCode: 1,
  };
}

async function runReinstall(
  ctx: CliContext,
  plugin: string,
  target: Exclude<CacheTarget, "claude" | "codex">,
  source: string,
  removed: PluginCacheRemoval[],
  clearSummary: string,
): Promise<CommandResult<SelfReloadPluginCacheData>> {
  const installArgs: ParsedArgs = {
    rest: [],
    plugin: {},
    flags: new Set(["--force"]),
    values: new Map<string, string>([
      ["from", source],
      ["target", target],
      ["namespace", plugin],
    ]),
    valuesMulti: new Map(),
  };
  const installResult = await selfInstallPluginSkills(installArgs, ctx);
  const reinstalled = installResult.data?.skills ?? [];
  return {
    ok: installResult.ok,
    data: {
      status: "reloaded",
      target,
      plugin,
      removed,
      reinstalled,
      summary: `${clearSummary} ${installResult.data?.summary ?? ""}`.trim(),
    },
    ...(installResult.error ? { error: installResult.error } : {}),
    exitCode: installResult.exitCode,
  };
}

async function resolveSource(
  ctx: CliContext,
  plugin: string,
  fromArg: string | undefined,
): Promise<string | null> {
  if (fromArg && (await ctx.fs.exists(fromArg))) return fromArg;
  const home = ctx.env.homeDir();
  for (const host of ["claude", "codex"] as const) {
    const found = await findInHostCache(ctx, join(home, `.${host}`, "plugins", "cache"), plugin);
    if (found) return found;
  }
  return null;
}

async function findInHostCache(
  ctx: CliContext,
  cacheRoot: string,
  plugin: string,
): Promise<string | null> {
  if (!(await ctx.fs.exists(cacheRoot))) return null;
  const marketplaces = await listSafe(ctx, cacheRoot);
  for (const mp of marketplaces) {
    const skillsDir = await findSkillsDir(ctx, join(cacheRoot, mp.name, plugin));
    if (skillsDir) return skillsDir;
  }
  return null;
}

async function findSkillsDir(ctx: CliContext, pluginRoot: string): Promise<string | null> {
  if (!(await ctx.fs.exists(pluginRoot))) return null;
  const versions = await listSafe(ctx, pluginRoot);
  const latest = pickLatestVersion(versions.map((v) => v.name));
  if (!latest) return null;
  const skillsDir = join(pluginRoot, latest, "skills");
  return (await ctx.fs.exists(skillsDir)) ? skillsDir : null;
}

function pickLatestVersion(names: string[]): string | null {
  const semver = names.filter((n) => /^\d+\.\d+\.\d+/.test(n));
  if (semver.length === 0) return null;
  semver.sort((a, b) => {
    const [aMaj = 0, aMin = 0, aPatch = 0] = a.split(".").map(Number);
    const [bMaj = 0, bMin = 0, bPatch = 0] = b.split(".").map(Number);
    return bMaj - aMaj || bMin - aMin || bPatch - aPatch;
  });
  return semver[0] ?? null;
}
