import { SessionsCsvError, parseSessionsCsv } from "../../application/parsers/sessions-csv.js";
import { runReleaseData } from "../../application/release-data-service.js";
import type { CommandResult } from "../../domain/types.js";
import { type ParsedArgs, flagValue } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import type { CliContext } from "../types.js";

export const releaseDataCommand: QtcCommand = {
  name: "release-data",
  describe:
    "Dump consolidado del corpus de sesiones para la familia export-* " +
    "(scripts/manuals/diagrams/reports). Usage: aw release-data [--sessions <csv>] " +
    "[--since sessionNNN] [--source <alias>] [--include-graduated] " +
    "[--standalone-sql] [--no-open] [--no-closed] [--verbose].",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const input: Parameters<typeof runReleaseData>[3] = {};
    const sessionsRaw = args.values.get("sessions");
    const since = args.values.get("since");
    const warnings: string[] = [];
    if (sessionsRaw !== undefined) {
      try {
        input.sessions = parseSessionsCsv(sessionsRaw);
      } catch (e) {
        if (e instanceof SessionsCsvError) {
          return { ok: false, error: { code: e.code, message: e.message }, exitCode: 1 };
        }
        throw e;
      }
      if (since !== undefined) {
        warnings.push("--sessions toma precedencia sobre --since; --since ignorado");
      }
    } else if (since !== undefined) {
      input.since = since;
    }
    const source = flagValue(args, "source");
    if (source !== undefined) input.sourceAlias = source;
    if (args.flags.has("--include-graduated")) input.includeGraduated = true;
    if (args.flags.has("--standalone-sql")) input.includeStandaloneSql = true;
    if (args.flags.has("--no-open")) input.includeOpen = false;
    if (args.flags.has("--no-closed")) input.includeClosed = false;
    if (args.flags.has("--verbose")) input.verbose = true;

    try {
      const data = await runReleaseData(ctx.fs, ctx.env, ctx.paths, input, ctx.runtime);
      if ("error" in data) {
        // Unknown alias / unreadable block: a real error, not an empty "ok" dump.
        return {
          ok: false,
          error: { code: "INVALID_INPUT", message: data.error },
          data,
          exitCode: 1,
        };
      }
      const dataWithWarnings = warnings.length > 0 ? { ...data, warnings } : data;
      return { ok: true, data: dataWithWarnings, exitCode: 0 };
    } catch (e) {
      if (e instanceof SessionsCsvError) {
        return { ok: false, error: { code: e.code, message: e.message }, exitCode: 1 };
      }
      throw e;
    }
  },
};
