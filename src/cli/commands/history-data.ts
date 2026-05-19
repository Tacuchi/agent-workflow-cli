import { runHistoryDataCommand } from "../../application/history-data-service.js";
import { SessionsCsvError, parseSessionsCsv } from "../../application/parsers/sessions-csv.js";
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
    const input: { verbose?: boolean; includeDocs?: boolean; sessions?: string[] } = {};
    if (verbose) input.verbose = true;
    if (includeDocs) input.includeDocs = true;
    const sessionsRaw = args.values.get("sessions");
    if (sessionsRaw !== undefined) {
      try {
        input.sessions = parseSessionsCsv(sessionsRaw);
      } catch (e) {
        if (e instanceof SessionsCsvError) {
          return { ok: false, error: { code: e.code, message: e.message }, exitCode: 1 };
        }
        throw e;
      }
    }
    try {
      const data = await runHistoryDataCommand(ctx.fs, ctx.env, ctx.paths, input);
      return { ok: true, data, exitCode: 0 };
    } catch (e) {
      if (e instanceof SessionsCsvError) {
        return { ok: false, error: { code: e.code, message: e.message }, exitCode: 1 };
      }
      throw e;
    }
  },
};
