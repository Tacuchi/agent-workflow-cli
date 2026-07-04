import { runGenerateLaunch } from "../../application/generate-launch-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import { fail } from "../render.js";
import type { CliContext } from "../types.js";

export const generateLaunchCommand: QtcCommand = {
  name: "generate-launch",
  describe:
    "(Re)generate the per-source launch scripts (.workflow/launch/<alias>/: launch.json + run.sh + run.ps1) by detecting each source's stack. Idempotent: pristine files are regenerated, hand-edited ones preserved (--force overwrites them). Reads sources from the WORKSPACE block; the launch flow also generates these on demand at the first launch. " +
    "Usage: aw generate-launch [--source <alias> (repeatable)] [--force] [--dry-run] [--workspace <dir>].",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const aliases = args.valuesMulti.get("source") ?? [];
    const workspace = args.values.get("workspace");
    const data = await runGenerateLaunch(ctx.fs, ctx.env, ctx.paths, {
      ...(aliases.length > 0 ? { aliases } : {}),
      force: args.flags.has("--force"),
      dryRun: args.flags.has("--dry-run"),
      ...(workspace !== undefined ? { workspace } : {}),
    });
    if ("error" in data) return fail("INVALID_INPUT", data.hint ?? data.error, data);
    return { ok: data.ok, data, exitCode: data.ok ? 0 : 1 };
  },
};
