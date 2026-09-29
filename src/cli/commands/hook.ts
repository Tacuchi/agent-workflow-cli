import { runSqlMutationGuard } from "../../application/hook-sql-mutation-guard.js";
import type { CommandResult } from "../../domain/types.js";
import { readHookStdin } from "../context-id.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand } from "../registry.js";
import { fail, writeStderr } from "../render.js";
import type { CliContext } from "../types.js";

export const hookCommand: CliCommand = {
  name: "hook",
  flags: { known: [], mode: "warn" },
  describe: "Hook target. Subcommand: sql-mutation-guard.",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const subcommand = args.rest[0];
    if (!subcommand) {
      return fail("INVALID_INPUT", "hook requires a subcommand: sql-mutation-guard");
    }
    // Bounded like the lifecycle hooks: run by hand from an agent's shell, fd 0
    // is an idle socket and an unbounded read would hang until the tool timeout.
    const stdin = (await readHookStdin()) ?? "";
    if (subcommand === "sql-mutation-guard") {
      const result = runSqlMutationGuard({
        stdin,
        env: ctx.env,
        runtime: ctx.runtime,
        paths: ctx.paths,
      });
      if (result.stderr) writeStderr(result.stderr);
      return { ok: true, data: undefined, exitCode: result.exitCode };
    }
    return fail("INVALID_INPUT", `hook: unknown subcommand '${subcommand}'`);
  },
};
