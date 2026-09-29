import { SessionsCsvError, parseSessionsCsv } from "../../application/parsers/sessions-csv.js";
import { runReleaseData } from "../../application/release-data-service.js";
import type { CommandResult } from "../../domain/types.js";
import { type ParsedArgs, flagValue } from "../parser.js";
import type { CliCommand } from "../registry.js";
import { fail } from "../render.js";
import type { CliContext } from "../types.js";

export const releaseDataCommand: CliCommand = {
  name: "release-data",
  flags: {
    known: [
      "sessions",
      "since",
      "source",
      "include-graduated",
      "no-closed",
      "no-open",
      "standalone-sql",
      "verbose",
    ],
  },
  help: {
    purpose:
      "Dump the consolidated session corpus that the export commands (scripts, manuals, diagrams, reports) read.",
    flags: {
      sessions: {
        value: "<csv>",
        effect: "Only these session codes; takes precedence over --since.",
      },
      since: { value: "<code>", effect: "Only the sessions after this one." },
      source: { value: "<alias>", effect: "Read the docs and release roots of this source." },
      "include-graduated": { effect: "Also list the bundles the sessions already graduated to." },
      "no-closed": { effect: "Leave out closed sessions." },
      "no-open": { effect: "Leave out open sessions." },
      "standalone-sql": { effect: "Also list SQL files that belong to no session." },
      verbose: { effect: "Include the full detail of each session." },
    },
    output:
      "{source_alias, docs_root, release_root, sessions[], sessions_count, legacy_sessions[]?, since?, graduated_bundles[]?, standalone_sql[]?, warnings[]?}.",
    notes: ["Read-only."],
  },
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
          return fail(e.code, e.message);
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
        return fail("INVALID_INPUT", data.error, data);
      }
      const dataWithWarnings = warnings.length > 0 ? { ...data, warnings } : data;
      return { ok: true, data: dataWithWarnings, exitCode: 0 };
    } catch (e) {
      if (e instanceof SessionsCsvError) {
        return fail(e.code, e.message);
      }
      throw e;
    }
  },
};
