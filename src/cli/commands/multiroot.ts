import { type MultirootInput, runMultiroot } from "../../application/multiroot-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
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
  const ws = args.values.get("workspace");
  if (ws !== undefined) input.workspace = ws;
  if (args.flags.has("--skip-claude")) input.skipClaude = true;
  if (args.flags.has("--skip-codex")) input.skipCodex = true;
  if (args.flags.has("--skip-warp")) input.skipWarp = true;
  if (args.flags.has("--skip-oz")) input.skipOz = true;
  return input;
}

export const attachMultirootCommand: QtcCommand = {
  name: "attach-multiroot",
  describe:
    "Configura visibilidad multi-root en Claude Code y Codex CLI. " +
    "Usage: aw attach-multiroot [--path <dir> ...] [--paths <csv>] [--workspace <dir>] " +
    "[--from-sources] [--global] [--skip-claude] [--skip-codex] [--skip-warp] [--skip-oz].",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const data = await runMultiroot(ctx.fs, ctx.env, ctx.paths, "attach", buildInput(args));
    return { ok: true, data, exitCode: 0 };
  },
};

export const detachMultirootCommand: QtcCommand = {
  name: "detach-multiroot",
  describe:
    "Quita visibilidad multi-root previamente configurada. " +
    "Usage: aw detach-multiroot [--path <dir> ...] [--paths <csv>] [--workspace <dir>] " +
    "[--from-sources] [--global] [--skip-claude] [--skip-codex] [--skip-warp] [--skip-oz].",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const data = await runMultiroot(ctx.fs, ctx.env, ctx.paths, "detach", buildInput(args));
    return { ok: true, data, exitCode: 0 };
  },
};
