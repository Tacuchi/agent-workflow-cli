import { runResumeSummary } from "../../application/checkpoint-service.js";
import type { CommandResult } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import type { CliContext } from "../types.js";

export const resumeSummaryCommand: QtcCommand = {
  name: "resume-summary",
  describe: "Compact resume payload for PostCompact hook.",
  async execute(_args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const data = await runResumeSummary(ctx.fs, ctx.env, ctx.paths);
    return { ok: true, data, exitCode: 0 };
  },
};
