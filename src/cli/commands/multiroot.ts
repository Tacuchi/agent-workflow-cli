import { type MultirootInput, runMultiroot } from "../../application/multiroot-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import type { CliContext } from "../types.js";

function buildInput(args: ParsedArgs): MultirootInput {
  const input: MultirootInput = {};
  // Repeated --path support via argv scan (the parser overwrites map values).
  const repeatedPaths = collectRepeated(process.argv.slice(2), "--path");
  if (repeatedPaths.length > 0) input.paths = repeatedPaths;
  const csv = args.values.get("paths");
  if (csv !== undefined) input.pathsCsv = csv;
  if (args.flags.has("--from-sources")) input.fromSources = true;
  if (args.flags.has("--global")) input.useGlobal = true;
  const ws = args.values.get("workspace");
  if (ws !== undefined) input.workspace = ws;
  if (args.flags.has("--skip-claude")) input.skipClaude = true;
  if (args.flags.has("--skip-codex")) input.skipCodex = true;
  return input;
}

function collectRepeated(argv: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && i + 1 < argv.length) {
      out.push(argv[i + 1] ?? "");
      i += 1;
    }
  }
  return out.filter((p) => p.length > 0);
}

export const attachMultirootCommand: QtcCommand = {
  name: "attach-multiroot",
  describe: "Configura visibilidad multi-root en Claude Code y Codex CLI.",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const data = await runMultiroot(ctx.fs, ctx.env, "attach", buildInput(args));
    return { ok: true, data, exitCode: 0 };
  },
};

export const detachMultirootCommand: QtcCommand = {
  name: "detach-multiroot",
  describe: "Quita visibilidad multi-root previamente configurada.",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const data = await runMultiroot(ctx.fs, ctx.env, "detach", buildInput(args));
    return { ok: true, data, exitCode: 0 };
  },
};
