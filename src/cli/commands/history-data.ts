import { runHistoryDataCommand } from "../../application/history-data-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import type { CliContext } from "../types.js";

export const historyDataCommand: QtcCommand = {
  name: "history-data",
  describe: "Aggregate session metadata to (re)build HISTORY.md.",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const verbose = args.flags.has("--verbose");
    const includeDocs = args.flags.has("--include-docs");
    const input: { verbose?: boolean; includeDocs?: boolean } = {};
    if (verbose) input.verbose = true;
    if (includeDocs) input.includeDocs = true;
    const data = await runHistoryDataCommand(ctx.fs, ctx.env, ctx.paths, input);
    return { ok: true, data, exitCode: 0 };
  },
};
