import {
  type ResumeSummaryOptions,
  runResumeSummary,
} from "../../application/checkpoint-service.js";
import type { CommandResult } from "../../domain/types.js";
import { readHookStdin, resolveContextId } from "../context-id.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand } from "../registry.js";
import { fail } from "../render.js";
import type { CliContext } from "../types.js";

export const resumeSummaryCommand: CliCommand = {
  name: "resume-summary",
  describe:
    "Compact resume payload for the PostCompact hook. " +
    "Usage: aw resume-summary [--code <session>] [--include-recent-closed] [--recent-days <n>].",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const options: ResumeSummaryOptions = {};
    if (args.flags.has("--include-recent-closed")) {
      options.includeRecentClosed = true;
    }
    const recentDaysRaw = args.values.get("recent-days");
    if (recentDaysRaw !== undefined) {
      const n = Number.parseInt(recentDaysRaw, 10);
      if (!Number.isFinite(n) || n <= 0) {
        return fail(
          "INVALID_INPUT",
          `--recent-days debe ser entero positivo (got '${recentDaysRaw}')`,
        );
      }
      options.recentDays = n;
    }
    const code = args.values.get("code");
    if (code !== undefined) options.code = code;

    // PostCompact delivers the conversation id on stdin; the same command run by
    // hand from a terminal simply has none.
    const context = resolveContextId(ctx.env, await readHookStdin());
    if (!context.ok) return fail(context.code, context.message);
    if (context.contextId !== undefined) options.contextId = context.contextId;

    const data = await runResumeSummary(ctx.fs, ctx.paths, options);
    return { ok: true, data, exitCode: 0 };
  },
};
