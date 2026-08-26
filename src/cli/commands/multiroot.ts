import { resolve } from "node:path";
import {
  type MultirootInput,
  multirootWouldMutate,
  runMultiroot,
} from "../../application/multiroot-service.js";
import { PathsService } from "../../application/paths-service.js";
import {
  type WorklineMaterialization,
  ensureWorklineMaterialized,
} from "../../application/workspace-materialization-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand } from "../registry.js";
import type { CliContext } from "../types.js";

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
  const ws = args.values.get("workspace");
  if (ws !== undefined) input.workspace = ws;
  if (args.flags.has("--skip-claude")) input.skipClaude = true;
  if (args.flags.has("--skip-codex")) input.skipCodex = true;
  if (args.flags.has("--skip-warp")) input.skipWarp = true;
  if (args.flags.has("--skip-oz")) input.skipOz = true;
  return input;
}

export const attachMultirootCommand: CliCommand = {
  name: "attach-multiroot",
  describe:
    "Configura visibilidad multi-root en Claude Code y Codex CLI. " +
    "Usage: aw attach-multiroot [--path <dir> ...] [--paths <csv>] [--workspace <dir>] " +
    "[--from-sources] [--global] [--dry-run] [--skip-claude] [--skip-codex] [--skip-warp] [--skip-oz].",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    return await runPublicMultiroot(ctx, "attach", buildInput(args));
  },
};

export const detachMultirootCommand: CliCommand = {
  name: "detach-multiroot",
  describe:
    "Quita visibilidad multi-root previamente configurada. " +
    "Usage: aw detach-multiroot [--path <dir> ...] [--paths <csv>] [--workspace <dir>] " +
    "[--from-sources] [--global] [--dry-run] [--skip-claude] [--skip-codex] [--skip-warp] [--skip-oz].",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    return await runPublicMultiroot(ctx, "detach", buildInput(args));
  },
};

/**
 * The multiroot adapters write host-owned files synchronously, outside the
 * workspace FileSystemPort guard. Preview their exact change first, then
 * materialize the resolved workspace only when a workspace-scoped operation
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

  const workspace =
    input.workspace === undefined ? ctx.paths.workspaceDir() : resolve(input.workspace);
  const current = resolve(ctx.paths.workspaceDir());
  const workspacePaths =
    workspace === current
      ? ctx.paths
      : new PathsService(ctx.paths.namespace, ctx.env.homeDir(), workspace);
  const materialization = await ensureWorklineMaterialized(ctx.rawFs ?? ctx.fs, workspacePaths);
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
