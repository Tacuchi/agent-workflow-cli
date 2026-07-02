import {
  type ResumeSummaryOptions,
  runResumeSummary,
} from "../../application/checkpoint-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import type { CliContext } from "../types.js";

export const resumeSummaryCommand: QtcCommand = {
  name: "resume-summary",
  describe:
    "Compact resume payload for PostCompact hook. " +
    "Usage: aw resume-summary [--include-recent-closed] [--recent-days <n>].",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const options: ResumeSummaryOptions = {};
    if (args.flags.has("--include-recent-closed")) {
      options.includeRecentClosed = true;
    }
    const recentDaysRaw = args.values.get("recent-days");
    if (recentDaysRaw !== undefined) {
      const n = Number.parseInt(recentDaysRaw, 10);
      if (!Number.isFinite(n) || n <= 0) {
        return {
          ok: false,
          error: {
            code: "INVALID_INPUT",
            message: `--recent-days debe ser entero positivo (got '${recentDaysRaw}')`,
          },
          exitCode: 1,
        };
      }
      options.recentDays = n;
    }
    const data = await runResumeSummary(ctx.fs, ctx.env, ctx.paths, options);
    return { ok: true, data, exitCode: 0 };
  },
};
