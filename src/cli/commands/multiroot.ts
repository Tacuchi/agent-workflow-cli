import { resolve } from "node:path";
import {
  type WorklineMaterialization,
  ensureWorklineMaterialized,
} from "../../application/hub-materialization-service.js";
import {
  type MultirootInput,
  multirootWouldMutate,
  runMultiroot,
} from "../../application/multiroot-service.js";
import { PathsService } from "../../application/paths-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand } from "../registry.js";
import type { CliContext } from "../types.js";

const MULTIROOT_FLAGS = {
  known: [
    "path",
    "paths",
    "from-sources",
    "global",
    "dry-run",
    "hub",
    "skip-claude",
    "skip-codex",
    "skip-warp",
    "skip-oz",
  ],
  repeatable: ["path"],
};

function buildInput(args: ParsedArgs): MultirootInput {
  const input: MultirootInput = {};
  // Repeated --path (routed to valuesMulti by the parser).
  const repeatedPaths = (args.valuesMulti.get("path") ?? []).filter((p) => p.length > 0);
  if (repeatedPaths.length > 0) input.paths = repeatedPaths;
  const csv = args.values.get("paths");
  if (csv !== undefined) input.pathsCsv = csv;
  if (args.flags.has("--from-sources")) input.fromSources = true;
  if (args.flags.has("--global")) input.useGlobal = true;
  if (args.flags.has("--dry-run")) input.dryRun = true;
  const ws = args.values.get("hub");
  if (ws !== undefined) input.hub = ws;
  if (args.flags.has("--skip-claude")) input.skipClaude = true;
  if (args.flags.has("--skip-codex")) input.skipCodex = true;
  if (args.flags.has("--skip-warp")) input.skipWarp = true;
  if (args.flags.has("--skip-oz")) input.skipOz = true;
  return input;
}

export const attachMultirootCommand: CliCommand = {
  name: "attach-multiroot",
  flags: MULTIROOT_FLAGS,
  help: {
    purpose:
      "Register directories as multi-root paths in the hosts' settings so agents can see them.",
    flags: {
      path: { value: "<dir>", effect: "Directory to register." },
      paths: { value: "<csv>", effect: "Directories to register, comma separated." },
      "from-sources": { effect: "Use the hub's declared sources as the directories." },
      global: { effect: "Work on each host's global scope instead of the hub." },
      "dry-run": { effect: "Report the change without writing." },
      hub: { value: "<dir>", effect: "Hub whose host settings change." },
      "skip-claude": { effect: "Leave Claude Code untouched." },
      "skip-codex": { effect: "Leave Codex CLI untouched." },
      "skip-warp": { effect: "Leave Warp untouched." },
      "skip-oz": { effect: "Leave Oz untouched." },
    },
    output:
      "{scope (global|hub), scope_dir, paths_input[], claude, codex, warp, oz, dry_run?, materialization?}; each host entry is its result or {skipped: true}. An unusable input returns {error, hint?} with ok true.",
  },
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    return await runPublicMultiroot(ctx, "attach", buildInput(args));
  },
};

export const detachMultirootCommand: CliCommand = {
  name: "detach-multiroot",
  flags: MULTIROOT_FLAGS,
  help: {
    purpose: "Remove multi-root paths previously registered in the hosts' settings.",
    flags: {
      path: { value: "<dir>", effect: "Directory to remove." },
      paths: { value: "<csv>", effect: "Directories to remove, comma separated." },
      "from-sources": { effect: "Use the hub's declared sources as the directories." },
      global: { effect: "Work on each host's global scope instead of the hub." },
      "dry-run": { effect: "Report the change without writing." },
      hub: { value: "<dir>", effect: "Hub whose host settings change." },
      "skip-claude": { effect: "Leave Claude Code untouched." },
      "skip-codex": { effect: "Leave Codex CLI untouched." },
      "skip-warp": { effect: "Leave Warp untouched." },
      "skip-oz": { effect: "Leave Oz untouched." },
    },
    output:
      "{scope (global|hub), scope_dir, paths_input[], claude, codex, warp, oz, dry_run?, materialization?}; each host entry is its result or {skipped: true}. An unusable input returns {error, hint?} with ok true.",
  },
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    return await runPublicMultiroot(ctx, "detach", buildInput(args));
  },
};

/**
 * The multiroot adapters write host-owned files synchronously, outside the
 * hub FileSystemPort guard. Preview their exact change first, then
 * materialize the resolved hub only when a hub-scoped operation
 * will actually write. Global scope deliberately stays outside Workline.
 */
async function runPublicMultiroot(
  ctx: CliContext,
  mode: "attach" | "detach",
  input: MultirootInput,
): Promise<CommandResult> {
  const preview = await runMultiroot(ctx.fs, ctx.env, ctx.paths, mode, { ...input, dryRun: true });
  if ("error" in preview) return { ok: true, data: preview, exitCode: 0 };
  if (input.dryRun) return { ok: true, data: { ...preview, dry_run: true }, exitCode: 0 };

  if (input.useGlobal || !multirootWouldMutate(preview)) {
    const data = await runMultiroot(ctx.fs, ctx.env, ctx.paths, mode, input);
    return { ok: true, data, exitCode: 0 };
  }

  const hub = input.hub === undefined ? ctx.paths.hubDir() : resolve(input.hub);
  const current = resolve(ctx.paths.hubDir());
  const hubPaths =
    hub === current ? ctx.paths : new PathsService(ctx.paths.namespace, ctx.env.homeDir(), hub);
  const materialization = await ensureWorklineMaterialized(ctx.rawFs ?? ctx.fs, hubPaths);
  const data = await runMultiroot(ctx.fs, ctx.env, ctx.paths, mode, input);
  if ("error" in data) return { ok: true, data, exitCode: 0 };
  return { ok: true, data: withMaterialization(data, materialization), exitCode: 0 };
}

function withMaterialization<T extends object>(
  data: T,
  materialization: WorklineMaterialization,
): T & { materialization: WorklineMaterialization } {
  return { ...data, materialization };
}
