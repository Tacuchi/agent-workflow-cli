import { runSqlMutationGuard } from "../../application/hook-sql-mutation-guard.js";
import type { CommandResult } from "../../domain/types.js";
import { readHookStdin } from "../context-id.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand } from "../registry.js";
import { fail, writeStderr } from "../render.js";
import type { CliContext } from "../types.js";

const SUBCOMMANDS = ["sql-mutation-guard"];

/** The one hook target of 31.0.0: the compaction and end hooks left with the sessions. */
export const hookCommand: CliCommand = {
  name: "hook",
  flags: { known: [], mode: "warn" },
  hook: true,
  help: {
    purpose: "Hook target the host runs before a tool call: sql-mutation-guard.",
    args: SUBCOMMANDS.join(" | "),
    output: "No data; the verdict is the exit code, and a block explains itself on stderr.",
    exit_codes: {
      "2": "sql-mutation-guard blocked the tool call: its SQL is not a plain read on a server outside AW_SQL_GUARD_ALLOW.",
    },
    notes: [
      "sql-mutation-guard reads the host hook payload on stdin (tool_name, tool_input). It passes (exit 0) when the runtime configures no SQL guard, AW_SQL_GUARD=off, the tool does not match the guarded pattern, the server is listed in AW_SQL_GUARD_ALLOW (comma separated) or the input carries no SQL. Anything but a closed list of reads (SELECT, VALUES, TABLE, SHOW) is blocked, including SQL that cannot be delimited or classified.",
    ],
  },
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const subcommand = args.rest[0];
    if (!subcommand) {
      return fail("INVALID_INPUT", `hook requires a subcommand: ${SUBCOMMANDS.join(", ")}`);
    }
    if (subcommand !== "sql-mutation-guard") {
      return fail("INVALID_INPUT", `hook: unknown subcommand '${subcommand}'`);
    }
    // Bounded: run by hand from an agent's shell, fd 0 is an idle socket and an
    // unbounded read would hang until the tool timeout.
    const stdin = (await readHookStdin()) ?? "";
    const result = runSqlMutationGuard({
      stdin,
      env: ctx.env,
      runtime: ctx.runtime,
      paths: ctx.paths,
    });
    if (result.stderr) writeStderr(result.stderr);
    return { ok: true, data: undefined, exitCode: result.exitCode };
  },
};
