import { runReleaseData } from "../../application/release-data-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import type { CliContext } from "../types.js";

export const releaseDataCommand: QtcCommand = {
  name: "release-data",
  describe: "Dump consolidado para los skills release y release-scripts.",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const input: Parameters<typeof runReleaseData>[2] = {};
    const since = args.values.get("since");
    if (since !== undefined) input.since = since;
    const source = args.values.get("source");
    if (source !== undefined) input.sourceAlias = source;
    if (args.flags.has("--include-graduated")) input.includeGraduated = true;
    if (args.flags.has("--no-open")) input.includeOpen = false;
    if (args.flags.has("--no-closed")) input.includeClosed = false;
    if (args.flags.has("--skip-content")) input.skipContent = true;
    if (args.flags.has("--verbose")) input.verbose = true;

    const data = await runReleaseData(ctx.fs, ctx.env, input);
    return { ok: true, data, exitCode: 0 };
  },
};
