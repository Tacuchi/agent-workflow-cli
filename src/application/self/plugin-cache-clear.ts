import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { ParsedArgs } from "../../cli/parser.js";
import type { CliContext } from "../../cli/types.js";
import type { CommandResult } from "../../domain/types.js";
import { INSTALL_TARGETS, type InstallTarget, TARGET_ROOTS } from "./install-targets.js";

export type CacheTarget = InstallTarget;

// Same single source as install/uninstall: hosts without a plugin cache or
// flattened skills simply report "nothing" instead of rejecting the target.
export const CACHE_TARGETS: readonly CacheTarget[] = INSTALL_TARGETS;

export interface PluginCacheRemoval {
  path: string;
  kind: "cache" | "installed-entry" | "skill-dir";
}

export interface SelfClearPluginCacheData {
  status: "removed" | "nothing" | "dry-run";
  target: CacheTarget;
  plugin: string;
  removed: PluginCacheRemoval[];
  summary: string;
}

export async function selfClearPluginCache(
  args: ParsedArgs,
  ctx: CliContext,
): Promise<CommandResult<SelfClearPluginCacheData>> {
  const plugin = args.values.get("plugin");
  const targetArg = args.values.get("target") as CacheTarget | undefined;
  const dryRun = args.flags.has("--dry-run");

  if (!plugin) {
    return {
      ok: false,
      error: { code: "INVALID_INPUT", message: "--plugin <namespace> es obligatorio." },
      exitCode: 1,
    };
  }

  if (!targetArg || !CACHE_TARGETS.includes(targetArg)) {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: `--target debe ser uno de: ${CACHE_TARGETS.join(", ")}. Recibido: '${
          targetArg ?? "(vacío)"
        }'`,
      },
      exitCode: 1,
    };
  }

  const home = ctx.env.homeDir();
  const removed: PluginCacheRemoval[] = [];

  if (targetArg === "claude" || targetArg === "codex") {
    removed.push(...(await clearHostCache(ctx, home, targetArg, plugin, dryRun)));
  } else {
    removed.push(...(await clearSkillDirs(ctx, home, targetArg, plugin, dryRun)));
  }

  const status = dryRun ? "dry-run" : removed.length === 0 ? "nothing" : "removed";
  const summary = buildSummary(status, targetArg, plugin, removed.length);

  return {
    ok: true,
    data: { status, target: targetArg, plugin, removed, summary },
    exitCode: 0,
  };
}

async function clearHostCache(
  ctx: CliContext,
  home: string,
  target: "claude" | "codex",
  plugin: string,
  dryRun: boolean,
): Promise<PluginCacheRemoval[]> {
  const pluginsRoot = join(home, `.${target}`, "plugins");
  const cacheRemovals = await removeCacheDirs(ctx, join(pluginsRoot, "cache"), plugin, dryRun);
  const installedRemoval = await removeInstalledEntry(
    ctx,
    join(pluginsRoot, "installed_plugins.json"),
    plugin,
    dryRun,
  );
  return installedRemoval ? [...cacheRemovals, installedRemoval] : cacheRemovals;
}

async function removeCacheDirs(
  ctx: CliContext,
  cacheRoot: string,
  plugin: string,
  dryRun: boolean,
): Promise<PluginCacheRemoval[]> {
  if (!(await ctx.fs.exists(cacheRoot))) return [];
  const marketplaces = await listSafe(ctx, cacheRoot);
  const removals: PluginCacheRemoval[] = [];
  for (const mp of marketplaces) {
    const pluginDir = join(cacheRoot, mp.name, plugin);
    if (!(await ctx.fs.exists(pluginDir))) continue;
    if (!dryRun) await rm(pluginDir, { recursive: true, force: true });
    removals.push({ path: pluginDir, kind: "cache" });
  }
  return removals;
}

async function removeInstalledEntry(
  ctx: CliContext,
  installedPath: string,
  plugin: string,
  dryRun: boolean,
): Promise<PluginCacheRemoval | null> {
  if (!(await ctx.fs.exists(installedPath))) return null;
  let data: { plugins?: Record<string, unknown> };
  try {
    data = JSON.parse(await ctx.fs.readText(installedPath));
  } catch {
    return null;
  }
  const plugins = (data.plugins ?? {}) as Record<string, unknown>;
  const keysToRemove = Object.keys(plugins).filter((k) => k.startsWith(`${plugin}@`));
  if (keysToRemove.length === 0) return null;

  if (!dryRun) {
    for (const k of keysToRemove) delete plugins[k];
    data.plugins = plugins;
    await ctx.fs.writeText(installedPath, `${JSON.stringify(data, null, 2)}\n`);
  }
  return {
    path: `${installedPath} (${keysToRemove.join(", ")})`,
    kind: "installed-entry",
  };
}

// Exported: plugin-cache-reload shares the same tolerant listing.
export async function listSafe(ctx: CliContext, path: string): Promise<{ name: string }[]> {
  try {
    return await ctx.fs.list(path);
  } catch {
    return [];
  }
}

async function clearSkillDirs(
  ctx: CliContext,
  home: string,
  target: CacheTarget,
  plugin: string,
  dryRun: boolean,
): Promise<PluginCacheRemoval[]> {
  const removals: PluginCacheRemoval[] = [];
  const skillsRoot = join(home, ...TARGET_ROOTS[target]);

  if (!(await ctx.fs.exists(skillsRoot))) return removals;

  let entries: { name: string; type: string }[] = [];
  try {
    entries = await ctx.fs.list(skillsRoot);
  } catch {
    return removals;
  }

  const prefix = `${plugin}-`;
  for (const entry of entries) {
    if (entry.type !== "dir") continue;
    if (!entry.name.startsWith(prefix)) continue;
    const full = join(skillsRoot, entry.name);
    if (!dryRun) await rm(full, { recursive: true, force: true });
    removals.push({ path: full, kind: "skill-dir" });
  }

  return removals;
}

function buildSummary(
  status: "removed" | "nothing" | "dry-run",
  target: CacheTarget,
  plugin: string,
  count: number,
): string {
  if (status === "dry-run") {
    return `[dry-run] se borrarían ${count} item(s) del plugin '${plugin}' en ${target}.`;
  }
  if (status === "nothing") {
    return `Nada que limpiar para '${plugin}' en ${target}.`;
  }
  return `Limpiados ${count} item(s) del plugin '${plugin}' en ${target}.`;
}
